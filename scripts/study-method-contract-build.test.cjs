'use strict';
const assert = require('node:assert/strict');
const { createHash, verify, createPublicKey } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { mkdtemp, readFile, writeFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const root = path.resolve(__dirname, '..');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (name) => JSON.parse(await readFile(path.join(root, name), 'utf8'));

test('V6 portable consumer is deterministic, source-bound and usable outside source in Node/Deno', async () => {
  const { buildStudyContract } = await import('./build-study-contract.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'study-method-codec-'));
  try {
    const output = path.join(temp, 'first');
    const manifest = await buildStudyContract(output, { allowDirty: true, apiVersion: 'v6' });
    assert.deepEqual(
      await buildStudyContract(path.join(temp, 'second'), { allowDirty: true, apiVersion: 'v6' }),
      manifest,
    );
    assert.equal(manifest.apiSchema, 'lca.study-api.v6');
    assert.equal(manifest.contractVersion, '6.0.0');
    for (const file of manifest.files) {
      const bytes = await readFile(path.join(output, file.path));
      assert.equal(bytes.length, file.bytes);
      assert.equal(digest(bytes), file.sha256);
    }
    for (const input of manifest.inputs) {
      const bytes = await readFile(path.join(root, input.path));
      assert.equal(bytes.length, input.bytes);
      assert.equal(digest(bytes), input.sha256);
    }
    const renderer = await json(
      'supabase/functions/_shared/study/vendor/renderer-v3/manifest.json',
    );
    for (const file of renderer.files)
      assert(
        manifest.inputs.some(
          (input) =>
            input.path.endsWith(`/renderer-v3/${file.path}`) && input.sha256 === file.sha256,
        ),
      );
    const worker = await json('contracts/lca-study/worker/method/manifest.json');
    for (const [name, sha256] of Object.entries(worker.schemas))
      assert(manifest.inputs.some((input) => input.path === name && input.sha256 === sha256));
    const codec = await import(pathToFileURL(path.join(output, 'index.mjs')).href);
    const service = await json('test/fixtures/lca-study-v6/database-report-contexts.json');
    const actual = (await json('test/fixtures/lca-study-v6/database-public-dtos.json')).responses;
    const request = codec.parseRequest(service.methodRequest);
    const q = {
      schemaVersion: codec.API_SCHEMA,
      requestId: 'portable-method',
      operation: 'method.assessment.read',
      assessmentId: service.methodRecord.data.value.assessmentId,
    };
    const response = {
      schemaVersion: codec.API_SCHEMA,
      requestId: q.requestId,
      ok: true,
      data: service.methodRecord.data,
    };
    codec.validateResponseForRequest(codec.parseRequest(q), codec.parseResponse(response));
    assert.equal(await codec.methodConfigHash(request.config), request.configHash);
    assert.equal(
      await codec.methodEvidenceHash(service.evidenceContext.data.request.content),
      service.evidenceContext.data.contentHash,
    );
    for (const data of [
      {
        ...actual.authoringCapability,
        ...actual.reviewCapability,
        operations: [
          ...new Set([
            ...actual.authoringCapability.operations,
            ...actual.reviewCapability.operations,
          ]),
        ],
      },
      actual.methodTask,
      actual.assessmentActions,
      actual.methodResourcePage,
      actual.shareActions,
    ])
      codec.parseResponse({ ...response, data });
    assert.throws(() => codec.parseRequest({ ...q, schemaVersion: 'lca.study-api.v5' }), {
      code: 'UNSUPPORTED_SCHEMA',
    });
    assert.throws(
      () => codec.parseRequest({ ...q, credential: 'secret-sentinel' }),
      (error) => error.code === 'INVALID_REQUEST' && !String(error).includes('secret-sentinel'),
    );
    assert.throws(() =>
      codec.validateResponseForRequest(
        codec.parseRequest(q),
        codec.parseResponse({ ...response, requestId: 'different' }),
      ),
    );
    assert.equal(codec.operationMetadata['method.assessment.request'].kind, 'mutation');
    assert.equal(codec.operationMetadata['method.evidence.read'].kind, 'query');
    const requestSchema = await json(path.relative(root, path.join(output, 'request.schema.json')));
    assert.match(JSON.stringify(requestSchema), /method\.evidence\.create/);
    const responseSchema = JSON.parse(
      await readFile(path.join(output, 'response.schema.json'), 'utf8'),
    );
    assert.match(JSON.stringify(responseSchema), /lca\.study-method-report-summary\.v1/);
    const declarations = await readFile(path.join(output, 'index.d.ts'), 'utf8');
    assert.doesNotMatch(declarations, /from\s+['"]|import\(/);
    await writeFile(
      path.join(output, 'types.ts'),
      `import type {StudyApiRequest,StudyApiResponse,ExportManifest,HistoricalExportManifest} from './index.d.ts';\nconst q:StudyApiRequest=${JSON.stringify(q)};\nconst operation:'method.assessment.read'=q.operation;\nlet response:StudyApiResponse|undefined;let current:ExportManifest|undefined;let retained:HistoricalExportManifest|undefined;void [operation,response,current,retained];\n// @ts-expect-error no old-version fallback\nconst old:StudyApiRequest={schemaVersion:'lca.study-api.v5',requestId:'x',operation:'capability.read'};\nvoid old;\n`,
    );
    execFileSync('deno', ['check', '--no-config', '--no-npm', path.join(output, 'types.ts')], {
      cwd: temp,
      stdio: 'pipe',
    });
    const result = execFileSync(
      'deno',
      [
        'eval',
        '--no-config',
        '--no-npm',
        `const c=await import(${JSON.stringify(pathToFileURL(path.join(output, 'index.mjs')).href)});const q=c.parseRequest(${JSON.stringify(q)});c.validateResponseForRequest(q,c.parseResponse(${JSON.stringify(response)}));console.log(q.operation);`,
      ],
      { cwd: temp, encoding: 'utf8' },
    );
    assert.equal(result.trim(), 'method.assessment.read');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('V6 portable export4 binds independently trusted signatures and exact complete View3 bytes', async () => {
  const { buildStudyContract } = await import('./build-study-contract.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'study-method-export-'));
  try {
    const output = path.join(temp, 'codec');
    await buildStudyContract(output, { allowDirty: true, apiVersion: 'v6' });
    const c = await import(pathToFileURL(path.join(output, 'index.mjs')).href);
    const view = (
      await json('supabase/functions/_shared/study/vendor/renderer-v3/methodProtocol.fixture.json')
    ).view;
    view.snapshot.finalization = 'finalized';
    const files = [
      {
        path: 'report.html',
        bytes: Buffer.from('<!doctype html><p>Synthetic signed transport fixture</p>'),
      },
      { path: 'projection.json', bytes: c.canonicalBytes(view) },
    ];
    const finalization = {
      finalizationId: 'fixture-finalization',
      studyId: view.report.studyId,
      reportRevisionId: view.report.reportRevisionId,
      reportContentHash: view.report.contentHash,
      profileId: 'lca.study-report-unreviewed.v1',
      expectedReviewStateHash: 'a'.repeat(64),
      acceptedReviewIds: [],
      actorId: '10000000-0000-4000-8000-000000000007',
      finalizedAt: view.report.generatedAt,
    };
    const manifest = {
      schemaVersion: 'lca.study-export-manifest.v4',
      issuerId: 'fixture-issuer',
      exportId: 'fixture-export',
      studyId: view.report.studyId,
      reportRevisionId: view.report.reportRevisionId,
      reportContentHash: view.report.contentHash,
      actorId: finalization.actorId,
      clientId: null,
      grantEpoch: 1,
      policyId: 'lca.study-report-disclosure.v1',
      disclosureContextHash: 'b'.repeat(64),
      generatedAt: view.report.generatedAt,
      validitySnapshot: {
        status: view.snapshot.validity,
        checkedAt: view.snapshot.checkedAt,
        reasonCodes: [],
      },
      reviewIds: [],
      renderer: {
        version: '3.0.0',
        viewModelVersion: 'lca.study-report-view.v3',
        artifactHash: '3f195573d530d0342815114fb3e14a4856930270df2874883b364f1ea5bc9c58',
      },
      files: files.map((f) => ({
        path: f.path,
        mediaType: f.path.endsWith('.html') ? 'text/html' : 'application/json',
        sha256: digest(f.bytes),
        byteSize: f.bytes.length,
      })),
      finalization,
    };
    const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const spki = Buffer.from(await crypto.subtle.exportKey('spki', keys.publicKey));
    const anchor = {
      keyId: 'fixture-key',
      issuerId: manifest.issuerId,
      publicKeySpki: spki.toString('base64url'),
      validFrom: '2026-01-01T00:00:00Z',
      validUntil: '2027-01-01T00:00:00Z',
      rendererArtifactHashes: [manifest.renderer.artifactHash],
    };
    const receipt = await c.signExportManifest(manifest, anchor.keyId, keys.privateKey);
    const expected = {
      issuerId: manifest.issuerId,
      exportId: manifest.exportId,
      studyId: manifest.studyId,
      reportRevisionId: manifest.reportRevisionId,
      reportContentHash: manifest.reportContentHash,
    };
    const bytes = c.canonicalBytes(manifest);
    assert.deepEqual(
      await c.verifyVersionedExport(bytes, receipt, files, [anchor], expected),
      manifest,
    );
    assert.equal(
      verify(
        null,
        Buffer.concat([Buffer.from('lca.study-export-signature.v1\0'), bytes]),
        createPublicKey({ key: spki, type: 'spki', format: 'der' }),
        Buffer.from(receipt.signature, 'base64url'),
      ),
      true,
    );
    await assert.rejects(
      c.verifyVersionedExport(bytes, receipt, files, [], expected),
      /trust_binding/,
    );
    await assert.rejects(
      c.verifyVersionedExport(
        bytes,
        receipt,
        [{ ...files[0], bytes: Buffer.from('altered') }, files[1]],
        [anchor],
        expected,
      ),
      /file_integrity/,
    );
    await assert.rejects(
      c.verifyVersionedExport(
        c.canonicalBytes({ ...manifest, schemaVersion: 'lca.study-export-manifest.v5' }),
        receipt,
        files,
        [anchor],
        expected,
      ),
    );
    const bundle = c.canonicalBytes({
      schemaVersion: 'lca.study-export-bundle.v4',
      manifestBase64: Buffer.from(bytes).toString('base64'),
      receipt,
      files: files.map((f) => ({
        path: f.path,
        encoding: 'base64',
        bytes: Buffer.from(f.bytes).toString('base64'),
      })),
    });
    const parsed = c.parseExportBundle(bundle);
    assert.deepEqual(Buffer.from(parsed.manifestBytes), Buffer.from(bytes));
    assert.deepEqual(
      await c.verifyVersionedExport(
        parsed.manifestBytes,
        parsed.receipt,
        parsed.files,
        [anchor],
        expected,
      ),
      manifest,
    );
    // Historical signed envelopes retain their original schema; no v4 relabeling.
    for (const version of [1, 2, 3]) {
      const old = structuredClone(manifest);
      old.schemaVersion = `lca.study-export-manifest.v${version}`;
      old.renderer = {
        ...old.renderer,
        version: version === 3 ? '2.0.0' : '1.0.0',
        viewModelVersion: version === 3 ? 'lca.study-report-view.v2' : 'lca.study-report-view.v1',
      };
      if (version === 1) delete old.finalization;
      // V1 authenticates opaque projection bytes. Later retained versions also
      // validate their own view family; none relabels the signed old manifest.
      const signed = Buffer.concat([
        Buffer.from('lca.study-export-signature.v1\0'),
        c.canonicalBytes(old),
      ]);
      const oldReceipt = {
        ...receipt,
        manifestHash: digest(signed),
        signature: Buffer.from(
          await crypto.subtle.sign('Ed25519', keys.privateKey, signed),
        ).toString('base64url'),
      };
      if (version === 1)
        assert.equal(
          (
            await c.verifyVersionedExport(
              c.canonicalBytes(old),
              oldReceipt,
              files,
              [anchor],
              expected,
            )
          ).schemaVersion,
          old.schemaVersion,
        );
      else
        await assert.rejects(
          c.verifyVersionedExport(c.canonicalBytes(old), oldReceipt, files, [anchor], expected),
        );
      const retainedView = await json('test/fixtures/lca-study-api/v4/view.json');
      retainedView.schemaVersion =
        version === 3 ? 'lca.study-report-view.v2' : 'lca.study-report-view.v1';
      retainedView.rendererVersion = version === 3 ? '2.0.0' : '1.0.0';
      if (version === 3) for (const fact of retainedView.facts) fact.reasonCodes = [];
      const protocol = await json('test/fixtures/lca-study-api/v4/protocol.json');
      const oldFiles = [
        files[0],
        { path: 'projection.json', bytes: c.canonicalBytes(retainedView) },
      ];
      Object.assign(old, {
        studyId: retainedView.report.studyId,
        reportRevisionId: retainedView.report.reportRevisionId,
        reportContentHash: retainedView.report.contentHash,
        generatedAt: retainedView.report.generatedAt,
        validitySnapshot: protocol.currentState.validity,
        reviewIds: version === 1 ? [] : retainedView.snapshot.reviewIds,
        files: oldFiles.map((f) => ({
          path: f.path,
          mediaType: f.path.endsWith('.html') ? 'text/html' : 'application/json',
          sha256: digest(f.bytes),
          byteSize: f.bytes.length,
        })),
      });
      if (version > 1) old.finalization = protocol.finalization;
      const oldBytes = c.canonicalBytes(old);
      const signedOld = Buffer.concat([Buffer.from('lca.study-export-signature.v1\0'), oldBytes]);
      const receiptOld = {
        ...receipt,
        manifestHash: digest(signedOld),
        signature: Buffer.from(
          await crypto.subtle.sign('Ed25519', keys.privateKey, signedOld),
        ).toString('base64url'),
      };
      const oldExpected = {
        issuerId: old.issuerId,
        exportId: old.exportId,
        studyId: old.studyId,
        reportRevisionId: old.reportRevisionId,
        reportContentHash: old.reportContentHash,
      };
      assert.equal(
        (await c.verifyVersionedExport(oldBytes, receiptOld, oldFiles, [anchor], oldExpected))
          .schemaVersion,
        old.schemaVersion,
      );
      const oldBundle = c.canonicalBytes({
        schemaVersion: `lca.study-export-bundle.v${version}`,
        manifestBase64: Buffer.from(oldBytes).toString('base64'),
        receipt: receiptOld,
        files: oldFiles.map((f) => ({
          path: f.path,
          encoding: 'base64',
          bytes: Buffer.from(f.bytes).toString('base64'),
        })),
      });
      const oldParsed = c.parseExportBundle(oldBundle);
      assert.equal(
        (
          await c.verifyVersionedExport(
            oldParsed.manifestBytes,
            oldParsed.receipt,
            oldParsed.files,
            [anchor],
            oldExpected,
          )
        ).schemaVersion,
        old.schemaVersion,
      );
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
