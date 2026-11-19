'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DISPOSABLE_ACK,
  FUNCTION_NAME,
  buildPortalR0DeployArgs,
  listSupabasePreviewBranches,
  validatePortalR0Deploy,
} = require('./deploy-portal-r0-fixture.cjs');

const NOW = Date.parse('2026-08-26T08:00:00.000Z');
const HEAD = 'a'.repeat(40);
const PREVIEW_REF = 'abcdefghijklmnopqrst';
const DEV_REF = 'submidrhbtknjxfympna';
const MAIN_REF = 'qgzvkongdjqiiamzbbts';

function readyBranch(overrides = {}) {
  return {
    id: 'branch-id-is-not-logged',
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

function validInput() {
  return {
    target: 'preview',
    environment: {
      PORTAL_R0_PROJECT_REF: PREVIEW_REF,
      PORTAL_R0_RUNTIME_TARGET: 'preview',
      PORTAL_R0_DEPLOYMENT_SHA: HEAD,
      PORTAL_R0_DEPLOY_EXPIRES_AT: '2026-08-27T07:59:59.000Z',
      PORTAL_R0_SUPABASE_BRANCH_NAME: 'portal-r0-issue-316',
      PORTAL_R0_SUPABASE_GIT_BRANCH: 'feature/issue-316',
      PORTAL_R0_SUPABASE_PR_NUMBER: '316',
      PORTAL_R0_DISPOSABLE_ACK: DISPOSABLE_ACK,
    },
    persistentDevProjectRef: DEV_REF,
    productionProjectRef: MAIN_REF,
    gitHead: HEAD,
    gitClean: true,
    nowMillis: NOW,
    branches: [readyBranch()],
  };
}

test('builds one fixed no-gateway-JWT R0 function deployment', () => {
  assert.deepEqual(buildPortalR0DeployArgs(PREVIEW_REF, 'supabase/functions/deno.json'), [
    'exec',
    'supabase',
    'functions',
    'deploy',
    FUNCTION_NAME,
    `--remote=${PREVIEW_REF}`,
    '--no-verify-jwt',
    '--import-map',
    'supabase/functions/deno.json',
  ]);
});

test('accepts only an exact ready no-data ephemeral branch returned by the Main parent', () => {
  assert.deepEqual(validatePortalR0Deploy(validInput()), {
    projectRef: PREVIEW_REF,
    deploymentSha: HEAD,
    expiresAtText: '2026-08-27T07:59:59.000Z',
    branchName: 'portal-r0-issue-316',
    gitBranch: 'feature/issue-316',
    prNumber: 316,
    branchState: 'ready',
  });
});

test('live branch list runner executes one read-only exact Main-parent query and parses CLI JSON', () => {
  const calls = [];
  const branches = listSupabasePreviewBranches({
    parentProjectRef: MAIN_REF,
    repoRoot: process.cwd(),
    environment: { SUPABASE_ACCESS_TOKEN: 'must-not-be-logged' },
    execFileSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return JSON.stringify([readyBranch()]);
    },
  });
  assert.equal(branches.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'pnpm');
  assert.deepEqual(calls[0].args, [
    'exec',
    'supabase',
    'branches',
    'list',
    `--remote=${MAIN_REF}`,
    '--output',
    'json',
  ]);
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
});

for (const [name, mutate] of [
  ['production target', (input) => (input.target = 'production')],
  ['local test target', (input) => (input.target = 'test')],
  ['persistent Dev ref', (input) => (input.environment.PORTAL_R0_PROJECT_REF = DEV_REF)],
  ['Production ref', (input) => (input.environment.PORTAL_R0_PROJECT_REF = MAIN_REF)],
  ['runtime target mismatch', (input) => (input.environment.PORTAL_R0_RUNTIME_TARGET = 'test')],
  [
    'missing disposable acknowledgement',
    (input) => delete input.environment.PORTAL_R0_DISPOSABLE_ACK,
  ],
  [
    'wrong disposable acknowledgement',
    (input) => (input.environment.PORTAL_R0_DISPOSABLE_ACK = 'keep'),
  ],
  ['SHA mismatch', (input) => (input.environment.PORTAL_R0_DEPLOYMENT_SHA = 'b'.repeat(40))],
  ['dirty worktree', (input) => (input.gitClean = false)],
  [
    'branch absent',
    (input) => (input.branches = [readyBranch({ project_ref: 'zzzzzzzzzzzzzzzzzzzz' })]),
  ],
  ['duplicate matching branches', (input) => (input.branches = [readyBranch(), readyBranch()])],
  ['malformed branch row', (input) => (input.branches = [{}])],
  ['wrong parent', (input) => (input.branches[0].parent_project_ref = DEV_REF)],
  ['default branch', (input) => (input.branches[0].is_default = true)],
  ['persistent branch', (input) => (input.branches[0].persistent = true)],
  ['branch cloned data', (input) => (input.branches[0].with_data = true)],
  [
    'branch name mismatch',
    (input) => (input.environment.PORTAL_R0_SUPABASE_BRANCH_NAME = 'another-branch'),
  ],
  [
    'git branch mismatch',
    (input) => (input.environment.PORTAL_R0_SUPABASE_GIT_BRANCH = 'feature/other'),
  ],
  ['PR number mismatch', (input) => (input.environment.PORTAL_R0_SUPABASE_PR_NUMBER = '317')],
  ['not-ready branch status', (input) => (input.branches[0].status = 'MIGRATIONS_PASSED')],
  ['unhealthy project status', (input) => (input.branches[0].preview_project_status = 'COMING_UP')],
  [
    'expired fixture',
    (input) => (input.environment.PORTAL_R0_DEPLOY_EXPIRES_AT = '2026-08-26T07:59:59.000Z'),
  ],
  [
    'fixture beyond 24 hours',
    (input) => (input.environment.PORTAL_R0_DEPLOY_EXPIRES_AT = '2026-08-27T08:00:01.000Z'),
  ],
]) {
  test(`rejects ${name}`, () => {
    const input = validInput();
    mutate(input);
    assert.throws(() => validatePortalR0Deploy(input), /R0 /u);
  });
}

for (const output of [
  'not-json',
  '{}',
  'null',
  '[]',
  '{"branches":[],"message":""}',
  '{"branches":[{}],"message":"unexpected"}',
]) {
  test(`live branch runner rejects malformed output ${output}`, () => {
    assert.throws(
      () =>
        listSupabasePreviewBranches({
          parentProjectRef: DEV_REF,
          repoRoot: process.cwd(),
          environment: {},
          execFileSyncImpl: () => output,
        }),
      /live Preview branch verification failed/u,
    );
  });
}

test('guard surface never accepts a function name argument', () => {
  assert.equal(FUNCTION_NAME, 'portal_r0_hmac_verify_v1');
  assert.equal(validatePortalR0Deploy.length, 1);
});

test('the real CLI3 raw JSON branch result preserves rows and rejects its target-bearing envelope', () => {
  const fixture = require('../test/fixtures/supabase-cli-v3.1.0-branches-output.json');
  assert.equal(fixture.cliVersion, '3.1.0');
  assert.equal(fixture.syntheticOnly, true);
  const run = (output) =>
    listSupabasePreviewBranches({
      parentProjectRef: fixture.syntheticParentProjectRef,
      repoRoot: process.cwd(),
      environment: {},
      execFileSyncImpl: (_command, args) => {
        assert.deepEqual(args.slice(-2), ['--output', 'json']);
        return JSON.stringify(output);
      },
    });
  assert.deepEqual(run(fixture.outputJson), fixture.outputJson);
  assert.deepEqual(fixture.outputJson, fixture.outputFormatJson.branches);
  assert.equal(fixture.outputFormatJson.target.project_ref, fixture.syntheticParentProjectRef);
  for (const output of [
    fixture.outputFormatJson,
    {
      ...fixture.outputFormatJson,
      target: { kind: 'linked', project_ref: MAIN_REF, environment: 'production' },
    },
    null,
    {},
    [],
    '',
    'not-json',
  ]) {
    assert.throws(() => run(output), /live Preview branch verification failed/u);
  }
});
