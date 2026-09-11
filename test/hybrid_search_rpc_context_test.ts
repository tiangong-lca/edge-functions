import { assertEquals, assertInstanceOf, assertThrows } from 'jsr:@std/assert';

import {
  HybridSearchRpcContextError,
  resolveHybridSearchRpcContext,
} from '../supabase/functions/_shared/hybrid_search_rpc_context.ts';

const TEST_JWT = 'header.payload.signature';

Deno.test('resolveHybridSearchRpcContext uses request JWT context for user-scoped sources', () => {
  const context = resolveHybridSearchRpcContext(`Bearer ${TEST_JWT}`, 'my');

  assertEquals(context, {
    bearerToken: TEST_JWT,
    userContextKind: 'jwt',
  });
});

Deno.test('resolveHybridSearchRpcContext also keeps JWT context for public sources', () => {
  const context = resolveHybridSearchRpcContext(`Bearer ${TEST_JWT}`, 'tg');

  assertEquals(context, {
    bearerToken: TEST_JWT,
    userContextKind: 'jwt',
  });
});

Deno.test(
  'resolveHybridSearchRpcContext allows service context for non-user-scoped sources',
  () => {
    const context = resolveHybridSearchRpcContext(null, 'tg');

    assertEquals(context, {
      userContextKind: 'service',
    });
  },
);

Deno.test('resolveHybridSearchRpcContext rejects my data without a Supabase JWT context', () => {
  const error = assertThrows(
    () => resolveHybridSearchRpcContext('Bearer oauth-access-token', 'my'),
    HybridSearchRpcContextError,
  );

  assertInstanceOf(error, HybridSearchRpcContextError);
  assertEquals(error.status, 403);
  assertEquals(error.code, 'HYBRID_SEARCH_USER_CONTEXT_REQUIRED');
  assertEquals(error.message, 'data_source my requires a Supabase JWT user context');
});

Deno.test('resolveHybridSearchRpcContext rejects team data without a Supabase JWT context', () => {
  const error = assertThrows(
    () => resolveHybridSearchRpcContext(null, 'te'),
    HybridSearchRpcContextError,
  );

  assertEquals(error.message, 'data_source te requires a Supabase JWT user context');
});

Deno.test('example search requires a user JWT and never falls back to service context', () => {
  for (const header of [null, '', 'Bearer service-key']) {
    assertThrows(() => resolveHybridSearchRpcContext(header, 'ex'), HybridSearchRpcContextError);
  }
  assertEquals(resolveHybridSearchRpcContext(`Bearer ${TEST_JWT}`, 'ex'), {
    bearerToken: TEST_JWT,
    userContextKind: 'jwt',
  });
});
