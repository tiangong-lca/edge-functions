import { assertEquals } from 'jsr:@std/assert';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2.118.0';

import { resolveActorContext } from '../supabase/functions/_shared/command_runtime/actor_context.ts';
import { AuthMethod } from '../supabase/functions/_shared/auth.ts';
import { createAppDatasetPrepareStableDraftHandler } from '../supabase/functions/app_dataset_prepare_stable_draft/index.ts';
import { createAppDatasetStableDraftRequestHandler } from '../supabase/functions/app_dataset_stable_draft_request/index.ts';

const actorId = '11111111-1111-4111-8111-111111111111';
const datasetId = '22222222-2222-4222-8222-222222222222';
const requestId = '33333333-3333-4333-8333-333333333333';
const body = {
  requestId,
  request: {
    table: 'processes',
    id: datasetId,
    expectedActorId: actorId,
    expectedDrafts: [{ version: '01.00.001', jsonOrdered: { array: [1, null, '鱼'], nested: {} } }],
    selectedVersion: null,
    source: {
      version: '01.00.000',
      userId: actorId,
      stateCode: 100,
      jsonOrdered: { foo: 'source' },
    },
  },
};

class FakeRpcClient {
  calls: Array<{ fn: string; args: unknown }> = [];
  constructor(
    private readonly response: unknown = {
      data: { ok: true, data: { version: '01.00.001' } },
      error: null,
    },
    private readonly lost = false,
  ) {}
  rpc(fn: string, args: unknown) {
    this.calls.push({ fn, args: structuredClone(args) });
    if (this.lost) return Promise.reject(new Error('lost response'));
    return Promise.resolve(this.response);
  }
}

const factories = [
  createAppDatasetPrepareStableDraftHandler,
  createAppDatasetStableDraftRequestHandler,
];
const names = ['cmd_dataset_prepare_stable_draft', 'get_dataset_stable_draft_request'];
function handler(index: number, client: FakeRpcClient) {
  return factories[index]({
    resolveActor: async () => ({
      ok: true,
      value: {
        userId: actorId,
        accessToken: 'user-jwt',
        supabase: client as unknown as SupabaseClient,
      },
    }),
  });
}
function request(value: unknown = body, authenticated = true, method = 'POST') {
  return new Request('http://localhost/functions/v1/stable-draft', {
    method,
    headers: {
      ...(authenticated ? { Authorization: 'Bearer user-jwt' } : {}),
      'Content-Type': 'application/json',
    },
    ...(method === 'POST' ? { body: JSON.stringify(value) } : {}),
  });
}

Deno.test(
  'stable draft handlers forward the exact complete wire once through the actor client',
  async () => {
    for (let index = 0; index < factories.length; index++) {
      const responseData =
        index === 0
          ? { version: '01.00.001', selectedDraft: body.request.expectedDrafts[0], replayed: false }
          : {
              recorded: true,
              result: { version: '01.00.001' },
              targetStatus: 'changed',
              currentDraft: null,
            };
      const client = new FakeRpcClient({ data: { ok: true, data: responseData }, error: null });
      const response = await handler(index, client)(request());
      assertEquals(response.status, 200);
      assertEquals(await response.json(), {
        ok: true,
        command: index === 0 ? 'dataset_prepare_stable_draft' : 'dataset_stable_draft_request',
        data: responseData,
      });
      assertEquals(client.calls, [
        { fn: names[index], args: { p_request_id: requestId, p_request: body.request } },
      ]);
    }
  },
);

Deno.test(
  'stable draft handlers preserve explicit selection and foreign public source on all supported tables',
  async () => {
    for (const table of ['contacts', 'sources', 'flows', 'processes']) {
      const selected = {
        ...body,
        request: {
          ...body.request,
          table,
          expectedDrafts: [
            { version: '01.00.009', jsonOrdered: { newer: true } },
            ...body.request.expectedDrafts,
          ],
          selectedVersion: '01.00.001',
          source: { ...body.request.source, userId: datasetId, stateCode: 200 },
        },
      };
      const client = new FakeRpcClient();
      const response = await handler(0, client)(request(selected));
      assertEquals(response.status, 200);
      assertEquals(client.calls, [
        { fn: names[0], args: { p_request_id: requestId, p_request: selected.request } },
      ]);
    }
  },
);

Deno.test(
  'stable draft handlers accept SDK-shaped dataset UUIDs while retaining actor binding',
  async () => {
    for (let index = 0; index < factories.length; index++) {
      for (const id of [
        '019a0880-1111-7abc-8def-0123456789ab',
        'abcdef01-2345-f678-0123-456789abcdef',
      ]) {
        const input = { ...body, request: { ...body.request, id } };
        const client = new FakeRpcClient();
        const handle = handler(index, client);
        assertEquals((await handle(request(input))).status, 200);
        assertEquals(client.calls, [
          { fn: names[index], args: { p_request_id: requestId, p_request: input.request } },
        ]);
        const mismatch = await handle(
          request({ ...input, request: { ...input.request, expectedActorId: datasetId } }),
        );
        assertEquals(mismatch.status, 403);
        assertEquals((await mismatch.json()).code, 'DATASET_ACTOR_MISMATCH');
        assertEquals(client.calls.length, 1);
      }
    }
  },
);

Deno.test(
  'stable draft handlers preserve every original review point in review-in-progress conflicts',
  async () => {
    const details = {
      table: 'processes',
      id: datasetId,
      reviews: [
        {
          table: 'processes',
          id: datasetId,
          version: '01.00.001',
          userId: actorId,
          stateCode: 20,
          reviewId: '44444444-4444-4444-8444-444444444444',
        },
        {
          table: 'processes',
          id: datasetId,
          version: '01.00.002',
          userId: actorId,
          stateCode: 30,
          reviewId: null,
        },
      ],
    };
    for (let index = 0; index < factories.length; index++) {
      const failure = {
        ok: false,
        code: 'DATASET_REVIEW_IN_PROGRESS',
        status: 409,
        message: 'The owner dataset family is under review; resume its existing review',
        details,
      };
      const client = new FakeRpcClient({ data: failure, error: null });
      const response = await handler(index, client)(request());
      assertEquals(response.status, 409);
      assertEquals(await response.json(), {
        ok: false,
        code: failure.code,
        message: failure.message,
        details,
      });
      assertEquals(client.calls, [
        { fn: names[index], args: { p_request_id: requestId, p_request: body.request } },
      ]);
    }
  },
);

Deno.test('stable draft handlers reject malformed and unsupported bodies before RPC', async () => {
  const invalid = [
    null,
    { ...body, actorId },
    { ...body, requestId: 'bad' },
    { ...body, request: { ...body.request, id: 'ABCDEF01-2345-f678-0123-456789abcdef' } },
    { ...body, request: { ...body.request, id: 'abcdef01-2345-f678-0123-456789abcde' } },
    { ...body, request: { ...body.request, modelId: datasetId } },
    { ...body, request: { ...body.request, table: 'lifecyclemodels' } },
    { ...body, request: { ...body.request, source: null } },
    {
      ...body,
      request: { ...body.request, source: { ...body.request.source, modelId: datasetId } },
    },
    { ...body, request: { ...body.request, source: { ...body.request.source, stateCode: 120 } } },
    { ...body, request: { ...body.request, source: { ...body.request.source, stateCode: '100' } } },
    { ...body, request: { ...body.request, source: { ...body.request.source, jsonOrdered: [] } } },
    {
      ...body,
      request: {
        ...body.request,
        expectedDrafts: [...body.request.expectedDrafts, ...body.request.expectedDrafts],
      },
    },
    {
      ...body,
      request: { ...body.request, expectedDrafts: [{ version: '01.00.001', jsonOrdered: null }] },
    },
    {
      ...body,
      request: {
        ...body.request,
        expectedDrafts: [{ version: '01.00.001', jsonOrdered: {}, stateCode: 0 }],
      },
    },
    { ...body, request: { ...body.request, selectedVersion: 'latest' } },
  ];
  for (const create of factories) {
    const client = new FakeRpcClient();
    const handle = create({
      resolveActor: async () => ({
        ok: true,
        value: {
          userId: actorId,
          accessToken: 'jwt',
          supabase: client as unknown as SupabaseClient,
        },
      }),
    });
    for (const input of invalid) {
      const response = await handle(request(input));
      assertEquals(response.status, 400);
      assertEquals((await response.json()).code, 'INVALID_PAYLOAD');
    }
    assertEquals(client.calls, []);
  }
});

Deno.test(
  'stable draft handlers retain complete database conflicts and native-owner errors',
  async () => {
    for (const code of [
      'DATASET_DRAFT_CONFLICT',
      'DATASET_DRAFT_CENSUS_CHANGED',
      'DATASET_SOURCE_CHANGED',
      'LIFECYCLEMODEL_BUNDLE_REQUIRED',
      'DATASET_BEFORE_CONTENT_CHANGED',
      'REQUEST_ID_REUSED',
    ]) {
      for (let index = 0; index < factories.length; index++) {
        const failure = {
          ok: false,
          code,
          status: 409,
          message: 'Original database message',
          details: {
            drafts: body.request.expectedDrafts,
            draftVersions: ['01.00.001', '01.00.002'],
            extra: { unchanged: true },
          },
        };
        const client = new FakeRpcClient({ data: failure, error: null });
        const response = await handler(index, client)(request());
        assertEquals(response.status, failure.status);
        assertEquals(await response.json(), {
          ok: false,
          code,
          message: failure.message,
          details: failure.details,
        });
        assertEquals(client.calls.length, 1);
      }
    }
  },
);

Deno.test(
  'stable draft missing capability and lost response never retry or use another RPC',
  async () => {
    for (let index = 0; index < factories.length; index++) {
      for (const lost of [false, true]) {
        const client = new FakeRpcClient(
          {
            data: null,
            error: { code: 'PGRST202', message: 'RPC unavailable', details: 'migration required' },
          },
          lost,
        );
        const response = await handler(index, client)(request());
        assertEquals(response.status, lost ? 502 : 503);
        assertEquals(
          (await response.json()).code,
          lost ? 'STABLE_DRAFT_TRANSPORT_ERROR' : 'PGRST202',
        );
        assertEquals(
          client.calls.map((call) => call.fn),
          [names[index]],
        );
      }
    }
  },
);

Deno.test('stable draft handlers reject actor mismatch and malformed RPC success', async () => {
  for (let index = 0; index < factories.length; index++) {
    const client = new FakeRpcClient({ data: null, error: null });
    const handle = handler(index, client);
    const mismatch = await handle(
      request({ ...body, request: { ...body.request, expectedActorId: datasetId } }),
    );
    assertEquals(mismatch.status, 403);
    assertEquals((await mismatch.json()).code, 'DATASET_ACTOR_MISMATCH');
    assertEquals(client.calls, []);
    const invalid = await handle(request());
    assertEquals(invalid.status, 502);
    assertEquals((await invalid.json()).code, 'INVALID_STABLE_DRAFT_RESPONSE');
  }
});

Deno.test(
  'stable draft handlers require JWT authentication before body or RPC and preserve preflight',
  async () => {
    for (const create of factories) {
      assertEquals((await create()(request(body, false))).status, 401);
      let authenticated = 0;
      let read = 0;
      const client = new FakeRpcClient();
      const handle = create({
        resolveActor: (req) =>
          resolveActorContext(req, {
            createSupabaseClient: (token) => {
              assertEquals(token, 'user-jwt');
              return client as unknown as SupabaseClient;
            },
            authenticate: async (_req, options) => {
              authenticated++;
              assertEquals(options?.allowedMethods, [AuthMethod.JWT]);
              return { isAuthenticated: false, response: new Response('denied', { status: 401 }) };
            },
          }),
        readBody: () => {
          read++;
          throw new Error('must authenticate first');
        },
      });
      assertEquals((await handle(request())).status, 401);
      assertEquals((await handle(request(body, true, 'OPTIONS'))).status, 200);
      assertEquals((await handle(request(body, true, 'GET'))).status, 405);
      assertEquals(authenticated, 1);
      assertEquals(read, 0);
      assertEquals(client.calls, []);
    }
  },
);

Deno.test(
  'real Supabase transport makes one POST per stable draft RPC after disconnect or 503',
  async () => {
    const baseUrl = 'https://stable-draft-transport.invalid';
    for (let index = 0; index < factories.length; index++) {
      for (const failure of ['disconnect', '503']) {
        const calls: Array<{
          url: string;
          method: string;
          authorization: string | null;
          profile: string | null;
          body: unknown;
        }> = [];
        const client = createClient(baseUrl, 'sb_publishable_synthetic_stable_draft', {
          db: { schema: 'api' },
          auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
          global: {
            headers: { Authorization: 'Bearer user-jwt' },
            fetch: async (input, init) => {
              const transport = new Request(input, init);
              calls.push({
                url: transport.url,
                method: transport.method,
                authorization: transport.headers.get('Authorization'),
                profile: transport.headers.get('Content-Profile'),
                body: await transport.json(),
              });
              if (failure === 'disconnect') throw new TypeError('synthetic disconnected response');
              return Response.json(
                { code: 'SYNTHETIC_UNAVAILABLE', message: 'synthetic 503' },
                { status: 503 },
              );
            },
          },
        });
        const handle = factories[index]({
          resolveActor: async () => ({
            ok: true,
            value: {
              userId: actorId,
              accessToken: 'user-jwt',
              supabase: client as unknown as SupabaseClient,
            },
          }),
        });
        const response = await handle(request());
        assertEquals(response.status, 502);
        assertEquals((await response.json()).ok, false);
        assertEquals(calls, [
          {
            url: `${baseUrl}/rest/v1/rpc/${names[index]}`,
            method: 'POST',
            authorization: 'Bearer user-jwt',
            profile: 'api',
            body: { p_request_id: requestId, p_request: body.request },
          },
        ]);
      }
    }
  },
);
