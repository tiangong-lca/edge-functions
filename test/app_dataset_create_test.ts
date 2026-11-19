import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js@2';

import {
  executeCreateCommand,
  parseCreateCommand,
} from '../supabase/functions/_shared/commands/dataset/create.ts';

const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const TEST_DATASET_ID = '22222222-2222-4222-8222-222222222222';
const TEST_MODEL_ID = '33333333-3333-4333-8333-333333333333';
const TEST_MODEL_VERSION = '01.01.021';

class FakeRpcSupabase {
  rpcCalls: Array<{ fn: string; args: unknown }> = [];
  response: { data: unknown; error: unknown };

  constructor(
    response: { data: unknown; error: unknown } = {
      data: {
        id: TEST_DATASET_ID,
        version: '01.00.000',
      },
      error: null,
    },
  ) {
    this.response = response;
  }

  rpc(fn: string, args: unknown) {
    this.rpcCalls.push({
      fn,
      args: structuredClone(args),
    });

    return Promise.resolve(structuredClone(this.response));
  }
}

function buildActor(supabase: FakeRpcSupabase) {
  return {
    userId: TEST_USER_ID,
    accessToken: 'access-token',
    supabase: supabase as unknown as SupabaseClient,
  };
}

Deno.test('executeCreateCommand forwards dataset creation to cmd_dataset_create', async () => {
  const supabase = new FakeRpcSupabase();
  const result = await executeCreateCommand(
    {
      table: 'processes',
      id: TEST_DATASET_ID,
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
      fn: 'cmd_dataset_create',
      args: {
        p_table: 'processes',
        p_id: TEST_DATASET_ID,
        p_json_ordered: { foo: 'bar' },
        p_model_id: TEST_MODEL_ID,
        p_model_version: TEST_MODEL_VERSION,
        p_rule_verification: false,
        p_audit: {
          command: 'dataset_create',
          actorUserId: TEST_USER_ID,
          targetTable: 'processes',
          targetId: TEST_DATASET_ID,
          targetVersion: '',
          payload: {
            modelId: TEST_MODEL_ID,
            modelVersion: TEST_MODEL_VERSION,
          },
        },
      },
    },
  ]);
});

Deno.test('executeCreateCommand allows process creates without modelId', async () => {
  const supabase = new FakeRpcSupabase();
  const result = await executeCreateCommand(
    {
      table: 'processes',
      id: TEST_DATASET_ID,
      jsonOrdered: { foo: 'bar' },
    },
    buildActor(supabase),
  );

  assertEquals(result.ok, true);
  assertEquals(supabase.rpcCalls, [
    {
      fn: 'cmd_dataset_create',
      args: {
        p_table: 'processes',
        p_id: TEST_DATASET_ID,
        p_json_ordered: { foo: 'bar' },
        p_model_id: null,
        p_model_version: null,
        p_rule_verification: null,
        p_audit: {
          command: 'dataset_create',
          actorUserId: TEST_USER_ID,
          targetTable: 'processes',
          targetId: TEST_DATASET_ID,
          targetVersion: '',
          payload: {},
        },
      },
    },
  ]);
});

Deno.test('parseCreateCommand rejects invalid dataset create payloads', () => {
  const result = parseCreateCommand({
    table: 'unknown',
    id: 'not-a-uuid',
    jsonOrdered: { foo: 'bar' },
  });

  assertEquals(result.ok, false);
});

Deno.test('executeCreateCommand rejects modelId for non-process datasets', async () => {
  const supabase = new FakeRpcSupabase();
  const result = await executeCreateCommand(
    {
      table: 'flows',
      id: TEST_DATASET_ID,
      jsonOrdered: { foo: 'bar' },
      modelId: TEST_MODEL_ID,
    },
    buildActor(supabase),
  );

  assertEquals(result, {
    ok: false,
    code: 'MODEL_ID_NOT_ALLOWED',
    message: 'modelId is only allowed for process dataset creates',
    status: 400,
  });
  assertEquals(supabase.rpcCalls, []);
});

Deno.test('executeCreateCommand rejects modelVersion without modelId', async () => {
  const supabase = new FakeRpcSupabase();
  const result = await executeCreateCommand(
    {
      table: 'processes',
      id: TEST_DATASET_ID,
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

Deno.test('executeCreateCommand rejects modelVersion for non-process datasets', async () => {
  const supabase = new FakeRpcSupabase();
  const result = await executeCreateCommand(
    {
      table: 'flows',
      id: TEST_DATASET_ID,
      jsonOrdered: { foo: 'bar' },
      modelVersion: TEST_MODEL_VERSION,
    },
    buildActor(supabase),
  );

  assertEquals(result, {
    ok: false,
    code: 'MODEL_VERSION_NOT_ALLOWED',
    message: 'modelVersion is only allowed for process dataset creates',
    status: 400,
  });
  assertEquals(supabase.rpcCalls, []);
});
