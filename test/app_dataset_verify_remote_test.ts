import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js@2';

import type { DatasetCommandExecutionResult } from '../supabase/functions/_shared/commands/dataset/types.ts';
import {
  executeVerifyRemoteCommand,
  parseVerifyRemoteCommand,
  stableJsonSha256,
} from '../supabase/functions/_shared/commands/dataset/verify_remote.ts';

const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const PROCESS_ID = '22222222-2222-4222-8222-222222222222';
const FLOW_ID = '33333333-3333-4333-8333-333333333333';
const SOURCE_ID = '44444444-4444-4444-8444-444444444444';

type Row = {
  id: string;
  version: string;
  state_code?: number | null;
  user_id?: string | null;
  modified_at?: string | null;
  json_ordered?: unknown;
};

class FakeQuery {
  private filters: Array<{ field: string; value: unknown }> = [];
  private orderField: string | null = null;
  private ascending = true;

  constructor(
    private rows: Row[],
    private error: { message: string; code?: string } | null = null,
  ) {}

  select(_columns: string) {
    return this;
  }

  eq(field: string, value: unknown) {
    this.filters.push({ field, value });
    return this;
  }

  order(field: string, options: { ascending?: boolean } = {}) {
    this.orderField = field;
    this.ascending = options.ascending ?? true;
    return this;
  }

  async range(from: number, to: number) {
    if (this.error) {
      return { data: null, error: this.error };
    }

    let rows = this.rows.filter((row) =>
      this.filters.every(
        (filter) => (row as unknown as Record<string, unknown>)[filter.field] === filter.value,
      ),
    );

    if (this.orderField) {
      rows = rows.toSorted((left, right) => {
        const leftValue = String(
          (left as unknown as Record<string, unknown>)[this.orderField ?? ''] ?? '',
        );
        const rightValue = String(
          (right as unknown as Record<string, unknown>)[this.orderField ?? ''] ?? '',
        );
        return this.ascending
          ? leftValue.localeCompare(rightValue)
          : rightValue.localeCompare(leftValue);
      });
    }

    return { data: rows.slice(from, to + 1), error: null };
  }
}

class FakeSupabase {
  errors = new Map<string, { message: string; code?: string }>();

  constructor(private rowsByTable: Record<string, Row[]>) {}

  schema(schema: string) {
    assertEquals(schema, 'public');
    return this;
  }

  from(table: string) {
    return new FakeQuery(this.rowsByTable[table] ?? [], this.errors.get(table) ?? null);
  }
}

function buildActor(supabase: FakeSupabase) {
  return {
    userId: TEST_USER_ID,
    accessToken: 'access-token',
    supabase: supabase as unknown as SupabaseClient,
  };
}

function commandBody<T>(result: DatasetCommandExecutionResult): T {
  if (!result.ok) {
    throw new Error(`Expected command success, got ${result.code}`);
  }

  return result.body as T;
}

Deno.test('parseVerifyRemoteCommand rejects malformed payloads', () => {
  const result = parseVerifyRemoteCommand({
    references: [{ table: 'processes', id: 'not-a-uuid', version: '1' }],
  });

  assertEquals(result.ok, false);
});

Deno.test(
  'executeVerifyRemoteCommand passes exact rows with expected state and payload hash',
  async () => {
    const payload = { b: 2, a: { z: true, c: [3, 1] } };
    const expectedHash = await stableJsonSha256(payload);
    const supabase = new FakeSupabase({
      processes: [
        {
          id: PROCESS_ID,
          version: '01.01.000',
          state_code: 0,
          user_id: TEST_USER_ID,
          modified_at: '2026-05-23T00:00:00Z',
          json_ordered: payload,
        },
      ],
    });

    const result = await executeVerifyRemoteCommand(
      {
        rootPolicy: 'existing',
        references: [
          {
            table: 'processes',
            id: PROCESS_ID,
            version: '01.01.000',
            role: 'root',
            expectedStateCodes: [0],
            expectedJsonSha256: expectedHash,
            requirePayload: true,
          },
        ],
      },
      buildActor(supabase),
    );

    assertEquals(result.ok, true);
    assertEquals(result.status, 200);
    const body = commandBody<{
      ok: boolean;
      data: { status: string; checks: Array<{ actual_json_sha256: string | null }> };
    }>(result);

    assertEquals(body.ok, true);
    assertEquals(body.data.status, 'passed_remote_verification');
    assertEquals(body.data.checks[0]?.actual_json_sha256, expectedHash);
  },
);

Deno.test(
  'executeVerifyRemoteCommand blocks missing versions and outdated exact versions',
  async () => {
    const supabase = new FakeSupabase({
      flows: [
        { id: FLOW_ID, version: '01.00.000', state_code: 100, json_ordered: {} },
        { id: FLOW_ID, version: '01.01.000', state_code: 100, json_ordered: {} },
      ],
      sources: [{ id: SOURCE_ID, version: '20.20.002', state_code: 100, json_ordered: {} }],
    });

    const result = await executeVerifyRemoteCommand(
      {
        rootPolicy: 'existing',
        references: [
          { table: 'flows', id: FLOW_ID, version: '01.00.000', role: 'reference' },
          { table: 'sources', id: SOURCE_ID, version: '01.00.000', role: 'reference' },
        ],
      },
      buildActor(supabase),
    );

    const body = commandBody<{
      ok: boolean;
      data: { counts: { blockers: number }; checks: Array<{ status: string }> };
    }>(result);

    assertEquals(result.ok, true);
    assertEquals(result.status, 409);
    assertEquals(body.ok, false);
    assertEquals(body.data.counts.blockers, 2);
    assertEquals(
      body.data.checks.map((check) => check.status),
      ['version_outdated', 'missing_version'],
    );
  },
);

Deno.test(
  'executeVerifyRemoteCommand allows new candidate roots but still blocks missing nested references',
  async () => {
    const supabase = new FakeSupabase({
      processes: [{ id: PROCESS_ID, version: '01.00.000', state_code: 0, json_ordered: {} }],
      sources: [],
    });

    const result = await executeVerifyRemoteCommand(
      {
        rootPolicy: 'candidate',
        references: [
          { table: 'processes', id: PROCESS_ID, version: '01.01.000', role: 'root' },
          {
            table: 'sources',
            id: SOURCE_ID,
            version: '20.20.002',
            role: 'reference',
            path: '/source',
          },
        ],
      },
      buildActor(supabase),
    );

    const body = commandBody<{
      ok: boolean;
      data: {
        counts: { blockers: number };
        checks: Array<{ status: string; path: string | null }>;
      };
    }>(result);

    assertEquals(result.status, 409);
    assertEquals(body.ok, false);
    assertEquals(body.data.counts.blockers, 1);
    assertEquals(
      body.data.checks.map((check) => check.status),
      ['candidate_root', 'missing_dataset'],
    );
    assertEquals(body.data.checks[1]?.path, '/source');
  },
);

Deno.test('executeVerifyRemoteCommand blocks state and payload hash mismatches', async () => {
  const supabase = new FakeSupabase({
    processes: [
      {
        id: PROCESS_ID,
        version: '01.01.000',
        state_code: 20,
        json_ordered: { value: 'actual' },
      },
    ],
    flows: [
      { id: FLOW_ID, version: '01.00.000', state_code: 100, json_ordered: { value: 'actual' } },
    ],
  });

  const result = await executeVerifyRemoteCommand(
    {
      rootPolicy: 'existing',
      references: [
        {
          table: 'processes',
          id: PROCESS_ID,
          version: '01.01.000',
          role: 'root',
          expectedStateCodes: [0],
        },
        {
          table: 'flows',
          id: FLOW_ID,
          version: '01.00.000',
          role: 'reference',
          expectedJsonSha256: await stableJsonSha256({ value: 'expected' }),
        },
      ],
    },
    buildActor(supabase),
  );

  const body = commandBody<{ data: { checks: Array<{ status: string }> } }>(result);

  assertEquals(result.status, 409);
  assertEquals(
    body.data.checks.map((check) => check.status),
    ['state_code_mismatch', 'payload_hash_mismatch'],
  );
});

Deno.test('executeVerifyRemoteCommand maps lookup errors to classified blockers', async () => {
  const supabase = new FakeSupabase({ processes: [] });
  supabase.errors.set('processes', { code: '42501', message: 'permission denied' });

  const result = await executeVerifyRemoteCommand(
    {
      rootPolicy: 'existing',
      references: [{ table: 'processes', id: PROCESS_ID, version: '01.01.000', role: 'root' }],
    },
    buildActor(supabase),
  );

  const body = commandBody<{
    data: {
      counts: { blockers: number };
      blockers: Array<{
        code: string;
        message: string;
        index: number;
        table: string;
        id: string;
        version: string | null;
        role: string;
        path: string | null;
      }>;
    };
  }>(result);

  assertEquals(result.status, 409);
  assertEquals(body.data.counts.blockers, 1);
  assertEquals(body.data.blockers[0], {
    code: 'lookup_failed',
    message: 'permission denied',
    index: 0,
    table: 'processes',
    id: PROCESS_ID,
    version: '01.01.000',
    role: 'root',
    path: null,
  });
});
