#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const validTargets = new Set(['dev', 'main']);
const disposableR0Function = 'portal_r0_hmac_verify_v1';

function main(options = {}) {
  const [target, ...functionNames] = options.argv ?? process.argv.slice(2);
  const run = Object.hasOwn(options, 'spawnSyncImpl') ? options.spawnSyncImpl : spawnSync;
  if (typeof run !== 'function') throw new TypeError('spawnSyncImpl must be a function');
  const environment = options.environment ?? process.env;

  if (!validTargets.has(target) || functionNames.length === 0) {
    console.error('Usage: pnpm deploy:<dev|main> <function-name> [more-function-names...]');
    return 1;
  }

  if (functionNames.includes(disposableR0Function)) {
    console.error('Disposable Portal R0 can only use the dedicated Preview/test deploy guard.');
    return 1;
  }

  const repoRoot = path.resolve(__dirname, '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const cliVersion = packageJson.config?.supabaseCliVersion;
  const installedCliVersion = packageJson.devDependencies?.supabase;
  const projectRefs = {
    dev: packageJson.config?.supabaseProjectRefDev,
    main: packageJson.config?.supabaseProjectRefMain,
  };
  const projectRef = projectRefs[target];

  if (!cliVersion || installedCliVersion !== cliVersion || !projectRef) {
    console.error('Missing Supabase CLI version or project ref config in package.json.');
    return 1;
  }

  for (const functionName of functionNames) {
    console.log(`[deploy:${target}] ${functionName} -> ${projectRef}`);
    const result = run(
      'pnpm',
      [
        'exec',
        'supabase',
        'functions',
        'deploy',
        functionName,
        `--remote=${projectRef}`,
        '--no-verify-jwt',
        '--import-map',
        path.join('supabase', 'functions', 'deno.json'),
      ],
      {
        cwd: repoRoot,
        stdio: 'inherit',
        env: environment,
      },
    );

    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

module.exports = { main };
if (require.main === module) process.exitCode = main();
