import { createClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { z } from 'zod';
import { API_SCHEMA, responseSchema } from '../contracts/lca-study/v2/index.ts';
import { createStudyHandler } from '../supabase/functions/_shared/study/handler.ts';
import { createAppWorkerJobsHandler } from '../supabase/functions/app_worker_jobs/index.ts';
import {
  DISABLED_CONFIG,
  P1_OPERATIONS,
  configSchema as runtimeConfigSchema,
} from '../supabase/functions/_shared/study/protocol.ts';
import { sha256 } from '../supabase/functions/_shared/study/repository.ts';

/** Qualification is restricted to the receipt-owned, disposable study894 stack. */
const root = '/tmp/lca-study-p1-p4-20261103/';
export const localRuntimeConfigSchema = z
  .object({
    schemaVersion: z.literal('lca.study-local-runtime-config.v1'),
    transportEnvPath: z.literal(root + 'study894-private-transport-env.json'),
    fixturePath: z.literal(root + 'edge537-private-actors.json'),
  })
  .strict();
const configSchema = localRuntimeConfigSchema;
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
    schemaVersion: z.literal('lca.study-local-runtime-private.v1'),
    projectId: z.literal('study894'),
    runId: z.string().uuid(),
    teamId: z.string().uuid(),
    actors: z.array(actorSchema).max(3),
    studyIds: z.array(z.string().uuid()),
    resources: z.array(
      z
        .object({ type: z.string(), id: z.string(), idempotencyKey: z.string().uuid().optional() })
        .strict(),
    ),
    commands: z
      .array(
        z
          .object({
            actor: z.enum(['owner', 'member', 'outsider']),
            request: z.record(z.string(), z.unknown()),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
type Fixture = z.infer<typeof fixtureSchema>;
type Config = z.infer<typeof configSchema> & {
  supabaseUrl: 'http://127.0.0.1:56421';
  publishableKey: string;
  serviceKey: string;
};
function check(value: unknown, rule: string): asserts value {
  if (!value) throw new Error(rule);
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
  const temporary = path + '.tmp-' + crypto.randomUUID();
  try {
    await Deno.writeTextFile(temporary, JSON.stringify(value, null, 2) + '\n', {
      mode: 0o600,
      createNew: true,
    });
    const file = await Deno.open(temporary, { write: true });
    try {
      await file.sync();
    } finally {
      file.close();
    }
    if (createNew) await Deno.link(temporary, path);
    else await Deno.rename(temporary, path);
  } finally {
    try {
      await Deno.remove(temporary);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
}
async function loadConfig(path: string): Promise<Config> {
  const config = configSchema.parse(await privateRead(path));
  const transport = z
    .object({
      API_URL: z.literal('http://127.0.0.1:56421'),
      ANON_KEY: z.string().min(1),
      SERVICE_ROLE_KEY: z.string().min(1),
      project: z.literal('study894'),
    })
    .strict()
    .parse(await privateRead(config.transportEnvPath));
  return {
    ...config,
    supabaseUrl: transport.API_URL,
    publishableKey: transport.ANON_KEY,
    serviceKey: transport.SERVICE_ROLE_KEY,
  };
}
function sdk(config: Config, key: string) {
  return createClient(config.supabaseUrl, key, {
    db: { schema: 'api' },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        check(url.origin === config.supabaseUrl, 'sdk-owned-loopback-target');
        return fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) });
      },
    },
  });
}
export async function provision(config: Config): Promise<void> {
  const fixture: Fixture = {
    schemaVersion: 'lca.study-local-runtime-private.v1',
    projectId: 'study894',
    runId: crypto.randomUUID(),
    teamId: crypto.randomUUID(),
    actors: [],
    studyIds: [],
    resources: [],
    commands: [],
  };
  // Create ownership before the first account; an existing fixture is never replaced.
  await save(config.fixturePath, fixture, true);
  const admin = sdk(config, config.serviceKey);
  try {
    for (const kind of ['owner', 'member', 'outsider'] as const) {
      const email = `study537-${fixture.runId}-${kind}@example.invalid`;
      const password = crypto.randomUUID() + crypto.randomUUID();
      const result = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      check(!result.error && result.data.user, 'owned-local-auth-provision');
      fixture.actors.push({ kind, id: result.data.user.id, email, password });
      await save(config.fixturePath, fixture);
    }
  } finally {
    admin.auth.dispose();
  }
}

function object(value: unknown): Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value), 'object-wire');
  return value as Record<string, unknown>;
}
function resource(value: unknown, type: string): Record<string, unknown> {
  const data = object(value);
  check(data.type === type, 'resource-kind-' + type);
  return object(data.value);
}
function str(value: unknown): string {
  check(typeof value === 'string' && value.length > 0, 'string-wire');
  return value;
}
async function loadSeed(config: Config, fixture: Fixture) {
  const seed = object(await privateRead(config.fixturePath + '.seed.json'));
  check(
    seed.schemaVersion === 'lca.study-runtime-sql-seed-receipt.v1' &&
      seed.projectId === 'study894' &&
      seed.runId === fixture.runId &&
      seed.teamId === fixture.teamId &&
      JSON.stringify(seed.actorIds) === JSON.stringify(fixture.actors.map((a) => a.id)),
    'seed-owned-fixture',
  );
  const path = str(seed.qualificationFixturePath);
  check(path === root + 'w06-runtime-qualification-fixture.json', 'owned-qualification-input-path');
  const input = object(await privateRead(path));
  check(
    input.schemaVersion === 'lca.study-runtime-qualification-fixture.v1',
    'qualification-input-schema',
  );
  return {
    seed,
    input,
    seedReceiptSha256: await sha256(await Deno.readFile(config.fixturePath + '.seed.json')),
  };
}
async function sourceBindings() {
  const paths = [
    'scripts/qualify-study-runtime.ts',
    'supabase/functions/app_worker_jobs/index.ts',
    'supabase/functions/_shared/commands/worker_jobs.ts',
    'supabase/functions/_shared/db_rpc/worker_jobs.ts',
    ...['handler', 'repository', 'protocol', 'validator'].map(
      (p) => `supabase/functions/_shared/study/${p}.ts`,
    ),
    'supabase/functions/_shared/auth.ts',
    'supabase/functions/_shared/supabase_client.ts',
    'supabase/functions/_shared/command_runtime/actor_context.ts',
    'supabase/functions/deno.json',
    ...['common', 'records', 'requests', 'responses', 'validation', 'pages'].map(
      (p) => `contracts/lca-study/v1/${p}.ts`,
    ),
    ...['common', 'records', 'requests', 'responses', 'index'].map(
      (p) => `contracts/lca-study/v2/${p}.ts`,
    ),
  ];
  const files = [];
  for (const path of paths)
    files.push({
      path,
      sha256: await sha256(await Deno.readFile(new URL('../' + path, import.meta.url))),
    });
  return {
    files,
    denoVersion: Deno.version.deno,
    supabaseJsVersion: '2.118.0',
    zodVersion: '4.6.7',
  };
}
type CallResult = { status: number; body: z.infer<typeof responseSchema> };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
function success(result: CallResult, rule: string): unknown {
  check(
    result.status === 200 && result.body.ok,
    rule + (!result.body.ok ? ':' + result.body.code : ''),
  );
  return result.body.data;
}
function failure(result: CallResult, code: string, rule: string) {
  check(!result.body.ok && result.body.code === code, rule);
}
async function withHarness<T>(
  config: Config,
  fixture: Fixture,
  input: Record<string, unknown>,
  run: (h: {
    call: (
      actor: string | undefined,
      operation: string,
      fields?: Record<string, unknown>,
      key?: string,
    ) => Promise<CallResult>;
    forget: (operation: string, fields: Record<string, unknown>, key: string) => Promise<void>;
    generic: (
      actor: string,
      fields: Record<string, unknown>,
    ) => Promise<{ status: number; body: unknown }>;
    relogin: () => Promise<void>;
  }) => Promise<T>,
): Promise<T> {
  const envGet = Deno.env.get;
  const env: Record<string, string> = {
    SUPABASE_URL: config.supabaseUrl,
    SUPABASE_PUBLISHABLE_KEY: config.publishableKey,
    SUPABASE_SECRET_KEY: config.serviceKey,
  };
  Deno.env.get = (key: string) => env[key];
  const clients: ReturnType<typeof sdk>[] = [];
  const tokens: Record<string, string> = {};
  const oldLog = console.log,
    oldError = console.error;
  console.log = () => {};
  console.error = () => {};
  let server: Deno.HttpServer | undefined;
  async function envelope(
    actor: string | undefined,
    operation: string,
    fields: Record<string, unknown>,
    key?: string,
  ) {
    const request = {
      schemaVersion: API_SCHEMA,
      requestId: crypto.randomUUID(),
      operation,
      ...fields,
      ...(key ? { idempotencyKey: key } : {}),
    };
    if (!key) return request;
    check(
      actor === 'owner' || actor === 'member' || actor === 'outsider',
      'journal-authenticated-actor',
    );
    const prior = fixture.commands.find(
      (c) =>
        c.actor === actor && c.request.operation === operation && c.request.idempotencyKey === key,
    );
    if (prior) {
      const { requestId: oldId, ...oldBody } = prior.request;
      const { requestId: _newId, ...newBody } = request;
      check(canonical(oldBody) === canonical(newBody), 'journal-original-intent');
      check(typeof oldId === 'string', 'journal-request-id');
      return prior.request;
    }
    fixture.commands.push({ actor, request });
    await save(config.fixturePath, fixture);
    return request;
  }
  async function login() {
    for (const actor of fixture.actors) {
      const client = sdk(config, config.publishableKey);
      clients.push(client);
      const result = await client.auth.signInWithPassword({
        email: actor.email,
        password: actor.password,
      });
      check(
        !result.error && result.data.user?.id === actor.id && result.data.session?.access_token,
        'actual-owned-auth-session',
      );
      tokens[actor.kind] = result.data.session.access_token;
    }
  }
  try {
    await login();
    const runtimeConfig = runtimeConfigSchema.parse({
      ...DISABLED_CONFIG,
      runtimeEnabled: true,
      operations: [...P1_OPERATIONS],
      profiles: [
        { profileId: str(input.profileId), calculationContractRef: input.calculationContractRef },
      ],
    });
    const study = createStudyHandler({ config: () => runtimeConfig });
    const generic = createAppWorkerJobsHandler();
    server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, (request) =>
      new URL(request.url).pathname === '/functions/v1/app_worker_jobs'
        ? generic(request)
        : study(request),
    );
    check(server.addr.transport === 'tcp', 'owned-tcp-listener');
    const endpoint = `http://127.0.0.1:${server.addr.port}`;
    async function send(actor: string | undefined, path: string, body: unknown) {
      return await fetch(endpoint + path, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          ...(actor ? { authorization: `Bearer ${tokens[actor] ?? actor}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
    }
    async function call(
      actor: string | undefined,
      operation: string,
      fields: Record<string, unknown> = {},
      key?: string,
    ) {
      const response = await send(
        actor,
        '/functions/v1/app_lca_study',
        await envelope(actor, operation, fields, key),
      );
      check(response.headers.get('cache-control') === 'no-store', 'no-store-response');
      return { status: response.status, body: responseSchema.parse(await response.json()) };
    }
    return await run({
      call,
      forget: async (operation, fields, key) => {
        const response = await send(
          'owner',
          '/functions/v1/app_lca_study',
          await envelope('owner', operation, fields, key),
        );
        if (response.status !== 200) {
          const body = responseSchema.parse(await response.json());
          throw new Error(
            'dispatch-before-lost-reply:' + (body.ok ? 'unexpected-status' : body.code),
          );
        }
        await response.body?.cancel();
      },
      generic: async (actor, fields) => {
        const response = await send(actor, '/functions/v1/app_worker_jobs', fields);
        return { status: response.status, body: await response.json() };
      },
      relogin: async () => {
        for (const client of clients) {
          await client.auth.signOut({ scope: 'local' });
          client.auth.dispose();
        }
        clients.length = 0;
        await login();
      },
    });
  } finally {
    if (server) {
      await server.shutdown();
      await server.finished;
    }
    for (const client of clients) {
      await client.auth.signOut({ scope: 'local' }).catch(() => {});
      client.auth.dispose();
    }
    Deno.env.get = envGet;
    console.log = oldLog;
    console.error = oldError;
  }
}
export async function admit(config: Config): Promise<Record<string, unknown>> {
  const fixture = fixtureSchema.parse(await privateRead(config.fixturePath));
  check(fixture.actors.length === 3 && fixture.studyIds.length === 0, 'fresh-admission-fixture');
  const { seed, input } = await loadSeed(config, fixture);
  return await withHarness(config, fixture, input, async ({ call, forget, generic }) => {
    failure(await call(undefined, 'capability.read'), 'AUTH_REQUIRED', 'anonymous-denied');
    failure(
      await call(config.serviceKey, 'capability.read'),
      'AUTH_REQUIRED',
      'service-is-not-actor',
    );
    const capabilities = object(
      success(await call('owner', 'capability.read'), 'qualified-capability-read'),
    );
    check(
      Array.isArray(capabilities.profiles) && capabilities.profiles.length === 1,
      'exact-active-profile',
    );
    let study = resource(
      success(
        await call(
          'owner',
          'study.create',
          {
            scope: { kind: 'team', teamId: fixture.teamId },
            title: 'Study537 actual runtime qualification',
          },
          crypto.randomUUID(),
        ),
        'team-study-create',
      ),
      'study',
    );
    const studyId = str(study.studyId);
    fixture.studyIds.push(studyId);
    await save(config.fixturePath, fixture);
    study = resource(
      success(
        await call(
          'owner',
          'member.set',
          {
            target: { type: 'study', id: studyId, expectedRevision: study.revision },
            memberId: fixture.actors.find((a) => a.kind === 'member')!.id,
            role: 'viewer',
          },
          crypto.randomUUID(),
        ),
        'grant-existing-viewer',
      ),
      'study',
    );
    failure(
      await call('outsider', 'study.read', { studyId }),
      'FORBIDDEN',
      'outsider-study-denied',
    );
    const cancel = resource(
      success(
        await call(
          'owner',
          'model.source.resolve',
          { studyId, originRef: input.originRef },
          crypto.randomUUID(),
        ),
        'queued-cancel-acquire',
      ),
      'modelSourceAcquisition',
    );
    const cancelId = str(cancel.acquisitionId);
    fixture.resources.push({ type: 'cancelledAcquisition', id: cancelId });
    await save(config.fixturePath, fixture);
    const cancelled = resource(
      success(
        await call(
          'owner',
          'task.cancel',
          {
            studyId,
            resource: { type: 'modelSourceAcquisition', id: cancelId },
            reason: 'Owned queued cancellation qualification',
          },
          crypto.randomUUID(),
        ),
        'scoped-queued-cancel',
      ),
      'task',
    );
    check(object(cancelled.execution).status === 'cancelled', 'canonical-queued-cancelled');
    for (const action of ['read', 'cancel']) {
      const denied = await generic('owner', { action, jobId: object(cancel.execution).jobId });
      check(denied.status !== 200, 'generic-study-' + action + '-denied');
    }
    const key = crypto.randomUUID(),
      fields = { studyId, originRef: input.originRef };
    await forget('model.source.resolve', fields, key);
    const acquisition = resource(
      success(
        await call('owner', 'model.source.resolve', fields, key),
        'unknown-outcome-source-readback',
      ),
      'modelSourceAcquisition',
    );
    check(object(acquisition.execution).status === 'queued', 'normal-source-queued-before-daemon');
    fixture.resources.push({
      type: 'modelSourceAcquisition',
      id: str(acquisition.acquisitionId),
      idempotencyKey: key,
    });
    await save(config.fixturePath, fixture);
    return {
      schemaVersion: 'lca.study-local-runtime-admission-proof.v1',
      passed: true,
      actualLocalAuth: true,
      actualPostgrest: true,
      actualHandler: true,
      queuedCancellation: true,
      genericRouteDenied: true,
      lostResponseRecovered: true,
      listenerClosed: true,
      workerExecutionQualified: false,
      ownerGeneration: seed.generation,
      sourceBindings: await sourceBindings(),
    };
  });
}

export async function recoverSource(config: Config): Promise<Record<string, unknown>> {
  const fixture = fixtureSchema.parse(await privateRead(config.fixturePath));
  const { seed, input } = await loadSeed(config, fixture);
  const old = fixture.resources.find((r) => r.type === 'modelSourceAcquisition');
  check(old && !old.idempotencyKey, 'original-failed-development-attempt');
  const recovery = object(
    await privateRead(root + 'edge537-original-source-command-recovery.json'),
  );
  check(
    recovery.schemaVersion === 'lca.study-owned-command-recovery.v1',
    'development-recovery-schema',
  );
  check(
    recovery.projectId === 'study894' &&
      recovery.runId === fixture.runId &&
      recovery.acquisitionId === old.id,
    'development-recovery-resource-binding',
  );
  const recovered = object(recovery.record);
  check(
    recovered.actorId === fixture.actors.find((a) => a.kind === 'owner')!.id &&
      recovered.operation === 'model.source.resolve',
    'development-recovery-actor-binding',
  );
  const request = object(recovered.request);
  check(
    request.operation === 'model.source.resolve' &&
      request.studyId === fixture.studyIds[0] &&
      canonical(request.originRef) === canonical(input.originRef),
    'development-recovery-original-binding',
  );
  return await withHarness(config, fixture, input, async ({ call, forget }) => {
    const studyId = fixture.studyIds[0];
    const cancelled = resource(
      success(
        await call(
          'owner',
          'task.cancel',
          {
            studyId,
            resource: { type: 'modelSourceAcquisition', id: old.id },
            reason: 'Retire failed development adapter attempt after its canonical budget expired',
          },
          crypto.randomUUID(),
        ),
        'retire-old-source',
      ),
      'task',
    );
    check(object(cancelled.execution).status === 'cancelled', 'old-source-terminal-cancelled');
    const { operation: _operation, ...fields } = request;
    const prior = resource(
      success(
        await call('owner', 'model.source.resolve', fields, str(recovered.idempotencyKey)),
        'development-original-receipt-readback',
      ),
      'modelSourceAcquisition',
    );
    check(prior.acquisitionId === old.id, 'old-key-remains-original-resource');
    old.type = 'failedDevelopmentAcquisition';
    await save(config.fixturePath, fixture);
    const key = crypto.randomUUID(),
      freshFields = { studyId, originRef: input.originRef };
    await forget('model.source.resolve', freshFields, key);
    const fresh = resource(
      success(
        await call('owner', 'model.source.resolve', freshFields, key),
        'fresh-source-exact-key-readback',
      ),
      'modelSourceAcquisition',
    );
    check(
      fresh.acquisitionId !== old.id && object(fresh.execution).status === 'queued',
      'new-explicit-source-intent',
    );
    fixture.resources.push({
      type: 'modelSourceAcquisition',
      id: str(fresh.acquisitionId),
      idempotencyKey: key,
    });
    await save(config.fixturePath, fixture);
    return {
      schemaVersion: 'lca.study-local-runtime-development-recovery.v1',
      passed: true,
      developmentOnly: true,
      administrativeReceiptExtractionUsed: true,
      ordinaryClientRecoveryQualified: false,
      newIntentJournaledBeforeDispatch: true,
      originalResourcePreserved: true,
      listenerClosed: true,
      ownerGeneration: seed.generation,
      sourceBindings: await sourceBindings(),
    };
  });
}

export async function verify(config: Config): Promise<Record<string, unknown>> {
  const fixture = fixtureSchema.parse(await privateRead(config.fixturePath));
  const { seed, input, seedReceiptSha256 } = await loadSeed(config, fixture);
  const studyId = fixture.studyIds[0];
  const acquisitionResource = fixture.resources.find((r) => r.type === 'modelSourceAcquisition');
  const acquisitionId = acquisitionResource?.id;
  check(studyId && acquisitionId, 'admission-resources-retained');
  const proofs: string[] = [];
  const bindings: Record<string, unknown>[] = [];
  return await withHarness(config, fixture, input, async ({ call, forget, generic, relogin }) => {
    const original = fixture.commands.find(
      (c) =>
        c.actor === 'owner' &&
        c.request.operation === 'model.source.resolve' &&
        c.request.idempotencyKey === acquisitionResource?.idempotencyKey,
    );
    check(original, 'durable-source-request-before-process-restart');
    const {
      schemaVersion: _schema,
      requestId: _requestId,
      operation: _operation,
      idempotencyKey: key,
      ...fields
    } = original.request;
    const replayed = resource(
      success(
        await call('owner', 'model.source.resolve', fields, str(key)),
        'restart-from-durable-original-request',
      ),
      'modelSourceAcquisition',
    );
    check(replayed.acquisitionId === acquisitionId, 'restart-retains-original-source-identity');
    proofs.push('durable-client-request-recovery-after-process-restart');
    const currentStudy = resource(
      success(
        await call('owner', 'study.read', { studyId }),
        'owned-study-before-final-verification',
      ),
      'study',
    );
    success(
      await call(
        'owner',
        'member.set',
        {
          target: { type: 'study', id: studyId, expectedRevision: currentStudy.revision },
          memberId: fixture.actors.find((a) => a.kind === 'member')!.id,
          role: 'viewer',
        },
        crypto.randomUUID(),
      ),
      'explicit-existing-member-verification-grant',
    );
    async function persist(type: string, id: unknown) {
      fixture.resources.push({ type, id: str(id) });
      await save(config.fixturePath, fixture);
    }
    async function read(operation: string, fields: Record<string, unknown>, type: string) {
      return resource(success(await call('owner', operation, fields), operation), type);
    }
    async function wait(operation: string, fields: Record<string, unknown>, type: string) {
      const deadline = performance.now() + 180000;
      while (true) {
        const value = await read(operation, fields, type),
          status = object(value.execution).status;
        if (status === 'completed') return value;
        check(
          ['queued', 'running', 'waiting'].includes(str(status)),
          'producer-terminal-' + type + ':' + str(status),
        );
        check(performance.now() < deadline, 'producer-deadline-' + type);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    async function artifact(ref: unknown) {
      const data = object(
        success(
          await call('owner', 'artifact.read', { studyId, artifactRef: ref }),
          'authorized-artifact-read',
        ),
      );
      check(data.type === 'artifact' && data.encoding === 'base64', 'artifact-wire');
      const bytes = Uint8Array.from(atob(str(data.bytes)), (c) => c.charCodeAt(0));
      const r = object(ref);
      check(
        bytes.length === r.byteSize && (await sha256(bytes)) === r.contentHash,
        'artifact-independent-integrity',
      );
      return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    }
    success(await call('member', 'study.read', { studyId }), 'existing-granted-member-read');
    failure(await call('outsider', 'study.read', { studyId }), 'FORBIDDEN', 'outsider-study-read');
    const acquired = await wait('model.source.read', { acquisitionId }, 'modelSourceAcquisition');
    const snapshot = object(acquired.snapshot);
    check(
      JSON.stringify(acquired.originRef) === JSON.stringify(input.originRef),
      'actual-source-origin-binding',
    );
    failure(
      await call('owner', 'artifact.read', { studyId, artifactRef: snapshot.sourceArtifactRef }),
      'DISCLOSURE_DENIED',
      'raw-source-never-public',
    );
    const sourceTask = resource(
      success(
        await call('member', 'task.read', {
          studyId,
          resource: { type: 'modelSourceAcquisition', id: acquisitionId },
        }),
        'authorized-source-task',
      ),
      'task',
    );
    check(object(sourceTask.execution).status === 'completed', 'actual-source-terminal');
    const genericSource = await generic('owner', {
      action: 'read',
      jobId: object(acquired.execution).jobId,
    });
    check(genericSource.status !== 200, 'completed-generic-source-denial');
    proofs.push(
      'resumed-actual-source-acquisition',
      'raw-source-disclosure-denied',
      'scoped-task-and-generic-denial',
    );
    const baseFields = {
      studyId,
      source: {
        type: 'modelSourceSnapshot',
        snapshotId: snapshot.snapshotId,
        contentHash: object(snapshot.sourceArtifactRef).contentHash,
        digestScope: 'artifact_bytes_sha256',
      },
      profileId: input.profileId,
      calculationContractRef: input.calculationContractRef,
      methodRefs: input.methodRefs,
      cutoffs: input.cutoffs,
    };
    const baseRequested = resource(
      success(
        await call('owner', 'model.prepare', baseFields, crypto.randomUUID()),
        'actual-base-prepare',
      ),
      'modelPreparation',
    );
    await persist('modelPreparation', baseRequested.preparationId);
    const base = await wait(
      'model.read',
      { preparationId: baseRequested.preparationId },
      'modelPreparation',
    );
    const baseInput = await artifact(base.inputArtifactRef);
    check(
      baseInput.schemaVersion === 'lca.study-prepared-input.v1' &&
        baseInput.modelHash === object(base.modelRef).contentHash,
      'actual-compiled-model-binding',
    );
    check(
      JSON.stringify(base.methodRefs) === JSON.stringify(input.methodRefs),
      'frozen-ordered-methods',
    );
    const revision = resource(
      success(
        await call(
          'owner',
          'revision.create',
          {
            studyId,
            parentRevisionId: null,
            definition: input.definition,
            modelPreparationId: base.preparationId,
            modelRef: base.modelRef,
          },
          crypto.randomUUID(),
        ),
        'actual-revision-create',
      ),
      'studyRevision',
    );
    await persist('studyRevision', revision.revisionId);
    const frozen = resource(
      success(
        await call(
          'owner',
          'revision.freeze',
          {
            target: {
              type: 'studyRevision',
              id: revision.revisionId,
              expectedRevision: revision.revision,
            },
            expectedContentHash: revision.contentHash,
          },
          crypto.randomUUID(),
        ),
        'actual-revision-freeze',
      ),
      'studyRevision',
    );
    check(
      frozen.status === 'frozen' && frozen.validation === 'passed',
      'server-validated-frozen-revision',
    );
    proofs.push(
      'actual-native-base-preparation',
      'actual-private-storage-integrity',
      'actual-service-validated-freeze',
    );
    const expected = object(input.expected),
      tolerance = Number(expected.absoluteTolerance);
    function numbers(actual: unknown, wanted: unknown, rule: string) {
      check(
        Array.isArray(actual) && Array.isArray(wanted) && actual.length === wanted.length,
        rule + '-shape',
      );
      actual.forEach((n, i) =>
        check(
          typeof n === 'number' &&
            Number.isFinite(n) &&
            Math.abs(n - Number(wanted[i])) <= tolerance,
          rule + '-oracle',
        ),
      );
    }
    async function scenario(label: 'baseline' | 'alternative', overrides: unknown) {
      const created = resource(
        success(
          await call(
            'owner',
            'scenario.create',
            { studyRevisionId: frozen.revisionId, parentScenarioRevisionId: null, overrides },
            crypto.randomUUID(),
          ),
          label + '-scenario-create',
        ),
        'scenarioRevision',
      );
      await persist('scenarioRevision', created.scenarioRevisionId);
      const p = resource(
        success(
          await call(
            'owner',
            'model.prepare',
            {
              studyId,
              source: {
                type: 'scenarioRevision',
                scenarioRevisionId: created.scenarioRevisionId,
                expectedRevision: created.revision,
                contentHash: created.contentHash,
              },
              profileId: input.profileId,
              calculationContractRef: input.calculationContractRef,
            },
            crypto.randomUUID(),
          ),
          label + '-scenario-prepare',
        ),
        'modelPreparation',
      );
      await persist('modelPreparation', p.preparationId);
      const prepared = await wait(
        'model.read',
        { preparationId: p.preparationId },
        'modelPreparation',
      );
      check(prepared.inputHash !== null, 'scenario-numerical-input-identity');
      const s = resource(
        success(
          await call(
            'owner',
            'scenario.freeze',
            {
              target: {
                type: 'scenarioRevision',
                id: created.scenarioRevisionId,
                expectedRevision: created.revision,
              },
              expectedContentHash: created.contentHash,
              modelPreparationId: prepared.preparationId,
            },
            crypto.randomUUID(),
          ),
          label + '-scenario-freeze',
        ),
        'scenarioRevision',
      );
      check(s.status === 'frozen', 'frozen-scenario');
      const fields = {
          studyRevisionId: frozen.revisionId,
          scenarioRevisionId: s.scenarioRevisionId,
          expectedInputHash: prepared.inputHash,
          profileId: input.profileId,
          calculationContractRef: input.calculationContractRef,
        },
        key = crypto.randomUUID();
      await forget('run.submit', fields, key);
      const requested = resource(
        success(
          await call('owner', 'run.submit', fields, key),
          label + '-unknown-run-outcome-readback',
        ),
        'run',
      );
      await persist('run', requested.runId);
      const replay = resource(
        success(await call('owner', 'run.submit', fields, key), label + '-run-exact-replay'),
        'run',
      );
      check(
        replay.runId === requested.runId && replay.inputHash === prepared.inputHash,
        'run-idempotent-identity',
      );
      await relogin();
      const completed = await wait('run.read', { runId: requested.runId }, 'run');
      const result = await artifact(completed.resultRef);
      check(
        result.schemaVersion === 'lca.study-result.v1' &&
          result.inputHash === completed.inputHash &&
          result.preparedArtifactSha256 === object(prepared.inputArtifactRef).contentHash &&
          JSON.stringify(result.calculationContractRef) ===
            JSON.stringify(input.calculationContractRef),
        'actual-result-input-provenance',
      );
      numbers(result.x, expected.x, label + '-activity');
      numbers(
        result.g,
        expected[label === 'baseline' ? 'gBaseline' : 'gAlternative'],
        label + '-inventory',
      );
      numbers(
        result.h,
        expected[label === 'baseline' ? 'hBaseline' : 'hAlternative'],
        label + '-impact',
      );
      check(
        JSON.stringify(result.coverage) === JSON.stringify(expected.coverageGaps),
        'explicit-factor-gaps',
      );
      check(
        result.businessPilotQualified === false &&
          result.completeLciaScores === false &&
          Number(result.maxResidual) <= Number(expected.maxResidual),
        'qualification-limits-preserved',
      );
      const genericRun = await generic('owner', {
        action: 'read',
        jobId: object(completed.execution).jobId,
      });
      check(genericRun.status !== 200, 'generic-result-denied');
      failure(
        await call('member', 'artifact.read', { studyId, artifactRef: completed.resultRef }),
        'DISCLOSURE_DENIED',
        'study-grant-does-not-publish-private-source',
      );
      const cancel = await call(
        'owner',
        'task.cancel',
        {
          studyId,
          resource: { type: 'run', id: completed.runId },
          reason: 'Late cancellation qualification',
        },
        crypto.randomUUID(),
      );
      if (!cancel.body.ok)
        check(cancel.body.code === 'REVISION_CONFLICT', 'late-cancel-domain-result');
      const stable = await read('run.read', { runId: completed.runId }, 'run');
      check(
        object(stable.execution).status === 'completed' &&
          JSON.stringify(stable.resultRef) === JSON.stringify(completed.resultRef),
        'late-cancel-preserves-result',
      );
      bindings.push({
        label,
        studyId,
        studyRevisionId: frozen.revisionId,
        scenarioRevisionId: s.scenarioRevisionId,
        preparationId: prepared.preparationId,
        runId: completed.runId,
        jobId: object(completed.execution).jobId,
        inputHash: completed.inputHash,
        resultRef: completed.resultRef,
        h: result.h,
        coverage: result.coverage,
      });
      return completed;
    }
    const baseline = await scenario('baseline', input.baselineOverrides);
    await scenario('alternative', input.alternativeOverrides);
    proofs.push(
      'actual-two-scenario-native-solve',
      'independent-numerical-oracles',
      'run-lost-response-idempotency',
      'new-auth-session-recovery',
      'late-cancel-preserves-result',
      'frozen-source-rights-disclosure',
    );
    let current = await read('study.read', { studyId }, 'study');
    current = resource(
      success(
        await call(
          'owner',
          'member.set',
          {
            target: { type: 'study', id: studyId, expectedRevision: current.revision },
            memberId: fixture.actors.find((a) => a.kind === 'member')!.id,
            role: null,
          },
          crypto.randomUUID(),
        ),
        'current-member-revocation',
      ),
      'study',
    );
    failure(
      await call('member', 'task.read', { studyId, resource: { type: 'run', id: baseline.runId } }),
      'FORBIDDEN',
      'revoked-task-denied',
    );
    failure(
      await call('member', 'artifact.read', { studyId, artifactRef: baseline.resultRef }),
      'FORBIDDEN',
      'revoked-artifact-denied',
    );
    failure(
      await call('outsider', 'run.read', { runId: baseline.runId }),
      'FORBIDDEN',
      'outsider-result-denied',
    );
    proofs.push('actual-live-member-revocation', 'actual-outsider-denial');
    return {
      schemaVersion: 'lca.study-local-runtime-proof.v1',
      passed: true,
      proofs,
      bindings,
      actualLocalAuth: true,
      actualPostgrest: true,
      actualHandler: true,
      actualWorkerQueue: true,
      actualNativeProducer: true,
      actualPrivateStorage: true,
      mockedActor: false,
      mockedSdk: false,
      mockedProducer: false,
      hostedEdgeQualified: false,
      outerGatewayQualified: false,
      businessPilotQualified: false,
      completeLciaScores: false,
      listenerClosed: true,
      ownedFixtureRetainedUntilCleanup: true,
      ownerGeneration: seed.generation,
      seedReceiptSha256,
      databaseSourceBinding: seed.databaseSourceBinding,
      inputSha256: await sha256(await Deno.readFile(str(seed.qualificationFixturePath))),
      sourceBindings: await sourceBindings(),
    };
  });
}

export async function freshSource(config: Config): Promise<Record<string, unknown>> {
  const fixture = fixtureSchema.parse(await privateRead(config.fixturePath));
  const { seed, input, seedReceiptSha256 } = await loadSeed(config, fixture);
  check(seed.databaseSourceBinding, 'stable-final-database-source-required');
  const old = fixture.resources.find((r) => r.type === 'modelSourceAcquisition');
  check(old, 'previous-owned-source-required');
  return await withHarness(config, fixture, input, async ({ call, forget }) => {
    const prior = resource(
      success(
        await call('owner', 'model.source.read', { acquisitionId: old.id }),
        'historical-source-read',
      ),
      'modelSourceAcquisition',
    );
    check(object(prior.execution).status === 'completed', 'previous-source-terminal');
    old.type = 'completedDevelopmentAcquisition';
    await save(config.fixturePath, fixture);
    const fields = { studyId: fixture.studyIds[0], originRef: input.originRef },
      key = crypto.randomUUID();
    await forget('model.source.resolve', fields, key);
    const next = resource(
      success(
        await call('owner', 'model.source.resolve', fields, key),
        'final-source-original-key-readback',
      ),
      'modelSourceAcquisition',
    );
    check(next.acquisitionId !== old.id, 'fresh-final-source-identity');
    fixture.resources.push({
      type: 'modelSourceAcquisition',
      id: str(next.acquisitionId),
      idempotencyKey: key,
    });
    await save(config.fixturePath, fixture);
    return {
      schemaVersion: 'lca.study-local-runtime-final-source-admission.v1',
      passed: true,
      previousSourceRetained: true,
      clientIntentSyncedBeforeDispatch: true,
      replyDiscardedAndRecovered: true,
      acquisitionId: next.acquisitionId,
      ownerGeneration: seed.generation,
      seedReceiptSha256,
      databaseSourceBinding: seed.databaseSourceBinding,
      listenerClosed: true,
      sourceBindings: await sourceBindings(),
    };
  });
}

export async function replayLast(config: Config): Promise<Record<string, unknown>> {
  const fixture = fixtureSchema.parse(await privateRead(config.fixturePath));
  const { input } = await loadSeed(config, fixture);
  const last = fixture.commands.at(-1);
  check(last, 'retained-command-required');
  const {
    schemaVersion: _schema,
    requestId: _requestId,
    operation,
    idempotencyKey,
    ...fields
  } = last.request;
  return await withHarness(config, fixture, input, async ({ call }) => {
    const result = await call(last.actor, str(operation), fields, str(idempotencyKey));
    if (result.body.ok && result.body.data.type === 'run') {
      const id = result.body.data.value.runId;
      if (!fixture.resources.some((r) => r.id === id)) {
        fixture.resources.push({ type: 'diagnosticRun', id });
        await save(config.fixturePath, fixture);
      }
    }
    return {
      schemaVersion: 'lca.study-local-runtime-command-replay.v1',
      passed: true,
      diagnosticOnly: true,
      domainSucceeded: result.body.ok,
      status: result.status,
      response: result.body,
      listenerClosed: true,
      sourceBindings: await sourceBindings(),
    };
  });
}

export async function negativeCompile(config: Config): Promise<Record<string, unknown>> {
  const fixture = fixtureSchema.parse(await privateRead(config.fixturePath)),
    { seed, input } = await loadSeed(config, fixture);
  const studyId = fixture.studyIds[0],
    acquisitionId = fixture.resources.find((r) => r.type === 'modelSourceAcquisition')?.id;
  check(studyId && acquisitionId, 'owned-negative-source');
  return await withHarness(config, fixture, input, async ({ call, generic }) => {
    const acquired = resource(
        success(
          await call('owner', 'model.source.read', { acquisitionId }),
          'negative-source-read',
        ),
        'modelSourceAcquisition',
      ),
      snapshot = object(acquired.snapshot);
    const preparation = resource(
      success(
        await call(
          'owner',
          'model.prepare',
          {
            studyId,
            source: {
              type: 'modelSourceSnapshot',
              snapshotId: snapshot.snapshotId,
              contentHash: object(snapshot.sourceArtifactRef).contentHash,
              digestScope: 'artifact_bytes_sha256',
            },
            methodRefs: input.methodRefs,
            profileId: input.profileId,
            calculationContractRef: input.calculationContractRef,
          },
          crypto.randomUUID(),
        ),
        'negative-explicit-missing-cutoff-admission',
      ),
      'modelPreparation',
    );
    fixture.resources.push({
      type: 'negativeModelPreparation',
      id: str(preparation.preparationId),
    });
    await save(config.fixturePath, fixture);
    const deadline = performance.now() + 180000;
    let result = preparation;
    while (['queued', 'running', 'waiting'].includes(str(object(result.execution).status))) {
      check(performance.now() < deadline, 'negative-compiler-deadline');
      await new Promise((resolve) => setTimeout(resolve, 300));
      result = resource(
        success(
          await call('owner', 'model.read', { preparationId: preparation.preparationId }),
          'negative-model-read',
        ),
        'modelPreparation',
      );
    }
    check(
      object(result.execution).status === 'failed' &&
        result.modelRef === null &&
        result.inputArtifactRef === null,
      'failed-compiler-no-fabricated-model',
    );
    const task = resource(
      success(
        await call('owner', 'task.read', {
          studyId,
          resource: { type: 'modelPreparation', id: preparation.preparationId },
        }),
        'negative-safe-task-read',
      ),
      'task',
    );
    check(
      task.errorCode === 'boundary_undeclared' && object(task.execution).status === 'failed',
      'actual-native-fixed-boundary-error',
    );
    check(
      (await generic('owner', { action: 'read', jobId: object(task.execution).jobId })).status !==
        200,
      'generic-failure-details-denied',
    );
    return {
      schemaVersion: 'lca.study-local-runtime-negative-proof.v1',
      passed: true,
      actualNativeFailure: true,
      actualFencedFailureCallback: true,
      errorCode: task.errorCode,
      modelArtifactAbsent: true,
      preparationId: preparation.preparationId,
      jobId: object(task.execution).jobId,
      ownerGeneration: seed.generation,
      listenerClosed: true,
      sourceBindings: await sourceBindings(),
    };
  });
}

export async function cancelRun(config: Config): Promise<Record<string, unknown>> {
  const fixture = fixtureSchema.parse(await privateRead(config.fixturePath)),
    { seed, input } = await loadSeed(config, fixture);
  const original = fixture.resources.find((r) => r.type === 'run');
  check(original, 'completed-owned-run-required');
  return await withHarness(config, fixture, input, async ({ call, forget }) => {
    const baseline = resource(
      success(await call('owner', 'run.read', { runId: original.id }), 'cancel-baseline-read'),
      'run',
    );
    check(object(baseline.execution).status === 'completed', 'cancel-frozen-baseline');
    const fields = {
      studyRevisionId: baseline.studyRevisionId,
      scenarioRevisionId: baseline.scenarioRevisionId,
      expectedInputHash: baseline.inputHash,
      profileId: baseline.profileId,
      calculationContractRef: baseline.calculationContractRef,
    };
    const run = resource(
      success(
        await call('owner', 'run.submit', fields, crypto.randomUUID()),
        'separate-owned-cancel-run-submit',
      ),
      'run',
    );
    fixture.resources.push({ type: 'cancelledRun', id: str(run.runId) });
    await save(config.fixturePath, fixture);
    check(object(run.execution).status === 'queued', 'daemon-paused-queued-run');
    const cancelFields = {
        runId: run.runId,
        reason: 'Owned queued public run.cancel qualification',
      },
      key = crypto.randomUUID();
    await forget('run.cancel', cancelFields, key);
    const cancelled = resource(
      success(
        await call('owner', 'run.cancel', cancelFields, key),
        'public-run-cancel-exact-replay',
      ),
      'run',
    );
    check(
      cancelled.runId === run.runId &&
        object(cancelled.execution).status === 'cancelled' &&
        cancelled.resultRef === null,
      'public-run-cancel-no-result',
    );
    const task = resource(
      success(
        await call('owner', 'task.read', {
          studyId: run.studyId,
          resource: { type: 'run', id: run.runId },
        }),
        'cancelled-run-scoped-read',
      ),
      'task',
    );
    check(object(task.execution).status === 'cancelled', 'cancelled-run-canonical-readback');
    return {
      schemaVersion: 'lca.study-local-runtime-run-cancel-proof.v1',
      passed: true,
      runId: run.runId,
      jobId: object(run.execution).jobId,
      actualPublicRunCancel: true,
      cancelReplyDiscardedAndRecovered: true,
      resultArtifactAbsent: true,
      queuedCancellationQualified: true,
      runningCancellationQualified: false,
      ownerGeneration: seed.generation,
      listenerClosed: true,
      sourceBindings: await sourceBindings(),
    };
  });
}

export async function cleanupAuth(config: Config): Promise<Record<string, unknown>> {
  const fixture = fixtureSchema.parse(await privateRead(config.fixturePath));
  const cleanup = object(await privateRead(config.fixturePath + '.cleanup.json'));
  check(
    cleanup.schemaVersion === 'lca.study-runtime-sql-cleanup.v1' &&
      cleanup.projectId === 'study894' &&
      cleanup.runId === fixture.runId &&
      cleanup.dataCleaned === true &&
      cleanup.configRestored === true &&
      canonical(cleanup.actorIds) === canonical(fixture.actors.map((a) => a.id)),
    'owner-database-cleanup-required',
  );
  const admin = sdk(config, config.serviceKey),
    removed: string[] = [];
  try {
    for (const actor of fixture.actors) {
      const before = await admin.auth.admin.getUserById(actor.id);
      if (before.error?.status !== 404) {
        check(
          !before.error &&
            before.data.user?.id === actor.id &&
            before.data.user.email === actor.email,
          'cleanup-exact-owned-auth-account',
        );
        const result = await admin.auth.admin.deleteUser(actor.id);
        check(!result.error, 'cleanup-delete-owned-auth-account');
      }
      const after = await admin.auth.admin.getUserById(actor.id);
      check(after.error?.status === 404 && !after.data.user, 'cleanup-auth-absence');
      removed.push(actor.id);
      await save(config.fixturePath + '.auth-cleanup-progress.json', {
        runId: fixture.runId,
        removedActorIds: removed,
        complete: removed.length === fixture.actors.length,
      });
    }
    await save(
      root + 'edge537-retained-request-ledger.json',
      {
        schemaVersion: 'lca.study-local-runtime-retained-ledger.v1',
        projectId: 'study894',
        runId: fixture.runId,
        actors: fixture.actors.map((a) => ({ kind: a.kind, id: a.id })),
        teamId: fixture.teamId,
        studyIds: fixture.studyIds,
        resources: fixture.resources,
        commands: fixture.commands,
        credentialsRemoved: true,
      },
      true,
    );
    await Deno.remove(config.fixturePath);
    await Deno.remove(root + 'edge537-private-config.json');
    return {
      schemaVersion: 'lca.study-local-runtime-auth-cleanup.v1',
      passed: true,
      runId: fixture.runId,
      exactOwnedAuthUsersAbsent: removed.length,
      privateCredentialCopiesRemoved: true,
      retainedRequestLedgerWithoutCredentials: true,
      sharedTransportEnvironmentRetained: true,
    };
  } finally {
    admin.auth.dispose();
  }
}

if (import.meta.main) {
  let failurePath: string | undefined;
  let initialSources: unknown;
  try {
    const [action, flag, path] = Deno.args;
    check(
      [
        'provision',
        'admit',
        'verify',
        'recover-source',
        'cleanup-auth',
        'replay-last',
        'negative-compile',
        'cancel-run',
        'fresh-source',
      ].includes(action) &&
        flag === '--config' &&
        path,
      'usage',
    );
    const config = await loadConfig(path);
    failurePath = config.fixturePath + `.failure-${Date.now()}.json`;
    initialSources = await sourceBindings();
    if (action === 'provision') {
      await provision(config);
      console.log(
        JSON.stringify({
          schemaVersion: 'lca.study-local-runtime-provision.v1',
          passed: true,
          ownedActorCount: 3,
          requiresOwnerSeed: true,
        }),
      );
    } else {
      let receipt: Record<string, unknown>;
      switch (action) {
        case 'admit':
          receipt = await admit(config);
          break;
        case 'recover-source':
          receipt = await recoverSource(config);
          break;
        case 'cleanup-auth':
          receipt = await cleanupAuth(config);
          break;
        case 'replay-last':
          receipt = await replayLast(config);
          break;
        case 'negative-compile':
          receipt = await negativeCompile(config);
          break;
        case 'cancel-run':
          receipt = await cancelRun(config);
          break;
        case 'fresh-source':
          receipt = await freshSource(config);
          break;
        case 'verify':
          receipt = await verify(config);
          break;
        default:
          throw new Error('usage');
      }
      if (action !== 'cleanup-auth')
        check(
          canonical(receipt.sourceBindings) === canonical(initialSources),
          'source-files-changed-during-execution',
        );
      await save(config.fixturePath + `.${action}-proof-${Date.now()}.json`, receipt, true);
      console.log(
        JSON.stringify({
          schemaVersion: receipt.schemaVersion,
          passed: true,
          listenerClosed: true,
        }),
      );
    }
  } catch (error) {
    if (failurePath)
      await save(
        failurePath,
        {
          schemaVersion: 'lca.study-local-runtime-private-failure.v1',
          errorName: error instanceof Error ? error.name : 'unknown',
          message: error instanceof Error ? error.message : 'unknown',
          sourceBindings: initialSources,
        },
        true,
      ).catch(() => {});
    console.error(
      JSON.stringify({
        schemaVersion: 'lca.study-local-runtime-proof.v1',
        passed: false,
        errorCode: 'LOCAL_RUNTIME_QUALIFICATION_FAILED',
      }),
    );
    Deno.exitCode = 1;
  }
}
