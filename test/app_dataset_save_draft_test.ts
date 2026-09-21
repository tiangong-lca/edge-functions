import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.112.4';

import { executeSaveDraftCommand } from '../supabase/functions/_shared/commands/dataset/save_draft.ts';
import { createAppDatasetSaveDraftHandler } from '../supabase/functions/app_dataset_save_draft/index.ts';

const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const TEST_DATASET_ID = '22222222-2222-4222-8222-222222222222';
const TEST_MODEL_ID = '33333333-3333-4333-8333-333333333333';
const TEST_MODEL_VERSION = '01.01.021';

const draftSavedRow = {
  id: TEST_DATASET_ID,
  version: '01.00.000',
};

class FakeRpcSupabase {
  rpcCalls: Array<{ fn: string; args: unknown }> = [];

  constructor(
    private readonly result: { data: unknown; error: unknown } = {
      data: draftSavedRow,
      error: null,
    },
  ) {}

  rpc(fn: string, args: unknown) {
    this.rpcCalls.push({
      fn,
      args: structuredClone(args),
    });

    return Promise.resolve(this.result);
  }
}

function buildActor(supabase: FakeRpcSupabase) {
  return {
    userId: TEST_USER_ID,
    accessToken: 'access-token',
    supabase: supabase as unknown as SupabaseClient,
  };
}

function saveDraftBody(overrides: Record<string, unknown> = {}) {
  return {
    table: 'processes',
    id: TEST_DATASET_ID,
    version: '01.00.000',
    jsonOrdered: { foo: 'bar' },
    ...overrides,
  };
}

Deno.test(
  'executeSaveDraftCommand forwards draft mutations to cmd_dataset_save_draft',
  async () => {
    const supabase = new FakeRpcSupabase();
    const result = await executeSaveDraftCommand(
      {
        table: 'processes',
        id: TEST_DATASET_ID,
        version: '01.00.000',
        jsonOrdered: { foo: 'bar' },
        modelId: TEST_MODEL_ID,
        modelVersion: TEST_MODEL_VERSION,
        ruleVerification: false,
      },
      buildActor(supabase),
    );

    assertEquals(result.ok, true);
    assertEquals(supabase.rpcCalls, [
      {
        fn: 'cmd_dataset_save_draft',
        args: {
          p_table: 'processes',
          p_id: TEST_DATASET_ID,
          p_version: '01.00.000',
          p_json_ordered: { foo: 'bar' },
          p_model_id: TEST_MODEL_ID,
          p_model_version: TEST_MODEL_VERSION,
          p_rule_verification: false,
          p_audit: {
            command: 'dataset_save_draft',
            actorUserId: TEST_USER_ID,
            targetTable: 'processes',
            targetId: TEST_DATASET_ID,
            targetVersion: '01.00.000',
            payload: {
              modelId: TEST_MODEL_ID,
              modelVersion: TEST_MODEL_VERSION,
            },
          },
        },
      },
    ]);
  },
);

Deno.test('executeSaveDraftCommand allows process drafts without modelId', async () => {
  const supabase = new FakeRpcSupabase();
  const result = await executeSaveDraftCommand(
    {
      table: 'processes',
      id: TEST_DATASET_ID,
      version: '01.00.000',
      jsonOrdered: { foo: 'bar' },
    },
    buildActor(supabase),
  );

  assertEquals(result.ok, true);
  assertEquals(supabase.rpcCalls, [
    {
      fn: 'cmd_dataset_save_draft',
      args: {
        p_table: 'processes',
        p_id: TEST_DATASET_ID,
        p_version: '01.00.000',
        p_json_ordered: { foo: 'bar' },
        p_model_id: null,
        p_model_version: null,
        p_rule_verification: null,
        p_audit: {
          command: 'dataset_save_draft',
          actorUserId: TEST_USER_ID,
          targetTable: 'processes',
          targetId: TEST_DATASET_ID,
          targetVersion: '01.00.000',
          payload: {},
        },
      },
    },
  ]);
});

Deno.test('executeSaveDraftCommand rejects modelVersion without modelId', async () => {
  const supabase = new FakeRpcSupabase();
  const result = await executeSaveDraftCommand(
    {
      table: 'processes',
      id: TEST_DATASET_ID,
      version: '01.00.000',
      jsonOrdered: { foo: 'bar' },
      modelVersion: TEST_MODEL_VERSION,
    },
    buildActor(supabase),
  );

  assertEquals(result, {
    ok: false,
    code: 'MODEL_ID_REQUIRED_FOR_MODEL_VERSION',
    message: 'modelId is required when modelVersion is provided',
    status: 400,
  });
  assertEquals(supabase.rpcCalls, []);
});

Deno.test(
  'executeSaveDraftCommand routes an explicit expected before image to the guarded RPC',
  async () => {
    const supabase = new FakeRpcSupabase();
    const result = await executeSaveDraftCommand(
      {
        table: 'processes',
        id: TEST_DATASET_ID,
        version: '01.00.000',
        jsonOrdered: { foo: 'bar' },
        expectedJsonOrdered: { foo: 'before' },
        modelId: TEST_MODEL_ID,
        modelVersion: TEST_MODEL_VERSION,
        ruleVerification: false,
      },
      buildActor(supabase),
    );

    assertEquals(result.ok, true);
    assertEquals(supabase.rpcCalls, [
      {
        fn: 'cmd_dataset_save_draft_guarded',
        args: {
          p_table: 'processes',
          p_id: TEST_DATASET_ID,
          p_version: '01.00.000',
          p_json_ordered: { foo: 'bar' },
          p_expected_json_ordered: { foo: 'before' },
          p_model_id: TEST_MODEL_ID,
          p_model_version: TEST_MODEL_VERSION,
          p_rule_verification: false,
          p_audit: {
            command: 'dataset_save_draft',
            actorUserId: TEST_USER_ID,
            targetTable: 'processes',
            targetId: TEST_DATASET_ID,
            targetVersion: '01.00.000',
            payload: {
              modelId: TEST_MODEL_ID,
              modelVersion: TEST_MODEL_VERSION,
            },
          },
        },
      },
    ]);
  },
);

Deno.test(
  'executeSaveDraftCommand forwards the guarded conflict without a legacy fallback',
  async () => {
    const conflict = {
      ok: false as const,
      code: 'DATASET_BEFORE_CONTENT_CHANGED',
      status: 409,
      message: 'Draft content changed since it was read',
    };
    const supabase = new FakeRpcSupabase({ data: conflict, error: null });
    const result = await executeSaveDraftCommand(
      {
        table: 'flows',
        id: TEST_DATASET_ID,
        version: '01.00.000',
        jsonOrdered: { foo: 'bar' },
        expectedJsonOrdered: { foo: 'stale' },
      },
      buildActor(supabase),
    );

    assertEquals(result, conflict);
    assertEquals(
      supabase.rpcCalls.map((call) => call.fn),
      ['cmd_dataset_save_draft_guarded'],
    );
  },
);

Deno.test('executeSaveDraftCommand fails closed when the guarded RPC is unavailable', async () => {
  const supabase = new FakeRpcSupabase({
    data: null,
    error: { code: 'PGRST202', message: 'Could not find the function' },
  });
  const result = await executeSaveDraftCommand(
    {
      table: 'flows',
      id: TEST_DATASET_ID,
      version: '01.00.000',
      jsonOrdered: { foo: 'bar' },
      expectedJsonOrdered: { foo: 'before' },
    },
    buildActor(supabase),
  );

  assertEquals(result.ok, false);
  assertEquals(
    supabase.rpcCalls.map((call) => call.fn),
    ['cmd_dataset_save_draft_guarded'],
  );
});

Deno.test(
  'guarded save draft rejects a malformed expected before image before dispatch',
  async () => {
    for (const expectedJsonOrdered of [null, ['before'], 'before', 7]) {
      const supabase = new FakeRpcSupabase();
      const handler = createAppDatasetSaveDraftHandler({
        resolveActor: async () => ({
          ok: true as const,
          value: buildActor(supabase),
        }),
      });

      const response = await handler(
        new Request('http://localhost/functions/v1/app_dataset_save_draft', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer access-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(saveDraftBody({ expectedJsonOrdered })),
        }),
      );

      assertEquals(response.status, 400);
      assertEquals((await response.json()).code, 'INVALID_PAYLOAD');
      assertEquals(supabase.rpcCalls, []);
    }
  },
);

Deno.test('guarded save draft accepts an explicit object before image', async () => {
  const supabase = new FakeRpcSupabase();
  const handler = createAppDatasetSaveDraftHandler({
    resolveActor: async () => ({
      ok: true as const,
      value: buildActor(supabase),
    }),
  });

  const response = await handler(
    new Request('http://localhost/functions/v1/app_dataset_save_draft', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(saveDraftBody({ expectedJsonOrdered: { foo: 'before' } })),
    }),
  );

  assertEquals(response.status, 200);
  assertEquals(
    supabase.rpcCalls.map((call) => call.fn),
    ['cmd_dataset_save_draft_guarded'],
  );
});
