import { createClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { z } from 'zod';
import { API_SCHEMA, responseSchema } from '../contracts/lca-study/v2/index.ts';
import { createStudyHandler } from '../supabase/functions/_shared/study/handler.ts';
import { DISABLED_CONFIG, P1_OPERATIONS } from '../supabase/functions/_shared/study/protocol.ts';

/** This operator harness can address only the explicitly owned disposable study894 stack. */
export const localConfigSchema = z
  .object({
    schemaVersion: z.literal('lca.study-local-core-config.v1'),
    projectId: z.literal('study894'),
    supabaseUrl: z.literal('http://127.0.0.1:56421'),
    publishableKey: z.string().min(1),
    serviceKey: z.string().min(1),
    fixturePath: z.string().startsWith('/').endsWith('.json'),
  })
  .strict();
type Config = z.infer<typeof localConfigSchema>;
const actorSchema = z
  .object({
    kind: z.enum(['owner', 'member', 'outsider']),
    id: z.string().uuid(),
    email: z.string().email(),
    password: z.string().min(16),
  })
  .strict();
const fixtureSchema = z
  .object({
    schemaVersion: z.literal('lca.study-local-core-private.v1'),
    projectId: z.literal('study894'),
    runId: z.string().uuid(),
    teamId: z.string().uuid(),
    actors: z.array(actorSchema).max(3),
    studyIds: z.array(z.string().uuid()),
  })
  .strict();
type Fixture = z.infer<typeof fixtureSchema>;
function check(value: unknown, rule: string): asserts value {
  if (!value) throw new Error(rule);
}
async function sourceBindings() {
  const paths = [
    'scripts/qualify-study-core.ts',
    'supabase/functions/_shared/study/handler.ts',
    'supabase/functions/_shared/study/protocol.ts',
    'supabase/functions/_shared/study/repository.ts',
    'supabase/functions/_shared/study/validator.ts',
    'supabase/functions/_shared/auth.ts',
    'supabase/functions/_shared/command_runtime/actor_context.ts',
    'supabase/functions/_shared/supabase_client.ts',
    'supabase/functions/deno.json',
    ...['common', 'records', 'requests', 'responses', 'validation', 'pages'].map(
      (n) => `contracts/lca-study/v1/${n}.ts`,
    ),
    ...['common', 'records', 'requests', 'responses', 'index'].map(
      (n) => `contracts/lca-study/v2/${n}.ts`,
    ),
  ];
  const files = [];
  for (const path of paths) {
    const bytes = await Deno.readFile(new URL('../' + path, import.meta.url));
    files.push({
      path,
      sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(''),
    });
  }
  return {
    files,
    denoVersion: Deno.version.deno,
    supabaseJsVersion: '2.118.0',
    zodVersion: '4.6.7',
  };
}
async function privateRead(path: string): Promise<unknown> {
  const stat = await Deno.stat(path);
  check(
    stat.isFile && (stat.mode === null || (stat.mode & 0o077) === 0),
    'private-file-permissions',
  );
  return JSON.parse(await Deno.readTextFile(path));
}
async function save(path: string, value: unknown, createNew = false) {
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, createNew });
}
function sdk(config: Config, key: string) {
  return createClient(config.supabaseUrl, key, {
    db: { schema: 'api' },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        check(url.origin === config.supabaseUrl, 'sdk-loopback-target');
        return fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) });
      },
    },
  });
}
export async function provision(config: Config): Promise<void> {
  const fixture: Fixture = {
    schemaVersion: 'lca.study-local-core-private.v1',
    projectId: 'study894',
    runId: crypto.randomUUID(),
    teamId: crypto.randomUUID(),
    actors: [],
    studyIds: [],
  };
  await save(config.fixturePath, fixture, true);
  const admin = sdk(config, config.serviceKey);
  for (const kind of ['owner', 'member', 'outsider'] as const) {
    const email = `study536-${fixture.runId}-${kind}@example.invalid`,
      password = crypto.randomUUID() + crypto.randomUUID();
    const result = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    check(!result.error && result.data.user, 'local-auth-provision');
    fixture.actors.push({ kind, id: result.data.user.id, email, password });
    await save(config.fixturePath, fixture);
  }
}
export async function verify(config: Config): Promise<Record<string, unknown>> {
  const sources = await sourceBindings();
  const fixture = fixtureSchema.parse(await privateRead(config.fixturePath));
  check(fixture.actors.length === 3, 'three-owned-actors');
  const seed = z
    .object({
      projectId: z.literal('study894'),
      runId: z.string().uuid(),
      teamId: z.string().uuid(),
      actorIds: z.array(z.string().uuid()),
      generation: z.string().min(1),
    })
    .strict()
    .parse(await privateRead(config.fixturePath + '.seed.json'));
  check(
    seed.runId === fixture.runId &&
      seed.teamId === fixture.teamId &&
      JSON.stringify(seed.actorIds) === JSON.stringify(fixture.actors.map((a) => a.id)),
    'owned-fixture-seed-binding',
  );
  const envGet = Deno.env.get;
  const env: Record<string, string> = {
    SUPABASE_URL: config.supabaseUrl,
    SUPABASE_PUBLISHABLE_KEY: config.publishableKey,
    SUPABASE_SECRET_KEY: config.serviceKey,
  };
  Deno.env.get = (name: string) => env[name];
  const clients: ReturnType<typeof sdk>[] = [];
  const proof: string[] = [];
  let server: Deno.HttpServer | undefined;
  let listenerClosed = false;
  const oldLog = console.log,
    oldError = console.error;
  // Shared auth emits fixed operational diagnostics. Keep all local-auth material off stdout.
  console.log = () => {};
  console.error = () => {};
  try {
    const tokens: Record<string, string> = {};
    for (const actor of fixture.actors) {
      const client = sdk(config, config.publishableKey);
      clients.push(client);
      const result = await client.auth.signInWithPassword({
        email: actor.email,
        password: actor.password,
      });
      check(
        !result.error && result.data.session?.access_token && result.data.user?.id === actor.id,
        'actual-local-auth-signin',
      );
      tokens[actor.kind] = result.data.session.access_token;
    }
    proof.push('actual-auth-password-sessions');
    server = Deno.serve(
      { hostname: '127.0.0.1', port: 0, onListen: () => {} },
      createStudyHandler({
        config: () => ({
          ...DISABLED_CONFIG,
          runtimeEnabled: true,
          operations: [...P1_OPERATIONS],
        }),
      }),
    );
    const address = server.addr;
    check(address.transport === 'tcp', 'loopback-tcp-listener');
    const endpoint = `http://127.0.0.1:${address.port}/functions/v1/app_lca_study`;
    async function call(
      actor: string | undefined,
      operation: string,
      fields: Record<string, unknown> = {},
      key?: string,
    ) {
      const request = {
        schemaVersion: API_SCHEMA,
        requestId: crypto.randomUUID(),
        operation,
        ...fields,
        ...(key ? { idempotencyKey: key } : {}),
      };
      const response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          ...(actor ? { authorization: `Bearer ${tokens[actor] ?? actor}` } : {}),
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(30000),
      });
      const body = responseSchema.parse(await response.json());
      return { status: response.status, body };
    }
    function success(result: Awaited<ReturnType<typeof call>>, rule: string) {
      check(result.status === 200 && result.body.ok, rule);
      return result.body.data;
    }
    function failure(result: Awaited<ReturnType<typeof call>>, code: string, rule: string) {
      check(!result.body.ok && result.body.code === code, rule);
    }
    const value = (data: ReturnType<typeof success>) => {
      check(data.type === 'study', 'study-resource');
      return data.value;
    };
    failure(await call(undefined, 'capability.read'), 'AUTH_REQUIRED', 'absent-actor');
    failure(await call('not-a-jwt', 'capability.read'), 'AUTH_REQUIRED', 'invalid-bearer');
    failure(
      await call(config.serviceKey, 'capability.read'),
      'AUTH_REQUIRED',
      'service-key-not-actor',
    );
    proof.push('actual-auth-rejections');
    const cap = success(await call('owner', 'capability.read'), 'capability-read');
    check(cap.type === 'capabilities', 'capability-kind');
    check(
      cap.operations.includes('study.create') &&
        cap.operations.includes('member.set') &&
        cap.profiles.length === 0 &&
        !cap.operations.some((op) =>
          [
            'model.source.resolve',
            'model.prepare',
            'run.submit',
            'run.cancel',
            'artifact.read',
            'report.create',
            'review.record',
            'share.create',
          ].includes(op),
        ),
      'core-only-capabilities',
    );
    proof.push('actual-db-capability-projection');
    const personalKey = crypto.randomUUID(),
      personalFields = { scope: { kind: 'personal' }, title: 'Study536 actual HTTP personal' };
    const personal = value(
      success(await call('owner', 'study.create', personalFields, personalKey), 'personal-create'),
    );
    fixture.studyIds.push(personal.studyId);
    await save(config.fixturePath, fixture);
    const replay = value(
      success(await call('owner', 'study.create', personalFields, personalKey), 'create-replay'),
    );
    check(replay.studyId === personal.studyId, 'idempotent-identity');
    failure(
      await call(
        'owner',
        'study.create',
        { ...personalFields, title: 'Changed intent' },
        personalKey,
      ),
      'IDEMPOTENCY_CONFLICT',
      'create-idempotency-conflict',
    );
    proof.push('actual-create-replay-conflict');
    failure(
      await call('member', 'study.read', { studyId: personal.studyId }),
      'FORBIDDEN',
      'personal-isolation',
    );
    failure(
      await call(
        'owner',
        'member.set',
        {
          target: { type: 'study', id: personal.studyId, expectedRevision: personal.revision },
          memberId: fixture.actors[1].id,
          role: 'viewer',
        },
        crypto.randomUUID(),
      ),
      'FORBIDDEN',
      'personal-remains-owner-only',
    );
    proof.push('actual-personal-isolation');
    failure(
      await call(
        'member',
        'study.create',
        { scope: { kind: 'team', teamId: fixture.teamId }, title: 'Unauthorized team create' },
        crypto.randomUUID(),
      ),
      'FORBIDDEN',
      'team-create-role',
    );
    let team = value(
      success(
        await call(
          'owner',
          'study.create',
          { scope: { kind: 'team', teamId: fixture.teamId }, title: 'Study536 actual HTTP team' },
          crypto.randomUUID(),
        ),
        'team-create',
      ),
    );
    fixture.studyIds.push(team.studyId);
    await save(config.fixturePath, fixture);
    const memberId = fixture.actors.find((a) => a.kind === 'member')!.id,
      outsiderId = fixture.actors.find((a) => a.kind === 'outsider')!.id;
    failure(
      await call('member', 'study.read', { studyId: team.studyId }),
      'FORBIDDEN',
      'no-auto-team-grant',
    );
    const grantKey = crypto.randomUUID(),
      firstGrant = {
        target: { type: 'study', id: team.studyId, expectedRevision: team.revision },
        memberId,
        role: 'viewer',
      };
    team = value(success(await call('owner', 'member.set', firstGrant, grantKey), 'viewer-grant'));
    success(await call('member', 'study.read', { studyId: team.studyId }), 'viewer-read');
    failure(
      await call(
        'member',
        'study.archive',
        { target: { type: 'study', id: team.studyId, expectedRevision: team.revision } },
        crypto.randomUUID(),
      ),
      'FORBIDDEN',
      'viewer-not-manager',
    );
    failure(
      await call('outsider', 'study.read', { studyId: team.studyId }),
      'FORBIDDEN',
      'team-outsider',
    );
    failure(
      await call(
        'owner',
        'member.set',
        {
          target: { type: 'study', id: team.studyId, expectedRevision: team.revision },
          memberId: outsiderId,
          role: 'viewer',
        },
        crypto.randomUUID(),
      ),
      'FORBIDDEN',
      'nonmember-cannot-grant',
    );
    proof.push('actual-team-acl');
    team = value(
      success(
        await call(
          'owner',
          'member.set',
          {
            target: { type: 'study', id: team.studyId, expectedRevision: team.revision },
            memberId,
            role: 'editor',
          },
          crypto.randomUUID(),
        ),
        'editor-grant',
      ),
    );
    const raceTarget = { type: 'study', id: team.studyId, expectedRevision: team.revision };
    const races = await Promise.all(
      ['viewer', 'editor'].map((role) =>
        call('owner', 'member.set', { target: raceTarget, memberId, role }, crypto.randomUUID()),
      ),
    );
    check(
      races.filter((r) => r.body.ok).length === 1 &&
        races.filter((r) => !r.body.ok && r.body.code === 'REVISION_CONFLICT').length === 1,
      'concurrent-cas-one-winner',
    );
    team = value(
      success(
        races.find((r) => r.body.ok)!,
        'cas-winner',
      ),
    );
    proof.push('actual-http-concurrent-cas');
    const listed = success(
      await call('owner', 'study.list', { cursor: null, limit: 1 }),
      'study-list',
    );
    check(listed.type === 'studyPage' && listed.nextCursor, 'bounded-recovery-page');
    failure(
      await call('owner', 'study.list', { cursor: listed.nextCursor, limit: 2 }),
      'FORBIDDEN',
      'cursor-selection-binding',
    );
    team = value(
      success(
        await call(
          'owner',
          'member.set',
          {
            target: { type: 'study', id: team.studyId, expectedRevision: team.revision },
            memberId,
            role: null,
          },
          crypto.randomUUID(),
        ),
        'member-revoke',
      ),
    );
    failure(
      await call('member', 'study.read', { studyId: team.studyId }),
      'FORBIDDEN',
      'immediate-revocation',
    );
    failure(
      await call('owner', 'study.list', { cursor: listed.nextCursor, limit: 1 }),
      'FORBIDDEN',
      'cursor-epoch-revocation',
    );
    success(await call('owner', 'member.set', firstGrant, grantKey), 'historical-grant-replay');
    failure(
      await call('member', 'study.read', { studyId: team.studyId }),
      'FORBIDDEN',
      'replay-does-not-regrant',
    );
    proof.push('actual-live-grant-and-cursor-revocation');
    const archived = value(
      success(
        await call(
          'owner',
          'study.archive',
          { target: { type: 'study', id: personal.studyId, expectedRevision: personal.revision } },
          crypto.randomUUID(),
        ),
        'archive',
      ),
    );
    check(archived.status === 'archived', 'archived-state');
    failure(
      await call(
        'owner',
        'study.archive',
        { target: { type: 'study', id: personal.studyId, expectedRevision: archived.revision } },
        crypto.randomUUID(),
      ),
      'FROZEN_REVISION',
      'archive-no-new-mutation',
    );
    proof.push('actual-study-lifecycle');
    const again = sdk(config, config.publishableKey);
    clients.push(again);
    const owner = fixture.actors.find((a) => a.kind === 'owner')!;
    const relogin = await again.auth.signInWithPassword({
      email: owner.email,
      password: owner.password,
    });
    check(!relogin.error && relogin.data.session, 'second-actual-session');
    tokens.owner = relogin.data.session.access_token;
    success(await call('owner', 'study.read', { studyId: archived.studyId }), 'cross-session-read');
    proof.push('actual-cross-session-recovery');
    failure(
      await call(
        'owner',
        'model.source.resolve',
        {
          studyId: team.studyId,
          originRef: {
            type: 'datasetRevision',
            datasetType: 'lifecyclemodel',
            id: crypto.randomUUID(),
            version: '01.00.000',
          },
        },
        crypto.randomUUID(),
      ),
      'CAPABILITY_UNAVAILABLE',
      'w06-not-enabled',
    );
    proof.push('unqualified-producer-unavailable');
    for (const client of clients) await client.auth.signOut();
    return {
      schemaVersion: 'lca.study-local-core-proof.v1',
      passed: true,
      proofs: proof,
      actualLocalAuth: true,
      actualPostgrest: true,
      actualHandler: true,
      mockedActor: false,
      mockedSdk: false,
      producerExecutionQualified: false,
      reportOperationsQualified: false,
      ownedFixtureRetainedUntilProjectReset: true,
      sourceBindings: sources,
      listenerClosed: true,
      ownedActorCount: fixture.actors.length,
      ownedStudyCount: fixture.studyIds.length,
      ownerGeneration: seed.generation,
    };
  } finally {
    if (server) {
      await server.shutdown();
      await server.finished;
      listenerClosed = true;
    }
    Deno.env.get = envGet;
    console.log = oldLog;
    console.error = oldError;
    check(!server || listenerClosed, 'listener-cleanup');
  }
}

if (import.meta.main) {
  let failurePath: string | undefined;
  try {
    const [action, flag, path] = Deno.args;
    check(['provision', 'verify'].includes(action) && flag === '--config' && path, 'usage');
    const config = localConfigSchema.parse(await privateRead(path));
    failurePath = config.fixturePath + `.failure-${Date.now()}.json`;
    if (action === 'provision') {
      await provision(config);
      console.log(
        JSON.stringify({
          schemaVersion: 'lca.study-local-core-provision.v1',
          passed: true,
          ownedActorCount: 3,
          requiresOwnerTeamSeed: true,
        }),
      );
    } else {
      const receipt = await verify(config);
      await save(config.fixturePath + `.proof-${Date.now()}.json`, receipt, true);
      console.log(
        JSON.stringify({
          schemaVersion: receipt.schemaVersion,
          passed: true,
          proofCount: (receipt.proofs as string[]).length,
          listenerClosed: true,
        }),
      );
    }
  } catch (error) {
    if (failurePath)
      await save(
        failurePath,
        {
          schemaVersion: 'lca.study-local-core-private-failure.v1',
          errorName: error instanceof Error ? error.name : 'unknown',
          message: error instanceof Error ? error.message : 'unknown',
        },
        true,
      ).catch(() => {});
    console.error(
      JSON.stringify({
        schemaVersion: 'lca.study-local-core-proof.v1',
        passed: false,
        errorCode: 'LOCAL_CORE_QUALIFICATION_FAILED',
      }),
    );
    Deno.exitCode = 1;
  }
}
