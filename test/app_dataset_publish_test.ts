import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js@2';

import { executePublishCommand } from '../supabase/functions/_shared/commands/dataset/publish.ts';

const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const TEST_DATASET_ID = '22222222-2222-4222-8222-222222222222';

class FakeRpcSupabase {
  rpcCalls: Array<{ fn: string; args: unknown }> = [];

  rpc(fn: string, args: unknown) {
    this.rpcCalls.push({
      fn,
      args: structuredClone(args),
    });

    return Promise.resolve({
      data: {
        id: TEST_DATASET_ID,
        published: true,
      },
      error: null,
    });
  }
}

function buildActor(supabase: FakeRpcSupabase) {
  return {
    userId: TEST_USER_ID,
    accessToken: 'access-token',
    supabase: supabase as unknown as SupabaseClient,
  };
}

Deno.test('executePublishCommand forwards dataset publication to cmd_dataset_publish', async () => {
  const supabase = new FakeRpcSupabase();
  const result = await executePublishCommand(
    {
      table: 'flows',
      id: TEST_DATASET_ID,
      version: '01.00.000',
    },
    buildActor(supabase),
  );

  assertEquals(result.ok, true);
  assertEquals(supabase.rpcCalls, [
    {
      fn: 'cmd_dataset_publish',
      args: {
        p_table: 'flows',
        p_id: TEST_DATASET_ID,
        p_version: '01.00.000',
        p_audit: {
          command: 'dataset_publish',
          actorUserId: TEST_USER_ID,
          targetTable: 'flows',
          targetId: TEST_DATASET_ID,
          targetVersion: '01.00.000',
          payload: {},
        },
      },
    },
  ]);
});
