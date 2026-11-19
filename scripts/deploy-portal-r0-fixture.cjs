#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const FUNCTION_NAME = 'portal_r0_hmac_verify_v1';
const REMOTE_TARGET = 'preview';
const DISPOSABLE_ACK = 'delete-after-evidence';
const CLEANUP_ACK = 'delete-function-and-confirm-external-resources';
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const BRANCH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const GIT_BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u;
const READY_BRANCH_STATUS = 'FUNCTIONS_DEPLOYED';
const READY_PROJECT_STATUS = 'ACTIVE_HEALTHY';

function requiredEnvironmentValue(environment, name) {
  const value = environment[name];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new Error('R0 deploy configuration is invalid.');
  }
  return value;
}

function listSupabasePreviewBranches(input) {
  let output;
  try {
    output = input.execFileSyncImpl(
      'pnpm',
      [
        'exec',
        'supabase',
        'branches',
        'list',
        `--remote=${input.parentProjectRef}`,
        '--output-format',
        'json',
      ],
      {
        cwd: input.repoRoot,
        encoding: 'utf8',
        env: input.environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch {
    throw new Error('R0 live Preview branch verification failed.');
  }
  try {
    const parsed = JSON.parse(output);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join('\n') !== ['branches', 'message'].sort().join('\n') ||
      parsed.message !== '' ||
      !Array.isArray(parsed.branches) ||
      parsed.branches.length === 0
    ) {
      throw new Error('invalid branch list');
    }
    return parsed.branches;
  } catch {
    throw new Error('R0 live Preview branch verification failed.');
  }
}

function matchingBranchRows(input, projectRef) {
  if (
    !Array.isArray(input.branches) ||
    input.branches.length === 0 ||
    input.branches.some(
      (candidate) =>
        !candidate ||
        typeof candidate !== 'object' ||
        Array.isArray(candidate) ||
        !PROJECT_REF_PATTERN.test(candidate.project_ref),
    )
  ) {
    throw new Error('R0 live Preview branch verification failed.');
  }
  return input.branches.filter((candidate) => candidate.project_ref === projectRef);
}

function validateDisposableBranchIdentity(input, projectRef) {
  const matches = matchingBranchRows(input, projectRef);
  if (matches.length !== 1) {
    throw new Error('R0 target is not one disposable Preview branch identity.');
  }
  const branch = matches[0];
  if (
    branch.parent_project_ref !== input.productionProjectRef ||
    branch.is_default !== false ||
    branch.persistent !== false ||
    branch.with_data !== false ||
    branch.name !== input.branchName ||
    branch.git_branch !== input.gitBranch ||
    (input.prNumber !== null && branch.pr_number !== input.prNumber)
  ) {
    throw new Error('R0 target is not one disposable Preview branch identity.');
  }
  return branch;
}

function validateReadyDisposableBranch(input, projectRef) {
  const branch = validateDisposableBranchIdentity(input, projectRef);
  if (
    branch.status !== READY_BRANCH_STATUS ||
    branch.preview_project_status !== READY_PROJECT_STATUS
  ) {
    throw new Error('R0 target is not one ready disposable Preview branch.');
  }
}

function validatePortalR0Base(input, acknowledgementName, acknowledgementValue) {
  if (input.target !== REMOTE_TARGET) {
    throw new Error('R0 remote target must be explicit Preview.');
  }
  const projectRef = requiredEnvironmentValue(input.environment, 'PORTAL_R0_PROJECT_REF');
  const runtimeTarget = requiredEnvironmentValue(input.environment, 'PORTAL_R0_RUNTIME_TARGET');
  const deploymentSha = requiredEnvironmentValue(input.environment, 'PORTAL_R0_DEPLOYMENT_SHA');
  const expiresAtText = requiredEnvironmentValue(input.environment, 'PORTAL_R0_DEPLOY_EXPIRES_AT');
  const branchName = requiredEnvironmentValue(input.environment, 'PORTAL_R0_SUPABASE_BRANCH_NAME');
  const gitBranch = requiredEnvironmentValue(input.environment, 'PORTAL_R0_SUPABASE_GIT_BRANCH');
  const prNumberText = input.environment.PORTAL_R0_SUPABASE_PR_NUMBER;
  let prNumber = null;
  if (prNumberText !== undefined && prNumberText !== '') {
    if (!/^[1-9]\d{0,9}$/u.test(prNumberText)) {
      throw new Error('R0 deploy configuration is invalid.');
    }
    prNumber = Number(prNumberText);
    if (!Number.isSafeInteger(prNumber)) throw new Error('R0 deploy configuration is invalid.');
  }
  const acknowledgement = requiredEnvironmentValue(input.environment, acknowledgementName);

  if (
    !PROJECT_REF_PATTERN.test(projectRef) ||
    projectRef === input.persistentDevProjectRef ||
    projectRef === input.productionProjectRef ||
    runtimeTarget !== REMOTE_TARGET ||
    !BRANCH_NAME_PATTERN.test(branchName) ||
    !GIT_BRANCH_PATTERN.test(gitBranch) ||
    branchName.includes('..') ||
    gitBranch.includes('..') ||
    gitBranch.includes('@{') ||
    gitBranch.endsWith('.lock') ||
    acknowledgement !== acknowledgementValue ||
    !SHA_PATTERN.test(deploymentSha) ||
    deploymentSha !== input.gitHead ||
    !input.gitClean ||
    !Number.isFinite(Date.parse(expiresAtText)) ||
    new Date(Date.parse(expiresAtText)).toISOString() !== expiresAtText
  ) {
    throw new Error('R0 deploy configuration is invalid.');
  }
  return { projectRef, deploymentSha, expiresAtText, branchName, gitBranch, prNumber };
}

function validatePortalR0Deploy(input) {
  const validated = validatePortalR0Base(input, 'PORTAL_R0_DISPOSABLE_ACK', DISPOSABLE_ACK);
  const expiresAt = Date.parse(validated.expiresAtText);
  if (expiresAt <= input.nowMillis || expiresAt - input.nowMillis > MAX_LIFETIME_MS) {
    throw new Error('R0 deploy expiry must be within the next 24 hours.');
  }
  validateReadyDisposableBranch({ ...input, ...validated }, validated.projectRef);
  return { ...validated, branchState: 'ready' };
}

function validatePortalR0Cleanup(input) {
  const validated = validatePortalR0Base(input, 'PORTAL_R0_CLEANUP_ACK', CLEANUP_ACK);
  const matches = matchingBranchRows(input, validated.projectRef);
  if (matches.length === 0) return { ...validated, branchState: 'absent' };
  validateDisposableBranchIdentity({ ...input, ...validated }, validated.projectRef);
  return { ...validated, branchState: 'present' };
}

function buildPortalR0DeployArgs(projectRef, importMapPath) {
  return [
    'exec',
    'supabase',
    'functions',
    'deploy',
    FUNCTION_NAME,
    `--remote=${projectRef}`,
    '--no-verify-jwt',
    '--import-map',
    importMapPath,
  ];
}

function main(options = {}) {
  const target = options.target ?? process.argv[2];
  const environment = options.environment ?? process.env;
  const repoRoot = options.repoRoot ?? path.resolve(__dirname, '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const execFile = options.execFileSyncImpl ?? execFileSync;
  const gitHead = execFile('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  const gitClean =
    execFile('git', ['status', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim() === '';
  const branches = (options.branchListRunner ?? listSupabasePreviewBranches)({
    parentProjectRef: packageJson.config?.supabaseProjectRefMain,
    execFileSyncImpl: execFile,
    repoRoot,
    environment,
  });
  const validated = validatePortalR0Deploy({
    target,
    environment,
    persistentDevProjectRef: packageJson.config?.supabaseProjectRefDev,
    productionProjectRef: packageJson.config?.supabaseProjectRefMain,
    gitHead,
    gitClean,
    nowMillis: options.nowMillis ?? Date.now(),
    branches,
  });
  const cliVersion = packageJson.config?.supabaseCliVersion;
  if (!cliVersion || packageJson.devDependencies?.supabase !== cliVersion) {
    throw new Error('Pinned Supabase CLI configuration is invalid.');
  }

  const args = buildPortalR0DeployArgs(
    validated.projectRef,
    path.join('supabase', 'functions', 'deno.json'),
  );
  if (environment.PORTAL_R0_DEPLOY_DRY_RUN === 'true') {
    console.log('[deploy:portal-r0] dry-run guard passed');
    return { command: 'pnpm', args, ...validated };
  }
  const result = (options.spawnSyncImpl ?? spawnSync)('pnpm', args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: environment,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  return { command: 'pnpm', args, ...validated };
}

module.exports = {
  CLEANUP_ACK,
  DISPOSABLE_ACK,
  FUNCTION_NAME,
  MAX_LIFETIME_MS,
  READY_BRANCH_STATUS,
  READY_PROJECT_STATUS,
  REMOTE_TARGET,
  buildPortalR0DeployArgs,
  listSupabasePreviewBranches,
  main,
  validatePortalR0Cleanup,
  validatePortalR0Deploy,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'R0 deploy rejected.');
    process.exit(1);
  }
}
