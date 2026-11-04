import { z } from 'zod';
import {
  API_SCHEMA,
  HISTORICAL_REVIEW_OPERATIONS,
  capabilitiesSchema,
  DISABLED_CAPABILITIES,
  type ReviewRequest,
} from '../../../../contracts/lca-study/v6/review.ts';
import {
  parseRequest,
  validateResponseForRequest,
} from '../../../../contracts/lca-study/v6/review_codec.ts';
import {
  responseSchema,
  responseDataSchema,
} from '../../../../contracts/lca-study/v6/responses.ts';
import { reportViewSchema } from '../../../../contracts/lca-study/v6/view.ts';
import {
  canonicalBytes,
  parseCanonicalBytes,
  sha256,
} from '../../../../contracts/lca-study/v3/canonical.ts';
import {
  exportManifestSchema,
  signExportManifest,
  validateExportViewBindings,
  parseExportBundle,
} from '../../../../contracts/lca-study/v6/export.ts';
import type { ActorContext } from '../command_runtime/actor_context.ts';
import { StudyFailure } from './protocol.ts';
import { unpack, MAX_ARTIFACT_BYTES } from './repository.ts';
import {
  methodCapabilitySchema as reportingCapabilitySchema,
  type MethodPrivateArtifact as PrivateReportArtifact,
} from './method_context.ts';
import {
  validateMethodReportInputs,
  makeMethodContent,
  methodContentValidation,
} from './method_producer.ts';
import { makeMethodView } from './method_view.ts';
import { configuredMethodSigner } from './method_signer.ts';
import { sameJson } from './reporting_producer.ts';
import { bundledMethodRenderer, type MethodRenderer } from './method_renderer.ts';
import {
  reviewContextSchema,
  reviewIntentSchema,
  type MethodReviewContext as ReviewContext,
} from './method_context.ts';
import {
  createMethodRepository,
  type MethodRepository as MethodReviewRepository,
} from './method_repository.ts';
type Config = z.infer<typeof capabilitiesSchema>;
export type MethodReviewOptions = {
  config?: () => Config;
  repository?: (actor: ActorContext) => MethodReviewRepository;
  renderer?: MethodRenderer | null;
  signer?: typeof configuredMethodSigner;
  allowDevelopmentRenderer?: boolean;
};
function config(): Config {
  const value = Deno.env.get('STUDY_METHOD_REVIEW_CONFIG');
  return value ? capabilitiesSchema.parse(JSON.parse(value)) : DISABLED_CAPABILITIES;
}
function base64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 16384)
    parts.push(String.fromCharCode(...bytes.subarray(i, i + 16384)));
  return btoa(parts.join(''));
}
const semantic = (v: ReviewRequest) => {
  const { requestId: _transport, ...identity } = v;
  return identity;
};
class CommittedReview extends Error {
  constructor(readonly data: unknown) {
    super('review_already_committed');
  }
}
function result(request: ReviewRequest, data: unknown) {
  const value = responseSchema.parse({
    schemaVersion: API_SCHEMA,
    requestId: request.requestId,
    ok: true,
    data,
  });
  validateResponseForRequest(request, value);
  return value;
}
function assertContext(c: ReviewContext, r: ReviewRequest, actor: ActorContext) {
  if (
    c.actorId !== actor.userId ||
    c.clientId !== (actor.clientId ?? null) ||
    c.operation !== r.operation ||
    !sameJson(semantic(c.request), semantic(r))
  )
    throw new StudyFailure('REFERENCE_MISMATCH', 502, 'review.intent_identity');
  const s = c.currentState;
  if (
    'reportRevisionId' in r &&
    'expectedContentHash' in r &&
    (s.reportRevisionId !== r.reportRevisionId || s.reportContentHash !== r.expectedContentHash)
  )
    throw new StudyFailure('REFERENCE_MISMATCH', 502, 'review.report_binding');
  if (
    r.operation === 'export.request' &&
    (!s.finalization ||
      s.acceptance !== 'current' ||
      s.finalization.finalizationId !== r.finalizationId ||
      s.reviewStateHash !== r.expectedReviewStateHash)
  )
    throw new StudyFailure('REVISION_CONFLICT', 409, 'review.finalization_state');
  if (r.operation === 'report.view' || r.operation === 'export.request') {
    const p = c.producerContext;
    if (
      !p ||
      p.intentId !== c.intentId ||
      p.expiresAt !== c.expiresAt ||
      p.operation !== r.operation ||
      !sameJson(semantic(p.request as ReviewRequest), semantic(r)) ||
      !p.report ||
      p.report.status !== 'frozen' ||
      p.studyId !== s.studyId ||
      p.reportRevisionId !== s.reportRevisionId ||
      p.report.contentHash !== s.reportContentHash ||
      p.report.revision !== s.reportRevision ||
      c.share ||
      c.artifact ||
      c.export
    )
      throw new StudyFailure('REFERENCE_MISMATCH', 502, 'review.producer_context');
  } else if (r.operation === 'export.download') {
    const ex = c.export,
      a = c.artifact;
    if (
      !ex ||
      !a ||
      c.producerContext ||
      c.share ||
      ex.exportId !== r.exportId ||
      ex.studyId !== s.studyId ||
      ex.reportRevisionId !== s.reportRevisionId ||
      ex.reportContentHash !== s.reportContentHash ||
      a.studyId !== ex.studyId ||
      !sameJson(a.artifactRef, ex.bundleRef)
    )
      throw new StudyFailure('REFERENCE_MISMATCH', 502, 'review.export_download_context');
  } else if (r.operation === 'share.view' || r.operation === 'share.download') {
    const share = c.share,
      ex = c.export,
      a = c.artifact;
    if (
      !share ||
      !ex ||
      !a ||
      c.producerContext ||
      share.shareId !== r.shareId ||
      share.recipientId !== actor.userId ||
      share.status !== 'active' ||
      share.reportRevisionId !== s.reportRevisionId ||
      share.reportContentHash !== s.reportContentHash ||
      share.studyId !== s.studyId ||
      ex.exportId !== share.exportId ||
      ex.reportRevisionId !== share.reportRevisionId ||
      ex.reportContentHash !== share.reportContentHash ||
      ex.finalization.finalizationId !== share.finalizationId ||
      !sameJson(ex.projectionRef, share.projectionRef) ||
      !sameJson(ex.bundleRef, share.bundleRef) ||
      a.studyId !== share.studyId ||
      !sameJson(a.artifactRef, r.operation === 'share.view' ? share.projectionRef : share.bundleRef)
    )
      throw new StudyFailure('REFERENCE_MISMATCH', 502, 'review.share_context');
  } else throw new StudyFailure('REFERENCE_MISMATCH', 502, 'review.intent_operation');
}
export async function executeMethodReview(
  input: unknown,
  actor: ActorContext,
  signal: AbortSignal,
  assertActive: () => void,
  options: MethodReviewOptions = {},
) {
  const request = parseRequest(input),
    runtime = capabilitiesSchema.parse((options.config ?? config)());
  if (
    !runtime.operations.includes(request.operation) ||
    (!runtime.runtimeEnabled && !HISTORICAL_REVIEW_OPERATIONS.includes(request.operation as never))
  )
    throw new StudyFailure('CAPABILITY_UNAVAILABLE', 503, 'review.capability');
  if (
    request.operation === 'report.finalize' &&
    !runtime.finalizationProfiles.includes(request.profileId)
  )
    throw new StudyFailure('CAPABILITY_UNAVAILABLE', 503, 'review.profile');
  if (
    (request.operation === 'review.record' || request.operation === 'review.delegation.issue') &&
    !runtime.reviewClasses.includes(request.reviewClass)
  )
    throw new StudyFailure('CAPABILITY_UNAVAILABLE', 503, 'review.class');
  if (
    request.operation === 'share.create' &&
    !runtime.disclosurePolicies.includes(request.disclosurePolicyId)
  )
    throw new StudyFailure('CAPABILITY_UNAVAILABLE', 503, 'review.disclosure_policy');
  if (request.operation === 'capability.read' && !runtime.runtimeEnabled)
    return result(request, DISABLED_CAPABILITIES);
  const repo = (options.repository ?? ((a) => createMethodRepository(a.supabase)))(actor);
  assertActive();
  let data = unpack(await repo.dispatch(request, signal, 'review'));
  assertActive();
  if (request.operation === 'capability.read') {
    const db = capabilitiesSchema.parse(data),
      operations = runtime.operations.filter((op) => db.operations.includes(op));
    return result(request, {
      ...runtime,
      runtimeEnabled:
        runtime.runtimeEnabled &&
        db.runtimeEnabled &&
        operations.some((op) => op !== 'capability.read'),
      operations,
      finalizationProfiles: runtime.finalizationProfiles.filter((p) =>
        db.finalizationProfiles.includes(p),
      ),
      reviewClasses: runtime.reviewClasses.filter((p) => db.reviewClasses.includes(p)),
      disclosurePolicies: runtime.disclosurePolicies.filter((p) =>
        db.disclosurePolicies.includes(p),
      ),
    });
  }
  if (request.operation === 'resource.actions') {
    const actions = responseDataSchema.parse(data);
    if (actions.type !== 'actions')
      throw new StudyFailure('REFERENCE_MISMATCH', 502, 'review.actions');
    return result(request, {
      ...actions,
      actions: actions.actions.filter((a) => runtime.operations.includes(a as never)),
      allowedMemberRoles: [],
    });
  }
  const parsed = reviewIntentSchema.safeParse(data);
  if (!parsed.success) return result(request, data);
  const intent = parsed.data;
  if (intent.operation !== request.operation)
    throw new StudyFailure('REFERENCE_MISMATCH', 502, 'review.intent_operation');
  const resolve = async (): Promise<ReviewContext> => {
    assertActive();
    const raw = unpack(await repo.resolveIntent('review', intent.intentId, signal));
    assertActive();
    const c = reviewContextSchema.safeParse(raw);
    if (!c.success) {
      const done = responseDataSchema.safeParse(raw);
      if (done.success) throw new CommittedReview(done.data);
      throw new StudyFailure('REFERENCE_MISMATCH', 502, 'review.intent_context');
    }
    if (c.data.intentId !== intent.intentId || c.data.expiresAt !== intent.expiresAt)
      throw new StudyFailure('REFERENCE_MISMATCH', 502, 'review.intent_binding');
    assertContext(c.data, request, actor);
    return c.data;
  };
  try {
    const context = await resolve(),
      recheck = async () => {
        const current = await resolve();
        if (!sameJson(current, context))
          throw new StudyFailure('REVISION_CONFLICT', 409, 'review.intent_changed');
      };
    const read = async (artifact: PrivateReportArtifact) => {
      const cap = reportingCapabilitySchema.parse({ kind: 'artifactCapability', ...artifact });
      if (cap.studyId !== context.currentState.studyId)
        throw new StudyFailure('REFERENCE_MISMATCH', 502, 'review.artifact_study');
      await recheck();
      assertActive();
      const bytes = await repo.download(cap, signal);
      assertActive();
      if (
        bytes.length !== cap.artifactRef.byteSize ||
        (await sha256(bytes)) !== cap.artifactRef.contentHash
      )
        throw new StudyFailure('REFERENCE_MISMATCH', 502, 'review.artifact_integrity');
      await recheck();
      return bytes;
    };
    if (
      request.operation === 'share.view' ||
      request.operation === 'share.download' ||
      request.operation === 'export.download'
    ) {
      const bytes = await read(context.artifact!),
        ex = context.export!,
        share = context.share!;
      if (request.operation === 'share.view') {
        const view = reportViewSchema.parse(parseCanonicalBytes(bytes));
        // Stored view is a historical export snapshot; live state is deliberately separate.
        if (
          view.report.studyId !== share.studyId ||
          view.report.reportRevisionId !== share.reportRevisionId ||
          view.report.contentHash !== share.reportContentHash ||
          view.report.generatedAt !== ex.generatedAt ||
          view.snapshot.finalization !== 'finalized' ||
          view.snapshot.review !==
            (ex.finalization.acceptedReviewIds.length ? 'reviewed' : 'unreviewed') ||
          !sameJson(view.snapshot.reviewIds, ex.finalization.acceptedReviewIds)
        )
          throw new StudyFailure('REFERENCE_MISMATCH', 502, 'review.shared_view');
        const renderer = options.renderer === undefined ? bundledMethodRenderer : options.renderer;
        if (!renderer) throw new StudyFailure('CAPABILITY_UNAVAILABLE', 503, 'review.renderer');
        renderer.validate(view);
        await recheck();
        return result(request, { type: 'view', view, state: context.currentState, share });
      }
      const bundle = parseExportBundle(bytes),
        manifest = exportManifestSchema.parse(parseCanonicalBytes(bundle.manifestBytes));
      if (
        manifest.exportId !== ex.exportId ||
        manifest.reportRevisionId !== ex.reportRevisionId ||
        manifest.reportContentHash !== ex.reportContentHash ||
        manifest.studyId !== ex.studyId ||
        !sameJson(manifest.finalization, ex.finalization) ||
        !sameJson(bundle.receipt, ex.receipt)
      )
        throw new StudyFailure('REFERENCE_MISMATCH', 502, 'review.shared_download');
      await recheck();
      return request.operation === 'export.download'
        ? result(request, {
            type: 'exportDownload',
            export: ex,
            encoding: 'base64',
            bytes: base64(bytes),
          })
        : result(request, { type: 'download', share, encoding: 'base64', bytes: base64(bytes) });
    }
    const p = context.producerContext!,
      inputs = new Map<string, Uint8Array>();
    for (const row of [
      ...p.runs.map((r) => r.preparedArtifact),
      ...p.runs.map((r) => r.resultArtifact),
      ...p.methodAssessments.map((a) => a.factsArtifact),
      p.contentArtifact!,
    ]) {
      const existing = inputs.get(row.artifactRef.id);
      if (existing) {
        if (
          existing.length !== row.artifactRef.byteSize ||
          (await sha256(existing)) !== row.artifactRef.contentHash
        )
          throw new StudyFailure('REFERENCE_MISMATCH', 502, 'review.artifact_alias');
        continue;
      }
      inputs.set(row.artifactRef.id, await read(row));
    }
    const producer = await validateMethodReportInputs(p, inputs),
      stored = parseCanonicalBytes(inputs.get(p.contentArtifact!.artifactRef.id)!);
    if (!stored || typeof stored !== 'object' || !('content' in stored))
      throw new StudyFailure('REFERENCE_MISMATCH', 502, 'review.content_shape');
    const envelope = makeMethodContent(producer, stored.content),
      validated = await methodContentValidation(producer, envelope);
    if (
      !sameJson(stored, envelope) ||
      validated.contentHash !== context.currentState.reportContentHash
    )
      throw new StudyFailure('REFERENCE_MISMATCH', 502, 'review.content_binding');
    const renderer = options.renderer === undefined ? bundledMethodRenderer : options.renderer;
    if (!renderer || (!renderer.qualifiedSource && !options.allowDevelopmentRenderer))
      throw new StudyFailure('CAPABILITY_UNAVAILABLE', 503, 'review.renderer_qualification');
    const state = context.currentState,
      final = state.finalization,
      snapshotReviewIds = final ? final.acceptedReviewIds : state.acceptedReviewIds;
    const view = renderer.validate(
      parseCanonicalBytes(
        canonicalBytes({
          ...(await makeMethodView(envelope, producer, renderer)),
          snapshot: {
            validity: state.validity.status,
            checkedAt: state.validity.checkedAt,
            review: snapshotReviewIds.length ? 'reviewed' : 'unreviewed',
            reviewIds: snapshotReviewIds,
            finalization: final ? 'finalized' : 'not_finalized',
          },
        }),
      ),
    );
    reportViewSchema.parse(view);
    await recheck();
    if (request.operation === 'report.view')
      return result(request, { type: 'view', view, state, share: null });
    if (request.operation !== 'export.request' || !final)
      throw new StudyFailure('REFERENCE_MISMATCH', 502, 'review.export_context');
    const profile = p.exportProfile;
    if (
      !profile ||
      renderer.artifactHash !== profile.rendererArtifactHash ||
      final.acceptedReviewIds.some((id) => !state.acceptedReviewIds.includes(id))
    )
      throw new StudyFailure('CAPABILITY_UNAVAILABLE', 503, 'review.export_profile');
    const projectionBytes = canonicalBytes(view),
      projectionHash = await sha256(projectionBytes),
      htmlBytes = new TextEncoder().encode(
        await renderer.render(parseCanonicalBytes(projectionBytes), {
          exportId: p.exportId!,
          projectionHash,
          verificationAtGeneration: 'verified_by_trusted_exporter',
        }),
      );
    assertActive();
    if (
      projectionBytes.length + htmlBytes.length >
      Math.floor(((MAX_ARTIFACT_BYTES - 16384) * 3) / 4)
    )
      throw new StudyFailure('PAYLOAD_TOO_LARGE', 413, 'review.output_bounds');
    const manifest = exportManifestSchema.parse({
      schemaVersion: 'lca.study-export-manifest.v4',
      issuerId: profile.issuerId,
      exportId: p.exportId,
      studyId: p.studyId,
      reportRevisionId: p.reportRevisionId,
      reportContentHash: state.reportContentHash,
      actorId: context.actorId,
      clientId: context.clientId,
      grantEpoch: p.grantEpoch,
      policyId: profile.policyId,
      disclosureContextHash: p.disclosureContextHash,
      generatedAt: p.generatedAt,
      validitySnapshot: state.validity,
      reviewIds: final.acceptedReviewIds,
      finalization: final,
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
    const key = await (options.signer ?? configuredMethodSigner)(profile);
    if (key.keyId !== profile.keyId || key.issuerId !== profile.issuerId)
      throw new StudyFailure('REFERENCE_MISMATCH', 502, 'review.signer_binding');
    const receipt = await signExportManifest(manifest, key.keyId, key.privateKey),
      resourcesBytes = canonicalBytes(manifest),
      bundleBytes = canonicalBytes({
        schemaVersion: 'lca.study-export-bundle.v4',
        manifestBase64: base64(resourcesBytes),
        receipt,
        files: [
          { path: 'report.html', encoding: 'base64', bytes: base64(htmlBytes) },
          { path: 'projection.json', encoding: 'base64', bytes: base64(projectionBytes) },
        ],
      });
    const artifact = async (
      id: string | null,
      type: 'reportProjection' | 'renderResources' | 'reportExportBundle',
      schemaVersion: string,
      name: string,
      bytes: Uint8Array,
    ): Promise<PrivateReportArtifact> => {
      if (!id) throw new StudyFailure('REFERENCE_MISMATCH', 502, 'review.artifact_allocation');
      if (bytes.length > MAX_ARTIFACT_BYTES)
        throw new StudyFailure('PAYLOAD_TOO_LARGE', 413, 'review.output_bounds');
      return reportingCapabilitySchema.omit({ kind: true }).parse({
        studyId: p.studyId,
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
        storageObjectPath: `study/${p.studyId}/${id}/${name}.json`,
      });
    };
    const projectionArtifact = await artifact(
        p.projectionArtifactId,
        'reportProjection',
        'lca.study-report-view.v3',
        'projection',
        projectionBytes,
      ),
      resourcesArtifact = await artifact(
        p.resourcesArtifactId,
        'renderResources',
        'lca.study-export-manifest.v4',
        'resources',
        resourcesBytes,
      ),
      bundleArtifact = await artifact(
        p.bundleArtifactId,
        'reportExportBundle',
        'lca.study-export-bundle.v4',
        'bundle',
        bundleBytes,
      );
    for (const [a, bytes] of [
      [projectionArtifact, projectionBytes],
      [resourcesArtifact, resourcesBytes],
      [bundleArtifact, bundleBytes],
    ] as const) {
      await recheck();
      assertActive();
      await repo.upload(a, bytes, signal);
      assertActive();
      await recheck();
    }
    data = unpack(
      await repo.consumeIntent(
        'review',
        context.intentId,
        {
          kind: 'validatedReviewExport',
          projectionArtifact,
          resourcesArtifact,
          bundleArtifact,
          manifest,
          receipt,
        },
        signal,
      ),
    );
    assertActive();
    return result(request, data);
  } catch (error) {
    if (error instanceof CommittedReview) return result(request, error.data);
    if (error instanceof Error && error.message === 'report_canonical_bounds')
      throw new StudyFailure('PAYLOAD_TOO_LARGE', 413, 'review.output_bounds');
    throw error;
  }
}
