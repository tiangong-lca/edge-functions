import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { assertEquals, assert } from 'jsr:@std/assert';
import { createStudyHandler } from '../supabase/functions/_shared/study/handler.ts';
import { reportingFixture } from './study_reporting_fixture.ts';
import { API_SCHEMA, OPERATIONS, FINALIZATION_PROFILES } from '../contracts/lca-study/v4/review.ts';
import { parseExportBundle, verifyExport } from '../contracts/lca-study/v4/export.ts';
import {
  base64Url,
  canonicalBytes,
  parseCanonicalBytes,
  sha256,
} from '../contracts/lca-study/v3/canonical.ts';
import { bundledReportingRenderer } from '../supabase/functions/_shared/study/reporting_view.ts';
import type { ReviewRepository } from '../supabase/functions/_shared/study/review_repository.ts';
import type { ActorContext } from '../supabase/functions/_shared/command_runtime/actor_context.ts';
const u = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function fixture() {
  const p2 = await reportingFixture();
  assertEquals((await p2.call(p2.create)).status, 200);
  const frozen = await p2.call({
    schemaVersion: 'lca.study-api.v3',
    requestId: u(12),
    idempotencyKey: u(13),
    operation: 'report.freeze',
    target: { type: 'reportRevision', id: u(1), expectedRevision: 1 },
    expectedContentHash: p2.getReport().contentHash,
  });
  assertEquals(frozen.status, 200);
  const p2Request = {
    schemaVersion: 'lca.study-api.v3',
    requestId: u(14),
    idempotencyKey: u(15),
    operation: 'export.request',
    reportRevisionId: u(1),
    expectedContentHash: p2.getReport().contentHash,
    rendererVersion: '1.0.0',
    viewModelVersion: 'lca.study-report-view.v1',
  };
  assertEquals((await p2.call(p2Request)).status, 200);
  const producer = structuredClone(p2.getContext()) as Record<string, any>;
  producer.exportId = u(104);
  producer.projectionArtifactId = u(105);
  producer.resourcesArtifactId = u(106);
  producer.bundleArtifactId = u(107);
  const finalizedAt = producer.generatedAt;
  const finalization = {
    studyId: producer.studyId,
    reportRevisionId: u(1),
    reportContentHash: producer.report.contentHash,
    finalizationId: u(110),
    actorId: p2.actor.userId,
    profileId: 'lca.study-report-internal-review.v1',
    expectedReviewStateHash: 'b'.repeat(64),
    acceptedReviewIds: [u(111)],
    finalizedAt,
  };
  const current = {
    studyId: producer.studyId,
    reportRevisionId: u(1),
    reportContentHash: producer.report.contentHash,
    reportRevision: 2,
    authorId: p2.actor.userId,
    reviewStateHash: 'b'.repeat(64),
    currentReviewIds: [u(111)],
    acceptedReviewIds: [u(111)],
    finalization,
    acceptance: 'current',
    validity: producer.report.validitySnapshot,
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
    deny: false,
  };
  let actor: ActorContext = p2.actor,
    exported: Record<string, any> | null = null,
    share: Record<string, any> | null = null,
    context: Record<string, any> | null = null,
    committed: unknown = null;
  const success = (data: unknown) => ({ ok: true, data });
  const repository: ReviewRepository = {
    async dispatch(r) {
      if (flags.revoked || flags.deny) return { ok: false, code: 'FORBIDDEN' };
      if (r.operation === 'capability.read') return success(runtime);
      if (r.operation === 'resource.actions')
        return success({
          type: 'actions',
          resource: r.resource,
          actions: ['report.view', 'review.record', 'export.request'],
          allowedMemberRoles: [],
        });
      if (r.operation === 'report.current') return success({ type: 'reportState', value: current });
      if (committed && r.operation === 'export.request') return success(committed);
      if (context && r.operation === 'export.request' && context.operation === r.operation) {
        return success({
          kind: 'studyReviewIntent',
          intentId: context.intentId,
          operation: context.operation,
          expiresAt: context.expiresAt,
        });
      }
      if (
        r.operation === 'report.view' ||
        r.operation === 'export.request' ||
        r.operation === 'share.view' ||
        r.operation === 'share.download' ||
        r.operation === 'export.download'
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
        context = {
          kind: 'studyReviewContext',
          intentId: u(100),
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
          kind: 'studyReviewIntent',
          intentId: context.intentId,
          operation: r.operation,
          expiresAt: context.expiresAt,
        });
      }
      return { ok: false, code: 'FORBIDDEN' };
    },
    async resolveIntent() {
      if (flags.revoked) return { ok: false, code: 'FORBIDDEN' };
      if (committed && context?.operation === 'export.request') return success(committed);
      const c = structuredClone(context!);
      if (flags.wrongActor) c.actorId = u(999);
      if (flags.wrongClient) c.clientId = u(998);
      if (flags.changed) c.currentState.reviewStateHash = 'c'.repeat(64);
      return success(c);
    },
    async consumeIntent(_id, raw) {
      if (flags.revoked) return { ok: false, code: 'FORBIDDEN' };
      flags.consumes++;
      const c = raw as Record<string, any>;
      assertEquals(c.kind, 'validatedReviewExport');
      exported = {
        studyId: producer.studyId,
        reportRevisionId: u(1),
        reportContentHash: producer.report.contentHash,
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
      const bytes = p2.storage.get(cap.artifactRef.id);
      assert(bytes);
      if (flags.revokeDuringRead) flags.revoked = true;
      if (flags.changeDuringRead) flags.changed = true;
      return bytes;
    },
    async upload(a, bytes) {
      flags.uploads++;
      const previous = p2.storage.get(a.artifactRef.id);
      if (previous) assertEquals(previous, bytes);
      else p2.storage.set(a.artifactRef.id, bytes);
      if (flags.revokeDuringUpload) flags.revoked = true;
      if (flags.failUploadOnce) {
        flags.failUploadOnce = false;
        throw new Error('synthetic lost upload acknowledgement');
      }
    },
  };
  const runtime = {
    type: 'capabilities' as const,
    contractVersion: '4.0.0' as const,
    runtimeEnabled: true,
    operations: OPERATIONS,
    finalizationProfiles: [...FINALIZATION_PROFILES],
    reviewClasses: ['internal' as const],
    disclosurePolicies: ['lca.study-report-summary-share.v1' as const],
  };
  const handler = createStudyHandler({
    resolveActor: async () => ({ ok: true, value: actor }),
    review: {
      config: () => runtime,
      repository: () => repository,
      renderer: bundledReportingRenderer,
      allowDevelopmentRenderer: true,
      signer: p2.reporting.signer,
    },
  });
  const call = async (value: unknown, selected = handler) => {
    const response = await selected(
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
    requestId: u(120),
    idempotencyKey: u(121),
    operation: 'export.request',
    reportRevisionId: u(1),
    expectedContentHash: producer.report.contentHash,
    finalizationId: finalization.finalizationId,
    expectedReviewStateHash: current.reviewStateHash,
    rendererVersion: '1.0.0',
    viewModelVersion: 'lca.study-report-view.v1',
  };
  return {
    p2,
    producer,
    current,
    flags,
    call,
    request,
    finalization,
    getContext: () => context!,
    getExport: () => exported!,
    setActor: (value: ActorContext) => {
      actor = value;
    },
    async recipient() {
      share = {
        studyId: producer.studyId,
        reportRevisionId: u(1),
        reportContentHash: producer.report.contentHash,
        shareId: u(130),
        exportId: exported!.exportId,
        finalizationId: finalization.finalizationId,
        issuerId: p2.actor.userId,
        recipientId: u(131),
        disclosurePolicyId: 'lca.study-report-summary-share.v1',
        disclosureContextHash: 'd'.repeat(64),
        grantEpoch: 1,
        projectionRef: exported!.projectionRef,
        bundleRef: exported!.bundleRef,
        createdAt: producer.generatedAt,
        expiresAt: '2026-11-04T05:10:51Z',
        revokedAt: null,
        status: 'active',
      };
      actor = { ...p2.actor, userId: share.recipientId };
      context = null;
      committed = null;
      return share;
    },
  };
}
Deno.test(
  'V4 actual handler exports exact reviewed finalized HTML without mutating P2 content',
  async () => {
    const f = await fixture(),
      frozen = structuredClone(f.p2.getReport());
    const value = await f.call(f.request);
    assertEquals(value.status, 200);
    assertEquals(f.p2.getReport(), frozen);
    assertEquals(f.flags.consumes, 1);
    const bytes = f.p2.storage.get(f.producer.bundleArtifactId)!;
    const b = parseExportBundle(bytes);
    const verified = await verifyExport(
      b.manifestBytes,
      b.receipt,
      b.files,
      [
        {
          keyId: f.p2.profile.keyId,
          issuerId: f.p2.profile.issuerId,
          publicKeySpki: base64Url(
            new Uint8Array(await crypto.subtle.exportKey('spki', f.p2.keys.publicKey)),
          ),
          validFrom: '2026-01-01T00:00:00Z',
          validUntil: '2027-01-01T00:00:00Z',
          rendererArtifactHashes: [f.p2.profile.rendererArtifactHash],
        },
      ],
      {
        issuerId: f.p2.profile.issuerId,
        exportId: f.producer.exportId,
        studyId: f.producer.studyId,
        reportRevisionId: u(1),
        reportContentHash: f.producer.report.contentHash,
      },
    );
    assertEquals(verified.finalization, f.finalization);
    const view = parseCanonicalBytes(b.files[1].bytes) as Record<string, any>;
    assertEquals(view.snapshot.review, 'reviewed');
    assertEquals(view.snapshot.finalization, 'finalized');
    assertEquals(view.snapshot.reviewIds, f.finalization.acceptedReviewIds);
    const uploads = f.flags.uploads;
    assertEquals((await f.call({ ...f.request, requestId: u(122) })).status, 200);
    assertEquals(f.flags.uploads, uploads);
    assertEquals(f.flags.consumes, 1);
    f.flags.revoked = true;
    assertEquals((await f.call({ ...f.request, requestId: u(123) })).status, 403);
  },
);
Deno.test(
  'V4 pending export recovery preserves original semantic request and exact bytes',
  async () => {
    const f = await fixture();
    f.flags.failUploadOnce = true;
    assertEquals((await f.call(f.request)).status, 502);
    assertEquals(f.flags.consumes, 0);
    assertEquals((await f.call({ ...f.request, requestId: u(122) })).status, 200);
    assertEquals(f.flags.consumes, 1);
    const changed = await fixture();
    changed.flags.failUploadOnce = true;
    await changed.call(changed.request);
    assertEquals(
      (
        await changed.call({
          ...changed.request,
          requestId: u(123),
          expectedReviewStateHash: 'f'.repeat(64),
        })
      ).status,
      502,
    );
  },
);
Deno.test(
  'V4 default-off, exact actor/client/report/hash, stale review state and current I/O checks fail closed',
  async () => {
    for (const flag of [
      'wrongActor',
      'wrongClient',
      'revokeDuringRead',
      'changeDuringRead',
      'revokeDuringUpload',
    ] as const) {
      const f = await fixture();
      f.flags[flag] = true;
      const response = await f.call(f.request);
      assert(response.status >= 400);
      assertEquals(f.flags.consumes, 0);
      if (flag === 'wrongActor' || flag === 'wrongClient') assertEquals(f.flags.downloads, 0);
    }
    const f = await fixture();
    assertEquals(
      (await f.call({ ...f.request, expectedReviewStateHash: 'c'.repeat(64) })).status,
      409,
    );
    assertEquals(f.flags.downloads, 0);
    const disabled = createStudyHandler({
      resolveActor: async () => ({ ok: true, value: f.p2.actor }),
    });
    assertEquals((await f.call(f.request, disabled)).status, 503);
    const denial = await fixture();
    denial.flags.deny = true;
    assertEquals(
      (await denial.call({ ...denial.request, operation: 'report.current' })).status,
      400,
    ); // strict request shape rejects mutation-only fields
    assertEquals(
      (
        await denial.call({
          schemaVersion: API_SCHEMA,
          requestId: u(140),
          operation: 'report.current',
          reportRevisionId: u(1),
          expectedContentHash: denial.producer.report.contentHash,
        })
      ).status,
      403,
    );
  },
);
Deno.test(
  'V4 reviewer report-only view and named recipient projection/download retain current state separately',
  async () => {
    const f = await fixture();
    f.setActor({ ...f.p2.actor, userId: u(141) });
    const viewed = await f.call({
      schemaVersion: API_SCHEMA,
      requestId: u(142),
      operation: 'report.view',
      reportRevisionId: u(1),
      expectedContentHash: f.producer.report.contentHash,
    });
    assertEquals(viewed.status, 200);
    assertEquals(viewed.body.data.share, null);
    assertEquals('storageBucket' in viewed.body.data.view, false);
    assertEquals('preparedArtifact' in viewed.body.data.view, false);
    assertEquals(f.flags.uploads, 0);
    f.setActor(f.p2.actor);
    f.getContext().operation = 'report.view';
    assertEquals((await f.call(f.request)).status, 200);
    const share = await f.recipient();
    const read = {
      schemaVersion: API_SCHEMA,
      requestId: u(143),
      operation: 'share.view',
      shareId: share.shareId,
    };
    const shared = await f.call(read);
    assertEquals(shared.status, 200);
    assertEquals(shared.body.data.share.recipientId, share.recipientId);
    assertEquals(shared.body.data.view.snapshot.reviewIds, f.finalization.acceptedReviewIds);
    const downloaded = await f.call({ ...read, operation: 'share.download', requestId: u(144) });
    assertEquals(downloaded.status, 200);
    assertEquals(
      await sha256(
        Uint8Array.from(atob(downloaded.body.data.bytes), (c: string) => c.charCodeAt(0)),
      ),
      share.bundleRef.contentHash,
    );
    f.flags.revokeDuringRead = true;
    assertEquals((await f.call({ ...read, requestId: u(145) })).status, 403);
  },
);

Deno.test(
  'V4 real pinned SDK sends query/command actor credentials and service intent calls to api only',
  async () => {
    const { createClient } = await import('jsr:@supabase/supabase-js@2.118.0');
    const { createReviewRepository } =
      await import('../supabase/functions/_shared/study/review_repository.ts');
    const { parseRequest } = await import('../contracts/lca-study/v4/codec.ts');
    const calls: Array<{
      url: string;
      authorization: string | null;
      profile: string | null;
      body: unknown;
    }> = [];
    const transport: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      calls.push({
        url: request.url,
        authorization: request.headers.get('authorization'),
        profile: request.headers.get('content-profile'),
        body: await request.json(),
      });
      return Response.json({ ok: true, data: { type: 'unconsumed-test-transport' } });
    };
    const client = (key: string, bearer?: string): SupabaseClient =>
      createClient('https://sdk-study.invalid', key, {
        db: { schema: 'api' },
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
          fetch: transport,
          ...(bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {}),
        },
      }) as unknown as SupabaseClient;
    const repository = createReviewRepository(client('publishable', 'actor-jwt'), () =>
      client('service-secret'),
    );
    const signal = new AbortController().signal;
    for (const request of [
      {
        schemaVersion: API_SCHEMA,
        requestId: u(200),
        operation: 'resource.actions',
        resource: { type: 'reportRevision', id: u(1) },
      },
      {
        schemaVersion: API_SCHEMA,
        requestId: u(201),
        operation: 'share.download',
        shareId: u(130),
      },
      {
        schemaVersion: API_SCHEMA,
        requestId: u(204),
        operation: 'export.download',
        exportId: u(104),
      },
      {
        schemaVersion: API_SCHEMA,
        requestId: u(202),
        idempotencyKey: u(203),
        operation: 'comment.append',
        reportRevisionId: u(1),
        expectedContentHash: 'a'.repeat(64),
        text: 'A substantive comment is still not an approval.',
      },
    ])
      await repository.dispatch(parseRequest(request), signal);
    await repository.resolveIntent('intent', signal);
    await repository.consumeIntent('intent', { kind: 'validatedReviewExport' }, signal);
    assertEquals(
      calls.map((c) => new URL(c.url).pathname.split('/').at(-1)),
      [
        'qry_study_review_v1',
        'qry_study_review_v1',
        'qry_study_review_v1',
        'cmd_study_review_v1',
        'svc_study_review_intent_resolve_v1',
        'svc_study_review_intent_consume_v1',
      ],
    );
    assertEquals(
      calls.map((c) => c.authorization),
      [
        'Bearer actor-jwt',
        'Bearer actor-jwt',
        'Bearer actor-jwt',
        'Bearer actor-jwt',
        'Bearer service-secret',
        'Bearer service-secret',
      ],
    );
    assertEquals(
      calls.map((c) => c.profile),
      ['api', 'api', 'api', 'api', 'api', 'api'],
    );
    assertEquals(calls[4].body, { p_intent_id: 'intent' });
    assertEquals(calls[5].body, {
      p_intent_id: 'intent',
      p_completion: { kind: 'validatedReviewExport' },
    });
  },
);

Deno.test(
  'V4 owner export download resolves only the exact immutable bundle and rechecks around I/O',
  async () => {
    const f = await fixture();
    assertEquals((await f.call(f.request)).status, 200);
    const request = {
      schemaVersion: API_SCHEMA,
      requestId: u(300),
      operation: 'export.download',
      exportId: f.producer.exportId,
    };
    const response = await f.call(request);
    assertEquals(response.status, 200);
    assertEquals(response.body.data.type, 'exportDownload');
    assertEquals(response.body.data.export.exportId, f.producer.exportId);
    assertEquals('share' in response.body.data, false);
    const bytes = Uint8Array.from(atob(response.body.data.bytes), (c: string) => c.charCodeAt(0));
    assertEquals(await sha256(bytes), f.getExport().bundleRef.contentHash);
    const reads = f.flags.downloads;
    assertEquals((await f.call({ ...request, requestId: u(301), exportId: u(999) })).status, 502);
    assertEquals(f.flags.downloads, reads);
    f.flags.revokeDuringRead = true;
    assertEquals((await f.call({ ...request, requestId: u(302) })).status, 403);
    const changed = await fixture();
    assertEquals((await changed.call(changed.request)).status, 200);
    changed.flags.changeDuringRead = true;
    assertEquals(
      (await changed.call({ ...request, requestId: u(303), exportId: changed.producer.exportId }))
        .status,
      409,
    );
  },
);

Deno.test(
  'V4 rejects a first withdrawal before dispatch while preserving explicit predecessor requests',
  async () => {
    const f = await fixture();
    f.flags.deny = true;
    const request = {
      schemaVersion: API_SCHEMA,
      requestId: u(400),
      idempotencyKey: u(401),
      operation: 'review.record',
      reportRevisionId: u(1),
      expectedContentHash: f.producer.report.contentHash,
      reviewClass: 'internal',
      decision: 'withdraw',
      comment: 'Withdraw the previous review.',
      predecessorReviewId: null,
      delegationId: null,
    };
    const response = await f.call(request);
    assertEquals(response.status, 400);
    assertEquals(response.body.code, 'INVALID_REQUEST');
    assertEquals(response.body.issues[0].ruleId, 'request.structure');
    const withHead = await f.call({ ...request, requestId: u(402), predecessorReviewId: u(111) });
    assertEquals(withHead.status, 403);
    const { comment: _comment, delegationId: _delegation, ...base } = request;
    const issue = {
      ...base,
      operation: 'review.delegation.issue',
      clientId: u(403),
      expiresAt: '2026-11-04T00:10:00Z',
    };
    const issued = await f.call(issue);
    assertEquals(issued.status, 400);
    assertEquals(issued.body.code, 'INVALID_REQUEST');
    assertEquals(issued.body.issues[0].ruleId, 'request.structure');
    assertEquals(
      (await f.call({ ...issue, requestId: u(404), predecessorReviewId: u(111) })).status,
      403,
    );
    assertEquals(f.flags.downloads, 0);
    assertEquals(f.flags.uploads, 0);
    assertEquals(f.flags.consumes, 0);
  },
);
