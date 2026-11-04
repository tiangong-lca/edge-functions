import { assert, assertEquals, assertRejects, assertThrows } from 'jsr:@std/assert';
import { advancedReviewFixture } from './study_advanced_review_fixture.ts';
import { advancedId } from './study_advanced_fixture.ts';
import { API_SCHEMA, DISABLED_CAPABILITIES } from '../contracts/lca-study/v5/review.ts';
import { reportViewSchema } from '../contracts/lca-study/v5/view.ts';
import { parseExportBundle, verifyExport } from '../contracts/lca-study/v5/export.ts';
import { canonicalBytes, parseCanonicalBytes } from '../contracts/lca-study/v3/canonical.ts';
import {
  parseRequest as parseLegacyRequest,
  parseResponse as parseLegacyResponse,
} from '../contracts/lca-study/v4/codec.ts';
type RecordValue = Record<string, any>;

Deno.test(
  'V5 advanced review exports exact native claims with renderer v2 and detached manifest/bundle v3',
  async () => {
    const f = await advancedReviewFixture();
    const value = await f.call(f.request);
    assertEquals(value.status, 200);
    assertEquals(value.body.schemaVersion, API_SCHEMA);
    assertEquals(f.flags.consumes, 1);
    assertEquals(f.flags.uploads, 3);
    assertEquals(f.native.getReport(), f.frozen);
    assertEquals(f.native.baseline, f.native.baselineBefore);
    const bytes = f.native.storage.get(f.producer.bundleArtifactId)!;
    assertEquals(
      (parseCanonicalBytes(bytes) as RecordValue).schemaVersion,
      'lca.study-export-bundle.v3',
    );
    const bundle = parseExportBundle(bytes),
      anchors = await f.trust();
    const manifest = await verifyExport(
      bundle.manifestBytes,
      bundle.receipt,
      bundle.files,
      anchors,
      f.expected,
    );
    assertEquals(manifest.schemaVersion, 'lca.study-export-manifest.v3');
    assertEquals(manifest.renderer.version, '2.0.0');
    assertEquals(manifest.renderer.viewModelVersion, 'lca.study-report-view.v2');
    assertEquals(manifest.finalization, f.finalization);
    assertEquals(manifest.reviewIds, f.finalization.acceptedReviewIds);
    const projection = reportViewSchema.parse(
      parseCanonicalBytes(bundle.files.find((file) => file.path === 'projection.json')!.bytes),
    );
    assertEquals(projection.snapshot.review, 'reviewed');
    assertEquals(projection.snapshot.finalization, 'finalized');
    assertEquals(projection.snapshot.reviewIds, f.finalization.acceptedReviewIds);
    const html = new TextDecoder().decode(
      bundle.files.find((file) => file.path === 'report.html')!.bytes,
    );
    assert(html.includes('Frozen characterization source'));
    assertEquals(html.includes('No LCIA method (activity or inventory fact)'), false);
    const uploads = f.flags.uploads;
    const replay = await f.call({ ...f.request, requestId: advancedId(1200) });
    assertEquals(replay.status, 200);
    assertEquals(replay.body.data, value.body.data);
    assertEquals(f.flags.uploads, uploads);
    assertEquals(f.flags.consumes, 1);
  },
);

Deno.test(
  'V5 report view preserves exact coverage/reasons, complete settings and real baseline provenance',
  async () => {
    const f = await advancedReviewFixture();
    const response = await f.call(f.viewRequest);
    assertEquals(response.status, 200);
    const view = reportViewSchema.parse(response.body.data.view);
    assertEquals(view.schemaVersion, 'lca.study-report-view.v2');
    assertEquals(view.rendererVersion, '2.0.0');
    assertEquals(
      view.runs.map((run) => run.runId),
      [f.native.input.analysis.config.baselineRunId],
    );
    for (const fact of view.facts) {
      const claim = f.native.content.claims.find((c) => c.claimId === fact.factId);
      assert(claim);
      const source = f.native.facts.factCatalog.find(
        (v: { factId: string }) => v.factId === claim.factId,
      );
      assert(source);
      assertEquals(fact.canonicalValue, source.canonicalValue);
      assertEquals(fact.coverage, source.coverage);
      assertEquals(fact.reasonCodes, source.reasonCodes);
      assertEquals(fact.runIds, [source.baselineRunId]);
      assertEquals(fact.provenance, {
        type: 'analysisFacts',
        id: f.native.analysis.factsRef.id,
        contentHash: f.native.analysis.factsRef.contentHash,
      });
    }
    const metadata = view.sections
      .filter((section) => section.title.includes('settings'))
      .flatMap((section) => section.paragraphs)
      .join('');
    for (const token of [
      f.native.analysis.configHash,
      f.native.facts.producerVersion,
      f.native.facts.baseline.methodSourceHash,
      f.native.facts.sourceSnapshotRef.contentHash,
      'executionLimits',
      'resolvedParameters',
      'counts',
    ])
      assert(metadata.includes(token), token);
    assert(view.limitations.some((value) => value.includes('sampling convergence')));
    const serialized = JSON.stringify(view);
    for (const forbidden of [
      'storageBucket',
      'storageObjectPath',
      'sourceAuthorization',
      'ownerActorId',
      'synthetic-advanced-actor-context',
    ])
      assertEquals(serialized.includes(forbidden), false, forbidden);
    const missingReason = structuredClone(view) as RecordValue;
    delete missingReason.facts[0].reasonCodes;
    assertThrows(() => reportViewSchema.parse(missingReason));
    assertThrows(() =>
      parseLegacyResponse({ ...response.body, schemaVersion: 'lca.study-api.v4' }),
    );
    assertThrows(() => parseLegacyRequest({ ...f.request, schemaVersion: 'lca.study-api.v4' }));
    assertEquals(f.flags.uploads, 0);
    assertEquals(f.flags.consumes, 0);
  },
);

Deno.test(
  'V5 detached verification rejects visible HTML and finalization/review identity tampering',
  async () => {
    const f = await advancedReviewFixture();
    assertEquals((await f.call(f.request)).status, 200);
    const bundle = parseExportBundle(f.native.storage.get(f.producer.bundleArtifactId)!);
    const anchors = await f.trust();
    const changedFiles = bundle.files.map((file) =>
      file.path === 'report.html'
        ? {
            ...file,
            bytes: new TextEncoder().encode(
              new TextDecoder().decode(file.bytes) + '<p>Changed visible result</p>',
            ),
          }
        : file,
    );
    await assertRejects(() =>
      verifyExport(bundle.manifestBytes, bundle.receipt, changedFiles, anchors, f.expected),
    );
    const changedReview = parseCanonicalBytes(bundle.manifestBytes) as RecordValue;
    changedReview.reviewIds = [advancedId(1990)];
    changedReview.finalization.acceptedReviewIds = [advancedId(1990)];
    await assertRejects(() =>
      verifyExport(
        canonicalBytes(changedReview),
        bundle.receipt,
        bundle.files,
        anchors,
        f.expected,
      ),
    );
    const changedFinal = parseCanonicalBytes(bundle.manifestBytes) as RecordValue;
    changedFinal.finalization.finalizationId = advancedId(1991);
    await assertRejects(() =>
      verifyExport(canonicalBytes(changedFinal), bundle.receipt, bundle.files, anchors, f.expected),
    );
    await assertRejects(() =>
      verifyExport(bundle.manifestBytes, bundle.receipt, bundle.files, anchors, {
        ...f.expected,
        reportContentHash: 'a'.repeat(64),
      }),
    );
    await assertRejects(() =>
      verifyExport(
        bundle.manifestBytes,
        bundle.receipt,
        bundle.files,
        [{ ...anchors[0], rendererArtifactHashes: ['a'.repeat(64)] }],
        f.expected,
      ),
    );
  },
);

Deno.test(
  'V5 advanced review denies revoked or changed authorization after Storage reads and uploads',
  async () => {
    for (const flag of ['revokeDuringRead', 'changeDuringRead', 'revokeDuringUpload'] as const) {
      const f = await advancedReviewFixture();
      f.flags[flag] = true;
      const result = await f.call(f.request);
      assertEquals(result.status, flag === 'changeDuringRead' ? 409 : 403, flag);
      assertEquals(result.body.ok, false);
      assertEquals(f.flags.consumes, 0);
      assertEquals(f.flags.uploads, flag === 'revokeDuringUpload' ? 1 : 0);
      assertEquals(f.native.getReport(), f.frozen);
    }
  },
);

Deno.test(
  'V5 advanced export rejects stale finalization and mismatched source/actor service contexts',
  async () => {
    const stale = await advancedReviewFixture();
    const staleResult = await stale.call({
      ...stale.request,
      expectedReviewStateHash: 'c'.repeat(64),
    });
    assertEquals(staleResult.status, 409);
    assertEquals(stale.flags.downloads, 0);
    assertEquals(stale.flags.uploads, 0);
    for (const kind of ['source', 'actor', 'client'] as const) {
      const f = await advancedReviewFixture();
      if (kind === 'source')
        f.flags.mutateContext = (c) => {
          c.producerContext.analyses[0].sourceSnapshotRef.contentHash = 'a'.repeat(64);
        };
      if (kind === 'actor') f.flags.wrongActor = true;
      if (kind === 'client') f.flags.wrongClient = true;
      const result = await f.call(f.request);
      assertEquals(result.status, kind === 'source' ? 409 : 502, kind);
      assertEquals(result.body.code, 'REFERENCE_MISMATCH');
      assertEquals(f.flags.uploads, 0);
      assertEquals(f.flags.consumes, 0);
    }
  },
);

Deno.test(
  'V5 review capability and renderer admission remain separate from existing authoring authority',
  async () => {
    const f = await advancedReviewFixture();
    const disabled = await f.call(f.request, { config: () => DISABLED_CAPABILITIES });
    assertEquals(disabled.status, 503);
    assertEquals(f.flags.dispatches, 0);
    const noRenderer = await f.call(f.request, { renderer: null });
    assertEquals(noRenderer.status, 503);
    assertEquals(f.flags.uploads, 0);
    assertEquals(f.flags.consumes, 0);
    assertEquals(f.native.getReport(), f.frozen);
  },
);

Deno.test(
  'V5 named summary views and downloads retain historical export bytes with fresh live state',
  async () => {
    const f = await advancedReviewFixture();
    assertEquals((await f.call(f.request)).status, 200);
    const share = await f.recipient();
    const request = {
      schemaVersion: API_SCHEMA,
      requestId: advancedId(1300),
      operation: 'share.view',
      shareId: share.shareId,
    };
    const read = await f.call(request);
    assertEquals(read.status, 200);
    assertEquals(read.body.data.share.recipientId, share.recipientId);
    assertEquals(read.body.data.view.snapshot.reviewIds, f.finalization.acceptedReviewIds);
    const download = await f.call({ ...request, operation: 'share.download' });
    assertEquals(download.status, 200);
    const bytes = Uint8Array.from(atob(download.body.data.bytes), (c: string) => c.charCodeAt(0));
    assertEquals(bytes, f.native.storage.get(f.producer.bundleArtifactId));
    f.flags.revoked = true;
    const revoked = await f.call({ ...request, requestId: advancedId(1301) });
    assertEquals(revoked.status, 403);
    assertEquals('data' in revoked.body, false);
  },
);
