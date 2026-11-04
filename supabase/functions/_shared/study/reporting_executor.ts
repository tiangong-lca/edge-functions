import { z } from 'zod';
import { idSchema } from '../../../../contracts/lca-study/v1/common.ts';
import {
  API_SCHEMA,
  capabilitiesSchema,
  DISABLED_CAPABILITIES,
  reportingArtifactRefSchema,
  type ReportingRequest,
} from '../../../../contracts/lca-study/v3/report.ts';
import {
  analysisConfigHash,
  parseRequest,
  validateResponseForRequest,
} from '../../../../contracts/lca-study/v3/codec.ts';
import {
  responseSchema,
  responseDataSchema,
} from '../../../../contracts/lca-study/v3/responses.ts';
import {
  canonicalBytes,
  decodeBase64Url,
  parseCanonicalBytes,
  sha256,
} from '../../../../contracts/lca-study/v3/canonical.ts';
import {
  exportManifestSchema,
  signExportManifest,
  validateExportViewBindings,
} from '../../../../contracts/lca-study/v3/export.ts';
import type { ActorContext } from '../command_runtime/actor_context.ts';
import { StudyFailure } from './protocol.ts';
import { unpack, MAX_ARTIFACT_BYTES } from './repository.ts';
import {
  createReportingRepository,
  reportingCapabilitySchema,
  reportingReadIntentSchema,
  type PrivateReportArtifact,
  type ReportingRepository,
} from './reporting_repository.ts';
import {
  reportContextSchema,
  reportIntentSchema,
  type ReportContext,
} from './reporting_context.ts';
import {
  assertReportContext,
  contentValidation,
  makeReportContent,
  sameJson,
  validateReportInputs,
} from './reporting_producer.ts';
import {
  bundledReportingRenderer,
  makeReportView,
  type ReportingRenderer,
} from './reporting_view.ts';

type RuntimeConfig = z.infer<typeof capabilitiesSchema>;
type SigningKey = { keyId: string; issuerId: string; privateKey: CryptoKey };
export type ReportingOptions = {
  config?: () => RuntimeConfig;
  repository?: (actor: ActorContext) => ReportingRepository;
  renderer?: ReportingRenderer | null;
  signer?: (profile: NonNullable<ReportContext['exportProfile']>) => Promise<SigningKey>;
  /** Internal owned qualification injection only; no request/env field enables a candidate renderer. */
  allowDevelopmentRenderer?: boolean;
};

function config(): RuntimeConfig {
  const text = Deno.env.get('STUDY_REPORTING_CONFIG');
  return text ? capabilitiesSchema.parse(JSON.parse(text)) : DISABLED_CAPABILITIES;
}
export async function configuredSigner(
  profile: NonNullable<ReportContext['exportProfile']>,
): Promise<SigningKey> {
  try {
    const raw = Deno.env.get('STUDY_EXPORT_SIGNING_KEY');
    if (!raw) throw new Error('missing');
    const value = z
      .object({ keyId: idSchema, issuerId: idSchema, privateKeyPkcs8: z.string().max(128) })
      .strict()
      .parse(JSON.parse(raw));
    if (value.keyId !== profile.keyId || value.issuerId !== profile.issuerId)
      throw new Error('binding');
    return {
      keyId: value.keyId,
      issuerId: value.issuerId,
      privateKey: await crypto.subtle.importKey(
        'pkcs8',
        decodeBase64Url(value.privateKeyPkcs8, 48),
        { name: 'Ed25519' },
        false,
        ['sign'],
      ),
    };
  } catch {
    throw new StudyFailure('CAPABILITY_UNAVAILABLE', 503, 'report.signer_configuration');
  }
}
function base64(bytes: Uint8Array): string {
  const pieces: string[] = [];
  for (let i = 0; i < bytes.length; i += 16384)
    pieces.push(String.fromCharCode(...bytes.subarray(i, i + 16384)));
  return btoa(pieces.join(''));
}
class CommittedReport extends Error {
  constructor(readonly data: unknown) {
    super('report_already_committed');
  }
}
function makeResponse(request: ReportingRequest, data: unknown) {
  const value = responseSchema.parse({
    schemaVersion: API_SCHEMA,
    requestId: request.requestId,
    ok: true,
    data,
  });
  validateResponseForRequest(request, value);
  return value;
}

export async function executeReporting(
  input: unknown,
  actor: ActorContext,
  signal: AbortSignal,
  assertActive: () => void,
  options: ReportingOptions = {},
) {
  const request = parseRequest(input),
    runtime = capabilitiesSchema.parse((options.config ?? config)());
  if (
    !runtime.operations.includes(request.operation) ||
    (request.operation !== 'capability.read' && !runtime.runtimeEnabled)
  )
    throw new StudyFailure('CAPABILITY_UNAVAILABLE', 503, 'report.capability');
  if (request.operation === 'analysis.request') {
    if (!runtime.analysisProfiles.includes(request.profileId))
      throw new StudyFailure('CAPABILITY_UNAVAILABLE', 503, 'analysis.profile');
    if ((await analysisConfigHash(request.config)) !== request.configHash)
      throw new StudyFailure('REFERENCE_MISMATCH', 409, 'analysis.config_identity');
  }
  if (request.operation === 'capability.read' && !runtime.runtimeEnabled)
    return makeResponse(request, DISABLED_CAPABILITIES);
  if (
    request.operation === 'report.create' &&
    !runtime.reportTemplates.includes(request.templateId)
  )
    throw new StudyFailure('CAPABILITY_UNAVAILABLE', 503, 'report.template');
  const repository = (options.repository ?? ((a) => createReportingRepository(a.supabase)))(actor);
  assertActive();
  let data = unpack(await repository.dispatch(request, signal));
  assertActive();
  if (request.operation === 'capability.read') {
    const database = capabilitiesSchema.parse(data),
      operations = runtime.operations.filter((op) => database.operations.includes(op));
    return makeResponse(request, {
      ...runtime,
      runtimeEnabled: runtime.runtimeEnabled && operations.some((op) => op !== 'capability.read'),
      operations,
      analysisProfiles: runtime.analysisProfiles.filter((p) =>
        database.analysisProfiles.includes(p),
      ),
      reportTemplates: runtime.reportTemplates.filter((p) => database.reportTemplates.includes(p)),
    });
  }
  if (request.operation === 'artifact.read') {
    const intent = reportingReadIntentSchema.parse(data);
    if (intent.studyId !== request.studyId || !sameJson(intent.artifactRef, request.artifactRef))
      throw new StudyFailure('REFERENCE_MISMATCH', 502, 'report.artifact_intent');
    const resolve = async () => {
      assertActive();
      const cap = reportingCapabilitySchema.parse(
        unpack(await repository.resolveArtifact(intent.intentId, signal)),
      );
      if (cap.studyId !== request.studyId || !sameJson(cap.artifactRef, request.artifactRef))
        throw new StudyFailure('REFERENCE_MISMATCH', 502, 'report.artifact_selection');
      return cap;
    };
    const cap = await resolve(),
      bytes = await repository.download(cap, signal);
    assertActive();
    if (!sameJson(await resolve(), cap))
      throw new StudyFailure('REFERENCE_MISMATCH', 502, 'report.artifact_changed');
    assertActive();
    return makeResponse(request, {
      type: 'artifact',
      studyId: request.studyId,
      artifactRef: request.artifactRef,
      encoding: 'base64',
      bytes: base64(bytes),
    });
  }
  const intentResult = reportIntentSchema.safeParse(data);
  if (!intentResult.success) return makeResponse(request, data);
  const intent = intentResult.data;
  if (intent.operation !== request.operation)
    throw new StudyFailure('REFERENCE_MISMATCH', 502, 'report.intent_operation');
  const resolve = async (): Promise<ReportContext> => {
    assertActive();
    const current = unpack(await repository.resolveIntent(intent.intentId, signal));
    assertActive();
    const parsed = reportContextSchema.safeParse(current);
    if (!parsed.success) {
      const done = responseDataSchema.safeParse(current);
      if (done.success) throw new CommittedReport(done.data);
      throw new StudyFailure('REFERENCE_MISMATCH', 502, 'report.intent_context');
    }
    const ctx = parsed.data;
    if (
      ctx.intentId !== intent.intentId ||
      ctx.actorId !== actor.userId ||
      (ctx.clientId ?? null) !== (actor.clientId ?? null)
    )
      throw new StudyFailure('REFERENCE_MISMATCH', 502, 'report.intent_actor');
    assertReportContext(ctx, request);
    return ctx;
  };
  try {
    const context = await resolve();
    const recheck = async () => {
      const current = await resolve();
      if (!sameJson(current, context))
        throw new StudyFailure('REVISION_CONFLICT', 409, 'report.intent_changed');
    };
    const inputs = new Map<string, Uint8Array>(),
      refs = new Map<string, unknown>();
    const read = async (artifact: PrivateReportArtifact) => {
      const cap = reportingCapabilitySchema.parse({ kind: 'artifactCapability', ...artifact });
      if (cap.studyId !== context.studyId)
        throw new StudyFailure('REFERENCE_MISMATCH', 502, 'report.artifact_study');
      const previous = refs.get(cap.artifactRef.id);
      if (previous && !sameJson(previous, cap.artifactRef))
        throw new StudyFailure('REFERENCE_MISMATCH', 502, 'report.artifact_alias');
      if (inputs.has(cap.artifactRef.id)) return;
      await recheck();
      assertActive();
      const bytes = await repository.download(cap, signal);
      assertActive();
      if (
        bytes.length !== cap.artifactRef.byteSize ||
        (await sha256(bytes)) !== cap.artifactRef.contentHash
      )
        throw new StudyFailure('REFERENCE_MISMATCH', 502, 'report.artifact_integrity');
      await recheck();
      refs.set(cap.artifactRef.id, cap.artifactRef);
      inputs.set(cap.artifactRef.id, bytes);
    };
    for (const row of context.runs) await read(row.preparedArtifact);
    for (const row of context.analyses) await read(row.factsArtifact);
    const producer = await validateReportInputs(context, inputs);
    assertActive();
    let content: unknown;
    if (request.operation === 'report.create' || request.operation === 'report.save')
      content = request.content;
    else {
      if (!context.contentArtifact)
        throw new StudyFailure('REFERENCE_MISMATCH', 502, 'report.content_missing');
      await read(context.contentArtifact);
      const stored = parseCanonicalBytes(inputs.get(context.contentArtifact.artifactRef.id)!);
      if (!stored || typeof stored !== 'object' || !('content' in stored))
        throw new StudyFailure('REFERENCE_MISMATCH', 502, 'report.content_shape');
      content = stored.content;
      const rebuilt = makeReportContent(producer, content);
      if (!sameJson(stored, rebuilt))
        throw new StudyFailure('REFERENCE_MISMATCH', 502, 'report.content_binding');
    }
    const envelope = makeReportContent(producer, content),
      validated = await contentValidation(envelope);
    assertActive();
    const renderPreview = async (renderer: ReportingRenderer, exportId: string) => {
      let view;
      try {
        view = makeReportView(envelope, producer, renderer);
      } catch (error) {
        if (error instanceof Error && error.name === 'ReportViewError')
          throw new StudyFailure('CAPABILITY_UNAVAILABLE', 503, 'report.view_profile');
        throw error;
      }
      const projectionBytes = canonicalBytes(view),
        projectionHash = await sha256(projectionBytes);
      const htmlBytes = new TextEncoder().encode(
        await renderer.render(view, {
          exportId,
          projectionHash,
          verificationAtGeneration: 'verified_by_trusted_exporter',
        }),
      );
      assertActive();
      // Reserve 16 KiB for the detached envelope and base64 expansion before content freezes.
      const contentLimit = Math.floor(((MAX_ARTIFACT_BYTES - 16384) * 3) / 4);
      if (htmlBytes.length + projectionBytes.length > contentLimit)
        throw new StudyFailure('PAYLOAD_TOO_LARGE', 413, 'report.output_bounds');
      return { view, projectionBytes, projectionHash, htmlBytes };
    };
    const artifact = async (
      id: string | null,
      type: z.infer<typeof reportingArtifactRefSchema>['type'],
      schemaVersion: string,
      name: string,
      bytes: Uint8Array,
    ): Promise<PrivateReportArtifact> => {
      if (!id) throw new StudyFailure('REFERENCE_MISMATCH', 502, 'report.artifact_allocation');
      if (bytes.length > MAX_ARTIFACT_BYTES)
        throw new StudyFailure('PAYLOAD_TOO_LARGE', 413, 'report.artifact_size');
      return {
        studyId: context.studyId,
        artifactRef: {
          type,
          id,
          contentHash: await sha256(bytes),
          digestScope: 'artifact_bytes_sha256',
          byteSize: bytes.length,
          mediaType: 'application/json',
          schemaVersion,
        },
        storageBucket: 'study-artifacts',
        storageObjectPath: `study/${context.studyId}/${id}/${name}.json`,
      };
    };
    const upload = async (a: PrivateReportArtifact, bytes: Uint8Array) => {
      await recheck();
      assertActive();
      await repository.upload(a, bytes, signal);
      assertActive();
      await recheck();
    };
    let completion: unknown;
    if (request.operation === 'report.create' || request.operation === 'report.save') {
      const contentArtifact = await artifact(
        context.contentArtifactId,
        'reportContent',
        'lca.study-report-content.v1',
        'content',
        validated.bytes,
      );
      await upload(contentArtifact, validated.bytes);
      completion = {
        kind: 'validatedContent',
        contentArtifact,
        factsRefs: envelope.factsRefs,
        validation: validated.validation,
      };
    } else if (request.operation === 'report.freeze') {
      if (
        !context.report ||
        validated.contentHash !== context.report.contentHash ||
        validated.contentHash !== request.expectedContentHash
      )
        throw new StudyFailure('REFERENCE_MISMATCH', 409, 'report.freeze_identity');
      const renderer = options.renderer === undefined ? bundledReportingRenderer : options.renderer;
      if (!renderer || (!renderer.qualifiedSource && !options.allowDevelopmentRenderer))
        throw new StudyFailure('CAPABILITY_UNAVAILABLE', 503, 'report.renderer_qualification');
      await renderPreview(renderer, context.reportRevisionId);
      completion = {
        kind: 'validatedFreeze',
        contentRef: context.report.contentRef,
        validation: validated.validation,
      };
    } else if (request.operation === 'export.request') {
      const renderer = options.renderer === undefined ? bundledReportingRenderer : options.renderer,
        profile = context.exportProfile;
      if (
        !renderer ||
        !profile ||
        (!renderer.qualifiedSource && !options.allowDevelopmentRenderer) ||
        renderer.artifactHash !== profile.rendererArtifactHash ||
        !context.report ||
        validated.contentHash !== context.report.contentHash
      )
        throw new StudyFailure('CAPABILITY_UNAVAILABLE', 503, 'report.renderer_qualification');
      const { view, projectionBytes, projectionHash, htmlBytes } = await renderPreview(
        renderer,
        context.exportId!,
      );
      const manifest = exportManifestSchema.parse({
        schemaVersion: 'lca.study-export-manifest.v1',
        issuerId: profile.issuerId,
        exportId: context.exportId,
        studyId: context.studyId,
        reportRevisionId: context.reportRevisionId,
        reportContentHash: context.report.contentHash,
        actorId: context.actorId,
        clientId: context.clientId,
        grantEpoch: context.grantEpoch,
        policyId: profile.policyId,
        disclosureContextHash: context.disclosureContextHash,
        generatedAt: context.generatedAt,
        validitySnapshot: context.report.validitySnapshot,
        reviewIds: [],
        renderer: {
          version: profile.rendererVersion,
          viewModelVersion: profile.viewModelVersion,
          artifactHash: profile.rendererArtifactHash,
        },
        files: [
          {
            path: 'report.html',
            mediaType: 'text/html',
            sha256: await sha256(htmlBytes),
            byteSize: htmlBytes.length,
          },
          {
            path: 'projection.json',
            mediaType: 'application/json',
            sha256: projectionHash,
            byteSize: projectionBytes.length,
          },
        ],
      });
      validateExportViewBindings(view, manifest);
      const key = await (options.signer ?? configuredSigner)(profile);
      if (key.keyId !== profile.keyId || key.issuerId !== profile.issuerId)
        throw new StudyFailure('REFERENCE_MISMATCH', 502, 'report.signer_binding');
      const receipt = await signExportManifest(manifest, key.keyId, key.privateKey),
        resourcesBytes = canonicalBytes(manifest);
      const bundleBytes = canonicalBytes({
        schemaVersion: 'lca.study-export-bundle.v1',
        manifestBase64: base64(resourcesBytes),
        receipt,
        files: [
          { path: 'report.html', encoding: 'base64', bytes: base64(htmlBytes) },
          { path: 'projection.json', encoding: 'base64', bytes: base64(projectionBytes) },
        ],
      });
      // Whole serialized nested bundle must be readable through the existing 4 MiB transport.
      const projectionArtifact = await artifact(
          context.projectionArtifactId,
          'reportProjection',
          'lca.study-report-view.v1',
          'projection',
          projectionBytes,
        ),
        resourcesArtifact = await artifact(
          context.resourcesArtifactId,
          'renderResources',
          'lca.study-export-manifest.v1',
          'resources',
          resourcesBytes,
        ),
        bundleArtifact = await artifact(
          context.bundleArtifactId,
          'reportExportBundle',
          'lca.study-export-bundle.v1',
          'bundle',
          bundleBytes,
        );
      await upload(projectionArtifact, projectionBytes);
      await upload(resourcesArtifact, resourcesBytes);
      await upload(bundleArtifact, bundleBytes);
      completion = {
        kind: 'validatedExport',
        projectionArtifact,
        resourcesArtifact,
        bundleArtifact,
        manifest,
        receipt,
      };
    } else throw new StudyFailure('REFERENCE_MISMATCH', 502, 'report.intent_kind');
    await recheck();
    assertActive();
    data = unpack(await repository.consumeIntent(context.intentId, completion, signal));
    assertActive();
    return makeResponse(request, data);
  } catch (error) {
    if (error instanceof CommittedReport) return makeResponse(request, error.data);
    if (error instanceof Error && error.message === 'report_canonical_bounds')
      throw new StudyFailure('PAYLOAD_TOO_LARGE', 413, 'report.output_bounds');
    throw error;
  }
}
