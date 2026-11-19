'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
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
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'edge590-deploy-'));
  try {
    const capture = path.join(temp, 'calls.jsonl');
    const shim = path.join(temp, 'pnpm');
    fs.writeFileSync(
      shim,
      `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.EDGE590_CAPTURE, JSON.stringify(process.argv.slice(2))+'\\n');\n`,
      { mode: 0o700 },
    );
    const environment = {
      ...process.env,
      PATH: temp + path.delimiter + process.env.PATH,
      EDGE590_CAPTURE: capture,
    };
    for (const target of ['dev', 'main']) {
      const result = spawnSync(
        process.execPath,
        ['scripts/deploy-function.cjs', target, 'synthetic_one', 'synthetic_two'],
        { cwd: root, env: environment, encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr);
    }
    const refs = json('package.json').config;
    assert.deepEqual(
      fs.readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse),
      [refs.supabaseProjectRefDev, refs.supabaseProjectRefMain].flatMap((ref) =>
        ['synthetic_one', 'synthetic_two'].map((name) => [
          'exec',
          'supabase',
          'functions',
          'deploy',
          name,
          `--remote=${ref}`,
          '--no-verify-jwt',
          '--import-map',
          'supabase/functions/deno.json',
        ]),
      ),
    );
    const before = fs.readFileSync(capture, 'utf8');
    for (const args of [['dev', 'portal_r0_hmac_verify_v1'], ['other', 'synthetic_one'], ['dev']]) {
      const result = spawnSync(process.execPath, ['scripts/deploy-function.cjs', ...args], {
        cwd: root,
        env: environment,
        encoding: 'utf8',
      });
      assert.equal(result.status, 1);
      assert.equal(fs.readFileSync(capture, 'utf8'), before);
    }
  } finally {
    fs.rmSync(temp, { recursive: true });
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
