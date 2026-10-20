'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const scriptPath = path.join(__dirname, 'deno-check-all.cjs');

test('checks the exact inventory through one bounded shared graph', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');
  assert.match(source, /module\.exports\s*=/u);

  const { MAX_ROOTS_PER_BATCH, buildCheckBatches, discoverTargets, runDenoChecks } = require(
    scriptPath,
  );
  const targets = discoverTargets();

  assert.equal(targets.length, 169);
  assert.ok(targets.includes('test/runtime_sdk_wire_test.ts'));
  assert.ok(targets.includes('test/supabase_sdk_wire_test.ts'));
  assert.ok(targets.includes('test/zod_consumer_compatibility_test.ts'));
  assert.ok(targets.includes('test/stable_draft_command_test.ts'));
  assert.ok(targets.includes('supabase/functions/app_dataset_prepare_stable_draft/index.ts'));
  assert.ok(targets.includes('supabase/functions/app_dataset_stable_draft_request/index.ts'));
  assert.deepEqual(targets, [...new Set(targets)].sort());
  assert.equal(
    targets.some((target) => target.includes('/antchain_')),
    false,
  );
  // Includes Portal/SDK/Zod proofs and the stable draft handler regression (#500).
  assert.equal(targets.filter((target) => target.startsWith('test/')).length, 90);

  const batches = buildCheckBatches(targets);
  assert.equal(MAX_ROOTS_PER_BATCH, 200);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], targets);

  const calls = [];
  const status = runDenoChecks({
    logger: () => {},
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });
  assert.equal(status, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'deno');
  assert.deepEqual(calls[0].args.slice(0, 3), [
    'check',
    '--config',
    path.join('supabase', 'functions', 'deno.json'),
  ]);
  assert.deepEqual(calls[0].args.slice(3), targets);
  assert.equal(calls[0].options.cwd, path.resolve(__dirname, '..'));
  assert.equal(calls[0].options.stdio, 'inherit');
});
