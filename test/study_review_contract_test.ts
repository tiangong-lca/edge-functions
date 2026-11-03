import { assertEquals, assertRejects, assertThrows } from 'jsr:@std/assert';
import {
  parseRequest,
  parseResponse,
  validateResponseForRequest,
  operationMetadata,
} from '../contracts/lca-study/v4/codec.ts';
import { canonicalBytes, base64Url, sha256 } from '../contracts/lca-study/v3/canonical.ts';
import {
  exportManifestSchema,
  signExportManifest,
  verifyExport,
  verifyVersionedExport,
  validateExportViewBindings,
} from '../contracts/lca-study/v4/export.ts';
import { bundledReportingRenderer } from '../supabase/functions/_shared/study/reporting_view.ts';
import {
  exportManifestSchema as legacyManifest,
  signExportManifest as legacySign,
  verifyExport as legacyVerify,
} from '../contracts/lca-study/v3/export.ts';
import { reportStateSchema } from '../contracts/lca-study/v4/review.ts';
const fixtures = new URL('./fixtures/lca-study-api/v4/', import.meta.url);
const read = async (name: string) => JSON.parse(await Deno.readTextFile(new URL(name, fixtures)));
Deno.test(
  'V4 contained vocabulary strictly binds actors, report hashes, review chains and selection',
  async () => {
    const f = await read('protocol.json');
    for (const request of f.requests) assertEquals(parseRequest(request), request);
    for (const response of f.responses) parseResponse(response);
    const review = f.requests.find((r: { operation: string }) => r.operation === 'review.record');
    validateResponseForRequest(parseRequest(review), parseResponse(f.responses[0]));
    assertThrows(() =>
      parseRequest({ ...review, decision: 'withdraw', predecessorReviewId: null }),
    );
    assertEquals(
      parseRequest({ ...review, decision: 'withdraw', predecessorReviewId: 'previous-review' })
        .operation,
      'review.record',
    );
    for (const decision of ['approve', 'reject'])
      assertEquals(
        parseRequest({ ...review, decision, predecessorReviewId: null }).operation,
        'review.record',
      );
    for (const field of [
      'reportRevisionId',
      'expectedContentHash',
      'predecessorReviewId',
      'decision',
      'delegationId',
    ] as const) {
      const request = {
        ...review,
        [field]:
          field === 'expectedContentHash'
            ? 'f'.repeat(64)
            : field === 'decision'
              ? 'reject'
              : 'other',
      };
      assertThrows(() =>
        validateResponseForRequest(parseRequest(request), parseResponse(f.responses[0])),
      );
    }
    for (const extra of [
      { evidence: 'I approve' },
      { actorId: f.review.actorId },
      { reviewClass: 'independent' },
      { comment: '<script>bad</script>' },
    ])
      assertThrows(() => parseRequest({ ...review, ...extra }));
    const delegation = f.requests.find(
      (r: { operation: string }) => r.operation === 'review.delegation.issue',
    );
    assertThrows(() =>
      parseRequest({ ...delegation, decision: 'withdraw', predecessorReviewId: null }),
    );
    assertEquals(
      parseRequest({ ...delegation, decision: 'withdraw', predecessorReviewId: 'previous-review' })
        .operation,
      'review.delegation.issue',
    );
    for (const decision of ['approve', 'reject'])
      assertEquals(
        parseRequest({ ...delegation, decision, predecessorReviewId: null }).operation,
        'review.delegation.issue',
      );
    const final = f.requests.find((r: { operation: string }) => r.operation === 'report.finalize');
    validateResponseForRequest(parseRequest(final), parseResponse(f.responses[1]));
    assertThrows(() => parseRequest({ ...final, acceptedReviewIds: [] }));
    assertThrows(() => parseRequest({ ...final, acceptedReviewIds: ['p3-review', 'p3-review'] }));
    assertEquals(
      reportStateSchema.safeParse({ ...f.currentState, reportContentHash: 'f'.repeat(64) }).success,
      false,
    );
    assertEquals(operationMetadata['resource.actions'].kind, 'query');
    assertEquals(operationMetadata['share.download'].kind, 'query');
    assertEquals(operationMetadata['review.record'].kind, 'mutation');
  },
);
async function exported() {
  const f = await read('protocol.json'),
    view = bundledReportingRenderer.validate(await read('view.json'));
  const projection = canonicalBytes(view),
    html = new TextEncoder().encode(
      await bundledReportingRenderer.render(view, {
        exportId: 'p3-export',
        projectionHash: await sha256(projection),
        verificationAtGeneration: 'verified_by_trusted_exporter',
      }),
    );
  const files = [
    { path: 'report.html' as const, bytes: html },
    { path: 'projection.json' as const, bytes: projection },
  ];
  const manifest = exportManifestSchema.parse({
    schemaVersion: 'lca.study-export-manifest.v2',
    issuerId: 'fixture',
    exportId: 'p3-export',
    studyId: 'p3-study',
    reportRevisionId: 'p3-report',
    reportContentHash: f.currentState.reportContentHash,
    actorId: f.finalization.actorId,
    clientId: null,
    grantEpoch: 1,
    policyId: 'lca.study-report-disclosure.v1',
    disclosureContextHash: 'e'.repeat(64),
    generatedAt: view.report.generatedAt,
    validitySnapshot: f.currentState.validity,
    reviewIds: ['p3-review'],
    finalization: f.finalization,
    renderer: {
      version: '1.0.0',
      viewModelVersion: 'lca.study-report-view.v1',
      artifactHash: bundledReportingRenderer.artifactHash,
    },
    files: await Promise.all(
      files.map(async (file) => ({
        path: file.path,
        mediaType: file.path === 'report.html' ? 'text/html' : 'application/json',
        sha256: await sha256(file.bytes),
        byteSize: file.bytes.length,
      })),
    ),
  });
  const keys = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const anchor = {
    keyId: 'fixture-key',
    issuerId: 'fixture',
    publicKeySpki: base64Url(new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey))),
    validFrom: '2026-01-01T00:00:00Z',
    validUntil: '2027-01-01T00:00:00Z',
    rendererArtifactHashes: [bundledReportingRenderer.artifactHash],
  };
  const expected = {
    issuerId: manifest.issuerId,
    exportId: manifest.exportId,
    studyId: manifest.studyId,
    reportRevisionId: manifest.reportRevisionId,
    reportContentHash: manifest.reportContentHash,
  };
  return { view, manifest, files, keys, anchor, expected };
}
Deno.test(
  'V4 actual safe view, visible HTML and immutable finalization are signed with exact bindings',
  async () => {
    const f = await exported();
    validateExportViewBindings(f.view, f.manifest);
    const receipt = await signExportManifest(f.manifest, f.anchor.keyId, f.keys.privateKey);
    assertEquals(
      await verifyExport(canonicalBytes(f.manifest), receipt, f.files, [f.anchor], f.expected),
      f.manifest,
    );
    assertEquals(
      await verifyVersionedExport(
        canonicalBytes(f.manifest),
        receipt,
        f.files,
        [f.anchor],
        f.expected,
      ),
      f.manifest,
    );
    const html = new TextDecoder().decode(f.files[0].bytes);
    assertEquals(html.includes('Reviewed at generation'), true);
    assertEquals(html.includes('Finalized report revision'), true);
    for (const changed of [
      { ...f.view, snapshot: { ...f.view.snapshot, reviewIds: [] } },
      { ...f.view, snapshot: { ...f.view.snapshot, review: 'unreviewed' } },
      { ...f.view, snapshot: { ...f.view.snapshot, finalization: 'not_finalized' } },
      { ...f.view, report: { ...f.view.report, contentHash: 'f'.repeat(64) } },
    ])
      assertThrows(() => validateExportViewBindings(changed, f.manifest));
    assertThrows(() =>
      exportManifestSchema.parse({
        ...f.manifest,
        finalization: { ...f.manifest.finalization, acceptedReviewIds: ['different'] },
      }),
    );
    await assertRejects(
      () =>
        verifyExport(
          canonicalBytes(f.manifest),
          receipt,
          [
            { ...f.files[0], bytes: new TextEncoder().encode('<p>Independent approval</p>') },
            f.files[1],
          ],
          [f.anchor],
          f.expected,
        ),
      Error,
      'export_file_integrity',
    );
    await assertRejects(() =>
      legacyVerify(canonicalBytes(f.manifest), receipt, f.files, [f.anchor], f.expected),
    );
  },
);
Deno.test(
  'V4 version discriminator preserves historical P2 unreviewed manifest verification',
  async () => {
    const f = await exported();
    const { finalization: _finalization, ...base } = f.manifest;
    const historical = legacyManifest.parse({
      ...base,
      schemaVersion: 'lca.study-export-manifest.v1',
      reviewIds: [],
    });
    const receipt = await legacySign(historical, f.anchor.keyId, f.keys.privateKey);
    assertEquals(
      await verifyVersionedExport(
        canonicalBytes(historical),
        receipt,
        f.files,
        [f.anchor],
        f.expected,
      ),
      historical,
    );
    await assertRejects(() =>
      verifyExport(canonicalBytes(historical), receipt, f.files, [f.anchor], f.expected),
    );
  },
);

Deno.test(
  'V4 closed contracts accept actual corrected Database906 service and fresh replay projections',
  async () => {
    const { reviewContextSchema } =
      await import('../supabase/functions/_shared/study/review_context.ts');
    const { responseDataSchema } = await import('../contracts/lca-study/v4/responses.ts');
    const fixture = await read('database-service-contexts.json');
    for (const [operation, wrapped] of Object.entries(fixture.contexts)) {
      const context = reviewContextSchema.parse((wrapped as { data: unknown }).data);
      assertEquals(context.operation, operation);
      if (context.producerContext)
        assertEquals(
          context.currentState.reportContentHash,
          context.producerContext.report!.contentHash,
        );
      if (operation === 'export.download') {
        assertEquals(context.producerContext, null);
        assertEquals(context.share, null);
        assertEquals(context.artifact!.artifactRef, context.export!.bundleRef);
      }
    }
    const responses = fixture.responses.map((wrapped: { data: unknown }) =>
      responseDataSchema.parse(wrapped.data),
    );
    assertEquals(responses.length, 6);
    const finalization = responses.find(
      (data: any) =>
        data.type === 'finalization' &&
        data.value.finalizationId !== data.state.finalization.finalizationId,
    );
    assertEquals(
      finalization.value.finalizationId === finalization.state.finalization.finalizationId,
      false,
    );
    for (const [index, data] of responses.entries()) {
      const base = { schemaVersion: 'lca.study-api.v4', requestId: `actual-response-${index}` };
      const request =
        data.type === 'review'
          ? {
              ...base,
              operation: 'review.record',
              idempotencyKey: `actual-review-${index}`,
              reportRevisionId: data.value.reportRevisionId,
              expectedContentHash: data.value.reportContentHash,
              reviewClass: data.value.reviewClass,
              decision: data.value.decision,
              comment: data.value.comment,
              predecessorReviewId: data.value.predecessorReviewId,
              delegationId: data.value.delegationId,
            }
          : data.type === 'finalization'
            ? {
                ...base,
                operation: 'report.finalize',
                idempotencyKey: `actual-final-${index}`,
                target: {
                  type: 'reportRevision',
                  id: data.value.reportRevisionId,
                  expectedRevision: data.state.reportRevision,
                },
                expectedContentHash: data.value.reportContentHash,
                expectedReviewStateHash: data.value.expectedReviewStateHash,
                profileId: data.value.profileId,
                acceptedReviewIds: data.value.acceptedReviewIds,
              }
            : { ...base, operation: 'resource.actions', resource: data.resource };
      validateResponseForRequest(parseRequest(request), parseResponse({ ...base, ok: true, data }));
    }
    const roles = responses.find((data: { type: string }) => data.type === 'actions');
    assertEquals(roles.allowedMemberRoles, ['reviewer']);
  },
);

Deno.test(
  'V4 replay validators retain original outcomes alongside fresh current review, finalization and delegation metadata',
  async () => {
    const f = await read('protocol.json');
    const reply = (data: unknown) =>
      parseResponse({ schemaVersion: 'lca.study-api.v4', requestId: 'p3-request', ok: true, data });
    const review = f.requests.find((r: { operation: string }) => r.operation === 'review.record');
    const withdrawn = {
      ...f.currentState,
      reviewStateHash: 'c'.repeat(64),
      acceptedReviewIds: [],
      acceptance: 'invalidated',
    };
    validateResponseForRequest(
      parseRequest(review),
      reply({ type: 'review', value: f.review, state: withdrawn }),
    );
    const finalized = f.requests.find(
      (r: { operation: string }) => r.operation === 'report.finalize',
    );
    const later = {
      ...f.finalization,
      finalizationId: 'later-finalization',
      profileId: 'lca.study-report-unreviewed.v1',
      expectedReviewStateHash: 'c'.repeat(64),
      acceptedReviewIds: [],
    };
    validateResponseForRequest(
      parseRequest(finalized),
      reply({
        type: 'finalization',
        value: f.finalization,
        state: { ...withdrawn, finalization: later, acceptance: 'current' },
      }),
    );
    const issue = f.requests.find(
      (r: { operation: string }) => r.operation === 'review.delegation.issue',
    );
    const delegation = {
      studyId: 'p3-study',
      reportRevisionId: issue.reportRevisionId,
      reportContentHash: issue.expectedContentHash,
      delegationId: 'delegation-1',
      actorId: f.review.actorId,
      clientId: issue.clientId,
      reviewClass: issue.reviewClass,
      decision: issue.decision,
      predecessorReviewId: issue.predecessorReviewId,
      issuedAt: '2026-11-03T00:00:00Z',
      expiresAt: issue.expiresAt,
      revokedAt: '2026-11-03T00:05:00Z',
      consumedReviewId: f.review.reviewId,
    };
    validateResponseForRequest(
      parseRequest(issue),
      reply({ type: 'delegation', value: delegation }),
    );
    assertEquals(operationMetadata['export.download'].kind, 'query');
  },
);

Deno.test(
  'V4 actions carry exact Database-provided member-role choices without consumer role inference',
  () => {
    const request = parseRequest({
      schemaVersion: 'lca.study-api.v4',
      requestId: 'roles',
      operation: 'resource.actions',
      resource: { type: 'study', id: 'study-1' },
    });
    const reply = (allowedMemberRoles: string[]) =>
      parseResponse({
        schemaVersion: 'lca.study-api.v4',
        requestId: 'roles',
        ok: true,
        data: {
          type: 'actions',
          resource: { type: 'study', id: 'study-1' },
          actions: ['member.set'],
          allowedMemberRoles,
        },
      });
    validateResponseForRequest(request, reply(['reviewer']));
    validateResponseForRequest(request, reply(['editor', 'reviewer', 'viewer']));
    assertThrows(() => reply(['reviewer', 'reviewer']));
    assertThrows(() => validateResponseForRequest(request, reply([])));
  },
);
