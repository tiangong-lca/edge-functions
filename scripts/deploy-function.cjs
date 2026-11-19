#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const [, , target, ...functionNames] = process.argv;
const validTargets = new Set(['dev', 'main']);
const disposableR0Function = 'portal_r0_hmac_verify_v1';

if (!validTargets.has(target) || functionNames.length === 0) {
  console.error('Usage: pnpm deploy:<dev|main> <function-name> [more-function-names...]');
  process.exit(1);
}

if (functionNames.includes(disposableR0Function)) {
  console.error('Disposable Portal R0 can only use the dedicated Preview/test deploy guard.');
  process.exit(1);
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
  process.exit(1);
}

for (const functionName of functionNames) {
  console.log(`[deploy:${target}] ${functionName} -> ${projectRef}`);
  const result = spawnSync(
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
      env: process.env,
    },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
