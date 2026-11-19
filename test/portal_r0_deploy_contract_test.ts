import { assertEquals, assertStringIncludes } from 'jsr:@std/assert';

Deno.test('R0 gateway JWT is disabled only with handler-owned HMAC and exact path', async () => {
  const config = await Deno.readTextFile('./supabase/config.toml');
  assertStringIncludes(config, '[functions.portal_r0_hmac_verify_v1]\nverify_jwt = false');

  const runtime = await Deno.readTextFile('./supabase/functions/portal_r0_hmac_verify_v1/index.ts');
  assertStringIncludes(runtime, 'verifyPortalHmacRequest({');
  assertStringIncludes(runtime, 'expectedFunctionPath: PORTAL_R0_FUNCTION_PATH');
  assertStringIncludes(
    runtime,
    'allowedRequestPaths: [PORTAL_R0_FUNCTION_PATH, PORTAL_R0_RUNTIME_PATH]',
  );
  assertStringIncludes(runtime, 'registerPortalR0Nonce(');
});

Deno.test('R0 deploy requires the dedicated live disposable Preview guard', async () => {
  const packageJson = JSON.parse(await Deno.readTextFile('./package.json')) as {
    scripts: Record<string, string>;
  };
  assertEquals(
    packageJson.scripts['deploy:portal-r0'],
    'node ./scripts/deploy-portal-r0-fixture.cjs',
  );
  assertEquals(
    packageJson.scripts['cleanup:portal-r0'],
    'node ./scripts/cleanup-portal-r0-fixture.cjs',
  );

  const guard = await Deno.readTextFile('./scripts/deploy-portal-r0-fixture.cjs');
  for (const required of [
    "const REMOTE_TARGET = 'preview'",
    "const FUNCTION_NAME = 'portal_r0_hmac_verify_v1'",
    "'PORTAL_R0_PROJECT_REF'",
    "'PORTAL_R0_RUNTIME_TARGET'",
    "'PORTAL_R0_DEPLOYMENT_SHA'",
    "'PORTAL_R0_DEPLOY_EXPIRES_AT'",
    "'PORTAL_R0_SUPABASE_BRANCH_NAME'",
    "'PORTAL_R0_SUPABASE_GIT_BRANCH'",
    "'PORTAL_R0_DISPOSABLE_ACK'",
    'projectRef === input.persistentDevProjectRef',
    'projectRef === input.productionProjectRef',
    "'branches'",
    "'list'",
    "'--output'",
    'branch.parent_project_ref !== input.productionProjectRef',
    'branch.is_default !== false',
    'branch.persistent !== false',
    'branch.status !== READY_BRANCH_STATUS',
    'branch.preview_project_status !== READY_PROJECT_STATUS',
    'branch.with_data !== false',
    'branch.name !== input.branchName',
    'branch.git_branch !== input.gitBranch',
    "'--no-verify-jwt'",
    "'--import-map'",
  ]) {
    assertStringIncludes(guard, required);
  }

  const persistentGuard = await Deno.readTextFile('./scripts/deploy-function.cjs');
  assertStringIncludes(persistentGuard, "const disposableR0Function = 'portal_r0_hmac_verify_v1'");
  assertStringIncludes(persistentGuard, 'functionNames.includes(disposableR0Function)');

  const cleanup = await Deno.readTextFile('./scripts/cleanup-portal-r0-fixture.cjs');
  assertStringIncludes(cleanup, "require('./deploy-portal-r0-fixture.cjs')");
  assertStringIncludes(cleanup, 'validatePortalR0Cleanup({');
  assertStringIncludes(cleanup, 'listSupabasePreviewBranches');
  assertStringIncludes(cleanup, "'delete'");
  assertStringIncludes(cleanup, 'FUNCTION_NAME');
  assertStringIncludes(cleanup, "'--yes'");
  assertStringIncludes(cleanup, 'PORTAL_R0_CLEANUP_DRY_RUN');
  assertStringIncludes(cleanup, 'delete only the exact R0 fixture keys');
  assertStringIncludes(cleanup, 'preserve the shared Upstash database');
  assertEquals(cleanup.includes('delete the dedicated R0 Redis database/resource'), false);
});

Deno.test('R0 environment template contains only its dedicated runtime surface', async () => {
  const template = await Deno.readTextFile('./supabase/.env.example');
  for (const expected of [
    'PORTAL_R0_RUNTIME_TARGET=test',
    'PORTAL_R0_HMAC_KEY_ID_CURRENT=',
    'PORTAL_R0_HMAC_SECRET_CURRENT=',
    'PORTAL_R0_HMAC_KEY_ID_PREVIOUS=',
    'PORTAL_R0_HMAC_SECRET_PREVIOUS=',
    'PORTAL_R0_SUPABASE_PUBLISHABLE_KEY=',
    'PORTAL_R0_REDIS_CLIENT_TYPE=upstash',
    'PORTAL_R0_UPSTASH_REDIS_URL=',
    'PORTAL_R0_UPSTASH_REDIS_TOKEN=',
    'PORTAL_R0_REDIS_URL=',
    'PORTAL_R0_REDIS_PASSWORD=',
    'PORTAL_R0_REDIS_NAMESPACE=portal:r0:fixture-change-me:v1',
    'PORTAL_R0_REDIS_TIMEOUT_MS=500',
    'PORTAL_R0_MINUTE_BUDGET=4',
    'PORTAL_R0_DAILY_BUDGET=20',
    'PORTAL_R0_MAX_CONCURRENCY=2',
    'PORTAL_R0_LEASE_TTL_SECONDS=20',
  ]) {
    assertStringIncludes(template, expected);
  }

  const r0Files = [
    './supabase/functions/_shared/portal_r0_hmac.ts',
    './supabase/functions/_shared/portal_r0_redis.ts',
    './supabase/functions/_shared/portal_r0_transport.ts',
    './supabase/functions/portal_r0_hmac_verify_v1/index.ts',
  ];
  const source = (await Promise.all(r0Files.map((file) => Deno.readTextFile(file)))).join('\n');
  for (const forbidden of [
    "env, 'PORTAL_HMAC_",
    "env, 'PORTAL_REDIS_",
    "env, 'PORTAL_UPSTASH_",
    "env, 'REDIS_",
    "env, 'UPSTASH_",
    "env, 'PORTAL_SUPABASE_PUBLISHABLE_KEY'",
    "env, 'REMOTE_",
  ]) {
    assertEquals(source.includes(forbidden), false, `forbidden R0 fallback: ${forbidden}`);
  }
});
