import { assert, assertEquals } from 'jsr:@std/assert';
import { advancedFixture, advancedId, advancedFixtureRoot } from './study_advanced_fixture.ts';
import { API_SCHEMA, DISABLED_CAPABILITIES } from '../contracts/lca-study/v5/advanced.ts';
import { DISABLED_CAPABILITIES as PUBLIC_DISABLED } from '../contracts/lca-study/v5/capabilities.ts';
import { parseCanonicalBytes, sha256 } from '../contracts/lca-study/v3/canonical.ts';

Deno.test(
  'V5 authoring validates actual native fact strings and saves canonical v2 bytes without modifying the baseline Run',
  async () => {
    const f = await advancedFixture();
    const originalPrepared = f.storage.get(f.baseline.preparedArtifact.artifactRef.id)!.slice();
    const originalSource = f.storage.get(f.input.sourceArtifact.artifactRef.id)!.slice();
    assertEquals(
      await sha256(originalPrepared),
      f.baseline.preparedArtifact.artifactRef.contentHash,
    );
    assertEquals(await sha256(originalSource), f.input.sourceArtifact.artifactRef.contentHash);
    assertEquals(
      await sha256(f.storage.get(f.baseline.resultArtifact.artifactRef.id)!),
      f.baseline.resultArtifact.artifactRef.contentHash,
    );
    assertEquals(
      await sha256(f.storage.get(f.analysis.factsRef.id)!),
      f.analysis.factsRef.contentHash,
    );
    const created = await f.call(f.create);
    assertEquals(created.status, 200);
    assertEquals(created.body.schemaVersion, API_SCHEMA);
    assertEquals(created.body.data.value.status, 'draft');
    assertEquals(created.body.data.value.templateId, 'lca.study-report.v2');
    assertEquals(created.headers.get('cache-control'), 'no-store');
    const replay = await f.call({ ...f.create, requestId: advancedId(100) });
    assertEquals(replay.status, 200);
    assertEquals(replay.body.data, created.body.data);
    assertEquals(replay.body.requestId, advancedId(100));
    assertEquals(f.state.uploads, 1);
    assertEquals(f.state.consumes, 1);
    const registered = f.getStoredContent();
    const envelope = parseCanonicalBytes(f.storage.get(registered.artifactRef.id)!) as Record<
      string,
      any
    >;
    assertEquals(envelope.schemaVersion, 'lca.study-report-content.v2');
    assertEquals(
      envelope.claims.map((c: Record<string, any>) => c.fact),
      f.content.claims.map((c) =>
        f.facts.factCatalog.find((fact: { factId: string }) => fact.factId === c.factId),
      ),
    );
    assertEquals(
      await sha256(f.storage.get(registered.artifactRef.id)!),
      created.body.data.value.contentHash,
    );
    const updated = structuredClone(f.content);
    updated.title = 'Saved exact OAT evidence';
    const saved = await f.call(f.save(updated));
    assertEquals(saved.status, 200);
    assertEquals(saved.body.data.value.revision, 2);
    assertEquals(f.stored().content.title, updated.title);
    assertEquals(
      f.stored().claims.map((c: Record<string, any>) => c.fact.canonicalValue),
      f.content.claims.map((c) => c.canonicalValue),
    );
    assertEquals(f.baseline, f.baselineBefore);
    assertEquals(f.storage.get(f.baseline.preparedArtifact.artifactRef.id), originalPrepared);
    assertEquals(f.storage.get(f.input.sourceArtifact.artifactRef.id), originalSource);
    assertEquals(saved.body.data.value.runIds, [f.input.analysis.config.baselineRunId]);
    assertEquals(f.state.consumes, 2);
  },
);

Deno.test(
  'V5 report claims reject changed producer values, units, selectors and artifact identities before writing',
  async () => {
    for (const change of ['value', 'unit', 'selector', 'artifact'] as const) {
      const f = await advancedFixture();
      const bad = structuredClone(f.create);
      if (change === 'value') bad.content.claims[0].canonicalValue = '101';
      if (change === 'unit') bad.content.claims[0].unit = '1';
      if (change === 'selector') bad.content.claims[0].factId = 'missing-worker-fact';
      if (change === 'artifact') bad.content.claims[0].bundleRef.contentHash = 'a'.repeat(64);
      const result = await f.call(bad);
      assertEquals(result.status, 409, change);
      assertEquals(result.body.code, 'REFERENCE_MISMATCH');
      assertEquals(f.state.uploads, 0);
      assertEquals(f.state.consumes, 0);
    }
  },
);

Deno.test(
  'V5 parameter catalog projects exact frozen non-reference exchanges and support provenance',
  async () => {
    const f = await advancedFixture();
    const result = await f.call(f.catalog);
    assertEquals(result.status, 200);
    assertEquals(result.body.data.type, 'parameterCatalog');
    const catalog = result.body.data;
    assertEquals(catalog.studyId, f.input.analysis.studyId);
    assertEquals(catalog.baselineRunId, f.input.analysis.config.baselineRunId);
    assertEquals(catalog.preparedArtifactRef, f.baseline.preparedArtifact.artifactRef);
    assertEquals(catalog.inputHash, f.baseline.run.inputHash);
    const { parameterIndex: _index, ...expected } = f.facts.resolvedParameters[0];
    assertEquals(catalog.parameters, [expected]);
    const prepared = JSON.parse(
      new TextDecoder().decode(f.storage.get(catalog.preparedArtifactRef.id)!),
    );
    for (const instance of prepared.model.instances)
      assert(
        !catalog.parameters.some(
          (p: { path: string }) =>
            p.path === `/instances/${instance.id}/exchanges/${instance.referenceExchangeId}/amount`,
        ),
      );
    const text = JSON.stringify(catalog);
    for (const privateField of [
      'storageBucket',
      'storageObjectPath',
      'sourceAuthorization',
      'actorId',
      'ownerActorId',
      'accessToken',
    ])
      assertEquals(text.includes(privateField), false);
    assertEquals(f.state.parameterResolves, 2);
    assertEquals(f.state.downloads, 1);
    assertEquals(f.state.uploads, 0);
  },
);

Deno.test(
  'V5 catalog denies revoked, changed and corrupted reads after actual byte I/O',
  async () => {
    for (const flag of ['revokeOnDownload', 'changeOnDownload', 'corruptDownload'] as const) {
      const f = await advancedFixture();
      f.state[flag] = true;
      const result = await f.call(f.catalog);
      assertEquals(result.status, flag === 'revokeOnDownload' ? 403 : 502, flag);
      assertEquals(result.body.ok, false);
      assertEquals('data' in result.body, false);
      assertEquals(f.state.downloads, 1);
      assertEquals(f.state.uploads, 0);
    }
  },
);

Deno.test(
  'V5 report authorization is rechecked after upload and original actor binding precedes disclosure',
  async () => {
    const f = await advancedFixture();
    f.state.revokeOnUpload = true;
    const denied = await f.call(f.create);
    assertEquals(denied.status, 403);
    assertEquals(f.state.uploads, 1);
    assertEquals(f.state.consumes, 0);
    assertEquals(f.getReport(), null);
    assertEquals(
      [...f.storage.keys()].some((id) => id.startsWith('30000000-0000-4000-8000-')),
      true,
    );
    const wrong = await advancedFixture();
    wrong.state.wrongActor = true;
    const mismatch = await wrong.call(wrong.create);
    assertEquals(mismatch.status, 502);
    assertEquals(mismatch.body.code, 'REFERENCE_MISMATCH');
    assertEquals(wrong.state.downloads, 0);
    assertEquals(wrong.state.consumes, 0);
  },
);

Deno.test(
  'V5 default-off admission, header binding, profile/hash checks and response selection fail before unrelated work',
  async () => {
    const f = await advancedFixture();
    const disabled = f.handler({
      advanced: { ...f.advanced, config: () => DISABLED_CAPABILITIES },
    });
    assertEquals(
      (
        await f.call(
          {
            schemaVersion: API_SCHEMA,
            requestId: 'disabled-capability',
            operation: 'capability.read',
          },
          disabled,
        )
      ).body.data,
      PUBLIC_DISABLED,
    );
    assertEquals((await f.call(f.analysisRequest, disabled)).status, 503);
    assertEquals(f.state.dispatches, 0);
    const header = await f.call(f.analysisRequest, f.handler(), 'lca.study-api.v4');
    assertEquals(header.status, 400);
    assertEquals(header.body.code, 'INVALID_REQUEST');
    assertEquals(f.state.dispatches, 0);
    const hash = await f.call({ ...f.analysisRequest, configHash: 'a'.repeat(64) });
    assertEquals(hash.status, 409);
    const wrongProfile = await f.call({
      ...f.analysisRequest,
      profileId: 'lca.study-uncertainty-bounded.v1',
    });
    assertEquals(wrongProfile.status, 400);
    assertEquals(f.state.dispatches, 0);
    f.state.replyOverride = {
      type: 'analysis',
      value: { ...f.analysis, analysisId: advancedId(999) },
    };
    const selection = await f.call({
      schemaVersion: API_SCHEMA,
      requestId: 'analysis-read',
      operation: 'analysis.read',
      analysisId: f.analysis.analysisId,
    });
    assertEquals(selection.status, 502);
    assertEquals(selection.body.code, 'REFERENCE_MISMATCH');
  },
);

Deno.test(
  'V5 freeze requires its qualified renderer and leaves report state unchanged on unavailable rendering',
  async () => {
    const f = await advancedFixture();
    assertEquals((await f.call(f.create)).status, 200);
    const before = structuredClone(f.getReport());
    const result = await f.call(
      f.freeze(),
      f.handler({ advanced: { ...f.advanced, renderer: null } }),
    );
    assertEquals(result.status, 503);
    assertEquals(result.body.code, 'CAPABILITY_UNAVAILABLE');
    assertEquals(f.getReport(), before);
    assertEquals(f.state.consumes, 1);
    assertEquals(f.state.uploads, 1);
  },
);

Deno.test(
  'V5 producer rejects changed frozen model/source bindings and corrupted native artifacts',
  async () => {
    const altered = await advancedFixture();
    altered.state.mutateContext = (c) => {
      c.runs[0].run.effectiveModelRef.contentHash = 'a'.repeat(64);
    };
    const mismatch = await altered.call(altered.create);
    assertEquals(mismatch.status, 409);
    assertEquals(mismatch.body.code, 'REFERENCE_MISMATCH');
    assertEquals(altered.state.downloads, 0);
    const source = await advancedFixture();
    source.state.mutateContext = (c) => {
      c.analyses[0].sourceSnapshotRef.contentHash = 'a'.repeat(64);
    };
    const sourceMismatch = await source.call(source.create);
    assertEquals(sourceMismatch.status, 409);
    assertEquals(sourceMismatch.body.code, 'REFERENCE_MISMATCH');
    assertEquals(source.state.uploads, 0);
    assertEquals(source.state.consumes, 0);
    const corrupt = await advancedFixture();
    corrupt.state.corruptDownload = true;
    const failed = await corrupt.call(corrupt.create);
    assertEquals(failed.status, 502);
    assertEquals(failed.body.code, 'REFERENCE_MISMATCH');
    assertEquals(corrupt.state.uploads, 0);
    assertEquals(corrupt.state.consumes, 0);
    const frozenBytes = await Deno.readFile(new URL('prepared.json', advancedFixtureRoot));
    assertEquals(
      corrupt.storage.get(corrupt.baseline.preparedArtifact.artifactRef.id),
      frozenBytes,
    );
  },
);

Deno.test(
  'V5 admission rollback preserves explicitly allowed historical reads with fresh authorization',
  async () => {
    const f = await advancedFixture();
    assertEquals((await f.call(f.create)).status, 200);
    const paused = {
      ...DISABLED_CAPABILITIES,
      operations: [
        'capability.read',
        'analysis.read',
        'report.read',
        'analysis.parameters.read',
      ] as const,
    };
    const config = () => ({ ...paused, operations: [...paused.operations] });
    const repository = {
      ...f.repository,
      dispatch: async (
        request: Parameters<typeof f.repository.dispatch>[0],
        signal: AbortSignal,
      ) =>
        request.operation === 'capability.read'
          ? { ok: true, data: config() }
          : await f.repository.dispatch(request, signal),
    };
    const handler = f.handler({
      advanced: { ...f.advanced, config, repository: () => repository },
    });
    const caps = await f.call(
      { schemaVersion: API_SCHEMA, requestId: 'paused-caps', operation: 'capability.read' },
      handler,
    );
    assertEquals(caps.status, 200);
    assertEquals(caps.body.data.runtimeEnabled, false);
    assertEquals(caps.body.data.operations, paused.operations);
    assertEquals(caps.body.data.analysisProfiles, []);
    assertEquals(caps.body.data.reportTemplates, []);
    const read = {
      schemaVersion: API_SCHEMA,
      requestId: 'paused-analysis',
      operation: 'analysis.read',
      analysisId: f.analysis.analysisId,
    };
    assertEquals((await f.call(read, handler)).status, 200);
    assertEquals(
      (
        await f.call(
          {
            schemaVersion: API_SCHEMA,
            requestId: 'paused-report',
            operation: 'report.read',
            reportRevisionId: f.getReport().reportRevisionId,
          },
          handler,
        )
      ).status,
      200,
    );
    assertEquals((await f.call(f.catalog, handler)).status, 200);
    assertEquals((await f.call(f.analysisRequest, handler)).status, 503);
    assertEquals((await f.call(f.save(), handler)).status, 503);
    assertEquals((await f.call(f.freeze(), handler)).status, 503);
    f.state.revoked = true;
    assertEquals(
      (await f.call({ ...read, requestId: 'paused-after-revoke' }, handler)).status,
      403,
    );
  },
);
