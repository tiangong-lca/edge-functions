import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js@2';

import { createCommandHandler } from '../supabase/functions/_shared/command_runtime/command.ts';

const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';

const fakeActor = {
  userId: TEST_USER_ID,
  accessToken: 'access-token',
  supabase: {
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as unknown as SupabaseClient,
};

Deno.test('createCommandHandler rejects invalid JSON bodies', async () => {
  const handler = createCommandHandler({
    parse: (body) => ({ ok: true as const, value: body }),
    execute: async () => ({ ok: true as const, body: { ok: true } }),
    resolveActor: async () => ({ ok: true as const, value: fakeActor }),
  });

  const response = await handler(
    new Request('http://localhost/functions/v1/app_dataset_save_draft', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
      },
      body: 'not-json',
    }),
  );

  assertEquals(response.status, 400);
  assertEquals(await response.json(), {
    ok: false,
    code: 'INVALID_PAYLOAD',
    message: 'Request body must be valid JSON',
  });
});

Deno.test('createCommandHandler wires actor context into command execution', async () => {
  const handler = createCommandHandler({
    parse: (body) => ({ ok: true as const, value: body as { table: string } }),
    execute: async (input, actor) => ({
      ok: true as const,
      body: {
        actorUserId: actor.userId,
        table: input.table,
      },
    }),
    resolveActor: async () => ({ ok: true as const, value: fakeActor }),
  });

  const response = await handler(
    new Request('http://localhost/functions/v1/app_dataset_publish', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ table: 'flows' }),
    }),
  );

  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    actorUserId: TEST_USER_ID,
    table: 'flows',
  });
});

Deno.test('createCommandHandler propagates actor resolution failures', async () => {
  const handler = createCommandHandler({
    parse: (body) => ({ ok: true as const, value: body }),
    execute: async () => ({ ok: true as const, body: { ok: true } }),
    resolveActor: async () => ({
      ok: false as const,
      response: new Response(
        JSON.stringify({
          ok: false,
          code: 'AUTH_REQUIRED',
          message: 'Authentication required',
        }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    }),
  });

  const response = await handler(
    new Request('http://localhost/functions/v1/app_dataset_save_draft', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ table: 'flows' }),
    }),
  );

  assertEquals(response.status, 401);
  assertEquals(await response.json(), {
    ok: false,
    code: 'AUTH_REQUIRED',
    message: 'Authentication required',
  });
});

Deno.test(
  'command preflight caches header permission without resolving an actor or executing work',
  async () => {
    let actorCalls = 0;
    let executions = 0;
    const handler = createCommandHandler({
      parse: (body) => ({ ok: true as const, value: body }),
      resolveActor: async () => {
        actorCalls += 1;
        return { ok: true as const, value: fakeActor };
      },
      execute: async () => {
        executions += 1;
        return { ok: true as const, body: { ok: true } };
      },
    });
    const response = await handler(
      new Request('http://localhost/command', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://lca.tiangong.earth',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers':
            'authorization,apikey,content-type,x-client-info,x-region',
        },
      }),
    );
    assertEquals(response.status, 200);
    assertEquals(response.headers.get('access-control-max-age'), '600');
    assertEquals(response.headers.get('access-control-allow-origin'), '*');
    const allowed = response.headers
      .get('access-control-allow-headers')!
      .toLowerCase()
      .split(',')
      .map((header) => header.trim());
    // Firefox requires explicit names to reuse SDK preflights, even with a wildcard.
    for (const header of ['authorization', 'apikey', 'content-type', 'x-client-info', 'x-region']) {
      assertEquals(allowed.includes(header), true, `Missing cached SDK header: ${header}`);
    }
    assertEquals(allowed.includes('*'), true);
    assertEquals(response.headers.has('cache-control'), false);
    assertEquals(actorCalls, 0);
    assertEquals(executions, 0);
    await response.body?.cancel();
  },
);

Deno.test(
  'a successful preflight never substitutes for authentication on a later POST',
  async () => {
    let actorCalls = 0;
    let executions = 0;
    const handler = createCommandHandler({
      parse: (body) => ({ ok: true as const, value: body }),
      resolveActor: async () => {
        actorCalls += 1;
        return { ok: false as const, response: new Response('Unauthorized', { status: 401 }) };
      },
      execute: async () => {
        executions += 1;
        return { ok: true as const, body: {} };
      },
    });
    const preflight = await handler(new Request('http://localhost/command', { method: 'OPTIONS' }));
    await preflight.body?.cancel();
    for (const token of ['expired-token', 'different-expired-token']) {
      const response = await handler(
        new Request('http://localhost/command', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: '{}',
        }),
      );
      assertEquals(response.status, 401);
      await response.body?.cancel();
    }
    assertEquals(actorCalls, 2);
    assertEquals(executions, 0);
    const unsupported = await handler(
      new Request('http://localhost/command', { method: 'DELETE' }),
    );
    assertEquals(unsupported.status, 405);
    await unsupported.body?.cancel();
    assertEquals(actorCalls, 2);
  },
);
