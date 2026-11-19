import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js@2';

import { executeAssignTeamCommand } from '../supabase/functions/_shared/commands/dataset/assign_team.ts';

const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const TEST_DATASET_ID = '22222222-2222-4222-8222-222222222222';
const TEST_TEAM_ID = '44444444-4444-4444-8444-444444444444';

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
        team_id: TEST_TEAM_ID,
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

Deno.test(
  'executeAssignTeamCommand forwards dataset team assignment to cmd_dataset_assign_team',
  async () => {
    const supabase = new FakeRpcSupabase();
    const result = await executeAssignTeamCommand(
      {
        table: 'flows',
        id: TEST_DATASET_ID,
        version: '01.00.000',
        teamId: TEST_TEAM_ID,
      },
      buildActor(supabase),
    );

    assertEquals(result.ok, true);
    assertEquals(supabase.rpcCalls, [
      {
        fn: 'cmd_dataset_assign_team',
        args: {
          p_table: 'flows',
          p_id: TEST_DATASET_ID,
          p_version: '01.00.000',
          p_team_id: TEST_TEAM_ID,
          p_audit: {
            command: 'dataset_assign_team',
            actorUserId: TEST_USER_ID,
            targetTable: 'flows',
            targetId: TEST_DATASET_ID,
            targetVersion: '01.00.000',
            payload: {
              teamId: TEST_TEAM_ID,
            },
          },
        },
      },
    ]);
  },
);
