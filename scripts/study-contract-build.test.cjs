'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

test('portable owner codec packs exact deterministic bytes and executes without source/dependencies', async () => {
  const { buildStudyContract, declaration } = await import('./build-study-contract.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'study-codec-'));
  try {
    const first = path.join(temp, 'first');
    const second = path.join(temp, 'second');
    const a = await buildStudyContract(first, { allowDirty: true });
    const b = await buildStudyContract(second, { allowDirty: true });
    assert.deepEqual(a, b);
    for (const file of a.files) {
      const bytes = await readFile(path.join(first, file.path));
      assert.equal(bytes.length, file.bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    }
    const codec = await import(pathToFileURL(path.join(first, 'index.mjs')).href);
    const request = codec.parseRequest({
      schemaVersion: codec.API_SCHEMA,
      requestId: 'request-1',
      operation: 'capability.read',
    });
    const response = codec.parseResponse({
      schemaVersion: codec.API_SCHEMA,
      requestId: 'request-1',
      ok: true,
      data: {
        type: 'capabilities',
        contractVersion: codec.CONTRACT_VERSION,
        runtimeEnabled: false,
        operations: ['capability.read'],
        profiles: [],
      },
    });
    assert.doesNotThrow(() => codec.validateResponseForRequest(request, response));
    assert.throws(
      () => codec.validateResponseForRequest(request, { ...response, requestId: 'request-2' }),
      { ruleId: 'response.envelope' },
    );
    assert.throws(
      () => codec.parseRequest({ ...request, credential: 'private-test-secret' }),
      (error) => error.code === 'INVALID_REQUEST' && !String(error).includes('private-test-secret'),
    );
    assert.throws(() => codec.parseRequest({ ...request, schemaVersion: 'future' }), {
      code: 'UNSUPPORTED_SCHEMA',
    });
    assert.equal(codec.operationMetadata['study.create'].kind, 'mutation');
    assert.equal(codec.operationMetadata['task.read'].kind, 'query');
    assert.equal(codec.operationMetadata['task.cancel'].kind, 'mutation');
    // A fresh Deno process loads only the artifact; imports must not resolve a source tree or npm.
    const deno = execFileSync(
      'deno',
      [
        'eval',
        '--no-config',
        '--no-npm',
        `const c=await import(${JSON.stringify(pathToFileURL(path.join(first, 'index.mjs')).href)}); console.log(c.parseRequest(${JSON.stringify(request)}).operation);`,
      ],
      { cwd: temp, encoding: 'utf8' },
    );
    assert.equal(deno.trim(), 'capability.read');
    assert.match(
      await readFile(path.join(first, 'index.d.ts'), 'utf8'),
      /export type StudyApiRequest/,
    );
    await assert.rejects(
      buildStudyContract(first, { allowDirty: true }),
      /study_output_must_be_new/,
    );
    assert.throws(
      () => declaration({ $ref: 'https://example.invalid/schema' }),
      /external_reference/,
    );
    assert.equal(
      declaration({
        type: 'object',
        properties: { x: { type: 'string' } },
        required: ['x'],
        additionalProperties: false,
      }),
      '{ "x": string; }',
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
