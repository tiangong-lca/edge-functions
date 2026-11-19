#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const {
  FUNCTION_NAME,
  listSupabasePreviewBranches,
  validatePortalR0Cleanup,
} = require('./deploy-portal-r0-fixture.cjs');

const EXTERNAL_CLEANUP_CHECKLIST = Object.freeze([
  'delete only the exact R0 fixture keys and verify every key is absent',
  'remove the disposable Preview copies of the R0 HMAC, publishable, and Redis secrets',
  'preserve the shared Upstash database, Dev/Main namespaces, and coordinated source token',
  'record function, exact-key, and temporary-secret cleanup evidence',
]);

function buildPortalR0CleanupArgs(projectRef) {
  return [
    'exec',
    'supabase',
    'functions',
    'delete',
    FUNCTION_NAME,
    `--remote=${projectRef}`,
    '--yes',
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
  const validated = validatePortalR0Cleanup({
    target,
    environment,
    persistentDevProjectRef: packageJson.config?.supabaseProjectRefDev,
    productionProjectRef: packageJson.config?.supabaseProjectRefMain,
    gitHead,
    gitClean,
    nowMillis: options.nowMillis ?? Date.now(),
    branches,
  });
  const args = buildPortalR0CleanupArgs(validated.projectRef);

  if (environment.PORTAL_R0_CLEANUP_DRY_RUN !== 'true' && validated.branchState === 'present') {
    const result = (options.spawnSyncImpl ?? spawnSync)('pnpm', args, {
      cwd: repoRoot,
      stdio: 'inherit',
      env: environment,
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  } else if (environment.PORTAL_R0_CLEANUP_DRY_RUN === 'true') {
    console.log('[cleanup:portal-r0] dry-run guard passed');
  } else {
    console.log('[cleanup:portal-r0] verified terminal: Preview branch is absent');
  }

  for (const item of EXTERNAL_CLEANUP_CHECKLIST) {
    console.log(`[cleanup:portal-r0] external action required: ${item}`);
  }
  return {
    command: 'pnpm',
    args,
    projectRef: validated.projectRef,
    deploymentSha: validated.deploymentSha,
    expiresAtText: validated.expiresAtText,
    branchState: validated.branchState,
    externalCleanupChecklist: [...EXTERNAL_CLEANUP_CHECKLIST],
  };
}

module.exports = {
  EXTERNAL_CLEANUP_CHECKLIST,
  buildPortalR0CleanupArgs,
  main,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'R0 cleanup rejected.');
    process.exit(1);
  }
}
