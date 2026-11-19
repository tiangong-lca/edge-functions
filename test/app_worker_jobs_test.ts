import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js@2';

import type { ActorContext } from '../supabase/functions/_shared/command_runtime/actor_context.ts';
import {
  executeWorkerJobCommand,
  mergeDataProductWorkerJobMetadata,
  parseWorkerJobCommand,
} from '../supabase/functions/_shared/commands/worker_jobs.ts';

const TEST_JOB_ID = '66666666-6666-4666-8666-666666666666';
const TEST_PACKAGE_ID = '77777777-7777-4777-8777-777777777777';
const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const TEST_DATASET_ID = '22222222-2222-4222-8222-222222222222';

class FakeWorkerJobSupabase {
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  roleQueries: Array<{ table: string }> = [];

  constructor(
    private readonly responses: Array<{ data: unknown; error: unknown }>,
    private readonly dataProductManager = true,
  ) {}

  from(table: string) {
    this.roleQueries.push({ table });
    return {
      select: () => ({
        eq: () => ({
          eq: () => ({
            in: () => ({
              limit: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: this.dataProductManager ? { user_id: TEST_USER_ID } : null,
                    error: null,
                  }),
              }),
            }),
          }),
        }),
      }),
    };
  }

  rpc(fn: string, args: Record<string, unknown>) {
    this.rpcCalls.push({ fn, args: structuredClone(args) });
    const response = this.responses.shift();
    if (!response) {
      throw new Error(`Unexpected RPC call: ${fn}`);
    }
    return Promise.resolve(response);
  }
}

function actor(dataProductManager = true): ActorContext {
  return {
    userId: TEST_USER_ID,
    accessToken: 'access-token',
    supabase: {
      rpc(fn: string) {
        assertEquals(fn, 'qry_membership_get_mine');
        return Promise.resolve({
          data: [
            {
              team_id: '00000000-0000-0000-0000-000000000000',
              role: dataProductManager ? 'data_product_manager' : 'member',
            },
          ],
          error: null,
        });
      },
    } as unknown as SupabaseClient,
  };
}

Deno.test('parseWorkerJobCommand defaults list action', () => {
  const result = parseWorkerJobCommand({
    subjectType: 'processes',
    subjectId: TEST_DATASET_ID,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.action, 'list');
  }
});

Deno.test('mergeDataProductWorkerJobMetadata exposes safe result-set fields only', () => {
  const result = mergeDataProductWorkerJobMetadata(
    [
      {
        id: TEST_JOB_ID,
        jobKind: 'lcia_result.package_build',
        subjectType: 'lcia_result_build',
        status: 'completed',
        result: {
          package: {
            packageName: 'lcia-result-technical-name',
          },
        },
      },
      {
        id: TEST_DATASET_ID,
        jobKind: 'lca.solve_one',
        subjectType: 'processes',
        status: 'running',
      },
    ],
    [
      {
        id: TEST_JOB_ID,
        payload_json: {
          name: 'June public result set',
          input_manifest: { processes: [{ id: 'process-a' }] },
        },
      },
    ],
    [
      {
        build_worker_job_id: TEST_JOB_ID,
        id: TEST_PACKAGE_ID,
        package_version: '2026-06-public',
        status: 'preview_ready',
        eligible_input_count: 2037,
        included_input_count: 2037,
      },
    ],
  );

  assertEquals(result, [
    {
      id: TEST_JOB_ID,
      jobKind: 'lcia_result.package_build',
      subjectType: 'lcia_result_build',
      status: 'completed',
      packageName: 'June public result set',
      resultSetName: 'June public result set',
      result: {
        package: {
          packageId: TEST_PACKAGE_ID,
          packageName: 'June public result set',
          packageVersion: '2026-06-public',
          status: 'preview_ready',
          eligibleInputCount: 2037,
          includedInputCount: 2037,
        },
      },
    },
    {
      id: TEST_DATASET_ID,
      jobKind: 'lca.solve_one',
      subjectType: 'processes',
      status: 'running',
    },
  ]);
});

Deno.test('executeWorkerJobCommand lists only current user worker jobs', async () => {
  const supabase = new FakeWorkerJobSupabase([
    {
      data: {
        ok: true,
        data: [
          {
            id: TEST_JOB_ID,
            status: 'running',
            requestedBy: TEST_USER_ID,
          },
        ],
      },
      error: null,
    },
  ]);

  const result = await executeWorkerJobCommand(
    {
      action: 'list',
      subjectType: 'processes',
      subjectId: TEST_DATASET_ID,
      statuses: ['queued', 'running'],
      limit: 25,
    },
    actor(),
    supabase as unknown as SupabaseClient,
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.body, {
      ok: true,
      command: 'worker_jobs_list',
      data: [
        {
          id: TEST_JOB_ID,
          status: 'running',
          requestedBy: TEST_USER_ID,
        },
      ],
    });
  }
  assertEquals(supabase.rpcCalls, [
    {
      fn: 'svc_worker_list_jobs',
      args: {
        p_requested_by: TEST_USER_ID,
        p_subject_type: 'processes',
        p_subject_id: TEST_DATASET_ID,
        p_statuses: ['queued', 'running'],
        p_visibility: 'user',
        p_limit: 25,
        p_include_internal: false,
      },
    },
  ]);
});

Deno.test(
  'executeWorkerJobCommand lets data product managers list operator jobs they requested',
  async () => {
    const supabase = new FakeWorkerJobSupabase([
      {
        data: {
          ok: true,
          data: [
            {
              id: TEST_JOB_ID,
              status: 'completed',
              requestedBy: TEST_USER_ID,
            },
          ],
        },
        error: null,
      },
    ]);

    const result = await executeWorkerJobCommand(
      {
        action: 'list',
        subjectType: 'lcia_result_build',
        visibility: 'operator',
        limit: 50,
      },
      actor(),
      supabase as unknown as SupabaseClient,
    );

    assertEquals(result.ok, true);
    assertEquals(supabase.roleQueries, []);
    assertEquals(supabase.rpcCalls, [
      {
        fn: 'svc_worker_list_jobs',
        args: {
          p_requested_by: TEST_USER_ID,
          p_subject_type: 'lcia_result_build',
          p_subject_id: null,
          p_statuses: null,
          p_visibility: 'operator',
          p_limit: 50,
          p_include_internal: false,
        },
      },
    ]);
  },
);

Deno.test(
  'executeWorkerJobCommand rejects operator job lists for non data product managers',
  async () => {
    const supabase = new FakeWorkerJobSupabase([], false);

    const result = await executeWorkerJobCommand(
      {
        action: 'list',
        subjectType: 'lcia_result_build',
        visibility: 'operator',
      },
      actor(false),
      supabase as unknown as SupabaseClient,
    );

    assertEquals(result, {
      ok: false,
      code: 'DATA_PRODUCT_MANAGER_REQUIRED',
      status: 403,
      message: 'Data product manager permissions are required to list operator worker jobs',
    });
    assertEquals(supabase.rpcCalls, []);
  },
);

Deno.test('executeWorkerJobCommand rejects reading another user job', async () => {
  const supabase = new FakeWorkerJobSupabase([
    {
      data: {
        ok: true,
        data: {
          id: TEST_JOB_ID,
          status: 'running',
          requestedBy: '33333333-3333-4333-8333-333333333333',
        },
      },
      error: null,
    },
  ]);

  const result = await executeWorkerJobCommand(
    {
      action: 'read',
      jobId: TEST_JOB_ID,
    },
    actor(),
    supabase as unknown as SupabaseClient,
  );

  assertEquals(result, {
    ok: false,
    code: 'WORKER_JOB_NOT_FOUND',
    status: 404,
    message: 'Worker job not found',
  });
});

Deno.test('executeWorkerJobCommand cancels owned jobs through service RPC', async () => {
  const supabase = new FakeWorkerJobSupabase([
    {
      data: {
        ok: true,
        data: {
          id: TEST_JOB_ID,
          status: 'running',
          requestedBy: TEST_USER_ID,
        },
      },
      error: null,
    },
    {
      data: {
        ok: true,
        data: {
          id: TEST_JOB_ID,
          status: 'cancelled',
          requestedBy: TEST_USER_ID,
        },
      },
      error: null,
    },
  ]);

  const result = await executeWorkerJobCommand(
    {
      action: 'cancel',
      jobId: TEST_JOB_ID,
      reason: 'user_cancelled',
    },
    actor(),
    supabase as unknown as SupabaseClient,
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.body, {
      ok: true,
      command: 'worker_jobs_cancel',
      data: {
        id: TEST_JOB_ID,
        status: 'cancelled',
        requestedBy: TEST_USER_ID,
      },
    });
  }
  assertEquals(
    supabase.rpcCalls.map((call) => call.fn),
    ['svc_worker_read_job', 'svc_worker_cancel_job'],
  );
  assertEquals(supabase.rpcCalls[1].args, {
    p_job_id: TEST_JOB_ID,
    p_cancelled_by: TEST_USER_ID,
    p_reason: 'user_cancelled',
  });
});
