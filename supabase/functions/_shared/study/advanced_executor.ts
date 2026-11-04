import { sameJson } from './reporting_producer.ts';
import { bundledAdvancedRenderer, type AdvancedRenderer } from './advanced_renderer.ts';
import {
  parameterIntentSchema,
  parameterContextSchema,
  makeParameterCatalog,
} from './advanced_catalog.ts';
import { z } from 'zod';
import {
  API_SCHEMA,
  capabilitiesSchema,
  DISABLED_CAPABILITIES,
  reportingArtifactRefSchema,
  type AdvancedRequest,
} from '../../../../contracts/lca-study/v5/advanced.ts';
import {
  analysisConfigHash,
  parseRequest,
  validateResponseForRequest,
} from '../../../../contracts/lca-study/v5/authoring_codec.ts';
import {
  responseSchema,
  responseDataSchema,
} from '../../../../contracts/lca-study/v5/authoring_responses.ts';
import {
  canonicalBytes,
  parseCanonicalBytes,
  sha256,
} from '../../../../contracts/lca-study/v3/canonical.ts';

import type { ActorContext } from '../command_runtime/actor_context.ts';
import { StudyFailure } from './protocol.ts';
import { unpack, MAX_ARTIFACT_BYTES } from './repository.ts';
import {
  createAdvancedRepository,
  reportingCapabilitySchema,
  reportingReadIntentSchema,
  type PrivateReportArtifact,
  type AdvancedRepository,
} from './advanced_repository.ts';
import { reportContextSchema, reportIntentSchema, type ReportContext } from './advanced_context.ts';
import {
  assertAdvancedContext,
  advancedContentValidation,
  makeAdvancedContent,
  validateAdvancedInputs,
} from './advanced_producer.ts';
import { makeAdvancedView } from './advanced_view.ts';

type RuntimeConfig = z.infer<typeof capabilitiesSchema>;
export type AdvancedOptions = {
  config?: () => RuntimeConfig;
  repository?: (actor: ActorContext) => AdvancedRepository;
  renderer?: AdvancedRenderer | null;
  /** Internal owned qualification injection only; no request/env field enables a candidate renderer. */
  allowDevelopmentRenderer?: boolean;
};

function config(): RuntimeConfig {
  const text = Deno.env.get('STUDY_ADVANCED_CONFIG');
  return text ? capabilitiesSchema.parse(JSON.parse(text)) : DISABLED_CAPABILITIES;
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
function makeResponse(request: AdvancedRequest, data: unknown) {
  const value = responseSchema.parse({
    schemaVersion: API_SCHEMA,
    requestId: request.requestId,
    ok: true,
    data,
  });
  validateResponseForRequest(request, value);
  return value;
}

export async function executeAdvancedAuthoring(
  input: unknown,
  actor: ActorContext,
  signal: AbortSignal,
  assertActive: () => void,
  options: AdvancedOptions = {},
) {
  const request = parseRequest(input),
    runtime = capabilitiesSchema.parse((options.config ?? config)());
  if (
    !runtime.operations.includes(request.operation) ||
    (['analysis.request', 'report.create', 'report.save', 'report.freeze'].includes(
      request.operation,
    ) &&
      !runtime.runtimeEnabled)
  )
    throw new StudyFailure('CAPABILITY_UNAVAILABLE', 503, 'report.capability');
  if (request.operation === 'analysis.request') {
    if (!runtime.analysisProfiles.includes(request.profileId))
      throw new StudyFailure('CAPABILITY_UNAVAILABLE', 503, 'analysis.profile');
    if ((await analysisConfigHash(request.config)) !== request.configHash)
      throw new StudyFailure('REFERENCE_MISMATCH', 409, 'analysis.config_identity');
  }
  if (
    request.operation === 'capability.read' &&
    !runtime.runtimeEnabled &&
    runtime.operations.length === 1
  )
    return makeResponse(request, DISABLED_CAPABILITIES);
  if (
    request.operation === 'report.create' &&
    !runtime.reportTemplates.includes(request.templateId)
  )
    throw new StudyFailure('CAPABILITY_UNAVAILABLE', 503, 'report.template');
  const repository = (options.repository ?? ((a) => createAdvancedRepository(a.supabase)))(actor);
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
  if (request.operation === 'analysis.parameters.read') {
    const intent = parameterIntentSchema.parse(data);
    if (intent.studyId !== request.studyId || intent.baselineRunId !== request.baselineRunId)
      throw new StudyFailure('REFERENCE_MISMATCH', 502, 'advanced.parameter_selection');
    const resolve = async () => {
      assertActive();
      const c = parameterContextSchema.parse(
        unpack(await repository.resolveParameters(intent.intentId, signal)),
      );
      assertActive();
      if (
        c.intentId !== intent.intentId ||
        c.actorId !== actor.userId ||
        (c.clientId ?? null) !== (actor.clientId ?? null) ||
        c.studyId !== request.studyId ||
        c.baselineRunId !== request.baselineRunId
      )
        throw new StudyFailure('REFERENCE_MISMATCH', 502, 'advanced.parameter_intent');
      return c;
    };
    const c = await resolve(),
      cap = reportingCapabilitySchema.parse({
        kind: 'artifactCapability',
        ...c.baseline.preparedArtifact,
      }),
      bytes = await repository.download(cap, signal);
    assertActive();
    if (
      bytes.length !== cap.artifactRef.byteSize ||
      (await sha256(bytes)) !== cap.artifactRef.contentHash ||
      !sameJson(c, await resolve())
    )
      throw new StudyFailure('REFERENCE_MISMATCH', 502, 'advanced.parameter_changed');
    return makeResponse(request, makeParameterCatalog(c, bytes));
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
    if (
      bytes.length !== cap.artifactRef.byteSize ||
      (await sha256(bytes)) !== cap.artifactRef.contentHash ||
      !sameJson(await resolve(), cap)
    )
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
    assertAdvancedContext(ctx, request);
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
    const producer = await validateAdvancedInputs(context, inputs);
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
      const rebuilt = makeAdvancedContent(producer, content);
      if (!sameJson(stored, rebuilt))
        throw new StudyFailure('REFERENCE_MISMATCH', 502, 'report.content_binding');
    }
    const envelope = makeAdvancedContent(producer, content),
      validated = await advancedContentValidation(envelope);
    assertActive();
    const renderPreview = async (renderer: AdvancedRenderer, exportId: string) => {
      let view;
      try {
        view = makeAdvancedView(envelope, producer, renderer);
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
        'lca.study-report-content.v2',
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
      const renderer = options.renderer === undefined ? bundledAdvancedRenderer : options.renderer;
      if (!renderer || (!renderer.qualifiedSource && !options.allowDevelopmentRenderer))
        throw new StudyFailure('CAPABILITY_UNAVAILABLE', 503, 'report.renderer_qualification');
      await renderPreview(renderer, context.reportRevisionId);
      completion = {
        kind: 'validatedFreeze',
        contentRef: context.report.contentRef,
        validation: validated.validation,
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
