import { assertEquals, assertFalse } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.112.4';
import { authenticateRequest, AuthMethod } from '../supabase/functions/_shared/auth.ts';

import {
  createHybridSearchHandler,
  type HybridSearchRouteConfig,
} from '../supabase/functions/_shared/hybrid_search_handler.ts';

const CONTACT_CONFIG: HybridSearchRouteConfig = {
  functionName: 'contact_hybrid_search',
  entityKind: 'contact',
  entityLabel: 'Contact',
  entityPlural: 'contacts',
  rpcName: 'hybrid_search_contacts',
  forwardVisibilityContext: true,
};

const VECTOR = Array.from({ length: 1024 }, () => 0.001);

// Database e9888c9385356ee6df66c2910a99e29f9fa7e08c: api.hybrid_search_flows/processes.
const LEGACY_SEARCH_RPC_PARAMETERS = [
  'query_text',
  'query_embedding',
  'filter_condition',
  'match_threshold',
  'match_count',
  'lexical_weight',
  'semantic_weight',
  'rrf_k',
  'data_source',
  'page_size',
  'page_current',
  'query_terms',
].sort();

const VERSIONED_CONFIG: HybridSearchRouteConfig = {
  functionName: 'process_hybrid_search',
  entityKind: 'process',
  entityLabel: 'Process',
  entityPlural: 'processes',
  rpcName: 'hybrid_search_processes',
  versionedRpcName: 'hybrid_search_process_versions_v1',
};
const VERSIONED_V2_CONFIG: HybridSearchRouteConfig = {
  ...VERSIONED_CONFIG,
  versionedRpcName: 'hybrid_search_process_versions_v2',
  forwardVisibilityContext: true,
  forwardProcessTypeFilter: true,
  requireSelectedTeamContext: true,
  rpcOwnsThresholdFallback: true,
};
const FLOW_VERSIONED_V2_CONFIG: HybridSearchRouteConfig = {
  ...VERSIONED_V2_CONFIG,
  functionName: 'flow_hybrid_search',
  entityKind: 'flow',
  entityLabel: 'Flow',
  entityPlural: 'flows',
  rpcName: 'hybrid_search_flows',
  versionedRpcName: 'hybrid_search_flow_versions_v2',
  forwardProcessTypeFilter: false,
};
const VERSION_ID = '11111111-1111-4111-8111-111111111111';
const VERIFIED_JWT_AUTH = {
  isAuthenticated: true,
  principal: {
    userId: VERSION_ID,
    authMethod: 'supabase_jwt',
    assurance: 'claims',
  },
} as const;

Deno.test(
  'matched mode rejects a service-key success with an unverified JWT-shaped bearer',
  async () => {
    const calls: string[] = [];
    const handler = createHybridSearchHandler(VERSIONED_CONFIG, {
      authenticate: async (request) => {
        const result = await authenticateRequest(request, {
          serviceApiKey: 'hybrid-test-service-key',
          allowedMethods: [AuthMethod.JWT, AuthMethod.SERVICE_API_KEY],
          authClient: {
            auth: {
              getClaims: () =>
                Promise.resolve({
                  data: null,
                  error: { message: 'JWT rejected' },
                }),
            },
          } as unknown as SupabaseClient,
        });
        assertEquals(result.principal?.authMethod, 'service_api_key');
        return result;
      },
      createRpcClient: () => {
        calls.push('client');
        return {
          client: {} as SupabaseClient,
          userContextKind: 'jwt',
          bearerToken: 'forged.jwt.signature',
        };
      },
      rewriteQuery: async () => {
        calls.push('rewrite');
        return {
          semantic_query_en: 'copper',
          fulltext_query_en: [],
          fulltext_query_zh: [],
        };
      },
      generateEmbedding: async () => {
        calls.push('embedding');
        return VECTOR;
      },
    });
    const response = await handler(
      new Request('http://localhost/search', {
        method: 'POST',
        headers: {
          apikey: 'hybrid-test-service-key',
          Authorization: 'Bearer forged.jwt.signature',
        },
        body: JSON.stringify({ query: 'copper', version_scope: 'matched' }),
      }),
    );
    assertEquals(response.status, 403);
    assertEquals((await response.json()).code, 'HYBRID_SEARCH_USER_CONTEXT_REQUIRED');
    assertEquals(calls, []);
  },
);

Deno.test(
  'matched mode fails closed when authentication supplies no verified principal',
  async () => {
    const handler = createHybridSearchHandler(VERSIONED_CONFIG, {
      authenticate: async () => ({ isAuthenticated: true }),
      createRpcClient: () => {
        throw new Error('must reject before creating a client');
      },
    });
    const response = await handler(
      new Request('http://localhost/search', {
        method: 'POST',
        body: JSON.stringify({ query: 'copper', version_scope: 'matched' }),
      }),
    );
    assertEquals(response.status, 403);
  },
);

Deno.test(
  'matched-version mode rejects service context before any paid or database work',
  async () => {
    let calls = 0;
    const handler = createHybridSearchHandler(VERSIONED_CONFIG, {
      authenticate: async () => VERIFIED_JWT_AUTH,
      createRpcClient: () => ({
        client: {} as SupabaseClient,
        userContextKind: 'service',
      }),
      rewriteQuery: async () => {
        calls += 1;
        return {
          semantic_query_en: 'copper',
          fulltext_query_en: [],
          fulltext_query_zh: [],
        };
      },
    });
    const response = await handler(
      new Request('http://localhost/search', {
        method: 'POST',
        body: JSON.stringify({ query: 'copper', version_scope: 'matched' }),
      }),
    );
    assertEquals(response.status, 403);
    assertEquals(calls, 0);
  },
);

Deno.test(
  'matched-version Hybrid keeps English embedding, original-language terms and exact result versions',
  async () => {
    const calls: string[] = [];
    const rows = [
      { id: VERSION_ID, version: '01.00.000' },
      { id: VERSION_ID, version: '01.00.001' },
    ];
    let resolveRewrite!: (value: {
      semantic_query_en: string;
      fulltext_query_en: string[];
      fulltext_query_zh: string[];
    }) => void;
    const rewriting = new Promise<{
      semantic_query_en: string;
      fulltext_query_en: string[];
      fulltext_query_zh: string[];
    }>((resolve) => {
      resolveRewrite = resolve;
    });
    const handler = createHybridSearchHandler(VERSIONED_CONFIG, {
      authenticate: async () => VERIFIED_JWT_AUTH,
      rewriteQuery: () => {
        calls.push('rewrite');
        return rewriting;
      },
      generateEmbedding: async (text) => {
        assertEquals(text, 'copper production');
        calls.push('embedding');
        return VECTOR;
      },
      createRpcClient: (authorization, scope) => {
        assertEquals(authorization, 'Bearer actor.jwt.signature');
        assertEquals(scope, 'my');
        return {
          client: {
            rpc: (name: string, body: Record<string, unknown>) => {
              calls.push('rpc');
              assertEquals(name, 'hybrid_search_process_versions_v1');
              assertEquals(body.match_count, 200);
              assertEquals((body.query_terms as string[])[0], 'производство меди');
              assertEquals(Object.hasOwn(body, 'state_code_filter'), false);
              assertEquals(Object.hasOwn(body, 'team_id_filter'), false);
              return Promise.resolve({ data: rows, error: null });
            },
          } as unknown as SupabaseClient,
          userContextKind: 'jwt',
          bearerToken: 'actor.jwt.signature',
        };
      },
      logger: { log: () => undefined, error: () => undefined },
    });
    const responsePromise = handler(
      new Request('http://localhost/process_hybrid_search', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer actor.jwt.signature',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: 'производство меди',
          data_source: 'my',
          version_scope: 'matched',
        }),
      }),
    );
    for (let attempt = 0; attempt < 20 && calls.length === 0; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    assertEquals(calls, ['rewrite']);
    resolveRewrite({
      semantic_query_en: 'copper production',
      fulltext_query_en: ['copper'],
      fulltext_query_zh: ['铜'],
    });
    const response = await responsePromise;
    assertEquals(response.status, 200);
    assertEquals(await response.json(), {
      data: rows,
      versionScope: 'matched',
    });
    assertEquals(calls, ['rewrite', 'embedding', 'rpc']);
  },
);

Deno.test(
  'matched-version empty fallback stays on the additive API and acknowledges empty results',
  async () => {
    const names: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    const handler = createHybridSearchHandler(VERSIONED_CONFIG, {
      authenticate: async () => VERIFIED_JWT_AUTH,
      rewriteQuery: async () => ({
        semantic_query_en: 'copper',
        fulltext_query_en: ['copper'],
        fulltext_query_zh: [],
      }),
      generateEmbedding: async () => VECTOR,
      createRpcClient: () => ({
        client: {
          rpc: (name: string, body: Record<string, unknown>) => {
            names.push(name);
            bodies.push(body);
            return Promise.resolve({ data: [], error: null });
          },
        } as unknown as SupabaseClient,
        userContextKind: 'jwt',
        bearerToken: 'actor.jwt.signature',
      }),
      logger: { log: () => undefined, error: () => undefined },
    });
    const response = await handler(
      new Request('http://localhost/process_hybrid_search', {
        method: 'POST',
        body: JSON.stringify({ query: 'copper', version_scope: 'matched' }),
      }),
    );
    assertEquals(response.status, 200);
    assertEquals(await response.json(), { data: [], versionScope: 'matched' });
    assertEquals(names, ['hybrid_search_process_versions_v1', 'hybrid_search_process_versions_v1']);
    assertEquals(
      bodies.map((body) => body.match_threshold),
      [0.5, 0],
    );
    assertEquals(
      bodies.map((body) => body.match_count),
      [200, 200],
    );
  },
);

for (const config of [VERSIONED_V2_CONFIG, FLOW_VERSIONED_V2_CONFIG]) {
  for (const versionScope of [undefined, 'latest']) {
    Deno.test(
      `V2 ${config.entityLabel} route retains legacy fallback with ${versionScope ?? 'omitted'} scope`,
      async () => {
        const rpcCalls: Array<{ name: string; body: Record<string, unknown> }> = [];
        const rows = [{ id: VERSION_ID, version: '01.00.000' }];
        const handler = createHybridSearchHandler(config, {
          authenticate: async () => VERIFIED_JWT_AUTH,
          rewriteQuery: async () => ({
            semantic_query_en: 'copper',
            fulltext_query_en: ['copper'],
            fulltext_query_zh: [],
          }),
          generateEmbedding: async () => VECTOR,
          createRpcClient: () => ({
            client: {
              rpc: (name: string, body: Record<string, unknown>) => {
                rpcCalls.push({ name, body });
                return Promise.resolve({
                  data: rpcCalls.length === 1 ? [] : rows,
                  error: null,
                });
              },
            } as unknown as SupabaseClient,
            userContextKind: 'jwt',
            bearerToken: 'actor.jwt.signature',
          }),
          logger: { log: () => undefined, error: () => undefined },
        });
        const response = await handler(
          new Request(`http://localhost/${config.functionName}`, {
            method: 'POST',
            body: JSON.stringify({ query: 'copper', version_scope: versionScope }),
          }),
        );

        assertEquals(response.status, 200);
        assertEquals(await response.json(), { data: rows });
        assertEquals(
          rpcCalls.map((call) => call.name),
          [config.rpcName, config.rpcName],
        );
        assertEquals(
          rpcCalls.map((call) => call.body.match_threshold),
          [0.5, 0],
        );
        assertEquals(
          rpcCalls.map((call) => Object.keys(call.body).sort()),
          [LEGACY_SEARCH_RPC_PARAMETERS, LEGACY_SEARCH_RPC_PARAMETERS],
        );
      },
    );
  }
}

Deno.test(
  'Next V2 forwards selected-team and Process type scope and owns fallback in one RPC',
  async () => {
    const rpcCalls: Array<{ name: string; body: Record<string, unknown> }> = [];
    const logCalls: unknown[] = [];
    const handler = createHybridSearchHandler(VERSIONED_V2_CONFIG, {
      authenticate: async () => VERIFIED_JWT_AUTH,
      rewriteQuery: async () => ({
        semantic_query_en: 'copper',
        fulltext_query_en: ['copper'],
        fulltext_query_zh: [],
      }),
      generateEmbedding: async () => VECTOR,
      createRpcClient: () => ({
        client: {
          rpc: (name: string, body: Record<string, unknown>) => {
            rpcCalls.push({ name, body });
            return Promise.resolve({ data: [], error: null });
          },
        } as unknown as SupabaseClient,
        userContextKind: 'jwt',
        bearerToken: 'actor.jwt.signature',
      }),
      logger: {
        log: (...args: unknown[]) => logCalls.push(args),
        error: () => undefined,
      },
    });

    const response = await handler(
      new Request('http://localhost/process_hybrid_search', {
        method: 'POST',
        body: JSON.stringify({
          query: 'private copper query',
          version_scope: 'matched',
          data_source: 'te',
          state_code: 20,
          team_id: 'c3000000-0000-4000-8000-000000000297',
          type_of_data_set: 'LCI result',
        }),
      }),
    );

    assertEquals(response.status, 200);
    assertEquals(await response.json(), { data: [], versionScope: 'matched' });
    assertEquals(rpcCalls.length, 1);
    assertEquals(rpcCalls[0].name, 'hybrid_search_process_versions_v2');
    assertEquals(rpcCalls[0].body.state_code_filter, 20);
    assertEquals(rpcCalls[0].body.team_id_filter, 'c3000000-0000-4000-8000-000000000297');
    assertEquals(rpcCalls[0].body.type_of_data_set_filter, 'LCI result');
    assertFalse(JSON.stringify(logCalls).includes('private copper query'));
  },
);

Deno.test('Next V2 rejects missing selected-team scope before model or RPC work', async () => {
  let calls = 0;
  const handler = createHybridSearchHandler(VERSIONED_V2_CONFIG, {
    authenticate: async () => VERIFIED_JWT_AUTH,
    rewriteQuery: async () => {
      calls++;
      return {
        semantic_query_en: 'copper',
        fulltext_query_en: [],
        fulltext_query_zh: [],
      };
    },
  });
  const response = await handler(
    new Request('http://localhost/process_hybrid_search', {
      method: 'POST',
      body: JSON.stringify({
        query: 'copper',
        version_scope: 'matched',
        data_source: 'te',
      }),
    }),
  );
  assertEquals(response.status, 400);
  assertEquals(calls, 0);
});

Deno.test('Next V2 forwards an optional public institution team scope', async () => {
  const rpcCalls: Array<{ name: string; body: Record<string, unknown> }> = [];
  const handler = createHybridSearchHandler(VERSIONED_V2_CONFIG, {
    authenticate: async () => VERIFIED_JWT_AUTH,
    rewriteQuery: async () => ({
      semantic_query_en: 'copper',
      fulltext_query_en: ['copper'],
      fulltext_query_zh: [],
    }),
    generateEmbedding: async () => VECTOR,
    createRpcClient: () => ({
      client: {
        rpc: (name: string, body: Record<string, unknown>) => {
          rpcCalls.push({ name, body });
          return Promise.resolve({ data: [], error: null });
        },
      } as unknown as SupabaseClient,
      userContextKind: 'jwt',
      bearerToken: 'actor.jwt.signature',
    }),
  });
  const response = await handler(
    new Request('http://localhost/process_hybrid_search', {
      method: 'POST',
      body: JSON.stringify({
        query: 'copper',
        version_scope: 'matched',
        data_source: 'tg',
        team_id: 'c3000000-0000-4000-8000-000000000297',
      }),
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(rpcCalls.length, 1);
  assertEquals(rpcCalls[0].body.data_source, 'tg');
  assertEquals(rpcCalls[0].body.team_id_filter, 'c3000000-0000-4000-8000-000000000297');
});

Deno.test('Next Flow V2 rejects malformed classification before model or RPC work', async () => {
  let calls = 0;
  const handler = createHybridSearchHandler(FLOW_VERSIONED_V2_CONFIG, {
    authenticate: async () => VERIFIED_JWT_AUTH,
    rewriteQuery: async () => {
      calls++;
      return {
        semantic_query_en: 'flow',
        fulltext_query_en: [],
        fulltext_query_zh: [],
      };
    },
  });
  const response = await handler(
    new Request('http://localhost/flow_hybrid_search', {
      method: 'POST',
      body: JSON.stringify({
        query: 'flow',
        version_scope: 'matched',
        filter_condition: { classification: [{ scope: 'wrong', code: '01' }] },
      }),
    }),
  );
  assertEquals(response.status, 400);
  assertEquals(calls, 0);
});

Deno.test('Next Flow V2 rejects unsupported Flow types before model or RPC work', async () => {
  let calls = 0;
  const handler = createHybridSearchHandler(FLOW_VERSIONED_V2_CONFIG, {
    authenticate: async () => VERIFIED_JWT_AUTH,
    rewriteQuery: async () => {
      calls++;
      return {
        semantic_query_en: 'flow',
        fulltext_query_en: [],
        fulltext_query_zh: [],
      };
    },
  });
  const response = await handler(
    new Request('http://localhost/flow_hybrid_search', {
      method: 'POST',
      body: JSON.stringify({
        query: 'flow',
        version_scope: 'matched',
        filter_condition: { flowType: 'Foreground flow' },
      }),
    }),
  );
  assertEquals(response.status, 400);
  assertEquals(calls, 0);
});

Deno.test('Next Flow V2 rejects a Process-only type filter before model or RPC work', async () => {
  let calls = 0;
  const handler = createHybridSearchHandler(FLOW_VERSIONED_V2_CONFIG, {
    authenticate: async () => VERIFIED_JWT_AUTH,
    rewriteQuery: async () => {
      calls++;
      return {
        semantic_query_en: 'flow',
        fulltext_query_en: [],
        fulltext_query_zh: [],
      };
    },
  });
  const response = await handler(
    new Request('http://localhost/flow_hybrid_search', {
      method: 'POST',
      body: JSON.stringify({
        query: 'flow',
        version_scope: 'matched',
        type_of_data_set: 'LCI result',
      }),
    }),
  );
  assertEquals(response.status, 400);
  assertEquals(calls, 0);
});

Deno.test(
  'matched-version mode rejects unsupported routes and bounds before model calls',
  async () => {
    for (const [config, extra] of [
      [CONTACT_CONFIG, {}],
      [VERSIONED_CONFIG, { page_size: 101 }],
      [VERSIONED_CONFIG, { match_count: 5000 }],
    ] as const) {
      let calls = 0;
      const handler = createHybridSearchHandler(config, {
        authenticate: async () => ({ isAuthenticated: true }),
        rewriteQuery: async () => {
          calls++;
          return {
            semantic_query_en: 'copper',
            fulltext_query_en: [],
            fulltext_query_zh: [],
          };
        },
      });
      const response = await handler(
        new Request('http://localhost/search', {
          method: 'POST',
          body: JSON.stringify({
            query: 'copper',
            version_scope: 'matched',
            ...extra,
          }),
        }),
      );
      assertEquals(response.status, 400);
      assertEquals(calls, 0);
    }
  },
);

Deno.test(
  'matched-version mode refuses id-only rows and never embeds a missing English rewrite',
  async () => {
    for (const missingEnglish of [false, true]) {
      let embeddingCalls = 0;
      const handler = createHybridSearchHandler(VERSIONED_CONFIG, {
        authenticate: async () => VERIFIED_JWT_AUTH,
        rewriteQuery: async () => ({
          semantic_query_en: missingEnglish ? '' : 'copper',
          fulltext_query_en: ['copper'],
          fulltext_query_zh: [],
        }),
        generateEmbedding: async () => {
          embeddingCalls++;
          return VECTOR;
        },
        createRpcClient: () => ({
          client: {
            rpc: () => Promise.resolve({ data: [{ id: VERSION_ID }], error: null }),
          } as unknown as SupabaseClient,
          userContextKind: 'jwt',
          bearerToken: 'actor.jwt.signature',
        }),
        logger: { log: () => undefined, error: () => undefined },
      });
      const response = await handler(
        new Request('http://localhost/search', {
          method: 'POST',
          body: JSON.stringify({ query: '铜', version_scope: 'matched' }),
        }),
      );
      assertEquals(response.status, 500);
      assertEquals(embeddingCalls, missingEnglish ? 0 : 1);
    }
  },
);

Deno.test(
  'shared Hybrid handler calls the configured RPC and performs one empty-threshold fallback',
  async () => {
    const rpcCalls: Array<{ name: string; body: Record<string, unknown> }> = [];
    const logCalls: unknown[] = [];
    let now = 100;
    const fakeClient = {
      rpc(name: string, body: Record<string, unknown>) {
        rpcCalls.push({ name, body: structuredClone(body) });
        return Promise.resolve(
          rpcCalls.length === 1
            ? { data: [], error: null }
            : { data: [{ id: 'contact-1' }], error: null },
        );
      },
    };
    const handler = createHybridSearchHandler(CONTACT_CONFIG, {
      authenticate: async () => ({ isAuthenticated: true }),
      rewriteQuery: async () => ({
        semantic_query_en: 'aluminium association',
        fulltext_query_en: ['aluminium association'],
        fulltext_query_zh: ['铝业协会'],
      }),
      generateEmbedding: async () => VECTOR,
      createRpcClient: () => ({
        client: fakeClient as unknown as SupabaseClient,
        userContextKind: 'jwt',
        bearerToken: 'header.payload.signature',
      }),
      now: () => ++now,
      logger: {
        log: (...args: unknown[]) => logCalls.push(args),
        error: () => undefined,
      },
    });

    const response = await handler(
      new Request('http://localhost/contact_hybrid_search', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer header.payload.signature',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: 'private contact query',
          filter_condition: '{"classification":["materials"]}',
          data_source: 'my',
          state_code: 0,
          team_id: 'c3000000-0000-4000-8000-000000000297',
        }),
      }),
    );

    assertEquals(response.status, 200);
    assertEquals(await response.json(), { data: [{ id: 'contact-1' }] });
    assertEquals(
      rpcCalls.map((call) => call.name),
      ['hybrid_search_contacts', 'hybrid_search_contacts'],
    );
    assertEquals(
      rpcCalls.map((call) => call.body.match_threshold),
      [0.5, 0],
    );
    assertEquals(rpcCalls[0].body.data_source, 'my');
    assertEquals(rpcCalls[0].body.filter_condition, {
      classification: ['materials'],
    });
    assertEquals(typeof rpcCalls[0].body.filter_condition, 'object');
    assertEquals(rpcCalls[1].body.filter_condition, {
      classification: ['materials'],
    });
    assertEquals(rpcCalls[0].body.state_code_filter, 0);
    assertEquals(rpcCalls[0].body.team_id_filter, 'c3000000-0000-4000-8000-000000000297');
    assertEquals(rpcCalls[1].body.state_code_filter, 0);
    assertEquals(rpcCalls[1].body.team_id_filter, 'c3000000-0000-4000-8000-000000000297');
    assertFalse(JSON.stringify(logCalls).includes('private contact query'));
  },
);

Deno.test(
  'shared Hybrid handler extraction preserves its exact legacy response bytes',
  async () => {
    const handler = createHybridSearchHandler(CONTACT_CONFIG, {
      authenticate: async () => ({ isAuthenticated: true }),
      rewriteQuery: async () => ({
        semantic_query_en: 'contact',
        fulltext_query_en: ['contact'],
        fulltext_query_zh: ['联系人'],
      }),
      generateEmbedding: async () => VECTOR,
      createRpcClient: () => ({
        client: {
          rpc() {
            return Promise.resolve({
              data: [{ id: 'contact-1' }],
              error: null,
            });
          },
        } as unknown as SupabaseClient,
        userContextKind: 'service',
      }),
      logger: { log: () => undefined, error: () => undefined },
    });

    const response = await handler(
      new Request('http://localhost/contact_hybrid_search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"query":"contact"}',
      }),
    );

    assertEquals(response.status, 200);
    assertEquals(response.headers.get('content-type'), 'application/json');
    assertEquals(await response.text(), '{"data":[{"id":"contact-1"}]}');
  },
);

Deno.test(
  'shared Hybrid handler does not add visibility RPC fields for mature routes',
  async () => {
    let rpcBody: Record<string, unknown> | undefined;
    const handler = createHybridSearchHandler(
      { ...CONTACT_CONFIG, forwardVisibilityContext: false },
      {
        authenticate: async () => ({ isAuthenticated: true }),
        rewriteQuery: async () => ({
          semantic_query_en: 'contact',
          fulltext_query_en: ['contact'],
          fulltext_query_zh: [],
        }),
        generateEmbedding: async () => VECTOR,
        createRpcClient: () => ({
          client: {
            rpc(_name: string, body: Record<string, unknown>) {
              rpcBody = body;
              return Promise.resolve({
                data: [{ id: 'contact-1' }],
                error: null,
              });
            },
          } as unknown as SupabaseClient,
          userContextKind: 'jwt',
          bearerToken: 'header.payload.signature',
        }),
        logger: { log: () => undefined, error: () => undefined },
      },
    );

    const response = await handler(
      new Request('http://localhost/contact_hybrid_search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: 'contact',
          state_code: 0,
          team_id: 'c3000000-0000-4000-8000-000000000297',
        }),
      }),
    );

    assertEquals(response.status, 200);
    assertEquals(Object.hasOwn(rpcBody ?? {}, 'state_code_filter'), false);
    assertEquals(Object.hasOwn(rpcBody ?? {}, 'team_id_filter'), false);
  },
);

Deno.test('shared Hybrid handler rejects invalid requests before model or RPC calls', async () => {
  let rewriteCalled = false;
  const handler = createHybridSearchHandler(CONTACT_CONFIG, {
    authenticate: async () => ({ isAuthenticated: true }),
    rewriteQuery: async () => {
      rewriteCalled = true;
      return {
        semantic_query_en: '',
        fulltext_query_en: [],
        fulltext_query_zh: [],
      };
    },
  });

  const response = await handler(
    new Request('http://localhost/contact_hybrid_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page_size: 10 }),
    }),
  );

  assertEquals(response.status, 400);
  assertEquals(rewriteCalled, false);
});

Deno.test('shared Hybrid handler fails closed on a non-1024 embedding', async () => {
  const handler = createHybridSearchHandler(CONTACT_CONFIG, {
    authenticate: async () => ({ isAuthenticated: true }),
    rewriteQuery: async () => ({
      semantic_query_en: 'contact',
      fulltext_query_en: ['contact'],
      fulltext_query_zh: ['联系人'],
    }),
    generateEmbedding: async () => [0.1, 0.2],
    logger: { log: () => undefined, error: () => undefined },
  });

  const response = await handler(
    new Request('http://localhost/contact_hybrid_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'contact' }),
    }),
  );

  assertEquals(response.status, 500);
  assertEquals(await response.json(), {
    error: 'Hybrid search failed',
    code: 'EMBEDDING_DIMENSION_MISMATCH',
  });
});
