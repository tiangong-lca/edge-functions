import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js@2';

import { executeApproveReviewCommand } from '../supabase/functions/_shared/commands/review/approve_review.ts';
import { executeRejectReviewCommand } from '../supabase/functions/_shared/commands/review/reject_review.ts';

const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const TEST_REVIEW_ID = '22222222-2222-4222-8222-222222222222';

class FakeRpcSupabase {
  rpcCalls: Array<{ fn: string; args: unknown }> = [];

  rpc(fn: string, args: unknown) {
    this.rpcCalls.push({
      fn,
      args: structuredClone(args),
    });

    return Promise.resolve({
      data: {
        review_id: TEST_REVIEW_ID,
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
  'executeApproveReviewCommand forwards approvals to cmd_review_finalize_approve',
  async () => {
    const supabase = new FakeRpcSupabase();
    const result = await executeApproveReviewCommand(
      {
        table: 'processes',
        reviewId: TEST_REVIEW_ID,
      },
      buildActor(supabase),
    );

    assertEquals(result.ok, true);
    assertEquals(supabase.rpcCalls, [
      {
        fn: 'cmd_review_finalize_approve',
        args: {
          p_review_id: TEST_REVIEW_ID,
          p_audit: {
            command: 'review_approve',
            actorUserId: TEST_USER_ID,
            targetTable: 'processes',
            targetId: TEST_REVIEW_ID,
            targetVersion: '',
            payload: {},
          },
        },
      },
    ]);
  },
);

Deno.test(
  'executeRejectReviewCommand forwards rejections to cmd_review_finalize_reject',
  async () => {
    const supabase = new FakeRpcSupabase();
    const result = await executeRejectReviewCommand(
      {
        table: 'lifecyclemodels',
        reviewId: TEST_REVIEW_ID,
        reason: 'Data quality issue',
      },
      buildActor(supabase),
    );

    assertEquals(result.ok, true);
    assertEquals(supabase.rpcCalls, [
      {
        fn: 'cmd_review_finalize_reject',
        args: {
          p_review_id: TEST_REVIEW_ID,
          p_reason: 'Data quality issue',
          p_audit: {
            command: 'review_reject',
            actorUserId: TEST_USER_ID,
            targetTable: 'lifecyclemodels',
            targetId: TEST_REVIEW_ID,
            targetVersion: '',
            payload: {
              reason: 'Data quality issue',
            },
          },
        },
      },
    ]);
  },
);

Deno.test('executeRejectReviewCommand rejects blank reason before RPC call', async () => {
  const supabase = new FakeRpcSupabase();
  const result = await executeRejectReviewCommand(
    {
      table: 'processes',
      reviewId: TEST_REVIEW_ID,
      reason: '   ',
    },
    buildActor(supabase),
  );

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.code, 'REASON_REQUIRED');
    assertEquals(result.status, 400);
  }
  assertEquals(supabase.rpcCalls.length, 0);
});
