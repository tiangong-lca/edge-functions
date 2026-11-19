import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js@2';

import { executeSaveCommentDraftCommand } from '../supabase/functions/_shared/commands/review/save_comment_draft.ts';
import { executeSubmitCommentCommand } from '../supabase/functions/_shared/commands/review/submit_comment.ts';

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
  'executeSaveCommentDraftCommand forwards comment draft save to cmd_review_save_comment_draft',
  async () => {
    const supabase = new FakeRpcSupabase();
    const json = { blocks: [{ type: 'paragraph', text: 'Needs adjustments' }] };
    const result = await executeSaveCommentDraftCommand(
      {
        reviewId: TEST_REVIEW_ID,
        json,
      },
      buildActor(supabase),
    );

    assertEquals(result.ok, true);
    assertEquals(supabase.rpcCalls, [
      {
        fn: 'cmd_review_save_comment_draft',
        args: {
          p_review_id: TEST_REVIEW_ID,
          p_json: json,
          p_audit: {
            command: 'review_save_comment_draft',
            actorUserId: TEST_USER_ID,
            targetTable: 'reviews',
            targetId: TEST_REVIEW_ID,
            targetVersion: '',
            payload: {
              hasJson: true,
            },
          },
        },
      },
    ]);
  },
);

Deno.test(
  'executeSubmitCommentCommand forwards comment submission to cmd_review_submit_comment',
  async () => {
    const supabase = new FakeRpcSupabase();
    const json = { summary: 'Approved with comments' };
    const result = await executeSubmitCommentCommand(
      {
        reviewId: TEST_REVIEW_ID,
        json,
      },
      buildActor(supabase),
    );

    assertEquals(result.ok, true);
    assertEquals(supabase.rpcCalls, [
      {
        fn: 'cmd_review_submit_comment',
        args: {
          p_review_id: TEST_REVIEW_ID,
          p_json: json,
          p_comment_state: 1,
          p_audit: {
            command: 'review_submit_comment',
            actorUserId: TEST_USER_ID,
            targetTable: 'reviews',
            targetId: TEST_REVIEW_ID,
            targetVersion: '',
            payload: {
              hasJson: true,
              commentState: 1,
            },
          },
        },
      },
    ]);
  },
);

Deno.test(
  'executeSubmitCommentCommand forwards reviewer rejection through cmd_review_submit_comment',
  async () => {
    const supabase = new FakeRpcSupabase();
    const json = { summary: 'Rejected by reviewer' };
    const result = await executeSubmitCommentCommand(
      {
        reviewId: TEST_REVIEW_ID,
        json,
        commentState: -3,
      },
      buildActor(supabase),
    );

    assertEquals(result.ok, true);
    assertEquals(supabase.rpcCalls, [
      {
        fn: 'cmd_review_submit_comment',
        args: {
          p_review_id: TEST_REVIEW_ID,
          p_json: json,
          p_comment_state: -3,
          p_audit: {
            command: 'review_submit_comment',
            actorUserId: TEST_USER_ID,
            targetTable: 'reviews',
            targetId: TEST_REVIEW_ID,
            targetVersion: '',
            payload: {
              hasJson: true,
              commentState: -3,
            },
          },
        },
      },
    ]);
  },
);

Deno.test('executeSubmitCommentCommand rejects invalid commentState before RPC call', async () => {
  const supabase = new FakeRpcSupabase();
  const result = await executeSubmitCommentCommand(
    {
      reviewId: TEST_REVIEW_ID,
      json: { summary: 'Invalid state' },
      commentState: 0 as never,
    },
    buildActor(supabase),
  );

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.code, 'INVALID_COMMENT_STATE');
    assertEquals(result.status, 400);
  }
  assertEquals(supabase.rpcCalls.length, 0);
});
