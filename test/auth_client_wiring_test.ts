import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js@2';

import { createDeleteLifecycleModelBundleHandler } from '../supabase/functions/delete_lifecycle_model_bundle/handler.ts';
import { createExportTidasPackageHandler } from '../supabase/functions/export_tidas_package/handler.ts';
import { createSaveLifecycleModelBundleHandler } from '../supabase/functions/save_lifecycle_model_bundle/handler.ts';

const TEST_MODEL_ID = '11111111-1111-4111-8111-111111111111';
const TEST_USER_ID = '22222222-2222-4222-8222-222222222222';

Deno.test(
  'save_lifecycle_model_bundle authenticates separately and executes RPC with the request client',
  async () => {
    const authClient = { name: 'auth-client' } as unknown as SupabaseClient;
    const serviceClient = { name: 'service-client' } as unknown as SupabaseClient;
    const actorRpcCalls: Array<{ fn: string; args: unknown }> = [];
    const actorClient = {
      rpc: async (fn: string, args: unknown) => {
        actorRpcCalls.push({ fn, args: structuredClone(args) });
        return {
          data: {
            model_id: TEST_MODEL_ID,
            version: '01.01.000',
            lifecycle_model: {
              id: TEST_MODEL_ID,
              version: '01.01.000',
              json_ordered: {},
              json_tg: {},
              rule_verification: false,
            },
          },
          error: null,
        };
      },
    } as unknown as SupabaseClient;
    const seenAuthClients: SupabaseClient[] = [];
    const seenAccessTokens: string[] = [];

    const handler = createSaveLifecycleModelBundleHandler({
      authClient,
      serviceSupabase: serviceClient,
      createRequestSupabaseClient: (accessToken) => {
        seenAccessTokens.push(accessToken);
        return actorClient;
      },
      authenticateRequest: async (_req, config) => {
        seenAuthClients.push(config.authClient!);
        return {
          isAuthenticated: true,
          principal: {
            userId: TEST_USER_ID,
            authMethod: 'supabase_jwt',
            assurance: 'claims',
          },
        };
      },
      ensureOwnerOrReviewAdmin: async () => {
        throw new Error('create must not run the service-role preflight');
      },
    });

    const response = await handler(
      new Request('https://example.com/functions/v1/save_lifecycle_model_bundle', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer header.payload.signature',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mode: 'create',
          modelId: TEST_MODEL_ID,
          parent: {
            jsonOrdered: {},
            jsonTg: {},
            ruleVerification: false,
          },
          processMutations: [],
        }),
      }),
    );

    assertEquals(response.status, 200);
    assertEquals(seenAuthClients, [authClient]);
    assertEquals(seenAccessTokens, ['header.payload.signature']);
    assertEquals(actorRpcCalls.length, 1);
    assertEquals(actorRpcCalls[0].fn, 'cmd_lifecycle_model_bundle_save');
    assertEquals(
      'actorUserId' in (actorRpcCalls[0].args as { p_plan: Record<string, unknown> }).p_plan,
      false,
    );
  },
);

Deno.test(
  'delete_lifecycle_model_bundle uses service role only for preflight and request client for command',
  async () => {
    const authClient = { name: 'auth-client' } as unknown as SupabaseClient;
    const serviceClient = { name: 'service-client' } as unknown as SupabaseClient;
    const actorRpcCalls: Array<{ fn: string; args: unknown }> = [];
    const actorClient = {
      rpc: async (fn: string, args: unknown) => {
        actorRpcCalls.push({ fn, args: structuredClone(args) });
        return {
          data: {
            model_id: TEST_MODEL_ID,
            version: '01.01.000',
          },
          error: null,
        };
      },
    } as unknown as SupabaseClient;
    const seenAuthClients: SupabaseClient[] = [];
    const seenAccessTokens: string[] = [];
    const seenPreflightClients: SupabaseClient[] = [];

    const handler = createDeleteLifecycleModelBundleHandler({
      authClient,
      serviceSupabase: serviceClient,
      createRequestSupabaseClient: (accessToken) => {
        seenAccessTokens.push(accessToken);
        return actorClient;
      },
      authenticateRequest: async (_req, config) => {
        seenAuthClients.push(config.authClient!);
        return {
          isAuthenticated: true,
          principal: {
            userId: TEST_USER_ID,
            authMethod: 'supabase_jwt',
            assurance: 'claims',
          },
        };
      },
      ensureOwnerOrReviewAdmin: async (supabase) => {
        seenPreflightClients.push(supabase);
        return { ok: true };
      },
    });

    const response = await handler(
      new Request('https://example.com/functions/v1/delete_lifecycle_model_bundle', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer header.payload.signature',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          modelId: TEST_MODEL_ID,
          version: '01.01.000',
        }),
      }),
    );

    assertEquals(response.status, 200);
    assertEquals(seenAuthClients, [authClient]);
    assertEquals(seenPreflightClients, [serviceClient]);
    assertEquals(seenAccessTokens, ['header.payload.signature']);
    assertEquals(actorRpcCalls, [
      {
        fn: 'cmd_lifecycle_model_bundle_delete',
        args: {
          p_model_id: TEST_MODEL_ID,
          p_version: '01.01.000',
        },
      },
    ]);
  },
);

Deno.test(
  'export_tidas_package authenticates with the auth client and queues exports with the service client',
  async () => {
    const authClient = { name: 'auth-client' } as unknown as SupabaseClient;
    const serviceClient = { name: 'service-client' } as unknown as SupabaseClient;
    const seenAuthClients: SupabaseClient[] = [];
    const seenSupabaseClients: SupabaseClient[] = [];

    const handler = createExportTidasPackageHandler({
      authClient,
      supabase: serviceClient,
      authenticateRequest: async (_req, config) => {
        seenAuthClients.push(config.authClient!);
        return {
          isAuthenticated: true,
          principal: {
            userId: TEST_USER_ID,
            authMethod: 'supabase_jwt',
            assurance: 'claims',
          },
        };
      },
      queueExportTidasPackage: async (supabase, userId, body, _req) => {
        seenSupabaseClients.push(supabase as SupabaseClient);
        assertEquals(userId, TEST_USER_ID);
        assertEquals(body, { scope: 'current_user_and_open_data' });
        return {
          ok: true as const,
          mode: 'queued' as const,
          job_id: 'job-1',
          scope: 'current_user_and_open_data' as const,
          root_count: 0,
        };
      },
    });

    const response = await handler(
      new Request('https://example.com/functions/v1/export_tidas_package', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer header.payload.signature',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          scope: 'current_user_and_open_data',
        }),
      }),
    );

    assertEquals(response.status, 202);
    assertEquals(seenAuthClients, [authClient]);
    assertEquals(seenSupabaseClients, [serviceClient]);
  },
);
