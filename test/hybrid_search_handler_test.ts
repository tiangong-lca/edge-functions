import { assertEquals, assertFalse } from 'jsr:@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js@2';
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
  openDataRpcName: 'hybrid_search_open_data_catalog',
  forwardVisibilityContext: true,
};

Deno.test('Open Data filters select the shared catalog hybrid RPC', async () => {
  const rpcCalls: Array<{ name: string; body: Record<string, unknown> }> = [];
  const handler = createHybridSearchHandler(CONTACT_CONFIG, {
    authenticate: async () => VERIFIED_JWT_AUTH,
    rewriteQuery: async () => ({
      semantic_query_en: 'steel',
      fulltext_query_en: ['steel'],
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
    logger: { log: () => undefined, error: () => undefined },
  });

  const response = await handler(
    new Request('http://localhost/contact_hybrid_search', {
      method: 'POST',
      body: JSON.stringify({
        query: 'steel',
        data_source: 'tg',
        source_filter: 'enterprise',
        publication_filter: 'all',
      }),
    }),
  );

  assertEquals(response.status, 200);
  assertEquals(rpcCalls.length, 2);
  assertEquals(rpcCalls[0].name, 'hybrid_search_open_data_catalog');
  assertEquals(rpcCalls[0].body.p_dataset_kind, 'contact');
  assertEquals(rpcCalls[0].body.source_filter, 'enterprise');
  assertEquals(rpcCalls[0].body.publication_filter, 'all');
  assertEquals(Object.hasOwn(rpcCalls[0].body, 'data_source'), false);
});

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
          filter_condition: '{"classification":[{"scope":"classification","code":"materials"}]}',
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
      classification: [{ scope: 'classification', code: 'materials' }],
    });
    assertEquals(typeof rpcCalls[0].body.filter_condition, 'object');
    assertEquals(rpcCalls[1].body.filter_condition, {
      classification: [{ scope: 'classification', code: 'materials' }],
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

Deno.test(
  'example search rejects a service principal before model or RPC work in every mode',
  async () => {
    for (const version_scope of ['latest', 'matched']) {
      const calls: string[] = [];
      const handler = createHybridSearchHandler(VERSIONED_V2_CONFIG, {
        authenticate: async () => ({ isAuthenticated: true }),
        rewriteQuery: async () => {
          calls.push('rewrite');
          throw new Error('unexpected model work');
        },
        createRpcClient: () => {
          calls.push('rpc');
          throw new Error('unexpected database work');
        },
      });
      const response = await handler(
        new Request('https://example.invalid/search', {
          method: 'POST',
          headers: { Authorization: 'Bearer forged.jwt.signature' },
          body: JSON.stringify({ query: 'steel', data_source: 'ex', version_scope }),
        }),
      );
      assertEquals(response.status, 403);
      assertEquals(calls, []);
    }
  },
);

Deno.test(
  'example search preserves verified actor and fixed scope across RPC contracts',
  async () => {
    for (const [config, version_scope, expectedRpc, forwardsState] of [
      [CONTACT_CONFIG, 'latest', 'hybrid_search_contacts', true],
      [VERSIONED_V2_CONFIG, 'latest', 'hybrid_search_processes', false],
      [VERSIONED_V2_CONFIG, 'matched', 'hybrid_search_process_versions_v2', true],
      [FLOW_VERSIONED_V2_CONFIG, 'matched', 'hybrid_search_flow_versions_v2', true],
    ] as const) {
      let calls = 0;
      const handler = createHybridSearchHandler(config, {
        authenticate: async () => VERIFIED_JWT_AUTH,
        rewriteQuery: async () => ({
          semantic_query_en: 'copper',
          fulltext_query_en: ['copper'],
          fulltext_query_zh: [],
        }),
        generateEmbedding: async () => VECTOR,
        createRpcClient: (authorization, scope) => {
          assertEquals(authorization, 'Bearer actor.jwt.signature');
          assertEquals(scope, 'ex');
          return {
            client: {
              rpc: (name: string, body: Record<string, unknown>) => {
                calls++;
                assertEquals(name, expectedRpc);
                assertEquals(body.data_source, 'ex');
                assertEquals(body.state_code_filter, forwardsState ? -1 : undefined);
                return Promise.resolve({ data: [], error: null });
              },
            } as unknown as SupabaseClient,
            userContextKind: 'jwt',
            bearerToken: 'actor.jwt.signature',
          };
        },
        logger: { log: () => undefined, error: () => undefined },
      });
      const response = await handler(
        new Request('http://localhost/search', {
          method: 'POST',
          headers: { Authorization: 'Bearer actor.jwt.signature' },
          body: JSON.stringify({ query: 'copper', data_source: 'ex', version_scope }),
        }),
      );
      assertEquals(response.status, 200);
      assertEquals(calls > 0, true);
      const result = await response.json();
      assertEquals(version_scope === 'matched' ? result.data : result, []);
      if (version_scope === 'matched') assertEquals(result.versionScope, 'matched');
    }
  },
);

type BoundsRpcResult = {
  data: unknown;
  error: { code: string; message: string } | null;
};

function rawBoundsFixture(
  config: HybridSearchRouteConfig,
  results: BoundsRpcResult[] = [{ data: [{ id: VERSION_ID, version: '01.00.000' }], error: null }],
) {
  const work = { rewrite: 0, embedding: 0, client: 0 };
  const rpcCalls: Array<{ name: string; body: Record<string, unknown> }> = [];
  const handler = createHybridSearchHandler(config, {
    authenticate: async () => VERIFIED_JWT_AUTH,
    rewriteQuery: async () => {
      work.rewrite++;
      return { semantic_query_en: 'steel', fulltext_query_en: ['steel'], fulltext_query_zh: [] };
    },
    generateEmbedding: async () => {
      work.embedding++;
      return VECTOR;
    },
    createRpcClient: () => {
      work.client++;
      return {
        client: {
          rpc: (name: string, body: Record<string, unknown>) => {
            rpcCalls.push({ name, body });
            return Promise.resolve(results[Math.min(rpcCalls.length - 1, results.length - 1)]);
          },
        } as unknown as SupabaseClient,
        userContextKind: 'jwt',
        bearerToken: 'actor.jwt.signature',
      };
    },
    logger: { log: () => undefined, error: () => undefined },
  });
  return {
    work,
    rpcCalls,
    invoke: (body: Record<string, unknown>) =>
      handler(
        new Request('https://example.invalid/search', {
          method: 'POST',
          headers: { Authorization: 'Bearer actor.jwt.signature' },
          body: JSON.stringify({ query: 'steel', ...body }),
        }),
      ),
  };
}

Deno.test('raw latest bounds reject requests before rewrite, embedding or RPC work', async () => {
  for (const config of [CONTACT_CONFIG, VERSIONED_V2_CONFIG, FLOW_VERSIONED_V2_CONFIG]) {
    for (const version_scope of [undefined, 'latest']) {
      for (const options of [
        { page_size: 101 },
        { match_count: 101 },
        { page_size: '101' },
        { match_count: '101' },
        { page_size: 2_147_483_647 },
        { match_count: 2_147_483_647 },
        { page_current: 2_147_483_647, page_size: 10 },
        { page_current: '2147483647', page_size: '10' },
        { page_current: 2_147_483_648, page_size: 1 },
        { page_current: Math.floor(2_147_483_647 / 100) + 2, page_size: 100 },
        { page_current: Number.MAX_SAFE_INTEGER, page_size: 1 },
      ]) {
        const fixture = rawBoundsFixture(config);
        const response = await fixture.invoke({ version_scope, ...options });
        assertEquals(response.status, 400);
        assertEquals(fixture.work, { rewrite: 0, embedding: 0, client: 0 });
        assertEquals(fixture.rpcCalls, []);
      }
    }
  }
});

Deno.test(
  'raw latest bounds retain defaults, NULL, Foundry80,100 and wide pagination',
  async () => {
    for (const config of [CONTACT_CONFIG, VERSIONED_V2_CONFIG, FLOW_VERSIONED_V2_CONFIG]) {
      for (const version_scope of [undefined, 'latest']) {
        for (const options of [
          {},
          { page_size: null, match_count: null, page_current: null },
          {
            page_size: 80,
            match_count: 80,
            match_threshold: 0.15,
            lexical_weight: 0.8,
            semantic_weight: 0.2,
            rrf_k: 30,
          },
          { page_size: 100, match_count: 100 },
          { page_size: '100', match_count: '100' },
          { page_size: 99, page_current: 1_000_000 },
          { page_size: 1, page_current: 2_147_483_647 },
          { page_size: 100, page_current: Math.floor(2_147_483_647 / 100) + 1 },
        ] as Array<Record<string, unknown>>) {
          const fixture = rawBoundsFixture(config);
          const response = await fixture.invoke({ version_scope, ...options });
          assertEquals(response.status, 200);
          assertEquals(fixture.work, { rewrite: 1, embedding: 1, client: 1 });
          assertEquals(fixture.rpcCalls.length, 1);
          assertEquals(fixture.rpcCalls[0].name, config.rpcName);
          assertEquals(fixture.rpcCalls[0].body.page_size, Number(options.page_size ?? 10));
          assertEquals(fixture.rpcCalls[0].body.match_count, Number(options.match_count ?? 20));
          assertEquals(fixture.rpcCalls[0].body.page_current, options.page_current ?? 1);
          if ('lexical_weight' in options) {
            assertEquals(fixture.rpcCalls[0].body.lexical_weight, 0.8);
            assertEquals(fixture.rpcCalls[0].body.semantic_weight, 0.2);
            assertEquals(fixture.rpcCalls[0].body.rrf_k, 30);
            assertEquals(fixture.rpcCalls[0].body.match_threshold, 0.15);
          }
        }
      }
    }
  },
);

Deno.test('raw bounds leave matched200 and Open Data dispatch on their own contracts', async () => {
  for (const config of [VERSIONED_V2_CONFIG, FLOW_VERSIONED_V2_CONFIG]) {
    const matched = rawBoundsFixture(config, [{ data: [], error: null }]);
    const response = await matched.invoke({ version_scope: 'matched', match_count: 200 });
    assertEquals(response.status, 200);
    assertEquals(matched.rpcCalls.length, 1);
    assertEquals(matched.rpcCalls[0].name, config.versionedRpcName);
    assertEquals(matched.rpcCalls[0].body.match_count, 200);
  }
  for (const version_scope of [undefined, 'latest', 'matched']) {
    const config = {
      ...VERSIONED_V2_CONFIG,
      openDataRpcName: 'hybrid_search_open_data_catalog',
    };
    const openData = rawBoundsFixture(config, [{ data: [], error: null }]);
    const response = await openData.invoke({
      version_scope,
      source_filter: 'all',
      publication_filter: 'all',
      match_count: 200,
    });
    assertEquals(response.status, 200);
    assertEquals(openData.rpcCalls[0].name, 'hybrid_search_open_data_catalog');
    assertEquals(openData.rpcCalls[0].body.match_count, 200);
    assertEquals(openData.work, { rewrite: 1, embedding: 1, client: 1 });
    assertEquals(openData.rpcCalls.length, version_scope === 'matched' ? 1 : 2);
  }
});

Deno.test(
  'SQLSTATE22023 maps to400 on initial and fallback RPC errors; other failures stay500',
  async () => {
    for (const code of ['22023', '42501', 'XX000']) {
      for (const fallback of [false, true]) {
        const failure = { data: null, error: { code, message: 'fixed database error' } };
        const fixture = rawBoundsFixture(
          VERSIONED_V2_CONFIG,
          fallback ? [{ data: [], error: null }, failure] : [failure],
        );
        const response = await fixture.invoke({ match_count: 80, page_size: 80 });
        assertEquals(response.status, code === '22023' ? 400 : 500);
        assertEquals(await response.json(), { error: 'fixed database error' });
        assertEquals(fixture.work, { rewrite: 1, embedding: 1, client: 1 });
        assertEquals(fixture.rpcCalls.length, fallback ? 2 : 1);
        if (fallback) {
          assertEquals(
            fixture.rpcCalls.map(({ body }) => body.match_threshold),
            [0.5, 0],
          );
        }
      }
    }
  },
);

Deno.test('canonical classification system and path survive all seven Hybrid routes', async () => {
  for (const kind of [
    'process',
    'flow',
    'lifecyclemodel',
    'contact',
    'source',
    'unitgroup',
    'flowproperty',
  ]) {
    const config: HybridSearchRouteConfig =
      kind === 'process'
        ? VERSIONED_V2_CONFIG
        : kind === 'flow'
          ? FLOW_VERSIONED_V2_CONFIG
          : {
              ...CONTACT_CONFIG,
              entityKind: kind,
              rpcName:
                kind === 'lifecyclemodel'
                  ? 'hybrid_search_lifecyclemodels_filtered'
                  : `hybrid_search_${kind}s`,
              requireSelectedTeamContext: true,
            };
    const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
    const filter = {
      classification: [{ scope: 'classification', code: '23', system: 'ISIC', path: ['C', '23'] }],
    };
    const handler = createHybridSearchHandler(config, {
      authenticate: async () => VERIFIED_JWT_AUTH,
      rewriteQuery: async () => ({
        semantic_query_en: 'cement',
        fulltext_query_en: ['cement'],
        fulltext_query_zh: [],
      }),
      generateEmbedding: async () => VECTOR,
      createRpcClient: () => ({
        client: {
          rpc: (name: string, body: Record<string, unknown>) => {
            calls.push({ name, body });
            return Promise.resolve({ data: [], error: null });
          },
        } as unknown as SupabaseClient,
        userContextKind: 'jwt',
        bearerToken: 'actor.jwt.signature',
      }),
      logger: { log: () => undefined, error: () => undefined },
    });
    const response = await handler(
      new Request('http://localhost/hybrid', {
        method: 'POST',
        body: JSON.stringify({
          query: 'cement',
          data_source: 'te',
          team_id: VERSION_ID,
          state_code: 20,
          filter_condition: filter,
          ...(config.versionedRpcName ? { version_scope: 'matched' } : {}),
        }),
      }),
    );
    assertEquals(response.status, 200, kind);
    assertEquals(calls.length > 0, true, kind);
    for (const call of calls) {
      assertEquals(call.body.filter_condition, filter, kind);
      assertEquals(call.body.team_id_filter, VERSION_ID, kind);
      assertEquals(call.body.state_code_filter, 20, kind);
    }
    if (kind === 'lifecyclemodel')
      assertEquals(calls[0].name, 'hybrid_search_lifecyclemodels_filtered');
  }
});

Deno.test(
  'invalid canonical filters and missing Model team reject before paid search work',
  async () => {
    const model: HybridSearchRouteConfig = {
      ...CONTACT_CONFIG,
      entityKind: 'lifecyclemodel',
      rpcName: 'hybrid_search_lifecyclemodels_filtered',
      requireSelectedTeamContext: true,
    };
    for (const filter of [
      { classification: {} },
      { classification: [{ scope: 'classification', code: '23', path: ['C', '24'] }] },
      { classification: [{ scope: 'classification', code: '23', system: '' }] },
      { classification: [{ scope: 'classification', code: '23', path: [] }] },
      { classification: [{ scope: 'classification', code: '23', path: Array(21).fill('23') }] },
      { classification: [{ scope: 'elementary', code: 'air' }] },
    ]) {
      let paidCalls = 0;
      const handler = createHybridSearchHandler(model, {
        authenticate: async () => VERIFIED_JWT_AUTH,
        rewriteQuery: () => {
          paidCalls++;
          throw new Error('must not rewrite');
        },
        logger: { log: () => undefined, error: () => undefined },
      });
      const response = await handler(
        new Request('http://localhost/model', {
          method: 'POST',
          body: JSON.stringify({ query: 'cement', data_source: 'my', filter_condition: filter }),
        }),
      );
      assertEquals(response.status, 400);
      assertEquals(paidCalls, 0);
    }
    let paidCalls = 0;
    const handler = createHybridSearchHandler(model, {
      authenticate: async () => VERIFIED_JWT_AUTH,
      rewriteQuery: () => {
        paidCalls++;
        throw new Error('must not rewrite');
      },
      logger: { log: () => undefined, error: () => undefined },
    });
    const response = await handler(
      new Request('http://localhost/model', {
        method: 'POST',
        body: JSON.stringify({ query: 'cement', data_source: 'te' }),
      }),
    );
    assertEquals(response.status, 400);
    assertEquals(paidCalls, 0);
  },
);
