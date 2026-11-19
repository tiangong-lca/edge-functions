import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js@2';

import {
  executeSimpleReviewDecisionCommand,
  parseSimpleReviewDecisionCommand,
} from '../supabase/functions/_shared/commands/review/simple_review_decision.ts';

const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const TEST_REVIEW_ID = '22222222-2222-4222-8222-222222222222';

class FakeRpcSupabase {
  rpcCalls: Array<{ fn: string; args: unknown }> = [];

  rpc(fn: string, args: unknown) {
    this.rpcCalls.push({ fn, args: structuredClone(args) });
    return Promise.resolve({
      data: { ok: true, data: { review_id: TEST_REVIEW_ID } },
      error: null,
    });
  }
}

Deno.test('simple review approval carries no reason and uses the v2 RPC', async () => {
  const supabase = new FakeRpcSupabase();
  const result = await executeSimpleReviewDecisionCommand(
    { reviewId: TEST_REVIEW_ID, decision: 'approve' },
    {
      userId: TEST_USER_ID,
      accessToken: 'access-token',
      supabase: supabase as unknown as SupabaseClient,
    },
  );

  assertEquals(result.ok, true);
  assertEquals(supabase.rpcCalls[0]?.fn, 'cmd_simple_review_submit_decision');
  assertEquals((supabase.rpcCalls[0]?.args as Record<string, unknown>).p_reason, null);
});

Deno.test('simple review rejection requires a non-empty reason', () => {
  const result = parseSimpleReviewDecisionCommand({
    reviewId: TEST_REVIEW_ID,
    decision: 'reject',
    reason: '   ',
  });
  assertEquals(result.ok, false);
});
