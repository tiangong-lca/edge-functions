'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  EXTERNAL_CLEANUP_CHECKLIST,
  buildPortalR0CleanupArgs,
  main,
} = require('./cleanup-portal-r0-fixture.cjs');
const { CLEANUP_ACK } = require('./deploy-portal-r0-fixture.cjs');

const NOW = Date.parse('2026-08-26T08:00:00.000Z');
const HEAD = 'a'.repeat(40);
const PREVIEW_REF = 'abcdefghijklmnopqrst';
const MAIN_REF = 'qgzvkongdjqiiamzbbts';

function readyBranch(overrides = {}) {
  return {
    project_ref: PREVIEW_REF,
    parent_project_ref: MAIN_REF,
    is_default: false,
    persistent: false,
    with_data: false,
    name: 'portal-r0-issue-316',
    git_branch: 'feature/issue-316',
    pr_number: 316,
    status: 'FUNCTIONS_DEPLOYED',
    preview_project_status: 'ACTIVE_HEALTHY',
    ...overrides,
  };
}

function environment(overrides = {}) {
  return {
    PORTAL_R0_PROJECT_REF: PREVIEW_REF,
    PORTAL_R0_RUNTIME_TARGET: 'preview',
    PORTAL_R0_DEPLOYMENT_SHA: HEAD,
    PORTAL_R0_DEPLOY_EXPIRES_AT: '2026-08-27T07:59:59.000Z',
    PORTAL_R0_SUPABASE_BRANCH_NAME: 'portal-r0-issue-316',
    PORTAL_R0_SUPABASE_GIT_BRANCH: 'feature/issue-316',
    PORTAL_R0_SUPABASE_PR_NUMBER: '316',
    PORTAL_R0_CLEANUP_ACK: CLEANUP_ACK,
    PORTAL_R0_CLEANUP_DRY_RUN: 'true',
    ...overrides,
  };
}

function run(overrides = {}) {
  const logs = [];
  const originalLog = console.log;
  console.log = (value) => logs.push(String(value));
  try {
    const result = main({
      target: 'preview',
      environment: environment(),
      repoRoot: process.cwd(),
      nowMillis: NOW,
      execFileSyncImpl(_command, args) {
        return args[0] === 'rev-parse' ? `${HEAD}\n` : '';
      },
      branchListRunner: () => [readyBranch()],
      spawnSyncImpl() {
        throw new Error('dry-run must not mutate remote state');
      },
      ...overrides,
    });
    return { result, logs };
  } finally {
    console.log = originalLog;
  }
}

test('builds one fixed remote function deletion and no generic delete surface', () => {
  assert.deepEqual(buildPortalR0CleanupArgs(PREVIEW_REF), [
    'exec',
    'supabase',
    'functions',
    'delete',
    'portal_r0_hmac_verify_v1',
    `--remote=${PREVIEW_REF}`,
    '--yes',
  ]);
});

test('dry-run requires exact-key cleanup and preserves the shared Redis resource', () => {
  const { result, logs } = run();
  assert.deepEqual(result.externalCleanupChecklist, EXTERNAL_CLEANUP_CHECKLIST);
  assert.equal(result.branchState, 'present');
  assert.equal(logs[0], '[cleanup:portal-r0] dry-run guard passed');
  assert.equal(logs.length, EXTERNAL_CLEANUP_CHECKLIST.length + 1);
  assert.match(logs.join('\n'), /delete only the exact R0 fixture keys/u);
  assert.match(logs.join('\n'), /preserve the shared Upstash database/u);
  assert.doesNotMatch(logs.join('\n'), /delete (?:the )?(?:shared )?Upstash database/u);
  assert.doesNotMatch(logs.join('\n'), new RegExp(PREVIEW_REF, 'u'));
  assert.doesNotMatch(logs.join('\n'), new RegExp(HEAD, 'u'));
});

for (const [name, overrides] of [
  ['production target', { target: 'production' }],
  ['local test target', { target: 'test' }],
  [
    'persistent Dev ref',
    { environment: environment({ PORTAL_R0_PROJECT_REF: 'submidrhbtknjxfympna' }) },
  ],
  [
    'Production ref',
    { environment: environment({ PORTAL_R0_PROJECT_REF: 'qgzvkongdjqiiamzbbts' }) },
  ],
  ['missing acknowledgement', { environment: environment({ PORTAL_R0_CLEANUP_ACK: undefined }) }],
  [
    'deploy acknowledgement instead of cleanup acknowledgement',
    { environment: environment({ PORTAL_R0_CLEANUP_ACK: 'delete-after-evidence' }) },
  ],
  [
    'dirty checkout',
    { execFileSyncImpl: (_command, args) => (args[0] === 'rev-parse' ? HEAD : ' M file') },
  ],
  [
    'matching branch is persistent',
    { branchListRunner: () => [readyBranch({ persistent: true })] },
  ],
]) {
  test(`cleanup rejects ${name}`, () => {
    assert.throws(() => run(overrides), /R0 /u);
  });
}

test('cleanup remains allowed after expiry and deletes the still-present disposable branch function', () => {
  const calls = [];
  const expiredAt = '2026-08-26T07:00:00.000Z';
  const { result } = run({
    environment: environment({
      PORTAL_R0_DEPLOY_EXPIRES_AT: expiredAt,
      PORTAL_R0_CLEANUP_DRY_RUN: 'false',
    }),
    spawnSyncImpl(command, args) {
      calls.push({ command, args });
      return { status: 0 };
    },
  });
  assert.equal(result.expiresAtText, expiredAt);
  assert.equal(result.branchState, 'present');
  assert.equal(calls.length, 1);
});

test('absent branch is a verified terminal and never invokes function delete', () => {
  const calls = [];
  const { result, logs } = run({
    environment: environment({ PORTAL_R0_CLEANUP_DRY_RUN: 'false' }),
    branchListRunner: () => [readyBranch({ project_ref: 'zzzzzzzzzzzzzzzzzzzz' })],
    spawnSyncImpl(...args) {
      calls.push(args);
      return { status: 0 };
    },
  });
  assert.equal(result.branchState, 'absent');
  assert.equal(calls.length, 0);
  assert.equal(logs[0], '[cleanup:portal-r0] verified terminal: Preview branch is absent');
});

test('cleanup still deletes the exact branch function when status is paused and unhealthy', () => {
  const calls = [];
  const { result } = run({
    environment: environment({ PORTAL_R0_CLEANUP_DRY_RUN: 'false' }),
    branchListRunner: () => [readyBranch({ status: 'PAUSED', preview_project_status: 'INACTIVE' })],
    spawnSyncImpl(command, args) {
      calls.push({ command, args });
      return { status: 0 };
    },
  });
  assert.equal(result.branchState, 'present');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[4], 'portal_r0_hmac_verify_v1');
});

test('non-dry cleanup invokes only the fixed Supabase delete command after live verification', () => {
  const calls = [];
  const { result } = run({
    environment: environment({ PORTAL_R0_CLEANUP_DRY_RUN: 'false' }),
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'pnpm');
  assert.deepEqual(calls[0].args, result.args);
  assert.equal(calls[0].args[4], 'portal_r0_hmac_verify_v1');
});
