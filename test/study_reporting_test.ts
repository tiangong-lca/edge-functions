import { assertEquals, assertRejects } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { createStudyHandler } from '../supabase/functions/_shared/study/handler.ts';
import { bundledReportingRenderer } from '../supabase/functions/_shared/study/reporting_view.ts';
import {
  API_SCHEMA,
  OPERATIONS,
  ANALYSIS_PROFILE,
  REPORT_TEMPLATE,
} from '../contracts/lca-study/v3/report.ts';
import {
  canonicalBytes,
  domainBytes,
  sha256,
  base64Url,
} from '../contracts/lca-study/v3/canonical.ts';
import {
  parseExportBundle,
  verifyExport,
  canonicalReceiptBytes,
} from '../contracts/lca-study/v3/export.ts';
import type {
  ReportingRepository,
  PrivateReportArtifact,
} from '../supabase/functions/_shared/study/reporting_repository.ts';

const base = new URL('./fixtures/lca-study-api/v3/native/', import.meta.url);
const json = async (name: string) => JSON.parse(await Deno.readTextFile(new URL(name, base)));
const u = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const stamp = '2026-11-03T05:10:51.610188+00:00';
async function fixture() {
  const input = await json('service-input.json'),
    facts = await json('facts.json'),
    factsRef = await json('facts-ref.json');
  const actor = {
    userId: u(2),
    accessToken: 'synthetic-local-context',
    supabase: {} as SupabaseClient,
  };
  const storage = new Map<string, Uint8Array>([
    [
      input.runs[0].preparedArtifact.artifactRef.id,
      await Deno.readFile(new URL('prepared.json', base)),
    ],
    [factsRef.id, await Deno.readFile(new URL('facts.json', base))],
  ]);
  const impact = facts.facts.find((f: { kind: string }) => f.kind === 'impact');
  const content = {
    schemaVersion: 'lca.study-report-draft.v1',
    title: 'Bounded study report',
    claims: [
      {
        claimId: 'impact',
        bundleRef: factsRef,
        factId: impact.factId,
        canonicalValue: impact.canonicalValue,
        unit: impact.unit,
        display: { style: 'exact' },
      },
    ],
    sections: [
      {
        sectionId: 'interpretation',
        title: 'Interpretation',
        paragraphs: ['A bounded unreviewed numerical result.'],
        claimIds: ['impact'],
      },
    ],
    tables: [],
    charts: [],
    additionalLimitations: [],
  };
  const profile = {
    issuerId: 'fixture-project',
    keyId: 'fixture-key',
    rendererVersion: '1.0.0' as const,
    viewModelVersion: 'lca.study-report-view.v1' as const,
    rendererArtifactHash: bundledReportingRenderer.artifactHash,
    policyId: 'lca.study-report-disclosure.v1' as const,
  };
  const analysis = {
    ...input.analysis,
    execution: { ...input.analysis.execution, status: 'completed' },
    comparability: {
      status: facts.comparability.status,
      reasonCodes: facts.comparability.reasonCodes,
    },
    factsRef,
  };
  const factsArtifact = {
    studyId: input.analysis.studyId,
    artifactRef: factsRef,
    storageBucket: 'study-artifacts',
    storageObjectPath: `study/${input.analysis.studyId}/${factsRef.id}/facts.json`,
  };
  const keys = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  let report: Record<string, unknown> | null = null,
    context: Record<string, unknown> | null = null,
    committed: unknown = null,
    storedContent: PrivateReportArtifact | null = null,
    exported: Record<string, unknown> | null = null;
  const state = {
    uploads: 0,
    consumes: 0,
    downloads: 0,
    revoked: false,
    revokeOnUpload: false,
    wrongActor: false,
    preservePendingRequest: false,
    failUploadOnce: false,
  };
  const success = (data: unknown) => ({ ok: true, data });
  const repository: ReportingRepository = {
    async dispatch(request) {
      if (request.operation === 'capability.read')
        return success({
          type: 'capabilities',
          contractVersion: '3.0.0',
          runtimeEnabled: true,
          operations: OPERATIONS,
          analysisProfiles: [ANALYSIS_PROFILE],
          reportTemplates: [REPORT_TEMPLATE],
        });
      if (state.preservePendingRequest && context) {
        if (committed) return success(committed);
        return success({
          kind: 'reportCommandIntent',
          intentId: context.intentId,
          expiresAt: context.expiresAt,
          operation: context.operation,
        });
      }
      committed = null;
      context = {
        kind: 'reportCommandContext',
        intentId: request.requestId,
        expiresAt: '2026-11-03T05:12:51.610188+00:00',
        operation: request.operation,
        request,
        studyId: input.analysis.studyId,
        actorId: state.wrongActor ? u(99) : actor.userId,
        clientId: null,
        grantEpoch: 1,
        generatedAt: stamp,
        reportRevisionId: u(1),
        contentArtifactId:
          request.operation === 'report.create' || request.operation === 'report.save'
            ? u(3)
            : null,
        exportId: request.operation === 'export.request' ? u(4) : null,
        projectionArtifactId: request.operation === 'export.request' ? u(5) : null,
        resourcesArtifactId: request.operation === 'export.request' ? u(6) : null,
        bundleArtifactId: request.operation === 'export.request' ? u(7) : null,
        report,
        contentArtifact: storedContent,
        runs: input.runs,
        analyses: [{ analysis, factsArtifact }],
        factsBindingHash: await sha256(
          domainBytes('lca.study-report-facts-binding.v1', [factsRef]),
        ),
        disclosureContextHash: request.operation === 'export.request' ? 'e'.repeat(64) : null,
        exportProfile: request.operation === 'export.request' ? profile : null,
      };
      return success({
        kind: 'reportCommandIntent',
        intentId: request.requestId,
        expiresAt: context.expiresAt,
        operation: request.operation,
      });
    },
    async resolveIntent() {
      return state.revoked ? { ok: false, code: 'FORBIDDEN' } : success(committed ?? context);
    },
    async consumeIntent(_id, raw) {
      state.consumes++;
      const c = raw as Record<string, any>;
      if (c.kind === 'validatedContent') {
        storedContent = c.contentArtifact;
        report = {
          reportRevisionId: u(1),
          studyId: input.analysis.studyId,
          parentReportRevisionId: null,
          authorId: actor.userId,
          revision: 1,
          status: 'draft',
          contentHash: c.contentArtifact.artifactRef.contentHash,
          runIds: input.analysis.config.runIds,
          analysisIds: [analysis.analysisId],
          factsRefs: [factsRef],
          contentRef: c.contentArtifact.artifactRef,
          templateId: REPORT_TEMPLATE,
          finalization: {
            status: 'not_finalized',
            profileId: 'lca.study-report-unreviewed.v1',
            reviewRequirement: 'none',
            finalizedAt: null,
            reviewIds: [],
          },
          validitySnapshot: { status: 'current', checkedAt: stamp, reasonCodes: [] },
        };
        committed = { type: 'reportRevision', value: report };
      } else if (c.kind === 'validatedFreeze') {
        report = { ...report, status: 'frozen', revision: 2 };
        committed = { type: 'reportRevision', value: report };
      } else {
        exported = {
          exportId: u(4),
          studyId: input.analysis.studyId,
          reportRevisionId: u(1),
          reportContentHash: report!.contentHash,
          status: 'ready',
          projectionRef: c.projectionArtifact.artifactRef,
          grantEpoch: 1,
          factsRefs: [factsRef],
          rendererVersion: '1.0.0',
          viewModelVersion: 'lca.study-report-view.v1',
          resourcesRef: c.resourcesArtifact.artifactRef,
          actorId: actor.userId,
          policyId: profile.policyId,
          disclosureContextHash: 'e'.repeat(64),
          disclosureDecision: 'allowed',
          generatedAt: stamp,
          validitySnapshot: report!.validitySnapshot,
          reviewIds: [],
          receipt: c.receipt,
          bundleRef: c.bundleArtifact.artifactRef,
        };
        committed = { type: 'export', value: exported };
      }
      return success(committed);
    },
    async reconcileIntent() {
      return { ok: false, code: 'CAPABILITY_UNAVAILABLE' };
    },
    async resolveArtifact() {
      return { ok: false, code: 'CAPABILITY_UNAVAILABLE' };
    },
    async download(cap) {
      state.downloads++;
      const bytes = storage.get(cap.artifactRef.id);
      if (!bytes) throw new Error('missing synthetic bytes');
      return bytes;
    },
    async upload(a, bytes) {
      state.uploads++;
      storage.set(a.artifactRef.id, bytes);
      if (state.failUploadOnce) {
        state.failUploadOnce = false;
        throw new Error('synthetic lost upload acknowledgement');
      }
      if (state.revokeOnUpload) state.revoked = true;
    },
  };
  const reporting = {
    config: () => ({
      type: 'capabilities' as const,
      contractVersion: '3.0.0' as const,
      runtimeEnabled: true,
      operations: OPERATIONS,
      analysisProfiles: [ANALYSIS_PROFILE],
      reportTemplates: [REPORT_TEMPLATE],
    }),
    repository: () => repository,
    renderer: bundledReportingRenderer,
    allowDevelopmentRenderer: true,
    signer: async () => ({
      keyId: profile.keyId,
      issuerId: profile.issuerId,
      privateKey: keys.privateKey,
    }),
  };
  const handler = createStudyHandler({
    resolveActor: async () => ({ ok: true, value: actor }),
    reporting,
  });
  const call = async (value: unknown) => {
    const response = await handler(
      new Request('http://127.0.0.1/functions/v1/app_lca_study', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      }),
    );
    return { status: response.status, body: await response.json() };
  };
  const create = {
    schemaVersion: API_SCHEMA,
    requestId: u(10),
    idempotencyKey: u(11),
    operation: 'report.create',
    studyId: input.analysis.studyId,
    parentReportRevisionId: null,
    runIds: input.analysis.config.runIds,
    analysisIds: [analysis.analysisId],
    content,
    templateId: REPORT_TEMPLATE,
  };
  return {
    call,
    create,
    state,
    storage,
    reporting,
    actor,
    profile,
    keys,
    getReport: () => report!,
    getExport: () => exported!,
  };
}

Deno.test(
  'P2 consumes actual native fact bytes, freezes real content and signs visible HTML',
  async () => {
    const f = await fixture();
    const created = await f.call(f.create);
    assertEquals(created.status, 200);
    assertEquals(created.body.data.value.status, 'draft');
    const frozen = await f.call({
      schemaVersion: API_SCHEMA,
      requestId: u(12),
      idempotencyKey: u(13),
      operation: 'report.freeze',
      target: { type: 'reportRevision', id: u(1), expectedRevision: 1 },
      expectedContentHash: f.getReport().contentHash,
    });
    assertEquals(frozen.status, 200);
    assertEquals(frozen.body.data.value.status, 'frozen');
    const exported = await f.call({
      schemaVersion: API_SCHEMA,
      requestId: u(14),
      idempotencyKey: u(15),
      operation: 'export.request',
      reportRevisionId: u(1),
      expectedContentHash: f.getReport().contentHash,
      rendererVersion: '1.0.0',
      viewModelVersion: 'lca.study-report-view.v1',
    });
    assertEquals(exported.status, 200);
    const bundle = parseExportBundle(f.storage.get(u(7))!);
    const anchors = [
      {
        keyId: f.profile.keyId,
        issuerId: f.profile.issuerId,
        publicKeySpki: base64Url(
          new Uint8Array(await crypto.subtle.exportKey('spki', f.keys.publicKey)),
        ),
        validFrom: '2026-01-01T00:00:00Z',
        validUntil: '2027-01-01T00:00:00Z',
        rendererArtifactHashes: [f.profile.rendererArtifactHash],
      },
    ];
    const expected = {
      issuerId: f.profile.issuerId,
      exportId: u(4),
      studyId: f.create.studyId,
      reportRevisionId: u(1),
      reportContentHash: f.getReport().contentHash as string,
    };
    const verified = await verifyExport(
      bundle.manifestBytes,
      bundle.receipt,
      bundle.files,
      anchors,
      expected,
    );
    assertEquals(verified.reviewIds, []);
    const html = new TextDecoder().decode(
      bundle.files.find((file) => file.path === 'report.html')!.bytes,
    );
    assertEquals(html.includes('Unreviewed'), true);
    assertEquals(html.includes('Frozen characterization source'), true);
    assertEquals(html.includes('storageObjectPath'), false);
    assertEquals(html.includes('synthetic-local-context'), false);
    assertEquals(
      JSON.parse(new TextDecoder().decode(canonicalReceiptBytes(bundle.receipt))),
      bundle.receipt,
    );
    await assertRejects(
      () =>
        verifyExport(
          bundle.manifestBytes,
          bundle.receipt,
          bundle.files.map((file) =>
            file.path === 'report.html'
              ? { ...file, bytes: new TextEncoder().encode('Changed conclusion') }
              : file,
          ),
          anchors,
          expected,
        ),
      Error,
      'export_file_integrity',
    );
    assertEquals(f.state.uploads, 4);
    assertEquals(f.state.consumes, 3);
  },
);

Deno.test(
  'P2 rejects wrong claims and actor binding before uploads; revocation retains unknown bytes',
  async () => {
    for (const change of ['value', 'unit', 'bundle']) {
      const f = await fixture();
      const request = structuredClone(f.create);
      if (change === 'value') request.content.claims[0].canonicalValue = '999';
      if (change === 'unit') request.content.claims[0].unit = 'other unit';
      if (change === 'bundle') request.content.claims[0].bundleRef.contentHash = 'a'.repeat(64);
      const result = await f.call(request);
      assertEquals(result.status, 409);
      assertEquals(result.body.code, 'REFERENCE_MISMATCH');
      assertEquals(f.state.uploads, 0);
      assertEquals(f.state.consumes, 0);
    }
    const wrong = await fixture();
    wrong.state.wrongActor = true;
    assertEquals((await wrong.call(wrong.create)).status, 502);
    assertEquals(wrong.state.downloads, 0);
    const revoked = await fixture();
    revoked.state.revokeOnUpload = true;
    const result = await revoked.call(revoked.create);
    assertEquals(result.status, 403);
    assertEquals(revoked.state.consumes, 0);
    assertEquals(revoked.storage.has(u(3)), true);
  },
);

Deno.test(
  'P2 pending intent recovery permits a fresh transport requestId without changing intent identity',
  async () => {
    const f = await fixture();
    f.state.failUploadOnce = true;
    f.state.preservePendingRequest = true;
    const first = await f.call(f.create);
    assertEquals(first.status, 502);
    assertEquals(f.state.consumes, 0);
    const before = f.storage.get(u(3));
    const retry = await f.call({ ...f.create, requestId: u(99) });
    assertEquals(retry.status, 200);
    assertEquals(retry.body.requestId, u(99));
    assertEquals(retry.body.data.value.revision, 1);
    assertEquals(f.storage.get(u(3)), before);
    assertEquals(f.state.consumes, 1);
  },
);

Deno.test(
  'P2 freezes only a renderable bounded report and preserves versioned pre-body errors',
  async () => {
    const f = await fixture();
    assertEquals((await f.call(f.create)).status, 200);
    f.reporting.renderer = {
      ...bundledReportingRenderer,
      render: async () => 'x'.repeat(3 * 1024 * 1024),
    };
    const result = await f.call({
      schemaVersion: API_SCHEMA,
      requestId: u(12),
      idempotencyKey: u(13),
      operation: 'report.freeze',
      target: { type: 'reportRevision', id: u(1), expectedRevision: 1 },
      expectedContentHash: f.getReport().contentHash,
    });
    assertEquals(result.status, 413);
    assertEquals(result.body.code, 'PAYLOAD_TOO_LARGE');
    assertEquals(f.getReport().status, 'draft');
    assertEquals(f.state.consumes, 1);
    const handler = createStudyHandler({
      resolveActor: async () => ({ ok: false, response: new Response(null, { status: 401 }) }),
    });
    const unauthorized = await handler(
      new Request('http://127.0.0.1/', {
        method: 'POST',
        headers: { 'x-study-schema': API_SCHEMA },
        body: 'not parsed before authentication',
      }),
    );
    assertEquals(unauthorized.status, 401);
    assertEquals((await unauthorized.json()).schemaVersion, API_SCHEMA);
    const authenticated = createStudyHandler({
      resolveActor: async () => ({ ok: true, value: f.actor }),
      reporting: f.reporting,
    });
    const mismatch = await authenticated(
      new Request('http://127.0.0.1/', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-study-schema': 'lca.study-api.v2' },
        body: JSON.stringify({
          schemaVersion: API_SCHEMA,
          requestId: u(20),
          operation: 'capability.read',
        }),
      }),
    );
    assertEquals(mismatch.status, 400);
    assertEquals((await mismatch.json()).issues[0].ruleId, 'schema.header_binding');
  },
);
