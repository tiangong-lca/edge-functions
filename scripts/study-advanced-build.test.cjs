'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

test('V5 portable codec binds exact Worker configuration and runs independently in Node and Deno', async () => {
  const { buildStudyContract } = await import('./build-study-contract.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'study-advanced-codec-'));
  try {
    const output = path.join(temp, 'codec');
    const manifest = await buildStudyContract(output, { allowDirty: true, apiVersion: 'v5' });
    assert.equal(manifest.apiSchema, 'lca.study-api.v5');
    assert.equal(manifest.contractVersion, '5.0.0');
    const fixtureRoot = path.join(__dirname, '../test/fixtures/lca-study-v5');
    const fixtures = await Promise.all(
      ['input-oat.json', 'input-uniform.json', 'input-uncertainty.json'].map(async (name) =>
        JSON.parse(await readFile(path.join(fixtureRoot, name), 'utf8')),
      ),
    );
    const requests = fixtures.map(({ analysis }, i) => ({
      schemaVersion: 'lca.study-api.v5',
      requestId: `advanced-request-${i}`,
      idempotencyKey: `advanced-key-${i}`,
      operation: 'analysis.request',
      studyId: analysis.studyId,
      profileId: analysis.profileId,
      config: analysis.config,
      configHash: analysis.configHash,
    }));
    const worker = JSON.parse(
      await readFile(
        path.join(__dirname, '../contracts/lca-study/worker/advanced-manifest.json'),
        'utf8',
      ),
    );
    for (const [relative, hash] of Object.entries(worker.schemas)) {
      const input = manifest.inputs.find((entry) => entry.path === relative);
      assert.equal(input?.sha256, hash);
    }
    assert(manifest.inputs.some((entry) => entry.path.endsWith('/advanced-manifest.json')));
    assert(manifest.files.some((entry) => entry.path === 'LICENSE.renderer'));
    const codec = await import(pathToFileURL(path.join(output, 'index.mjs')).href);
    for (const request of requests) {
      assert.deepEqual(codec.parseRequest(request), request);
      assert.equal(await codec.analysisConfigHash(request.config), request.configHash);
    }
    assert.equal(codec.operationMetadata['analysis.parameters.read'].kind, 'query');
    assert.equal(codec.operationMetadata['analysis.request'].kind, 'mutation');
    assert.equal(codec.operationMetadata['export.request'].kind, 'mutation');
    assert.equal(codec.operationMetadata['report.view'].kind, 'query');
    assert.equal(typeof codec.verifyVersionedExport, 'function');
    const finalExport = {
      schemaVersion: codec.API_SCHEMA,
      requestId: 'export',
      idempotencyKey: 'export-key',
      operation: 'export.request',
      reportRevisionId: '10000000-0000-4000-8000-000000000001',
      expectedContentHash: 'a'.repeat(64),
      finalizationId: '10000000-0000-4000-8000-000000000002',
      expectedReviewStateHash: 'b'.repeat(64),
      rendererVersion: '2.0.0',
      viewModelVersion: 'lca.study-report-view.v2',
    };
    assert.deepEqual(codec.parseRequest(finalExport), finalExport);
    assert.throws(() => codec.parseRequest({ ...finalExport, rendererVersion: '1.0.0' }), {
      code: 'INVALID_REQUEST',
    });
    assert.equal(typeof codec.verifyExport, 'function');
    assert.equal(typeof codec.validateExportViewBindings, 'function');
    const declarations = await readFile(path.join(output, 'index.d.ts'), 'utf8');
    assert.match(declarations, /export declare function analysisConfigHash/);
    assert.match(declarations, /lca\.study-analysis-config\.v2/);
    assert.match(declarations, /lca\.study-sensitivity-oat\.v1/);
    assert.match(declarations, /lca\.study-export-manifest\.v3/);
    assert.match(declarations, /verifyVersionedExport/);
    for (const file of manifest.files) {
      const bytes = await readFile(path.join(output, file.path));
      assert.equal(bytes.length, file.bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    }
    // A separate process imports only the packed artifact and a synthetic input file.
    // Its cwd has neither source nor node_modules; Deno additionally forbids npm resolution.
    const consumerPath = path.join(temp, 'consumer.mjs');
    const fixturePath = path.join(temp, 'requests.json');
    await writeFile(fixturePath, JSON.stringify(requests));
    await writeFile(
      consumerPath,
      `import {readFile} from 'node:fs/promises';
const codec=await import(process.argv[2]);
const requests=JSON.parse(await readFile(process.argv[3],'utf8'));
for(const request of requests){codec.parseRequest(request);if(await codec.analysisConfigHash(request.config)!==request.configHash)throw new Error('config identity');}
console.log(codec.CONTRACT_VERSION+':'+requests.length);
`,
    );
    assert.equal(
      execFileSync(
        process.execPath,
        [consumerPath, pathToFileURL(path.join(output, 'index.mjs')).href, fixturePath],
        {
          cwd: temp,
          encoding: 'utf8',
        },
      ).trim(),
      '5.0.0:3',
    );
    assert.equal(
      execFileSync(
        'deno',
        [
          'eval',
          '--no-config',
          '--no-npm',
          `const c=await import(${JSON.stringify(pathToFileURL(path.join(output, 'index.mjs')).href)});const r=${JSON.stringify(requests[0])};if(await c.analysisConfigHash(c.parseRequest(r).config)!==r.configHash)throw new Error('identity');console.log(c.API_SCHEMA);`,
        ],
        { cwd: temp, encoding: 'utf8' },
      ).trim(),
      'lca.study-api.v5',
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
