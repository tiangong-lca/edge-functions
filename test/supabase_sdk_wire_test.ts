import { assert, assertEquals } from 'jsr:@std/assert';
import { AuthInvalidJwtError, FunctionsHttpError } from '@supabase/supabase-js@2';

import { authenticateRequest, AuthMethod } from '../supabase/functions/_shared/auth.ts';
import {
  createRequestSupabaseClient,
  createSupabaseAuthClient,
  createSupabaseServiceClient,
} from '../supabase/functions/_shared/supabase_client.ts';

const PUBLISHABLE_KEY = 'sb_publishable_synthetic_sdk_wire';
const SERVICE_KEY = 'sb_secret_synthetic_sdk_wire';
const ACTOR_TOKEN = 'synthetic-actor-access-token';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const CLIENT_ID = '33333333-3333-4333-8333-333333333333';

async function withSyntheticEnvironment(baseUrl: string, run: () => Promise<void>) {
  const previousGet = Deno.env.get;
  const values: Record<string, string> = {
    SUPABASE_URL: baseUrl,
    SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
    SUPABASE_SECRET_KEY: SERVICE_KEY,
  };
  // No host credential value is read, copied, or used by these fixtures.
  Deno.env.get = (name: string) => values[name];
  try {
    await run();
  } finally {
    Deno.env.get = previousGet;
  }
}

interface WireRequest {
  url: string;
  method: string;
  authorization: string | null;
  apikey: string | null;
  contentProfile: string | null;
  acceptProfile: string | null;
  contentType: string | null;
  body: unknown;
}

async function recordRequest(request: Request): Promise<WireRequest> {
  const text = await request.text();
  return {
    url: request.url,
    method: request.method,
    authorization: request.headers.get('authorization'),
    apikey: request.headers.get('apikey'),
    contentProfile: request.headers.get('content-profile'),
    acceptProfile: request.headers.get('accept-profile'),
    contentType: request.headers.get('content-type'),
    body: text ? JSON.parse(text) : null,
  };
}

Deno.test(
  'shared Supabase factories preserve RPC schema and isolate actor and service credentials',
  async () => {
    const previousFetch = globalThis.fetch;
    const requests: WireRequest[] = [];
    const baseUrl = 'https://supabase-rpc-wire.invalid';
    globalThis.fetch = async (input, init) => {
      requests.push(await recordRequest(new Request(input, init)));
      return Response.json({ accepted: true });
    };
    try {
      await withSyntheticEnvironment(baseUrl, async () => {
        const actor = createRequestSupabaseClient(ACTOR_TOKEN);
        const service = createSupabaseServiceClient();
        const auth = createSupabaseAuthClient();
        const publishable = createRequestSupabaseClient();
        const args = { p_text: 'steel 钢', p_count: 2 };
        for (const operation of [
          actor.rpc('wire_fixture_rpc', args),
          actor.schema('public').rpc('wire_fixture_rpc', args),
          service.rpc('wire_fixture_rpc', args),
          auth.rpc('wire_fixture_rpc', args),
          publishable.rpc('wire_fixture_rpc', args),
          actor.rpc('wire_fixture_rpc', args, { get: true }),
          actor.schema('public').rpc('wire_fixture_rpc', args, { get: true }),
        ]) {
          const result = await operation;
          assertEquals(result.error, null);
          assertEquals(result.data, { accepted: true });
        }
        const post = {
          url: `${baseUrl}/rest/v1/rpc/wire_fixture_rpc`,
          method: 'POST',
          authorization: `Bearer ${ACTOR_TOKEN}`,
          apikey: PUBLISHABLE_KEY,
          contentProfile: 'api',
          acceptProfile: null,
          contentType: 'application/json',
          body: args,
        };
        const getUrl = new URL(post.url);
        getUrl.searchParams.set('p_text', args.p_text);
        getUrl.searchParams.set('p_count', String(args.p_count));
        assertEquals(requests, [
          post,
          { ...post, contentProfile: 'public' },
          { ...post, authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY },
          { ...post, authorization: `Bearer ${PUBLISHABLE_KEY}` },
          { ...post, authorization: `Bearer ${PUBLISHABLE_KEY}` },
          {
            ...post,
            url: getUrl.toString(),
            method: 'GET',
            contentProfile: null,
            acceptProfile: 'api',
            contentType: null,
            body: null,
          },
          {
            ...post,
            url: getUrl.toString(),
            method: 'GET',
            contentProfile: null,
            acceptProfile: 'public',
            contentType: null,
            body: null,
          },
        ]);
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  },
);

Deno.test(
  'shared Supabase Functions invocation preserves credentials and maps HTTP errors',
  async () => {
    const previousFetch = globalThis.fetch;
    const requests: WireRequest[] = [];
    const baseUrl = 'https://supabase-functions-wire.invalid';
    let rejectRequest = false;
    globalThis.fetch = async (input, init) => {
      requests.push(await recordRequest(new Request(input, init)));
      return rejectRequest
        ? Response.json({ code: 'synthetic_function_rejection' }, { status: 422 })
        : Response.json({ signature: 'synthetic-only' });
    };
    try {
      await withSyntheticEnvironment(baseUrl, async () => {
        const actor = createRequestSupabaseClient(ACTOR_TOKEN);
        const service = createSupabaseServiceClient();
        const publishable = createRequestSupabaseClient();
        const body = { message: 'offline wire 钢', method: 'POST' };
        const success = await actor.functions.invoke('sign_request', { body });
        assertEquals(success.error, null);
        assertEquals(success.data, { signature: 'synthetic-only' });
        rejectRequest = true;
        const failure = await actor.functions.invoke('sign_request', { body });
        assertEquals(failure.data, null);
        assert(failure.error instanceof FunctionsHttpError);
        assert(failure.error.context instanceof Response);
        assertEquals(failure.error.context.status, 422);
        assertEquals(await failure.error.context.json(), { code: 'synthetic_function_rejection' });
        assertEquals(failure.response, failure.error.context);
        rejectRequest = false;
        const serviceResult = await service.functions.invoke('sign_request', { body });
        assertEquals(serviceResult.error, null);
        assertEquals(serviceResult.data, { signature: 'synthetic-only' });
        const publishableResult = await publishable.functions.invoke('sign_request', { body });
        assertEquals(publishableResult.error, null);
        assertEquals(publishableResult.data, { signature: 'synthetic-only' });
        const actorWire = {
          url: `${baseUrl}/functions/v1/sign_request`,
          method: 'POST',
          authorization: `Bearer ${ACTOR_TOKEN}`,
          apikey: PUBLISHABLE_KEY,
          contentProfile: null,
          acceptProfile: null,
          contentType: 'application/json',
          body,
        };
        assertEquals(requests, [
          actorWire,
          actorWire,
          // Modern API keys remain apikey-only for Functions; they are not JWTs.
          { ...actorWire, authorization: null, apikey: SERVICE_KEY },
          { ...actorWire, authorization: null },
        ]);
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  },
);

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

async function signingKeys() {
  return await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
}

function claims(baseUrl: string) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: `${baseUrl}/auth/v1`,
    aud: 'authenticated',
    exp: now + 300,
    iat: now - 10,
    sub: USER_ID,
    role: 'authenticated',
    session_id: SESSION_ID,
    client_id: CLIENT_ID,
    email: 'claims-wire@example.invalid',
  };
}

async function signJwt(privateKey: CryptoKey, kid: string, payload: Record<string, unknown>) {
  const encoder = new TextEncoder();
  const header = base64Url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })));
  const body = base64Url(encoder.encode(JSON.stringify(payload)));
  const message = `${header}.${body}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    encoder.encode(message),
  );
  return `${message}.${base64Url(new Uint8Array(signature))}`;
}

function authRequest(token: string) {
  return new Request('https://edge-auth-wire.invalid/functions/v1/offline_fixture', {
    headers: { authorization: `Bearer ${token}`, apikey: PUBLISHABLE_KEY },
  });
}

Deno.test(
  'real Supabase claims verification uses fetched RS256 JWKS and never calls user lookup',
  async () => {
    const previousFetch = globalThis.fetch;
    const baseUrl = 'https://supabase-claims-wire.invalid';
    const keys = await signingKeys();
    const kid = 'claims-wire-rs256';
    const publicKey = {
      ...(await crypto.subtle.exportKey('jwk', keys.publicKey)),
      kid,
      alg: 'RS256',
      use: 'sig',
    };
    const payload = claims(baseUrl);
    const token = await signJwt(keys.privateKey, kid, payload);
    const requests: WireRequest[] = [];
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(await recordRequest(request));
      assertEquals(request.url, `${baseUrl}/auth/v1/.well-known/jwks.json`);
      return Response.json({ keys: [publicKey] });
    };
    try {
      await withSyntheticEnvironment(baseUrl, async () => {
        const authClient = createSupabaseAuthClient();
        for (let index = 0; index < 2; index += 1) {
          const result = await authenticateRequest(authRequest(token), {
            authClient,
            allowedMethods: [AuthMethod.JWT],
          });
          assertEquals(result.isAuthenticated, true);
          assertEquals(result.response, undefined);
          assertEquals(result.principal, {
            userId: USER_ID,
            email: payload.email,
            authMethod: 'supabase_jwt',
            assurance: 'claims',
            clientId: CLIENT_ID,
            sessionId: SESSION_ID,
            claims: payload,
          });
          assertEquals(result.user?.id, USER_ID);
        }
        assertEquals(requests, [
          {
            url: `${baseUrl}/auth/v1/.well-known/jwks.json`,
            method: 'GET',
            authorization: `Bearer ${PUBLISHABLE_KEY}`,
            apikey: PUBLISHABLE_KEY,
            contentProfile: null,
            acceptProfile: null,
            contentType: null,
            body: null,
          },
        ]);
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  },
);

Deno.test(
  'real signed JWTs reject wrong issuer, audience, and signature with HTTP 401',
  async () => {
    const previousFetch = globalThis.fetch;
    const baseUrl = 'https://supabase-rejected-claims-wire.invalid';
    const keys = await signingKeys();
    const wrongKeys = await signingKeys();
    const kid = 'rejected-claims-wire-rs256';
    const publicKey = {
      ...(await crypto.subtle.exportKey('jwk', keys.publicKey)),
      kid,
      alg: 'RS256',
      use: 'sig',
    };
    const payload = claims(baseUrl);
    const wrongIssuer = await signJwt(keys.privateKey, kid, {
      ...payload,
      iss: 'https://different-project.invalid/auth/v1',
    });
    const wrongAudience = await signJwt(keys.privateKey, kid, { ...payload, aud: 'anon' });
    const wrongSignature = await signJwt(wrongKeys.privateKey, kid, payload);
    const paths: string[] = [];
    globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      assertEquals(request.url, `${baseUrl}/auth/v1/.well-known/jwks.json`);
      paths.push(new URL(request.url).pathname);
      return Promise.resolve(Response.json({ keys: [publicKey] }));
    };
    try {
      await withSyntheticEnvironment(baseUrl, async () => {
        const authClient = createSupabaseAuthClient();
        const sdkResult = await authClient.auth.getClaims(wrongSignature);
        assertEquals(sdkResult.data, null);
        assert(sdkResult.error instanceof AuthInvalidJwtError);
        assertEquals(sdkResult.error.status, 400);
        assertEquals(sdkResult.error.message, 'Invalid JWT signature');
        for (const [token, expectedMessage] of [
          [wrongIssuer, 'Invalid JWT issuer'],
          [wrongAudience, 'Invalid JWT audience'],
          [wrongSignature, 'Invalid JWT signature'],
        ]) {
          const result = await authenticateRequest(authRequest(token), {
            authClient,
            allowedMethods: [AuthMethod.JWT],
          });
          assertEquals(result.isAuthenticated, false);
          assertEquals(result.principal, undefined);
          assert(result.response instanceof Response);
          assertEquals(result.response.status, 401);
          assertEquals(await result.response.text(), expectedMessage);
        }
        assertEquals(paths, ['/auth/v1/.well-known/jwks.json']);
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  },
);

Deno.test(
  'real Supabase fresh_user alone looks up the user and enforces the verified subject',
  async () => {
    const previousFetch = globalThis.fetch;
    const baseUrl = 'https://supabase-fresh-user-wire.invalid';
    const keys = await signingKeys();
    const kid = 'fresh-user-wire-rs256';
    const publicKey = {
      ...(await crypto.subtle.exportKey('jwk', keys.publicKey)),
      kid,
      alg: 'RS256',
      use: 'sig',
    };
    const payload = claims(baseUrl);
    const token = await signJwt(keys.privateKey, kid, payload);
    const requests: WireRequest[] = [];
    let returnedUserId = USER_ID;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(await recordRequest(request));
      if (request.url === `${baseUrl}/auth/v1/.well-known/jwks.json`) {
        return Response.json({ keys: [publicKey] });
      }
      assertEquals(request.url, `${baseUrl}/auth/v1/user`);
      assertEquals(request.method, 'GET');
      assertEquals(request.headers.get('authorization'), `Bearer ${token}`);
      assertEquals(request.headers.get('apikey'), PUBLISHABLE_KEY);
      return Response.json({
        id: returnedUserId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'fresh-wire@example.invalid',
        created_at: '2026-10-18T00:00:00.000Z',
        app_metadata: { provider: 'email' },
        user_metadata: {},
      });
    };
    try {
      await withSyntheticEnvironment(baseUrl, async () => {
        const authClient = createSupabaseAuthClient();
        const ordinary = await authenticateRequest(authRequest(token), {
          authClient,
          allowedMethods: [AuthMethod.JWT],
        });
        assertEquals(ordinary.isAuthenticated, true);
        assert(ordinary.principal);
        assertEquals(ordinary.principal?.assurance, 'claims');
        assertEquals(ordinary.principal?.email, payload.email);
        assertEquals(
          requests.map((request) => new URL(request.url).pathname),
          ['/auth/v1/.well-known/jwks.json'],
        );
        const fresh = await authenticateRequest(authRequest(token), {
          authClient,
          allowedMethods: [AuthMethod.JWT],
          jwtAssurance: 'fresh_user',
        });
        assertEquals(fresh.isAuthenticated, true);
        assertEquals(fresh.principal, {
          ...ordinary.principal,
          assurance: 'fresh_user',
          email: 'fresh-wire@example.invalid',
        });
        assertEquals(fresh.user?.id, USER_ID);
        returnedUserId = '44444444-4444-4444-8444-444444444444';
        const mismatch = await authenticateRequest(authRequest(token), {
          authClient,
          allowedMethods: [AuthMethod.JWT],
          jwtAssurance: 'fresh_user',
        });
        assertEquals(mismatch.isAuthenticated, false);
        assert(mismatch.response instanceof Response);
        assertEquals(mismatch.response.status, 401);
        assertEquals(await mismatch.response.text(), 'JWT subject mismatch');
        assertEquals(
          requests.map((request) => new URL(request.url).pathname),
          ['/auth/v1/.well-known/jwks.json', '/auth/v1/user', '/auth/v1/user'],
        );
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  },
);
