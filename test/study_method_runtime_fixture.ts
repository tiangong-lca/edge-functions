import { methodFixture } from './study_method_fixture.ts';
import { createStudyHandler } from '../supabase/functions/_shared/study/handler.ts';
import { bundledMethodRenderer } from '../supabase/functions/_shared/study/method_renderer.ts';
import {
  AUTHORING_OPERATIONS,
  capabilitiesSchema as authoringCaps,
} from '../contracts/lca-study/v6/authoring.ts';
import {
  OPERATIONS as reviewOps,
  capabilitiesSchema as reviewCaps,
} from '../contracts/lca-study/v6/review.ts';
import { canonicalBytes, canonicalJson, sha256 } from '../contracts/lca-study/v3/canonical.ts';
import type { ActorContext } from '../supabase/functions/_shared/command_runtime/actor_context.ts';
import type { MethodRepository } from '../supabase/functions/_shared/study/method_repository.ts';
import type { MethodOptions } from '../supabase/functions/_shared/study/method_dispatch.ts';
import publicDtos from './fixtures/lca-study-v6/database-public-dtos.json' with { type: 'json' };
import service from './fixtures/lca-study-v6/database-report-contexts.json' with { type: 'json' };
type Row = Record<string, any>;
export const methodId = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** In-memory adapter/byte tests. No SQL, actual actor, native job or scientific qualification. */
export async function methodRuntimeFixture() {
  const f = await methodFixture(),
    base = f.context,
    storage = f.bytes;
  const actor = { userId: base.actorId, clientId: null, supabase: {} } as unknown as ActorContext;
  const a = authoringCaps.parse({
    ...structuredClone(publicDtos.responses.authoringCapability),
    operations: AUTHORING_OPERATIONS,
  });
  const b = reviewCaps.parse({
    ...structuredClone(publicDtos.responses.reviewCapability),
    operations: reviewOps,
  });
  const flags = {
    revoked: false,
    revokeAfterRead: false,
    revokeAfterUpload: false,
    failUpload: false,
    loseConsume: false,
    wrongActor: false,
    wrongClient: false,
    changeAfterRead: false,
    reads: 0,
    uploads: 0,
    consumes: 0,
    resolves: 0,
    dispatches: 0,
    contexts: [] as Row[],
    mutateContext: null as null | ((c: Row) => void),
  };
  const pending = new Map<string, Row>(),
    done = new Map<string, unknown>(),
    identities = new Map<string, string>();
  let report: Row | null = null,
    contentArtifact: Row | null = null,
    exported: Row | null = null,
    shared: Row | null = null;
  let next = 600,
    active: Row | undefined,
    final: Row | null = null;
  const keys = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const profile = {
    issuerId: 'method-runtime-fixture',
    keyId: 'fixture-key',
    rendererVersion: '3.0.0',
    viewModelVersion: 'lca.study-report-view.v3',
    rendererArtifactHash: bundledMethodRenderer.artifactHash,
    policyId: 'lca.study-report-disclosure.v1',
  };
  const okay = (data: unknown) => ({ ok: true, data }),
    deny = () => ({ ok: false, code: 'FORBIDDEN' });
  const state = () => ({
    studyId: base.studyId,
    reportRevisionId: base.reportRevisionId,
    reportContentHash: report!.contentHash,
    reportRevision: report!.revision,
    authorId: actor.userId,
    reviewStateHash: 'b'.repeat(64),
    currentReviewIds: [],
    acceptedReviewIds: [],
    finalization: final,
    acceptance: final ? 'current' : 'not_finalized',
    validity: report!.validitySnapshot,
    checkedAt: base.generatedAt,
  });
  const makeProducer = (q: Row) => ({
    ...structuredClone(base),
    operation: q.operation,
    request: q,
    report: structuredClone(report),
    contentArtifact: structuredClone(contentArtifact),
    contentArtifactId:
      q.operation === 'report.create' || q.operation === 'report.save' ? methodId(next++) : null,
    exportId: q.operation === 'export.request' ? methodId(next++) : null,
    projectionArtifactId: q.operation === 'export.request' ? methodId(next++) : null,
    resourcesArtifactId: q.operation === 'export.request' ? methodId(next++) : null,
    bundleArtifactId: q.operation === 'export.request' ? methodId(next++) : null,
    exportProfile: q.operation === 'export.request' ? profile : null,
    disclosureContextHash: q.operation === 'export.request' ? 'e'.repeat(64) : null,
  });
  const repository: MethodRepository = {
    async dispatch(request, _signal, channel) {
      flags.dispatches++;
      if (flags.revoked) return deny();
      const q = request as Row;
      if (q.operation === 'capability.read') return okay(channel === 'authoring' ? a : b);
      if (q.operation === 'resource.actions')
        return okay({
          type: 'actions',
          resource: q.resource,
          actions:
            q.resource.type === 'methodAssessment'
              ? ['task.read', 'task.cancel', 'method.assessment.read', 'artifact.read']
              : ['report.view', 'export.request'],
          corePermissions: {
            read: q.resource.type === 'methodAssessment',
            write: q.resource.type === 'methodAssessment',
          },
          allowedMemberRoles: [],
        });
      if (q.operation === 'method.assessment.request' || q.operation === 'method.assessment.read')
        return okay({ type: 'methodAssessment', value: base.methodAssessments[0].assessment });
      if (q.operation === 'report.read') return okay({ type: 'reportRevision', value: report });
      if (q.operation === 'report.current') return okay({ type: 'reportState', value: state() });
      if (q.operation === 'export.read') return okay({ type: 'export', value: exported });
      if (q.operation === 'share.create') {
        shared = {
          ...structuredClone(service.shareContext.data.share),
          shareId: methodId(next++),
          studyId: base.studyId,
          reportRevisionId: base.reportRevisionId,
          reportContentHash: report!.contentHash,
          exportId: exported!.exportId,
          finalizationId: final!.finalizationId,
          issuerId: actor.userId,
          recipientId: q.recipientId,
          projectionRef: exported!.projectionRef,
          bundleRef: exported!.bundleRef,
          createdAt: base.generatedAt,
          expiresAt: q.expiresAt,
          revokedAt: null,
          status: 'active',
        };
        return okay({ type: 'share', value: shared });
      }
      if (q.operation === 'share.read') return okay({ type: 'share', value: shared });
      if (q.operation === 'share.revoke') {
        shared = { ...shared, status: 'revoked', revokedAt: base.generatedAt };
        return okay({ type: 'share', value: shared });
      }
      if (q.operation === 'report.finalize') {
        final = {
          studyId: base.studyId,
          reportRevisionId: base.reportRevisionId,
          reportContentHash: report!.contentHash,
          finalizationId: methodId(next++),
          actorId: actor.userId,
          profileId: q.profileId,
          expectedReviewStateHash: q.expectedReviewStateHash,
          acceptedReviewIds: q.acceptedReviewIds,
          finalizedAt: base.generatedAt,
        };
        return okay({ type: 'finalization', value: final, state: state() });
      }
      const key = q.idempotencyKey ?? q.requestId,
        { requestId: _transport, ...identity } = q,
        encoded = canonicalJson(identity);
      if (identities.has(key) && identities.get(key) !== encoded)
        return { ok: false, code: 'REVISION_CONFLICT' };
      identities.set(key, encoded);
      if (done.has(key)) return okay(done.get(key));
      let c = pending.get(key);
      if (!c) {
        const intentId = methodId(next++);
        if (q.operation === 'method.evidence.create')
          c = {
            kind: 'methodEvidenceCommandContext',
            intentId,
            expiresAt: base.expiresAt,
            request: q,
            studyId: base.studyId,
            actorId: actor.userId,
            clientId: null,
            evidenceId: methodId(next++),
            artifactId: methodId(next++),
            recordedAt: base.generatedAt,
            byteSize: canonicalBytes(q.content).length,
            contentHash: await sha256(canonicalBytes(q.content)),
          };
        else if (q.operation === 'artifact.read')
          c = {
            kind: 'artifactCapability',
            studyId: q.studyId,
            artifactRef: q.artifactRef,
            storageBucket: 'study-artifacts',
            storageObjectPath: `study/${q.studyId}/${q.artifactRef.id}/fixture.json`,
            intentId,
          };
        else if (channel === 'review')
          c = {
            kind: 'studyMethodReviewContext',
            intentId,
            expiresAt: base.expiresAt,
            operation: q.operation,
            request: q,
            actorId: actor.userId,
            clientId: null,
            currentState: state(),
            producerContext: ['report.view', 'export.request'].includes(q.operation)
              ? { ...makeProducer(q), intentId }
              : null,
            share: q.operation.startsWith('share.') ? shared : null,
            export:
              q.operation === 'export.download' || q.operation.startsWith('share.')
                ? exported
                : null,
            artifact:
              q.operation === 'export.download' || q.operation.startsWith('share.')
                ? {
                    kind: 'artifactCapability',
                    studyId: base.studyId,
                    artifactRef:
                      q.operation === 'share.view' ? exported!.projectionRef : exported!.bundleRef,
                    storageBucket: 'study-artifacts',
                    storageObjectPath: `study/${base.studyId}/${exported!.bundleRef.id}/bundle.json`,
                  }
                : null,
          };
        else c = { ...makeProducer(q), intentId };
        pending.set(key, c);
      }
      active = c;
      if (q.operation === 'artifact.read')
        return okay({
          kind: 'artifactReadIntent',
          intentId: c.intentId,
          expiresAt: base.expiresAt,
          studyId: q.studyId,
          artifactRef: q.artifactRef,
        });
      const kind =
        c.kind === 'methodEvidenceCommandContext'
          ? 'methodEvidenceCommandIntent'
          : c.kind === 'studyMethodReviewContext'
            ? 'studyMethodReviewIntent'
            : 'reportMethodCommandIntent';
      return okay({ kind, intentId: c.intentId, expiresAt: c.expiresAt, operation: q.operation });
    },
    async resolveIntent(_kind, id) {
      flags.resolves++;
      if (flags.revoked) return deny();
      const c = [...pending.values()].find((c) => c.intentId === id)!;
      const value = structuredClone(c);
      if (flags.wrongActor) value.actorId = methodId(900);
      if (flags.wrongClient) value.clientId = methodId(901);
      flags.mutateContext?.(value);
      flags.contexts.push(value);
      return okay(value);
    },
    async consumeIntent(kind, id, completion) {
      flags.consumes++;
      if (flags.revoked) return deny();
      const c = [...pending.values()].find((c) => c.intentId === id)!,
        x = completion as Row;
      let result: unknown;
      if (kind === 'evidence')
        result = {
          type: 'methodEvidence',
          value: {
            schemaVersion: 'lca.study-method-evidence-record.v1',
            evidenceId: c.evidenceId,
            studyId: c.studyId,
            requirementId: c.request.content.requirementId,
            declaredKind: c.request.content.declaredKind,
            artifactRef: x.artifact.artifactRef,
            status: 'recorded_unverified',
            recordedAt: c.recordedAt,
          },
        };
      else if (kind === 'report') {
        if (x.kind === 'validatedContent') {
          contentArtifact = x.contentArtifact;
          report = {
            ...structuredClone(service.reportRecord.data.value),
            studyId: base.studyId,
            reportRevisionId: base.reportRevisionId,
            parentReportRevisionId:
              c.request.parentReportRevisionId ?? report?.parentReportRevisionId ?? null,
            authorId: actor.userId,
            revision: (report?.revision ?? 0) + 1,
            status: 'draft',
            runIds: [base.runs[0].run.runId],
            methodAssessmentIds: [base.methodAssessments[0].assessment.assessmentId],
            factsRefs: x.factsRefs,
            contentRef: x.contentArtifact.artifactRef,
            contentHash: x.validation.contentHash,
            validitySnapshot: { status: 'current', checkedAt: base.generatedAt, reasonCodes: [] },
          };
        } else report = { ...report, revision: report!.revision + 1, status: 'frozen' };
        result = { type: 'reportRevision', value: report };
      } else {
        exported = {
          studyId: base.studyId,
          exportId: c.producerContext.exportId,
          reportRevisionId: base.reportRevisionId,
          reportContentHash: report!.contentHash,
          finalization: final,
          generatedAt: base.generatedAt,
          projectionRef: x.projectionArtifact.artifactRef,
          resourcesRef: x.resourcesArtifact.artifactRef,
          bundleRef: x.bundleArtifact.artifactRef,
          receipt: x.receipt,
        };
        result = { type: 'export', value: exported };
      }
      const key = c.request.idempotencyKey ?? c.request.requestId;
      done.set(key, structuredClone(result));
      if (flags.loseConsume) {
        flags.loseConsume = false;
        throw Error('private lost consume sentinel');
      }
      return okay(result);
    },
    async reconcileIntent() {
      return okay({ deletionPermitted: false });
    },
    async resolveArtifact(id) {
      if (flags.revoked) return deny();
      const c = [...pending.values()].find((c) => c.intentId === id)!;
      const { intentId: _id, ...cap } = c;
      return okay(cap);
    },
    async download(cap) {
      flags.reads++;
      const bytes = storage.get(cap.artifactRef.id);
      if (!bytes) throw Error('missing synthetic bytes');
      if (flags.revokeAfterRead) flags.revoked = true;
      if (flags.changeAfterRead && active) active.grantEpoch++;
      return bytes.slice();
    },
    async upload(artifact, bytes) {
      flags.uploads++;
      const prior = storage.get(artifact.artifactRef.id);
      if (prior && (await sha256(prior)) !== (await sha256(bytes)))
        throw Error('immutable conflict');
      storage.set(artifact.artifactRef.id, bytes.slice());
      if (flags.revokeAfterUpload) flags.revoked = true;
      if (flags.failUpload) {
        flags.failUpload = false;
        throw Error('private unknown upload sentinel');
      }
    },
  };
  const options: MethodOptions = {
    config: () => a,
    repository: () => repository,
    review: {
      config: () => b,
      repository: () => repository,
      signer: async () => ({
        keyId: profile.keyId,
        issuerId: profile.issuerId,
        privateKey: keys.privateKey,
      }),
    },
  };
  const handler = (overrides: Partial<MethodOptions> = {}) =>
    createStudyHandler({
      resolveActor: () => Promise.resolve({ ok: true, value: actor }),
      method: { ...options, ...overrides },
    });
  const call = async (q: unknown, overrides: Partial<MethodOptions> = {}) => {
    const response = await handler(overrides)(
      new Request('http://127.0.0.1/study-method', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-study-schema': 'lca.study-api.v6' },
        body: JSON.stringify(q),
      }),
    );
    return {
      status: response.status,
      headers: response.headers,
      body: (await response.json()) as Row,
    };
  };
  const request = (operation: string, fields: Row = {}) => ({
    schemaVersion: 'lca.study-api.v6',
    requestId: methodId(next++),
    operation,
    ...fields,
  });
  return {
    f,
    actor,
    flags,
    storage,
    options,
    repository,
    call,
    request,
    profile,
    keys,
    create: base.request as Row,
    getReport: () => report!,
    getContentArtifact: () => contentArtifact!,
    getExport: () => exported!,
    state,
    freeze: () =>
      request('report.freeze', {
        idempotencyKey: methodId(next++),
        target: {
          type: 'reportRevision',
          id: base.reportRevisionId,
          expectedRevision: report!.revision,
        },
        expectedContentHash: report!.contentHash,
      }),
    view: () =>
      request('report.view', {
        reportRevisionId: base.reportRevisionId,
        expectedContentHash: report!.contentHash,
      }),
    finalize: () =>
      request('report.finalize', {
        idempotencyKey: methodId(next++),
        target: {
          type: 'reportRevision',
          id: base.reportRevisionId,
          expectedRevision: report!.revision,
        },
        expectedContentHash: report!.contentHash,
        expectedReviewStateHash: 'b'.repeat(64),
        profileId: 'lca.study-report-unreviewed.v1',
        acceptedReviewIds: [],
      }),
    exportRequest: () =>
      request('export.request', {
        idempotencyKey: methodId(next++),
        reportRevisionId: base.reportRevisionId,
        expectedContentHash: report!.contentHash,
        finalizationId: final!.finalizationId,
        expectedReviewStateHash: 'b'.repeat(64),
        rendererVersion: '3.0.0',
        viewModelVersion: 'lca.study-report-view.v3',
      }),
  };
}
