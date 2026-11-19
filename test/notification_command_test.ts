import { assertEquals, assertThrows } from 'jsr:@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js@2';

import { createNotificationCommandRepository } from '../supabase/functions/_shared/commands/notification/repository.ts';
import {
  executeNotificationSendValidationIssueCommand,
  parseNotificationSendValidationIssueCommand,
} from '../supabase/functions/_shared/commands/notification/send_validation_issue.ts';

const TEST_ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const TEST_RECIPIENT_ID = '22222222-2222-4222-8222-222222222222';
const TEST_DATASET_ID = '33333333-3333-4333-8333-333333333333';

class FakeRpcSupabase {
  rpcCalls: Array<{ fn: string; args: unknown }> = [];

  rpc(fn: string, args: unknown) {
    this.rpcCalls.push({
      fn,
      args: structuredClone(args),
    });

    return Promise.resolve({
      data: {
        ok: true,
        data: {
          id: '44444444-4444-4444-8444-444444444444',
        },
      },
      error: null,
    });
  }
}

function buildActor(supabase: FakeRpcSupabase) {
  return {
    userId: TEST_ACTOR_ID,
    accessToken: 'access-token',
    supabase: supabase as unknown as SupabaseClient,
  };
}

Deno.test(
  'notification validation-issue payload parser rejects removed source dataset fields',
  () => {
    const parsed = parseNotificationSendValidationIssueCommand({
      recipientUserId: TEST_RECIPIENT_ID,
      datasetType: 'process data set',
      datasetId: TEST_DATASET_ID,
      datasetVersion: '01.00.000',
      issueCodes: ['ruleVerificationFailed'],
      sourceDatasetType: 'process data set',
    });

    assertEquals(parsed.ok, false);
  },
);

Deno.test('createNotificationCommandRepository requires an explicit Supabase client', () => {
  assertThrows(
    () => createNotificationCommandRepository(undefined as never),
    Error,
    'Notification command repository requires an explicit Supabase client',
  );
});

Deno.test(
  'executeNotificationSendValidationIssueCommand forwards cmd_notification_send_validation_issue args',
  async () => {
    const supabase = new FakeRpcSupabase();

    const result = await executeNotificationSendValidationIssueCommand(
      {
        recipientUserId: TEST_RECIPIENT_ID,
        datasetType: 'process data set',
        datasetId: TEST_DATASET_ID,
        datasetVersion: '01.00.000',
        link: 'https://example.com/issues/1',
        issueCodes: ['ruleVerificationFailed', 'sdkInvalid'],
        tabNames: ['processInformation', 'modellingAndValidation'],
        issueCount: 2,
      },
      buildActor(supabase),
    );

    assertEquals(result.ok, true);
    assertEquals(supabase.rpcCalls, [
      {
        fn: 'cmd_notification_send_validation_issue',
        args: {
          p_recipient_user_id: TEST_RECIPIENT_ID,
          p_dataset_type: 'process data set',
          p_dataset_id: TEST_DATASET_ID,
          p_dataset_version: '01.00.000',
          p_link: 'https://example.com/issues/1',
          p_issue_codes: ['ruleVerificationFailed', 'sdkInvalid'],
          p_tab_names: ['processInformation', 'modellingAndValidation'],
          p_issue_count: 2,
          p_audit: {
            command: 'notification_send_validation_issue',
            actorUserId: TEST_ACTOR_ID,
            targetTable: 'notifications',
            targetId: TEST_DATASET_ID,
            targetVersion: '01.00.000',
            payload: {
              recipientUserId: TEST_RECIPIENT_ID,
              datasetType: 'process data set',
              issueCount: 2,
            },
          },
        },
      },
    ]);
  },
);
