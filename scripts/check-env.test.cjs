'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  EXPECTED_TOOLCHAIN_VERSIONS,
  readToolchainVersions,
  validateToolchainVersions,
} = require('./check-env.cjs');

test('accepts only the Supabase Edge Runtime-compatible Deno and exact auxiliary toolchain', () => {
  assert.deepEqual(
    validateToolchainVersions({
      deno: '2.1.4',
      denoTypescript: '5.6.2',
      node: '24.19.0',
      pnpm: '11.24.0',
      supabaseCli: '3.1.0',
    }),
    [],
  );
  assert.deepEqual(EXPECTED_TOOLCHAIN_VERSIONS, {
    deno: '2.1.4',
    denoTypescript: '5.6.2',
    node: '24.19.0',
    pnpm: '11.24.0',
    supabaseCli: '3.1.0',
  });
});

for (const [tool, actual] of [
  ['deno', '2.9.5'],
  ['denoTypescript', '6.0.3'],
  ['denoTypescript', '7.0.2'],
  ['node', '22.0.0'],
  ['pnpm', '11.22.0'],
  ['supabaseCli', '2.106.0'],
  ['deno', 'unavailable'],
]) {
  test(`rejects ${tool} version ${actual}`, () => {
    const versions = { ...EXPECTED_TOOLCHAIN_VERSIONS, [tool]: actual };
    assert.deepEqual(validateToolchainVersions(versions), [
      `${tool} version mismatch: expected ${EXPECTED_TOOLCHAIN_VERSIONS[tool]}, got ${actual}`,
    ]);
  });
}

test('the installed repository runtimes satisfy the same contract', () => {
  assert.deepEqual(validateToolchainVersions(readToolchainVersions()), []);
});
