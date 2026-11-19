import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js@2';

import type { ActorContext } from '../supabase/functions/_shared/command_runtime/actor_context.ts';
import {
  executeNationalCarbonGraphCacheJobCommand,
  NATIONAL_CARBON_GRAPH_CACHE_JOB_KIND,
  NATIONAL_CARBON_GRAPH_CACHE_SUBJECT_TYPE,
  parseNationalCarbonGraphCacheJobCommand,
} from '../supabase/functions/_shared/commands/national_carbon_graph_cache_jobs.ts';

const TEST_JOB_ID = '66666666-6666-4666-8666-666666666666';
const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const SYSTEM_TEAM_ID = '00000000-0000-0000-0000-000000000000';

class FakeNationalCarbonGraphCacheSupabase {
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  roleQueries: Array<{ table: string }> = [];

  constructor(
    private readonly responses: Array<{ data: unknown; error: unknown }>,
    private readonly systemManager = true,
  ) {}

  from(table: string) {
    this.roleQueries.push({ table });
    const state: Record<string, unknown> = { table };
    return {
      select: (columns: string) => {
        state.columns = columns;
        return {
          eq: (column: string, value: unknown) => {
            state[column] = value;
            return {
              eq: (nextColumn: string, nextValue: unknown) => {
                state[nextColumn] = nextValue;
                return {
                  in: (inColumn: string, values: unknown[]) => {
                    state[inColumn] = values;
                    return {
                      limit: (limit: number) => {
                        state.limit = limit;
                        return {
                          maybeSingle: () =>
                            Promise.resolve({
                              data: this.systemManager ? { user_id: TEST_USER_ID } : null,
                              error: null,
                            }),
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
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

function actor(systemManager = true): ActorContext {
  return {
    userId: TEST_USER_ID,
    accessToken: 'access-token',
    supabase: {
      rpc(fn: string) {
        assertEquals(fn, 'qry_membership_get_mine');
        return Promise.resolve({
          data: systemManager ? [{ team_id: SYSTEM_TEAM_ID, role: 'admin' }] : [],
          error: null,
        });
      },
    } as unknown as SupabaseClient,
  };
}

function readEnv(name: string): string | undefined {
  const values: Record<string, string> = {
    NATIONAL_CARBON_GRAPH_CACHE_ENVIRONMENT: 'dev',
    NATIONAL_CARBON_GRAPH_CACHE_PREFIX: 'national-carbon/process-flow-graph/v1',
    NATIONAL_CARBON_GRAPH_CACHE_BUCKET: 'cache-bucket',
  };
  return values[name];
}

Deno.test('parseNationalCarbonGraphCacheJobCommand accepts enqueue action only', () => {
  const result = parseNationalCarbonGraphCacheJobCommand({ action: 'enqueue' });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, { action: 'enqueue' });
  }
});

Deno.test(
  'executeNationalCarbonGraphCacheJobCommand requires system-manager permissions',
  async () => {
    const supabase = new FakeNationalCarbonGraphCacheSupabase([], false);

    const result = await executeNationalCarbonGraphCacheJobCommand(
      { action: 'enqueue' },
      actor(false),
      supabase as unknown as SupabaseClient,
    );

    assertEquals(result, {
      ok: false,
      code: 'SYSTEM_MANAGER_REQUIRED',
      status: 403,
      message: 'System-manager permissions are required to manage national carbon graph cache jobs',
    });
    assertEquals(supabase.rpcCalls, []);
  },
);

Deno.test(
  'executeNationalCarbonGraphCacheJobCommand enqueues fixed maintenance worker job',
  async () => {
    const supabase = new FakeNationalCarbonGraphCacheSupabase([
      {
        data: {
          ok: true,
          data: {
            id: TEST_JOB_ID,
            jobKind: NATIONAL_CARBON_GRAPH_CACHE_JOB_KIND,
            subjectType: NATIONAL_CARBON_GRAPH_CACHE_SUBJECT_TYPE,
            status: 'queued',
          },
        },
        error: null,
      },
    ]);

    const result = await executeNationalCarbonGraphCacheJobCommand(
      { action: 'enqueue' },
      actor(),
      supabase as unknown as SupabaseClient,
      {
        now: () => new Date('2026-06-12T09:45:37.000Z'),
        readEnv,
      },
    );

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.body, {
        ok: true,
        command: 'national_carbon_graph_cache_jobs_enqueue',
        reused: false,
        data: {
          id: TEST_JOB_ID,
          jobKind: NATIONAL_CARBON_GRAPH_CACHE_JOB_KIND,
          subjectType: NATIONAL_CARBON_GRAPH_CACHE_SUBJECT_TYPE,
          status: 'queued',
        },
      });
    }
    assertEquals(supabase.roleQueries, []);
    assertEquals(supabase.rpcCalls, [
      {
        fn: 'svc_worker_enqueue_job',
        args: {
          p_job_kind: NATIONAL_CARBON_GRAPH_CACHE_JOB_KIND,
          p_payload_json: {
            environment: 'dev',
            execute: true,
            cachePrefix: 'national-carbon/process-flow-graph/v1',
            cacheBucket: 'cache-bucket',
          },
          p_payload_schema_version: 'national_carbon.process_flow_graph_cache_build.request.v1',
          p_subject_type: NATIONAL_CARBON_GRAPH_CACHE_SUBJECT_TYPE,
          p_subject_id: null,
          p_subject_version: 'dev',
          p_requested_by: TEST_USER_ID,
          p_requester_type: 'operator',
          p_team_id: null,
          p_idempotency_key:
            'national_carbon.process_flow_graph_cache_build:dev:execute:11111111-1111-4111-8111-111111111111:2026-06-12T09:45',
          p_request_hash: null,
          p_concurrency_key: 'national_carbon.process_flow_graph_cache_build:dev:execute',
          p_priority: 0,
          p_queue_key: 'dev',
          p_run_after: null,
          p_visibility: 'operator',
          p_max_attempts: 1,
          p_timeout_at: null,
          p_payload_ref: null,
          p_parent_job_id: null,
          p_root_job_id: null,
        },
      },
    ]);
  },
);

Deno.test(
  'executeNationalCarbonGraphCacheJobCommand returns active job on concurrency conflict',
  async () => {
    const supabase = new FakeNationalCarbonGraphCacheSupabase([
      {
        data: {
          ok: false,
          code: 'WORKER_JOB_CONCURRENCY_CONFLICT',
          status: 409,
          message: 'A conflicting worker job is already active',
          details: {
            id: TEST_JOB_ID,
            jobKind: NATIONAL_CARBON_GRAPH_CACHE_JOB_KIND,
            subjectType: NATIONAL_CARBON_GRAPH_CACHE_SUBJECT_TYPE,
            status: 'running',
          },
        },
        error: null,
      },
    ]);

    const result = await executeNationalCarbonGraphCacheJobCommand(
      { action: 'enqueue' },
      actor(),
      supabase as unknown as SupabaseClient,
      {
        now: () => new Date('2026-06-12T09:45:37.000Z'),
        readEnv,
      },
    );

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.body, {
        ok: true,
        command: 'national_carbon_graph_cache_jobs_enqueue',
        reused: true,
        data: {
          id: TEST_JOB_ID,
          jobKind: NATIONAL_CARBON_GRAPH_CACHE_JOB_KIND,
          subjectType: NATIONAL_CARBON_GRAPH_CACHE_SUBJECT_TYPE,
          status: 'running',
        },
      });
    }
  },
);

Deno.test('executeNationalCarbonGraphCacheJobCommand reads only graph cache jobs', async () => {
  const supabase = new FakeNationalCarbonGraphCacheSupabase([
    {
      data: {
        ok: true,
        data: {
          id: TEST_JOB_ID,
          jobKind: 'lca.solve_one',
          subjectType: 'processes',
          status: 'completed',
        },
      },
      error: null,
    },
  ]);

  const result = await executeNationalCarbonGraphCacheJobCommand(
    { action: 'read', jobId: TEST_JOB_ID },
    actor(),
    supabase as unknown as SupabaseClient,
  );

  assertEquals(result, {
    ok: false,
    code: 'NATIONAL_CARBON_GRAPH_CACHE_JOB_NOT_FOUND',
    status: 404,
    message: 'National carbon graph cache job not found',
  });
});

Deno.test(
  'executeNationalCarbonGraphCacheJobCommand lists latest operator graph cache jobs',
  async () => {
    const supabase = new FakeNationalCarbonGraphCacheSupabase([
      {
        data: {
          ok: true,
          data: [
            {
              id: TEST_JOB_ID,
              jobKind: NATIONAL_CARBON_GRAPH_CACHE_JOB_KIND,
              subjectType: NATIONAL_CARBON_GRAPH_CACHE_SUBJECT_TYPE,
              status: 'completed',
            },
          ],
        },
        error: null,
      },
    ]);

    const result = await executeNationalCarbonGraphCacheJobCommand(
      { action: 'read_latest', limit: 1 },
      actor(),
      supabase as unknown as SupabaseClient,
    );

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.body, {
        ok: true,
        command: 'national_carbon_graph_cache_jobs_read_latest',
        data: [
          {
            id: TEST_JOB_ID,
            jobKind: NATIONAL_CARBON_GRAPH_CACHE_JOB_KIND,
            subjectType: NATIONAL_CARBON_GRAPH_CACHE_SUBJECT_TYPE,
            status: 'completed',
          },
        ],
      });
    }
    assertEquals(supabase.rpcCalls, [
      {
        fn: 'svc_worker_list_jobs',
        args: {
          p_requested_by: null,
          p_subject_type: NATIONAL_CARBON_GRAPH_CACHE_SUBJECT_TYPE,
          p_subject_id: null,
          p_statuses: null,
          p_visibility: 'operator',
          p_limit: 1,
          p_include_internal: false,
        },
      },
    ]);
  },
);

assertEquals(SYSTEM_TEAM_ID, '00000000-0000-0000-0000-000000000000');
