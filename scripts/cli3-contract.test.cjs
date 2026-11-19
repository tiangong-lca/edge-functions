'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { main: deploy } = require('./deploy-function.cjs');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const json = (file) => JSON.parse(read(file));

test('the CLI major matrix actually exercises the qualified old and proposed new CLI', () => {
  const variants = json('test/fixtures/stack-qualification/cli3-case.json');
  assert.deepEqual(variants, {
    baseline: { cli: '2.121.0', runtime: '1.77.4', postgres: '17.11.0.004' },
    candidate: { cli: '3.1.0', runtime: '1.78.1', postgres: '17.11.0.018' },
  });
  const pkg = json('package.json');
  assert.equal(variants.candidate.cli, pkg.devDependencies.supabase);
  assert.equal(variants.candidate.cli, pkg.config.supabaseCliVersion);
  assert.equal(variants.candidate.runtime, pkg.config.supabaseEdgeRuntimeVersion);
  assert.match(
    read('scripts/qualify-local-stack.cjs'),
    /const variants = require\('\.\.\/test\/fixtures\/stack-qualification\/cli3-case\.json'\);/u,
  );
  for (const selected of Object.values(variants)) {
    const transport = json(`test/fixtures/supabase-cli-v${selected.cli}-functions-transport.json`);
    const runtime = json(`test/fixtures/supabase-edge-runtime-v${selected.runtime}-deno.json`);
    assert.equal(transport.cliVersion, selected.cli);
    assert.equal(runtime.cli.version, selected.cli);
    assert.equal(runtime.cli.edgeRuntimeVersion, selected.runtime);
    assert.equal(runtime.edgeRuntime.version, selected.runtime);
    assert.equal(runtime.edgeRuntime.denoVersion, '2.1.4');
    assert.equal(runtime.deno.bundledTypeScriptVersion, '5.6.2');
  }
});

test('CLI3 config retains every existing mail testing option under its supported section', () => {
  const config = read('supabase/config.toml');
  assert.doesNotMatch(config, /^\[inbucket\]$/mu);
  const section = config.match(/^\[local_smtp\]\n([\s\S]*?)(?=^\[)/mu)?.[1];
  assert.ok(section);
  assert.deepEqual(
    section
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
    ['enabled = true', 'port = 54324'],
  );
});

test('ordinary deploy keeps explicit targets, import map and JWT policy without automatic consent', () => {
  const calls = [];
  const environment = Object.freeze({});
  const spawnSyncImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0 };
  };
  for (const target of ['dev', 'main']) {
    assert.equal(
      deploy({ argv: [target, 'synthetic_one', 'synthetic_two'], environment, spawnSyncImpl }),
      0,
    );
  }
  const refs = json('package.json').config;
  assert.deepEqual(
    calls.map(({ command, args, options }) => ({ command, args, options })),
    [refs.supabaseProjectRefDev, refs.supabaseProjectRefMain].flatMap((ref) =>
      ['synthetic_one', 'synthetic_two'].map((name) => ({
        command: 'pnpm',
        args: [
          'exec',
          'supabase',
          'functions',
          'deploy',
          name,
          `--remote=${ref}`,
          '--no-verify-jwt',
          '--import-map',
          path.join('supabase', 'functions', 'deno.json'),
        ],
        options: { cwd: root, stdio: 'inherit', env: environment },
      })),
    ),
  );
  for (const argv of [['dev', 'portal_r0_hmac_verify_v1'], ['other', 'synthetic_one'], ['dev']]) {
    assert.equal(deploy({ argv, environment, spawnSyncImpl }), 1);
    assert.equal(calls.length, 4);
  }
});

test('an unavailable or failing explicit deploy mock cannot fall back to a real client', () => {
  for (const spawnSyncImpl of [undefined, null, false, 'pnpm']) {
    assert.throws(
      () => deploy({ argv: ['dev', 'synthetic_one'], environment: {}, spawnSyncImpl }),
      /spawnSyncImpl must be a function/u,
    );
  }
  const failure = new Error('synthetic unavailable mock');
  let calls = 0;
  assert.throws(
    () =>
      deploy({
        argv: ['dev', 'synthetic_one', 'synthetic_two'],
        environment: {},
        spawnSyncImpl() {
          calls++;
          throw failure;
        },
      }),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
  for (const status of [17, null]) {
    calls = 0;
    assert.equal(
      deploy({
        argv: ['main', 'synthetic_one', 'synthetic_two'],
        environment: {},
        spawnSyncImpl() {
          calls++;
          return { status };
        },
      }),
      status ?? 1,
    );
    assert.equal(calls, 1);
  }
});

test('the four historical source fixtures retain their reviewed exact bytes', () => {
  for (const [file, sha256] of [
    [
      'test/fixtures/supabase-cli-v2.116.0-functions-transport.json',
      'aac606fbffe9b205cfd52bca5aae6da4b7598d92c3e25925385c6d9e60a0aa90',
    ],
    [
      'test/fixtures/supabase-cli-v2.121.0-functions-transport.json',
      'a8e2ad220c53b563aef3ba600ce82be6589626f17289fcdd50426cff4245b3a5',
    ],
    [
      'test/fixtures/supabase-edge-runtime-v1.74.3-deno.json',
      'c99dbc3cf07bf23550d4c92901341e05b37f03ba47031d63206b16d2e098a851',
    ],
    [
      'test/fixtures/supabase-edge-runtime-v1.77.4-deno.json',
      '0da3f9bcc2409cb1c63d5f430b273e74cd138f91219f033eadcb21c9dacb55fc',
    ],
  ])
    assert.equal(crypto.createHash('sha256').update(read(file)).digest('hex'), sha256);
});
