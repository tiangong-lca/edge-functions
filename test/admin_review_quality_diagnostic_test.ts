import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js@2';

import {
  executeReviewQualityDiagnosticCommand,
  parseReviewQualityDiagnosticCommand,
} from '../supabase/functions/_shared/commands/review/quality_diagnostic.ts';

const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const TEST_RUN_ID = '22222222-2222-4222-8222-222222222222';

class FakeRpcSupabase {
  calls: Array<{ fn: string; args: unknown }> = [];

  constructor(
    private readonly reply: (fn: string) => { data: unknown; error: unknown } = () => ({
      data: {
        ok: true,
        data: {
          runId: TEST_RUN_ID,
          status: 'queued',
        },
      },
      error: null,
    }),
  ) {}

  rpc(fn: string, args: unknown) {
    this.calls.push({ fn, args: structuredClone(args) });
    return Promise.resolve(this.reply(fn));
  }
}

function buildActor(supabase: FakeRpcSupabase) {
  return {
    userId: TEST_USER_ID,
    accessToken: 'access-token',
    supabase: supabase as unknown as SupabaseClient,
  };
}

Deno.test('quality diagnostic payload accepts start and read without client scope', () => {
  assertEquals(parseReviewQualityDiagnosticCommand({ action: 'start' }).ok, true);
  assertEquals(parseReviewQualityDiagnosticCommand({ action: 'read' }).ok, true);
  assertEquals(
    parseReviewQualityDiagnosticCommand({ action: 'read', runId: TEST_RUN_ID }).ok,
    true,
  );
});

Deno.test('quality diagnostic payload rejects browser-selected review or Process scope', () => {
  assertEquals(
    parseReviewQualityDiagnosticCommand({
      action: 'start',
      reviewIds: ['33333333-3333-4333-8333-333333333333'],
    }).ok,
    false,
  );
  assertEquals(
    parseReviewQualityDiagnosticCommand({
      action: 'start',
      processIds: ['44444444-4444-4444-8444-444444444444'],
    }).ok,
    false,
  );
});

Deno.test('Review Admin start invokes only the database-owned manual start command', async () => {
  const supabase = new FakeRpcSupabase();
  const result = await executeReviewQualityDiagnosticCommand(
    { action: 'start' },
    buildActor(supabase),
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.status, 202);
    assertEquals(result.body, {
      ok: true,
      command: 'review_quality_diagnostic',
      action: 'start',
      data: {
        runId: TEST_RUN_ID,
        status: 'queued',
      },
    });
  }
  assertEquals(supabase.calls, [
    {
      fn: 'cmd_review_quality_diagnostic_start',
      args: {},
    },
  ]);
});

Deno.test('Review Admin read without runId requests the latest diagnostic', async () => {
  const supabase = new FakeRpcSupabase(() => ({
    data: {
      ok: true,
      data: {
        runId: TEST_RUN_ID,
        status: 'completed',
        outcome: 'findings',
        report: {
          informationalOnly: true,
          affectsReviewState: false,
        },
      },
    },
    error: null,
  }));
  const result = await executeReviewQualityDiagnosticCommand(
    { action: 'read' },
    buildActor(supabase),
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.status, 200);
  }
  assertEquals(supabase.calls, [
    {
      fn: 'qry_review_quality_diagnostic',
      args: { p_run_id: null },
    },
  ]);
});

Deno.test('Review Member denial is preserved as stable 403', async () => {
  const supabase = new FakeRpcSupabase(() => ({
    data: {
      ok: false,
      code: 'REVIEW_ADMIN_REQUIRED',
      status: 403,
      message: 'Review Admin role is required',
    },
    error: null,
  }));
  const result = await executeReviewQualityDiagnosticCommand(
    { action: 'read', runId: TEST_RUN_ID },
    buildActor(supabase),
  );

  assertEquals(result, {
    ok: false,
    code: 'REVIEW_ADMIN_REQUIRED',
    status: 403,
    message: 'Review Admin role is required',
  });
});

Deno.test(
  'failed diagnostic is returned as report state and never as a review-operation Gate',
  async () => {
    const supabase = new FakeRpcSupabase(() => ({
      data: {
        ok: true,
        data: {
          runId: TEST_RUN_ID,
          status: 'failed',
          error: {
            code: 'review_quality_diagnostic_runtime_error',
            message: 'worker failed before producing a report',
          },
        },
      },
      error: null,
    }));
    const result = await executeReviewQualityDiagnosticCommand(
      { action: 'read', runId: TEST_RUN_ID },
      buildActor(supabase),
    );

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.status, 200);
    }
  },
);
