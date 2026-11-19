import { createSaveLifecycleModelBundleHandler } from '../supabase/functions/save_lifecycle_model_bundle/handler.ts';
import { createDeleteLifecycleModelBundleHandler } from '../supabase/functions/delete_lifecycle_model_bundle/handler.ts';
import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js@2';

import {
  mapRpcError,
  userHasReviewAdminRole,
} from '../supabase/functions/_shared/lifecyclemodel_bundle.ts';

const USER_ID = '11111111-1111-4111-8111-111111111111';

Deno.test(
  'guarded bundle recovery uses only the authenticated actor and verifies the original operation',
  async () => {
    const requests: unknown[] = [];
    const target = {
      protocol: 'model-bundle.v1',
      modelId: USER_ID,
      version: '06.00.000',
      operationId: '22222222-2222-4222-8222-222222222222',
    };
    const actor = {
      rpc(name: string, args: unknown) {
        requests.push({ name, args });
        return Promise.resolve({
          data: { ...target, status: 'unknown' },
          error: null,
        });
      },
    } as unknown as SupabaseClient;
    const handler = createSaveLifecycleModelBundleHandler({
      authClient: actor,
      serviceSupabase: {} as SupabaseClient,
      createRequestSupabaseClient: () => actor,
      authenticateRequest: async () => ({
        isAuthenticated: true,
        principal: { userId: USER_ID, authMethod: 'supabase_jwt', assurance: 'claims' },
      }),
      ensureOwnerOrReviewAdmin: () => {
        throw new Error('Guarded recovery must use actor admission');
      },
    });
    const request = (body: unknown) =>
      new Request('https://example.test/bundle', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { Authorization: 'Bearer test.header.signature' },
      });
    const invalid = await handler(request({ ...target, action: 'recover', actorUserId: USER_ID }));
    assertEquals(invalid.status, 400);
    assertEquals(requests, []);
    const result = await handler(request({ ...target, action: 'recover' }));
    assertEquals(result.status, 200);
    assertEquals((await result.json()).status, 'unknown');
    assertEquals(requests, [
      {
        name: 'cmd_lifecycle_model_bundle_save',
        args: { p_plan: { ...target, action: 'recover' } },
      },
    ]);
  },
);

Deno.test(
  'lifecycle model authorization uses the service-only review-admin predicate',
  async () => {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const supabase = {
      rpc(fn: string, args: Record<string, unknown>) {
        calls.push({ fn, args });
        return Promise.resolve({ data: { ok: true, data: true }, error: null });
      },
    } as unknown as SupabaseClient;

    assertEquals(await userHasReviewAdminRole(supabase, USER_ID), true);
    assertEquals(calls, [
      {
        fn: 'svc_membership_is_review_admin',
        args: { p_user_id: USER_ID },
      },
    ]);
  },
);

Deno.test(
  'lifecycle model authorization fails closed on malformed predicate responses',
  async () => {
    const supabase = {
      rpc() {
        return Promise.resolve({ data: { ok: true, data: 'yes' }, error: null });
      },
    } as unknown as SupabaseClient;

    assertEquals(await userHasReviewAdminRole(supabase, USER_ID), false);
  },
);

Deno.test('bundle RPC diagnostics retain business codes and filter raw database details', () => {
  assertEquals(
    mapRpcError({
      message: 'PROCESS_NOT_FOUND',
      details: JSON.stringify({
        process_id: USER_ID,
        version: '04.00.000',
        sql: 'private query',
        token: 'secret',
      }),
    }),
    {
      ok: false,
      code: 'PROCESS_NOT_FOUND',
      message: 'A lifecycle model result process was not found at the requested version',
      details: { process_id: USER_ID, version: '04.00.000' },
    },
  );
  for (const details of ['raw SQL', null, [], { version: 'secret', process_id: 'secret' }]) {
    assertEquals(mapRpcError({ message: 'PROCESS_NOT_FOUND', details }).details, null);
  }
  assertEquals(
    mapRpcError({ message: 'unknown SQL failure', details: { id: USER_ID } }).details,
    null,
  );
  assertEquals(
    mapRpcError({ code: '23505', details: 'Key (private) already exists' }).code,
    'VERSION_CONFLICT',
  );
});

for (const [message, code, status] of [
  ['MODEL_NOT_FOUND', 'MODEL_NOT_FOUND', 404],
  ['PROCESS_NOT_FOUND', 'PROCESS_NOT_FOUND', 404],
  ['INVALID_PLAN', 'INVALID_PAYLOAD', 400],
  ['VERSION_CONFLICT', 'VERSION_CONFLICT', 409],
  ['AUTH_REQUIRED', 'AUTH_REQUIRED', 401],
  ['FORBIDDEN', 'FORBIDDEN', 403],
  ['unknown database failure', 'PROCESS_PERSIST_FAILED', 500],
] as const) {
  for (const operation of ['save', 'delete'] as const) {
    Deno.test(`${operation} bundle returns ${code} with HTTP ${status}`, async () => {
      const client = {
        rpc: () => Promise.resolve({ data: null, error: { message } }),
      } as unknown as SupabaseClient;
      const deps = {
        authClient: client,
        serviceSupabase: client,
        createRequestSupabaseClient: () => client,
        authenticateRequest: async () => ({
          isAuthenticated: true,
          principal: {
            userId: USER_ID,
            authMethod: 'supabase_jwt' as const,
            assurance: 'claims' as const,
          },
        }),
        ensureOwnerOrReviewAdmin: async () => ({ ok: true as const }),
      };
      const handler =
        operation === 'save'
          ? createSaveLifecycleModelBundleHandler(deps)
          : createDeleteLifecycleModelBundleHandler(deps);
      const body =
        operation === 'save'
          ? {
              mode: 'update',
              modelId: USER_ID,
              version: '06.00.000',
              parent: { jsonOrdered: {}, jsonTg: {} },
              processMutations: [],
            }
          : { modelId: USER_ID, version: '06.00.000' };
      const response = await handler(
        new Request('https://example.test/bundle', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer test.header.signature',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }),
      );
      assertEquals(response.status, status);
      const result = await response.json();
      assertEquals(result.code, code);
      assertEquals(result.ok, false);
      assertEquals(result.details, null);
    });
  }
}
