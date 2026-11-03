import { createClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { z } from 'zod';
import { createStudyHandler } from '../supabase/functions/_shared/study/handler.ts';
import { createAppWorkerJobsHandler } from '../supabase/functions/app_worker_jobs/index.ts';
import {
  configSchema as coreConfigSchema,
  DISABLED_CONFIG,
} from '../supabase/functions/_shared/study/protocol.ts';
import { capabilitiesSchema as reportingConfigSchema } from '../contracts/lca-study/v3/report.ts';

/** Opt-in owned-local preparation. Importing this module performs no I/O. */
const ROOT = '/tmp/lca-study-p1-p4-20261103/p2-runtime/';
const UPSTREAM = 'http://127.0.0.1:56421';
const ORIGIN = 'http://127.0.0.1:56431';
const CALLBACK = 'http://127.0.0.1:49192/oauth/callback';
export const reportingQualificationConfigSchema = z
  .object({
    schemaVersion: z.literal('lca.study-p2-local-config.v1'),
    projectId: z.literal('study894'),
    upstreamOrigin: z.literal(UPSTREAM),
    gatewayOrigin: z.literal(ORIGIN),
    callbackUri: z.literal(CALLBACK),
    transportEnvPath: z.literal(
      '/tmp/lca-study-p1-p4-20261103/study894-private-transport-env.json',
    ),
    fixturePath: z.literal(ROOT + 'actors.private.json'),
    stackReceiptPath: z.literal(ROOT + 'stack.ready.json'),
    coreConfigPath: z.literal(ROOT + 'core-config.private.json').optional(),
    reportingConfigPath: z.literal(ROOT + 'reporting-config.private.json').optional(),
    signingKeyPath: z.literal(ROOT + 'export-signing-key.private.json').optional(),
    allowDevelopmentRenderer: z.boolean().default(false),
  })
  .strict();
type Config = z.infer<typeof reportingQualificationConfigSchema> & {
  publishableKey: string;
  serviceKey: string;
};
const actorSchema = z
  .object({
    kind: z.enum(['owner', 'member', 'outsider']),
    id: z.string().uuid().nullable(),
    email: z.string().email(),
    password: z.string().min(32),
  })
  .strict();
const fixtureSchema = z
  .object({
    schemaVersion: z.literal('lca.study-p2-owned-auth.v1'),
    projectId: z.literal('study894'),
    runId: z.string().uuid(),
    teamId: z.string().uuid(),
    actors: z.array(actorSchema).length(3),
    clientName: z.string().regex(/^study-p2-[a-f0-9-]{36}$/u),
    clientId: z.string().uuid().nullable(),
    callbackUri: z.literal(CALLBACK),
    provisionComplete: z.boolean(),
  })
  .strict();
type Fixture = z.infer<typeof fixtureSchema>;
function check(value: unknown, rule: string): asserts value {
  if (!value) throw new Error(rule);
}
async function sha256(bytes: Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
async function privateJson(path: string): Promise<unknown> {
  const info = await Deno.lstat(path);
  check(
    info.isFile && !info.isSymlink && (info.mode === null || (info.mode & 0o077) === 0),
    'private-regular-file-required',
  );
  return JSON.parse(await Deno.readTextFile(path));
}
async function save(path: string, value: unknown, createNew = false) {
  check(path.startsWith(ROOT) && !path.slice(ROOT.length).includes('/'), 'owned-evidence-path');
  const temp = path + '.' + crypto.randomUUID() + '.tmp';
  try {
    await Deno.writeTextFile(temp, JSON.stringify(value, null, 2) + '\n', {
      mode: 0o600,
      createNew: true,
    });
    const file = await Deno.open(temp, { write: true });
    try {
      await file.sync();
    } finally {
      file.close();
    }
    if (createNew) await Deno.link(temp, path);
    else await Deno.rename(temp, path);
  } finally {
    await Deno.remove(temp).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
}
async function loadConfig(path: string): Promise<Config> {
  check(path === ROOT + 'config.private.json', 'fixed-private-config-path');
  const directory = await Deno.lstat(ROOT.slice(0, -1));
  check(
    directory.isDirectory &&
      !directory.isSymlink &&
      (directory.mode === null || (directory.mode & 0o077) === 0),
    'private-owned-directory',
  );
  const config = reportingQualificationConfigSchema.parse(await privateJson(path));
  const transport = z
    .object({
      API_URL: z.literal(UPSTREAM),
      ANON_KEY: z.string().min(1),
      SERVICE_ROLE_KEY: z.string().min(1),
      project: z.literal('study894'),
    })
    .strict()
    .parse(await privateJson(config.transportEnvPath));
  const receipt = z
    .object({
      projectId: z.literal('study894'),
      configPath: z.literal('/tmp/lca-study-p1-p4-20261103/study894/supabase/config.toml'),
      configSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      oauthEnabled: z.literal(true),
      siteUrl: z.literal(ORIGIN),
      callbackUri: z.literal(CALLBACK),
      asymmetricAlgorithm: z.literal('ES256'),
    })
    .passthrough()
    .parse(await privateJson(config.stackReceiptPath));
  check(
    (await sha256(await Deno.readFile(receipt.configPath))) === receipt.configSha256,
    'owned-stack-configuration-changed',
  );
  return { ...config, publishableKey: transport.ANON_KEY, serviceKey: transport.SERVICE_ROLE_KEY };
}
function client(key: string, origin = UPSTREAM) {
  check(origin === UPSTREAM || origin === ORIGIN, 'owned-sdk-origin');
  return createClient(origin, key, {
    db: { schema: 'api' },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        check(
          url.origin === origin && url.username === '' && url.password === '',
          'owned-sdk-target',
        );
        return await fetch(input, {
          ...init,
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
        });
      },
    },
  });
}
async function sourceBindings() {
  const paths = new Set([
    'scripts/qualify-study-reporting.ts',
    'supabase/functions/app_worker_jobs/index.ts',
    'supabase/functions/_shared/auth.ts',
    'supabase/functions/_shared/supabase_client.ts',
    'supabase/functions/_shared/command_runtime/actor_context.ts',
    'supabase/functions/deno.json',
  ]);
  async function visit(path: string) {
    for await (const entry of Deno.readDir(new URL('../' + path, import.meta.url))) {
      if (entry.isDirectory) await visit(path + '/' + entry.name);
      else if (entry.isFile && /\.(ts|json|mjs)$/u.test(entry.name))
        paths.add(path + '/' + entry.name);
    }
  }
  for (const path of ['supabase/functions/_shared/study', 'contracts/lca-study']) await visit(path);
  return {
    denoVersion: Deno.version.deno,
    supabaseJsVersion: '2.118.0',
    files: await Promise.all(
      [...paths].sort().map(async (path) => ({
        path,
        sha256: await sha256(await Deno.readFile(new URL('../' + path, import.meta.url))),
      })),
    ),
  };
}
async function boundedBytes(stream: ReadableStream<Uint8Array> | null, maximum: number) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      check(size <= maximum, 'auth-stream-byte-limit');
      chunks.push(item.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
async function boundedJson(response: Response) {
  const bytes = await boundedBytes(response.body, 65536);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
function plainObject(value: unknown): Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value), 'auth-object');
  return value as Record<string, unknown>;
}
async function readiness(config: Config) {
  const response = await fetch(UPSTREAM + '/auth/v1/.well-known/jwks.json', {
    headers: { apikey: config.publishableKey },
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  check(response.ok, 'actual-jwks-response');
  const document = plainObject(await boundedJson(response));
  check(
    Array.isArray(document.keys) && document.keys.length > 0 && document.keys.length <= 8,
    'actual-jwks-keys',
  );
  const keys = document.keys.map(plainObject);
  check(
    keys.some((key) => key.alg === 'ES256' && key.kty === 'EC' && key.crv === 'P-256') &&
      keys.every((key) => !['d', 'p', 'q', 'dp', 'dq', 'qi', 'k'].some((field) => field in key)),
    'actual-asymmetric-public-jwks',
  );
  return {
    schemaVersion: 'lca.study-p2-auth-readiness.v1',
    passed: true,
    actualGoTrue: true,
    asymmetricAlgorithm: 'ES256',
    publicKeys: keys.map((key) => ({ kid: key.kid, alg: key.alg, kty: key.kty, crv: key.crv })),
  };
}
async function provision(config: Config) {
  const runId = crypto.randomUUID();
  const fixture: Fixture = {
    schemaVersion: 'lca.study-p2-owned-auth.v1',
    projectId: 'study894',
    runId,
    teamId: crypto.randomUUID(),
    clientName: 'study-p2-' + runId,
    clientId: null,
    callbackUri: CALLBACK,
    provisionComplete: false,
    actors: (['owner', 'member', 'outsider'] as const).map((kind) => ({
      kind,
      id: null,
      email: `study-p2-${runId}-${kind}@example.invalid`,
      password: crypto.randomUUID() + crypto.randomUUID(),
    })),
  };
  await save(config.fixturePath, fixture, true);
  const admin = client(config.serviceKey);
  try {
    for (const actor of fixture.actors) {
      const result = await admin.auth.admin.createUser({
        email: actor.email,
        password: actor.password,
        email_confirm: true,
      });
      check(!result.error && result.data.user?.email === actor.email, 'owned-actor-provision');
      actor.id = result.data.user.id;
      await save(config.fixturePath, fixture);
    }
    const result = await admin.auth.admin.oauth.createClient({
      client_name: fixture.clientName,
      redirect_uris: [CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'openid email profile',
      token_endpoint_auth_method: 'none',
    });
    check(!result.error && result.data?.client_id, 'actual-owned-public-oauth-client');
    fixture.clientId = result.data.client_id;
    fixture.provisionComplete = true;
    await save(config.fixturePath, fixture);
    return {
      schemaVersion: 'lca.study-p2-owned-auth-provision.v1',
      passed: true,
      actualOwnedActors: fixture.actors.length,
      actualOAuthClient: true,
      clientAuthentication: 'none',
      databaseClientGrantsConfigured: false,
    };
  } finally {
    admin.auth.dispose();
  }
}
async function loadFixture(config: Config) {
  const fixture = fixtureSchema.parse(await privateJson(config.fixturePath));
  check(
    fixture.provisionComplete && fixture.clientId && fixture.actors.every((actor) => actor.id),
    'complete-owned-auth-fixture-required',
  );
  return fixture;
}
function html(body: string, cookie?: string) {
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>Owned Study P2 consent</title>' + body,
    {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy':
          "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        'referrer-policy': 'no-referrer',
        ...(cookie ? { 'set-cookie': cookie } : {}),
      },
    },
  );
}
async function startGateway(config: Config, fixture: Fixture) {
  // Only this isolated process sees these credentials; no auth/repository override exists.
  for (const name of [
    'REMOTE_SUPABASE_URL',
    'REMOTE_SUPABASE_SERVICE_ROLE_KEY',
    'REMOTE_SUPABASE_SECRET_KEY',
    'REMOTE_SUPABASE_PUBLISHABLE_KEY',
    'REMOTE_SUPABASE_ANON_KEY',
  ])
    check(!Deno.env.get(name), 'foreign-remote-environment-forbidden');
  Deno.env.set('SUPABASE_URL', UPSTREAM);
  Deno.env.set('SUPABASE_PUBLISHABLE_KEY', config.publishableKey);
  Deno.env.set('SUPABASE_SECRET_KEY', config.serviceKey);
  Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', config.serviceKey);
  Deno.env.set('SUPABASE_ANON_KEY', config.publishableKey);
  Deno.env.delete('STUDY_REPORTING_CONFIG');
  Deno.env.delete('STUDY_EXPORT_SIGNING_KEY');
  if (config.signingKeyPath)
    Deno.env.set(
      'STUDY_EXPORT_SIGNING_KEY',
      JSON.stringify(await privateJson(config.signingKeyPath)),
    );
  const core = config.coreConfigPath
    ? coreConfigSchema.parse(await privateJson(config.coreConfigPath))
    : DISABLED_CONFIG;
  const reporting = config.reportingConfigPath
    ? reportingConfigSchema.parse(await privateJson(config.reportingConfigPath))
    : undefined;
  const study = createStudyHandler({
    config: () => core,
    reporting: {
      ...(reporting ? { config: () => reporting } : {}),
      allowDevelopmentRenderer: config.allowDevelopmentRenderer,
    },
  });
  const generic = createAppWorkerJobsHandler();
  const sessions = new Map<
    string,
    { sdk: ReturnType<typeof client>; authorizationId: string; csrf: string }
  >();
  const upstreamPaths =
    /^(?:token|user|logout|\.well-known\/(?:jwks\.json|openid-configuration)|oauth\/(?:authorize|token|userinfo|authorizations\/[A-Za-z0-9_-]{16,128}(?:\/consent)?)|user\/oauth\/grants)$/u;
  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    check(url.origin === ORIGIN, 'gateway-request-origin');
    if (url.pathname === '/functions/v1/app_lca_study') return await study(request);
    if (url.pathname === '/functions/v1/app_worker_jobs') return await generic(request);
    if (url.pathname.startsWith('/auth/v1/')) {
      const path = url.pathname.slice('/auth/v1/'.length);
      check(upstreamPaths.test(path), 'gateway-auth-route-allowlist');
      const methods =
        path === 'user/oauth/grants'
          ? ['GET', 'DELETE']
          : ['token', 'oauth/token', 'logout'].includes(path) || path.endsWith('/consent')
            ? ['POST']
            : ['GET'];
      check(methods.includes(request.method), 'gateway-auth-method-allowlist');
      if (path === 'oauth/authorize') {
        check(
          request.method === 'GET' &&
            url.searchParams.get('client_id') === fixture.clientId &&
            url.searchParams.get('redirect_uri') === CALLBACK &&
            url.searchParams.get('code_challenge_method') === 'S256',
          'owned-oauth-authorize-target',
        );
      }
      const body = ['GET', 'HEAD'].includes(request.method)
        ? undefined
        : await boundedBytes(request.body, 65536);
      if (path === 'oauth/token' && body) {
        check(
          new URLSearchParams(new TextDecoder().decode(body)).get('client_id') === fixture.clientId,
          'owned-oauth-token-client',
        );
      }
      const headers = new Headers();
      for (const name of [
        'authorization',
        'apikey',
        'content-type',
        'x-client-info',
        'x-supabase-api-version',
      ]) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      const response = await fetch(UPSTREAM + url.pathname + url.search, {
        method: request.method,
        body,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
      });
      const location = response.headers.get('location');
      if (location) {
        const target = new URL(location, UPSTREAM);
        check(
          (target.origin === ORIGIN && target.pathname === '/oauth/consent') ||
            (target.origin === new URL(CALLBACK).origin && target.pathname === '/oauth/callback'),
          'owned-auth-redirect-only',
        );
      }
      const responseHeaders = new Headers({
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
      for (const name of ['content-type', 'location', 'www-authenticate']) {
        const value = response.headers.get(name);
        if (value) responseHeaders.set(name, value);
      }
      const bytes = await boundedBytes(response.body, 65536);
      return new Response([204, 205, 304].includes(response.status) ? null : bytes, {
        status: response.status,
        headers: responseHeaders,
      });
    }
    if (url.pathname === '/oauth/consent' && request.method === 'GET') {
      const id = url.searchParams.get('authorization_id');
      check(id && /^[A-Za-z0-9_-]{16,128}$/u.test(id), 'authorization-id-required');
      const token = crypto.randomUUID(),
        csrf = crypto.randomUUID();
      check(sessions.size < 16, 'bounded-consent-sessions');
      sessions.set(token, {
        sdk: client(config.publishableKey, ORIGIN),
        authorizationId: id,
        csrf,
      });
      return html(
        `<h1>Owned local Study P2 authorization</h1><p>Synthetic qualification accounts only.</p><form method="post" action="/oauth/login"><input type="hidden" name="csrf" value="${csrf}"><label>Email <input name="email" type="email" required></label><label>Password <input name="password" type="password" required></label><button>Sign in</button></form>`,
        `study_p2=${token}; HttpOnly; SameSite=Strict; Path=/oauth; Max-Age=180`,
      );
    }
    if (['/oauth/login', '/oauth/approve'].includes(url.pathname) && request.method === 'POST') {
      check(request.headers.get('origin') === ORIGIN, 'consent-form-origin');
      const token = request.headers
        .get('cookie')
        ?.match(/(?:^|;\s*)study_p2=([a-f0-9-]{36})(?:;|$)/u)?.[1];
      const session = token ? sessions.get(token) : undefined;
      check(session, 'consent-session-required');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(
        await boundedBytes(request.body, 4096),
      );
      const form = new URLSearchParams(text);
      check(form.get('csrf') === session.csrf, 'consent-form-csrf');
      if (url.pathname === '/oauth/login') {
        const actor = fixture.actors.find(
          (item) => item.email === form.get('email') && item.password === form.get('password'),
        );
        check(actor, 'owned-synthetic-account-only');
        const signed = await session.sdk.auth.signInWithPassword({
          email: actor.email,
          password: actor.password,
        });
        check(!signed.error && signed.data.user?.id === actor.id, 'consent-real-first-party-login');
        const details = await session.sdk.auth.oauth.getAuthorizationDetails(
          session.authorizationId,
        );
        check(
          !details.error &&
            details.data &&
            'authorization_id' in details.data &&
            details.data.client.id === fixture.clientId &&
            details.data.redirect_uri === CALLBACK,
          'consent-real-owned-authorization',
        );
        return html(
          `<h1>Allow owned Study P2 client</h1><p>openid email profile</p><form method="post" action="/oauth/approve"><input type="hidden" name="csrf" value="${session.csrf}"><button>Allow connection</button></form>`,
        );
      }
      const approved = await session.sdk.auth.oauth.approveAuthorization(session.authorizationId, {
        skipBrowserRedirect: true,
      });
      check(!approved.error && approved.data?.redirect_url, 'actual-consent-approval');
      const target = new URL(approved.data.redirect_url);
      check(
        target.origin === new URL(CALLBACK).origin && target.pathname === '/oauth/callback',
        'actual-consent-callback-target',
      );
      await session.sdk.auth.signOut({ scope: 'local' });
      session.sdk.auth.dispose();
      sessions.delete(token!);
      return new Response(null, {
        status: 303,
        headers: {
          location: target.href,
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          'set-cookie': 'study_p2=; HttpOnly; SameSite=Strict; Path=/oauth; Max-Age=0',
        },
      });
    }
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 56431, onListen: () => {} },
    async (request) => {
      try {
        return await route(request);
      } catch {
        return new Response(JSON.stringify({ error: 'OWNED_GATEWAY_REQUEST_REJECTED' }), {
          status: 400,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        });
      }
    },
  );
  return {
    server,
    close: async () => {
      await server.shutdown();
      await server.finished;
      for (const session of sessions.values()) {
        await session.sdk.auth.signOut({ scope: 'local' }).catch(() => {});
        session.sdk.auth.dispose();
      }
      sessions.clear();
    },
  };
}
function decode64(value: string) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)), (c) =>
    c.charCodeAt(0),
  );
}
async function oauth(config: Config, fixture: Fixture) {
  const gateway = await startGateway(config, fixture);
  const actor = fixture.actors.find((item) => item.kind === 'owner')!;
  const firstParty = client(config.publishableKey, ORIGIN);
  let callback: Deno.HttpServer | undefined;
  try {
    const admin = client(config.serviceKey);
    try {
      const ownedClient = await admin.auth.admin.oauth.getClient(fixture.clientId!);
      check(
        !ownedClient.error &&
          ownedClient.data?.client_name === fixture.clientName &&
          ownedClient.data.client_type === 'public' &&
          ownedClient.data.token_endpoint_auth_method === 'none' &&
          JSON.stringify(ownedClient.data.redirect_uris) === JSON.stringify([CALLBACK]),
        'actual-owned-public-client-readback',
      );
    } finally {
      admin.auth.dispose();
    }
    const signed = await firstParty.auth.signInWithPassword({
      email: actor.email,
      password: actor.password,
    });
    check(
      !signed.error && signed.data.user?.id === actor.id && signed.data.session,
      'actual-first-party-session',
    );
    const state = crypto.randomUUID() + crypto.randomUUID();
    const verifier = crypto.randomUUID() + crypto.randomUUID();
    const challenge = btoa(
      String.fromCharCode(
        ...new Uint8Array(
          await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
        ),
      ),
    )
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
    let receiveCode!: (code: string) => void;
    const received = new Promise<string>((resolve) => {
      receiveCode = resolve;
    });
    let consumed = false;
    callback = Deno.serve({ hostname: '127.0.0.1', port: 49192, onListen: () => {} }, (request) => {
      const url = new URL(request.url);
      if (
        consumed ||
        request.method !== 'GET' ||
        url.origin !== new URL(CALLBACK).origin ||
        url.pathname !== '/oauth/callback' ||
        url.searchParams.get('state') !== state ||
        !url.searchParams.get('code')
      )
        return new Response('Rejected', { status: 400 });
      consumed = true;
      receiveCode(url.searchParams.get('code')!);
      return new Response('Owned OAuth callback received', {
        headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
      });
    });
    const authorize = new URL(ORIGIN + '/auth/v1/oauth/authorize');
    authorize.search = new URLSearchParams({
      response_type: 'code',
      client_id: fixture.clientId!,
      redirect_uri: CALLBACK,
      scope: 'openid email profile',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    }).toString();
    const response = await fetch(authorize, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
    check(
      response.status >= 300 && response.status < 400 && response.headers.get('location'),
      'real-authorize-redirect',
    );
    const consent = new URL(response.headers.get('location')!);
    check(
      consent.origin === ORIGIN &&
        consent.pathname === '/oauth/consent' &&
        consent.searchParams.get('authorization_id'),
      'real-local-consent-target',
    );
    const authorizationId = consent.searchParams.get('authorization_id')!;
    const details = await firstParty.auth.oauth.getAuthorizationDetails(authorizationId);
    await save(ROOT + 'oauth-details-diagnostic.json', {
      authorizationIdLength: authorizationId.length,
      authorizationIdSafePath: /^[A-Za-z0-9_-]{16,128}$/u.test(authorizationId),
      dataKeys: details.data ? Object.keys(details.data) : [],
      clientKeys: details.data && 'client' in details.data ? Object.keys(details.data.client) : [],
      errorStatus: details.error?.status ?? null,
      errorCode: details.error?.code ?? null,
      clientMatches:
        !!details.data && 'client' in details.data && details.data.client.id === fixture.clientId,
      callbackMatches:
        !!details.data && 'redirect_uri' in details.data && details.data.redirect_uri === CALLBACK,
    });
    check(
      !details.error &&
        details.data &&
        'authorization_id' in details.data &&
        details.data.client.id === fixture.clientId &&
        details.data.redirect_uri === CALLBACK,
      'real-authorization-details',
    );
    const consentPage = await fetch(consent, {
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    const cookie = consentPage.headers.get('set-cookie')?.split(';')[0];
    const page = new TextDecoder().decode(await boundedBytes(consentPage.body, 4096));
    const csrf = page.match(/name="csrf" value="([a-f0-9-]{36})"/u)?.[1];
    check(consentPage.ok && cookie && csrf, 'real-consent-form');
    const formHeaders = {
      'content-type': 'application/x-www-form-urlencoded',
      origin: ORIGIN,
      cookie,
    };
    const loginForm = await fetch(ORIGIN + '/oauth/login', {
      method: 'POST',
      headers: formHeaders,
      body: new URLSearchParams({ csrf, email: actor.email, password: actor.password }),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    check(loginForm.ok, 'real-consent-form-login');
    await loginForm.body?.cancel();
    const approvalForm = await fetch(ORIGIN + '/oauth/approve', {
      method: 'POST',
      headers: formHeaders,
      body: new URLSearchParams({ csrf }),
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
    check(
      approvalForm.status === 303 && approvalForm.headers.get('location'),
      'real-consent-approved',
    );
    const redirect = new URL(approvalForm.headers.get('location')!);
    await approvalForm.body?.cancel();
    check(
      redirect.origin === new URL(CALLBACK).origin &&
        redirect.pathname === '/oauth/callback' &&
        redirect.searchParams.get('state') === state,
      'real-generated-callback',
    );
    const callbackResponse = await fetch(redirect, {
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    check(callbackResponse.ok, 'real-callback-delivery');
    await callbackResponse.body?.cancel();
    const code = await received;
    const tokensResponse = await fetch(ORIGIN + '/auth/v1/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: fixture.clientId!,
        redirect_uri: CALLBACK,
        code_verifier: verifier,
      }),
    });
    const tokens = plainObject(await boundedJson(tokensResponse));
    check(
      tokensResponse.ok &&
        typeof tokens.access_token === 'string' &&
        typeof tokens.refresh_token === 'string' &&
        typeof tokens.id_token === 'string',
      'actual-oauth-token-and-id-token',
    );
    const actorResponse = await fetch(ORIGIN + '/auth/v1/user', {
      headers: { apikey: config.publishableKey, authorization: 'Bearer ' + tokens.access_token },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    check(
      actorResponse.ok && plainObject(await boundedJson(actorResponse)).id === actor.id,
      'oauth-live-user',
    );
    const info = await fetch(ORIGIN + '/auth/v1/oauth/userinfo', {
      headers: { authorization: 'Bearer ' + tokens.access_token },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    check(info.ok && plainObject(await boundedJson(info)).sub === actor.id, 'oauth-live-userinfo');
    const parts = tokens.access_token.split('.');
    check(parts.length === 3, 'oauth-jwt-shape');
    const header = plainObject(JSON.parse(new TextDecoder().decode(decode64(parts[0]))));
    const claims = plainObject(JSON.parse(new TextDecoder().decode(decode64(parts[1]))));
    check(
      header.alg === 'ES256' && claims.client_id === fixture.clientId && claims.sub === actor.id,
      'live-verified-oauth-client-claims',
    );
    const jwks = await fetch(ORIGIN + '/auth/v1/.well-known/jwks.json', {
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    const keys = plainObject(await boundedJson(jwks)).keys;
    check(jwks.ok && Array.isArray(keys), 'oauth-actual-jwks');
    const jwk = keys.map(plainObject).find((key) => key.kid === header.kid && key.alg === 'ES256');
    check(jwk, 'oauth-jwks-key-match');
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk as JsonWebKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    check(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        decode64(parts[2]),
        new TextEncoder().encode(parts[0] + '.' + parts[1]),
      ),
      'oauth-jwks-signature-verification',
    );
    const revoked = await firstParty.auth.oauth.revokeGrant({ clientId: fixture.clientId! });
    check(!revoked.error, 'owned-test-grant-revoked');
    const grants = await firstParty.auth.oauth.listGrants();
    check(
      !grants.error &&
        grants.data &&
        !grants.data.some((grant) => grant.client.id === fixture.clientId),
      'owned-test-grant-absence',
    );
    return {
      schemaVersion: 'lca.study-p2-actual-oauth-protocol.v1',
      passed: true,
      firstPartySessionSeparatelyVerified: true,
      actualAuthorize: true,
      actualConsent: true,
      actualLocalConsentForms: true,
      actualCallback: true,
      actualPkceExchange: true,
      actualIdToken: true,
      actualOAuthClientClaim: true,
      actualLiveUser: true,
      actualUserinfo: true,
      actualJwksSignature: true,
      algorithm: 'ES256',
      testGrantRevoked: true,
      installedCliLoginQualified: false,
      reportComputationQualified: false,
    };
  } finally {
    if (callback) {
      await callback.shutdown();
      await callback.finished;
    }
    await firstParty.auth.signOut({ scope: 'local' }).catch(() => {});
    firstParty.auth.dispose();
    await gateway.close();
  }
}
if (import.meta.main) {
  const output = console.log.bind(console);
  console.log = () => {};
  console.error = () => {};
  let stage = 'arguments';
  try {
    const [action, flag, path] = Deno.args;
    check(
      ['readiness', 'provision', 'oauth', 'gateway'].includes(action) &&
        flag === '--config' &&
        path &&
        Deno.args.length === 3,
      'usage-readiness-provision-oauth-gateway-config',
    );
    stage = 'configuration';
    const config = await loadConfig(path);
    stage = 'sources';
    const sources = await sourceBindings();
    stage = action;
    if (action === 'gateway') {
      const gateway = await startGateway(config, await loadFixture(config));
      await save(ROOT + 'gateway.started.json', {
        schemaVersion: 'lca.study-p2-gateway-start.v1',
        pid: Deno.pid,
        origin: ORIGIN,
        startedAt: new Date().toISOString(),
        sourceBindings: sources,
        configSha256: await sha256(await Deno.readFile(path)),
      });
      output(
        JSON.stringify({
          schemaVersion: 'lca.study-p2-gateway-start.v1',
          ready: true,
          origin: ORIGIN,
          pid: Deno.pid,
        }),
      );
      const stop = () => {
        gateway.close().catch(() => {});
      };
      Deno.addSignalListener('SIGTERM', stop);
      Deno.addSignalListener('SIGINT', stop);
      await gateway.server.finished;
      await save(ROOT + 'gateway.stopped.json', {
        pid: Deno.pid,
        stoppedAt: new Date().toISOString(),
        listenerClosed: true,
      });
    } else {
      const receipt =
        action === 'readiness'
          ? await readiness(config)
          : action === 'provision'
            ? await provision(config)
            : await oauth(config, await loadFixture(config));
      check(
        JSON.stringify(sources) === JSON.stringify(await sourceBindings()),
        'source-changed-during-qualification',
      );
      await save(
        ROOT + action + '.proof-' + Date.now() + '.json',
        { ...receipt, sourceBindings: sources },
        true,
      );
      output(
        JSON.stringify({
          schemaVersion: receipt.schemaVersion,
          passed: true,
          installedCliLoginQualified: false,
        }),
      );
    }
  } catch (error) {
    await save(
      ROOT + 'failure-' + Date.now() + '.json',
      {
        schemaVersion: 'lca.study-p2-private-failure.v1',
        stage,
        rule:
          error instanceof Error && /^[a-z0-9-]+$/u.test(error.message)
            ? error.message
            : 'private-error',
        passed: false,
      },
      true,
    ).catch(() => {});
    output(JSON.stringify({ schemaVersion: 'lca.study-p2-preparation.v1', passed: false, stage }));
    Deno.exitCode = 1;
  }
}
