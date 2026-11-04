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

import { reportingFixture as fixture } from './study_reporting_fixture.ts';
const u = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

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
