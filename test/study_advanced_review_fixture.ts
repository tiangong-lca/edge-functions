import { assert, assertEquals } from 'jsr:@std/assert';
import { advancedFixture, advancedId } from './study_advanced_fixture.ts';
import { createStudyHandler } from '../supabase/functions/_shared/study/handler.ts';
import { bundledAdvancedRenderer } from '../supabase/functions/_shared/study/advanced_renderer.ts';
import type { ActorContext } from '../supabase/functions/_shared/command_runtime/actor_context.ts';
import type { AdvancedReviewRepository } from '../supabase/functions/_shared/study/advanced_review_repository.ts';
import type { AdvancedReviewOptions } from '../supabase/functions/_shared/study/advanced_review_executor.ts';
import { API_SCHEMA, OPERATIONS, FINALIZATION_PROFILES } from '../contracts/lca-study/v5/review.ts';
import { base64Url } from '../contracts/lca-study/v3/canonical.ts';
type RecordValue = Record<string, any>;

/** Adapter and byte-proof fixture only: in-memory RPC authority is not real SQL/OAuth qualification. */
export async function advancedReviewFixture() {
  const native = await advancedFixture();
  assert(
    bundledAdvancedRenderer,
    'The exact renderer-v2 artifact must be pinned before executing this fixture.',
  );
  assertEquals((await native.call(native.create)).status, 200);
  assertEquals((await native.call(native.freeze())).status, 200);
  const frozen = structuredClone(native.getReport());
  const profile = {
    issuerId: 'advanced-fixture-project',
    keyId: 'advanced-fixture-key',
    rendererVersion: '2.0.0' as const,
    viewModelVersion: 'lca.study-report-view.v2' as const,
    rendererArtifactHash: bundledAdvancedRenderer.artifactHash,
    policyId: 'lca.study-report-disclosure.v1' as const,
  };
  const keys = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const producer = structuredClone(native.getContext());
  producer.operation = 'export.request';
  producer.request = {
    schemaVersion: API_SCHEMA,
    requestId: advancedId(1010),
    idempotencyKey: advancedId(1011),
    operation: 'export.request',
    reportRevisionId: frozen.reportRevisionId,
    expectedContentHash: frozen.contentHash,
    rendererVersion: '2.0.0',
    viewModelVersion: 'lca.study-report-view.v2',
  };
  producer.report = structuredClone(frozen);
  producer.contentArtifact = native.getStoredContent();
  producer.contentArtifactId = null;
  producer.exportId = advancedId(1004);
  producer.projectionArtifactId = advancedId(1005);
  producer.resourcesArtifactId = advancedId(1006);
  producer.bundleArtifactId = advancedId(1007);
  producer.exportProfile = profile;
  producer.disclosureContextHash = 'e'.repeat(64);
  const finalization = {
    studyId: producer.studyId,
    reportRevisionId: frozen.reportRevisionId,
    reportContentHash: frozen.contentHash,
    finalizationId: advancedId(1110),
    actorId: native.actor.userId,
    profileId: 'lca.study-report-internal-review.v1',
    expectedReviewStateHash: 'b'.repeat(64),
    acceptedReviewIds: [advancedId(1111)],
    finalizedAt: producer.generatedAt,
  };
  const current = {
    studyId: producer.studyId,
    reportRevisionId: frozen.reportRevisionId,
    reportContentHash: frozen.contentHash,
    reportRevision: frozen.revision,
    authorId: native.actor.userId,
    reviewStateHash: 'b'.repeat(64),
    currentReviewIds: [advancedId(1111)],
    acceptedReviewIds: [advancedId(1111)],
    finalization,
    acceptance: 'current',
    validity: frozen.validitySnapshot,
    checkedAt: producer.generatedAt,
  };
  const flags = {
    revoked: false,
    wrongActor: false,
    wrongClient: false,
    changed: false,
    revokeDuringRead: false,
    changeDuringRead: false,
    revokeDuringUpload: false,
    failUploadOnce: false,
    downloads: 0,
    uploads: 0,
    consumes: 0,
    dispatches: 0,
    resolves: 0,
    mutateContext: null as ((c: RecordValue) => void) | null,
  };
  let actor: ActorContext = native.actor,
    context: RecordValue | null = null,
    committed: unknown = null,
    exported: RecordValue | null = null,
    share: RecordValue | null = null;
  const success = (data: unknown) => ({ ok: true, data });
  const denied = () => ({ ok: false, code: 'FORBIDDEN' });
  const runtime = {
    type: 'capabilities' as const,
    contractVersion: '5.0.0' as const,
    runtimeEnabled: true,
    operations: OPERATIONS,
    finalizationProfiles: [...FINALIZATION_PROFILES],
    reviewClasses: ['internal' as const],
    disclosurePolicies: ['lca.study-report-summary-share.v1' as const],
  };
  const repository: AdvancedReviewRepository = {
    async dispatch(r) {
      flags.dispatches++;
      if (flags.revoked) return denied();
      if (r.operation === 'capability.read') return success(runtime);
      if (r.operation === 'report.current') return success({ type: 'reportState', value: current });
      if (r.operation === 'export.read') return success({ type: 'export', value: exported });
      if (r.operation === 'resource.actions')
        return success({
          type: 'actions',
          resource: r.resource,
          actions: ['report.view', 'review.record', 'export.request'],
          allowedMemberRoles: [],
          corePermissions: { read: false, write: false },
        });
      if (committed && r.operation === 'export.request') return success(committed);
      if (
        r.operation === 'report.view' ||
        r.operation === 'export.request' ||
        r.operation === 'export.download' ||
        r.operation === 'share.view' ||
        r.operation === 'share.download'
      ) {
        const inner = structuredClone(producer);
        if (r.operation === 'report.view') {
          inner.exportId = null;
          inner.projectionArtifactId = null;
          inner.resourcesArtifactId = null;
          inner.bundleArtifactId = null;
          inner.exportProfile = null;
          inner.disclosureContextHash = null;
        }
        if (
          (r.operation === 'share.view' || r.operation === 'share.download') &&
          (!share || share.recipientId !== actor.userId)
        )
          return denied();
        context = {
          kind: 'studyAdvancedReviewContext',
          intentId: advancedId(1100),
          operation: r.operation,
          expiresAt: producer.expiresAt,
          actorId: actor.userId,
          clientId: actor.clientId ?? null,
          request: structuredClone(r),
          currentState: structuredClone(current),
          producerContext:
            r.operation === 'report.view' || r.operation === 'export.request' ? inner : null,
          share: r.operation.startsWith('share.') ? share : null,
          export:
            r.operation.startsWith('share.') || r.operation === 'export.download' ? exported : null,
          artifact:
            r.operation === 'export.download'
              ? {
                  kind: 'artifactCapability',
                  studyId: producer.studyId,
                  artifactRef: exported!.bundleRef,
                  storageBucket: 'study-artifacts',
                  storageObjectPath: `study/${producer.studyId}/${exported!.bundleRef.id}/bundle.json`,
                }
              : r.operation.startsWith('share.')
                ? {
                    kind: 'artifactCapability',
                    studyId: producer.studyId,
                    artifactRef:
                      r.operation === 'share.view' ? share!.projectionRef : share!.bundleRef,
                    storageBucket: 'study-artifacts',
                    storageObjectPath: `study/${producer.studyId}/${r.operation === 'share.view' ? share!.projectionRef.id : share!.bundleRef.id}/${r.operation === 'share.view' ? 'projection' : 'bundle'}.json`,
                  }
                : null,
        };
        return success({
          kind: 'studyAdvancedReviewIntent',
          intentId: context.intentId,
          operation: r.operation,
          expiresAt: context.expiresAt,
        });
      }
      return denied();
    },
    async resolveIntent() {
      flags.resolves++;
      if (flags.revoked) return denied();
      if (committed && context?.operation === 'export.request') return success(committed);
      const c = structuredClone(context!);
      if (flags.wrongActor) c.actorId = advancedId(1999);
      if (flags.wrongClient) c.clientId = advancedId(1998);
      if (flags.changed) c.currentState.reviewStateHash = 'c'.repeat(64);
      flags.mutateContext?.(c);
      return success(c);
    },
    async consumeIntent(_id, raw) {
      if (flags.revoked) return denied();
      flags.consumes++;
      const c = raw as RecordValue;
      assertEquals(c.kind, 'validatedReviewExport');
      exported = {
        studyId: producer.studyId,
        reportRevisionId: frozen.reportRevisionId,
        reportContentHash: frozen.contentHash,
        exportId: producer.exportId,
        finalization: structuredClone(finalization),
        generatedAt: producer.generatedAt,
        projectionRef: c.projectionArtifact.artifactRef,
        resourcesRef: c.resourcesArtifact.artifactRef,
        bundleRef: c.bundleArtifact.artifactRef,
        receipt: c.receipt,
      };
      committed = { type: 'export', value: exported };
      return success(committed);
    },
    async download(cap) {
      flags.downloads++;
      const bytes = native.storage.get(cap.artifactRef.id);
      assert(bytes);
      if (flags.revokeDuringRead) flags.revoked = true;
      if (flags.changeDuringRead) flags.changed = true;
      return bytes;
    },
    async upload(a, bytes) {
      flags.uploads++;
      const old = native.storage.get(a.artifactRef.id);
      if (old) assertEquals(old, bytes);
      else native.storage.set(a.artifactRef.id, bytes);
      if (flags.revokeDuringUpload) flags.revoked = true;
      if (flags.failUploadOnce) {
        flags.failUploadOnce = false;
        throw new Error('synthetic lost upload acknowledgement');
      }
    },
  };
  const review: AdvancedReviewOptions = {
    config: () => runtime,
    repository: () => repository,
    renderer: bundledAdvancedRenderer,
    allowDevelopmentRenderer: true,
    signer: async () => ({
      keyId: profile.keyId,
      issuerId: profile.issuerId,
      privateKey: keys.privateKey,
    }),
  };
  const handler = (override: Partial<AdvancedReviewOptions> = {}) =>
    createStudyHandler({
      resolveActor: async () => ({ ok: true, value: actor }),
      advanced: { ...native.advanced, review: { ...review, ...override } },
    });
  const call = async (value: unknown, override: Partial<AdvancedReviewOptions> = {}) => {
    const response = await handler(override)(
      new Request('http://127.0.0.1/functions/v1/app_lca_study', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-study-schema': API_SCHEMA },
        body: JSON.stringify(value),
      }),
    );
    return { status: response.status, body: await response.json() };
  };
  const request = {
    schemaVersion: API_SCHEMA,
    requestId: advancedId(1120),
    idempotencyKey: advancedId(1121),
    operation: 'export.request',
    reportRevisionId: frozen.reportRevisionId,
    expectedContentHash: frozen.contentHash,
    finalizationId: finalization.finalizationId,
    expectedReviewStateHash: current.reviewStateHash,
    rendererVersion: '2.0.0',
    viewModelVersion: 'lca.study-report-view.v2',
  };
  const viewRequest = {
    schemaVersion: API_SCHEMA,
    requestId: advancedId(1122),
    operation: 'report.view',
    reportRevisionId: frozen.reportRevisionId,
    expectedContentHash: frozen.contentHash,
  };
  const trust = async () => [
    {
      keyId: profile.keyId,
      issuerId: profile.issuerId,
      publicKeySpki: base64Url(
        new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey)),
      ),
      validFrom: '2026-01-01T00:00:00Z',
      validUntil: '2027-01-01T00:00:00Z',
      rendererArtifactHashes: [profile.rendererArtifactHash],
    },
  ];
  const expected = {
    issuerId: profile.issuerId,
    exportId: producer.exportId,
    studyId: producer.studyId,
    reportRevisionId: frozen.reportRevisionId,
    reportContentHash: frozen.contentHash,
  };
  return {
    native,
    frozen,
    producer,
    profile,
    keys,
    finalization,
    current,
    flags,
    call,
    request,
    viewRequest,
    review,
    trust,
    expected,
    getContext: () => context!,
    getExport: () => exported!,
    setActor: (next: ActorContext) => {
      actor = next;
    },
    async recipient() {
      assert(exported);
      share = {
        studyId: producer.studyId,
        reportRevisionId: frozen.reportRevisionId,
        reportContentHash: frozen.contentHash,
        shareId: advancedId(1130),
        exportId: exported.exportId,
        finalizationId: finalization.finalizationId,
        issuerId: native.actor.userId,
        recipientId: advancedId(1131),
        disclosurePolicyId: 'lca.study-report-summary-share.v1',
        disclosureContextHash: 'd'.repeat(64),
        grantEpoch: 1,
        projectionRef: exported.projectionRef,
        bundleRef: exported.bundleRef,
        createdAt: producer.generatedAt,
        expiresAt: '2026-11-05T00:00:00Z',
        revokedAt: null,
        status: 'active',
      };
      actor = { ...native.actor, userId: share.recipientId };
      context = null;
      committed = null;
      return share;
    },
  };
}
