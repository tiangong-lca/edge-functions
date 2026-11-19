import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js@2';

import { executeAssignReviewersCommand } from '../supabase/functions/_shared/commands/review/assign_reviewers.ts';
import { executeRevokeReviewerCommand } from '../supabase/functions/_shared/commands/review/revoke_reviewer.ts';
import { executeSaveAssignmentDraftCommand } from '../supabase/functions/_shared/commands/review/save_assignment_draft.ts';

const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const TEST_REVIEW_ID = '22222222-2222-4222-8222-222222222222';
const TEST_REVIEWER_A = '33333333-3333-4333-8333-333333333333';
const TEST_REVIEWER_B = '44444444-4444-4444-8444-444444444444';

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
  'executeSaveAssignmentDraftCommand forwards review assignment draft to cmd_review_save_assignment_draft',
  async () => {
    const supabase = new FakeRpcSupabase();
    const result = await executeSaveAssignmentDraftCommand(
      {
        reviewId: TEST_REVIEW_ID,
        reviewerIds: [TEST_REVIEWER_A, TEST_REVIEWER_B],
      },
      buildActor(supabase),
    );

    assertEquals(result.ok, true);
    assertEquals(supabase.rpcCalls, [
      {
        fn: 'cmd_review_save_assignment_draft',
        args: {
          p_review_id: TEST_REVIEW_ID,
          p_reviewer_ids: [TEST_REVIEWER_A, TEST_REVIEWER_B],
          p_audit: {
            command: 'review_save_assignment_draft',
            actorUserId: TEST_USER_ID,
            targetTable: 'reviews',
            targetId: TEST_REVIEW_ID,
            targetVersion: '',
            payload: {
              reviewerIds: [TEST_REVIEWER_A, TEST_REVIEWER_B],
            },
          },
        },
      },
    ]);
  },
);

Deno.test(
  'executeAssignReviewersCommand forwards review assignment to cmd_review_assign_reviewers',
  async () => {
    const supabase = new FakeRpcSupabase();
    const result = await executeAssignReviewersCommand(
      {
        reviewId: TEST_REVIEW_ID,
        reviewerIds: [TEST_REVIEWER_A],
        deadline: '2026-04-10T12:00:00.000Z',
      },
      buildActor(supabase),
    );

    assertEquals(result.ok, true);
    assertEquals(supabase.rpcCalls, [
      {
        fn: 'cmd_review_assign_reviewers',
        args: {
          p_review_id: TEST_REVIEW_ID,
          p_reviewer_ids: [TEST_REVIEWER_A],
          p_deadline: '2026-04-10T12:00:00.000Z',
          p_audit: {
            command: 'review_assign_reviewers',
            actorUserId: TEST_USER_ID,
            targetTable: 'reviews',
            targetId: TEST_REVIEW_ID,
            targetVersion: '',
            payload: {
              reviewerIds: [TEST_REVIEWER_A],
              deadline: '2026-04-10T12:00:00.000Z',
            },
          },
        },
      },
    ]);
  },
);

Deno.test(
  'executeRevokeReviewerCommand forwards review revocation to cmd_review_revoke_reviewer',
  async () => {
    const supabase = new FakeRpcSupabase();
    const result = await executeRevokeReviewerCommand(
      {
        reviewId: TEST_REVIEW_ID,
        reviewerId: TEST_REVIEWER_B,
      },
      buildActor(supabase),
    );

    assertEquals(result.ok, true);
    assertEquals(supabase.rpcCalls, [
      {
        fn: 'cmd_review_revoke_reviewer',
        args: {
          p_review_id: TEST_REVIEW_ID,
          p_reviewer_id: TEST_REVIEWER_B,
          p_audit: {
            command: 'review_revoke_reviewer',
            actorUserId: TEST_USER_ID,
            targetTable: 'reviews',
            targetId: TEST_REVIEW_ID,
            targetVersion: '',
            payload: {
              reviewerId: TEST_REVIEWER_B,
            },
          },
        },
      },
    ]);
  },
);
