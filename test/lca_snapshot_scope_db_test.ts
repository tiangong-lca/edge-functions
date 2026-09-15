import { assertEquals } from 'jsr:@std/assert';

import {
  buildSnapshotProcessFilter,
  NUMERICAL_SNAPSHOT_POLICY_VERSION,
} from '../supabase/functions/_shared/lca_snapshot_scope.ts';
import {
  resolveLatestSnapshotForNewCalculation,
  verifySnapshotEvidenceForNewCalculation,
  verifySnapshotMatchesDataScope,
} from '../supabase/functions/_shared/lca_snapshot_scope_db.ts';

type MockState = {
  row: { process_filter: unknown } | null;
  error: { code: string; message: string } | null;
  snapshotIds: unknown[];
};

function createSupabaseMock(state: MockState) {
  return {
    rpc(fn: string, args: Record<string, unknown>) {
      assertEquals(fn, 'svc_lca_snapshot_candidates');
      state.snapshotIds.push(args.p_snapshot_id);
      if (state.error) {
        return Promise.resolve({ data: null, error: state.error });
      }
      return Promise.resolve({
        data: {
          ok: true,
          data: state.row
            ? [
                {
                  // The no-user fallback passes a null snapshot id; keep a stable identity so tests
                  // read the same row shape the candidate RPC would return.
                  snapshotId: args.p_snapshot_id ?? 'snapshot-1',
                  scope: 'full_library',
                  processFilter: state.row.process_filter,
                  createdAt: '2026-08-07T00:00:00Z',
                  isActive: true,
                  artifact: { artifactUrl: 's3://snapshot' },
                },
              ]
            : [],
        },
        error: null,
      });
    },
  };
}

Deno.test(
  'verifySnapshotMatchesDataScope accepts only the exact actor-bound manifest',
  async () => {
    const expected = await buildSnapshotProcessFilter('public_plus_owner_draft', 'user-1');
    const state: MockState = {
      row: { process_filter: expected },
      error: null,
      snapshotIds: [],
    };
    const result = await verifySnapshotMatchesDataScope(createSupabaseMock(state) as never, {
      snapshotId: 'snapshot-1',
      dataScope: 'public_plus_owner_draft',
      userId: 'user-1',
    });

    assertEquals(result, { ok: true, matches: true, process_filter: expected });
    assertEquals(state.snapshotIds, ['snapshot-1']);
  },
);

Deno.test(
  'explicit snapshot verification accepts full and root identities inside the same data scope',
  async () => {
    const rootScoped = await buildSnapshotProcessFilter('public_plus_owner_draft', 'user-1', [
      {
        process_id: '11111111-1111-4111-8111-111111111111',
        process_version: '00.00.001',
      },
    ]);
    const state: MockState = {
      row: { process_filter: rootScoped },
      error: null,
      snapshotIds: [],
    };
    const result = await verifySnapshotMatchesDataScope(createSupabaseMock(state) as never, {
      snapshotId: 'snapshot-root',
      dataScope: 'public_plus_owner_draft',
      userId: 'user-1',
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.matches, true);
      if (result.matches) {
        assertEquals(result.process_filter.selection_mode, 'filtered_library');
        assertEquals(result.process_filter.request_roots, []);
      }
    }
  },
);

Deno.test(
  'verifySnapshotMatchesDataScope rejects old broad and foreign-actor snapshots',
  async () => {
    const broad = await buildSnapshotProcessFilter('current_user', 'user-1');
    const foreignActor = await buildSnapshotProcessFilter('public_plus_owner_draft', 'user-2');
    const supersededCombinedScope = {
      ...(await buildSnapshotProcessFilter('public_plus_owner_draft', 'user-1')),
      scope_manifest_sha256: '348b347f1bc962707aa69010b1e8e2e9f1cdfbc9eff2ca075d4bb625a4309f7d',
    };

    for (const processFilter of [broad, foreignActor, supersededCombinedScope, null]) {
      const state: MockState = {
        row: processFilter ? { process_filter: processFilter } : null,
        error: null,
        snapshotIds: [],
      };
      const result = await verifySnapshotMatchesDataScope(createSupabaseMock(state) as never, {
        snapshotId: 'snapshot-1',
        dataScope: 'public_plus_owner_draft',
        userId: 'user-1',
      });
      assertEquals(result, { ok: true, matches: false });
    }
  },
);

Deno.test('verifySnapshotMatchesDataScope reports lookup failures closed', async () => {
  const state: MockState = {
    row: null,
    error: { code: 'XX000', message: 'boom' },
    snapshotIds: [],
  };
  const result = await verifySnapshotMatchesDataScope(createSupabaseMock(state) as never, {
    snapshotId: 'snapshot-1',
    dataScope: 'public_plus_owner_draft',
    userId: 'user-1',
  });
  assertEquals(result, { ok: false, error: 'snapshot_scope_lookup_failed', status: 500 });
});

// A `ready` row written by the Worker under the current policy: the stored filter carries the
// Worker-authored marker, which is what makes it new-compute evidence.
const readyProcessFilter = (overrides: Record<string, unknown> = {}) => ({
  ...buildStoredFilterShape(),
  numerical_policy_version: NUMERICAL_SNAPSHOT_POLICY_VERSION,
  ...overrides,
});

function buildStoredFilterShape() {
  return {
    all_states: false,
    process_states: [100],
    include_user_id: 'user-1',
    selection_mode: 'filtered_library',
    request_roots: [],
    scope_hash: 'a'.repeat(64),
  };
}

Deno.test('stored ready snapshots need the current Worker-authored marker', async () => {
  const accepted: MockState = {
    row: { process_filter: readyProcessFilter() },
    error: null,
    snapshotIds: [],
  };
  const result = await verifySnapshotEvidenceForNewCalculation(
    createSupabaseMock(accepted) as never,
    {
      snapshotId: 'snapshot-1',
    },
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.matches, true);
    if (result.matches) {
      assertEquals(result.candidate.snapshotId, 'snapshot-1');
    }
  }

  // Regression: an older owner-all-states row also stored `process_states: [100]`. Without the
  // marker it must fail closed rather than be accepted from the state list.
  const statesOnlyFilter = buildStoredFilterShape();
  for (const [processFilter, error] of [
    [statesOnlyFilter, 'snapshot_numerical_policy_version_missing'],
    [
      { ...statesOnlyFilter, numerical_policy_version: 'published-state-code-100-199:v1' },
      'snapshot_numerical_policy_version_not_current',
    ],
    // A draft enqueue-time row stores `coalesce(p_process_filter,'{}')`.
    [{}, 'snapshot_numerical_policy_version_missing'],
  ] as const) {
    const rejected: MockState = {
      row: { process_filter: processFilter },
      error: null,
      snapshotIds: [],
    };
    assertEquals(
      await verifySnapshotEvidenceForNewCalculation(createSupabaseMock(rejected) as never, {
        snapshotId: 'snapshot-1',
      }),
      { ok: false, error, status: 409 },
    );
  }
});

Deno.test(
  'stored snapshot evidence reports absent rows and lookup failures separately',
  async () => {
    const missing: MockState = { row: null, error: null, snapshotIds: [] };
    assertEquals(
      await verifySnapshotEvidenceForNewCalculation(createSupabaseMock(missing) as never, {
        snapshotId: 'snapshot-1',
      }),
      { ok: true, matches: false },
    );

    const failed: MockState = {
      row: null,
      error: { code: 'XX000', message: 'boom' },
      snapshotIds: [],
    };
    assertEquals(
      await verifySnapshotEvidenceForNewCalculation(createSupabaseMock(failed) as never, {
        snapshotId: 'snapshot-1',
      }),
      { ok: false, error: 'snapshot_artifact_lookup_failed', status: 500 },
    );
  },
);

Deno.test('the no-user latest-snapshot fallback applies the same evidence gate', async () => {
  const latest = (row: { process_filter: unknown } | null) =>
    resolveLatestSnapshotForNewCalculation(
      createSupabaseMock({ row, error: null, snapshotIds: [] }) as never,
      { scope: 'full_library' },
    );

  // Current marker: the fallback may return the row.
  const current = await latest({ process_filter: readyProcessFilter() });
  assertEquals(current.ok, true);
  if (current.ok) {
    assertEquals(current.candidate.snapshotId, 'snapshot-1');
    assertEquals(current.candidate.artifact.artifactUrl, 's3://snapshot');
  }

  // Missing marker (an older `process_states: [100]` owner-all-states row), retired marker, a draft
  // enqueue-time row, and an artifact-less row must all fail closed before a caller can read the
  // snapshot id and reach a cached result or an enqueue.
  for (const [processFilter, error] of [
    [buildStoredFilterShape(), 'snapshot_numerical_policy_version_missing'],
    [
      { ...buildStoredFilterShape(), numerical_policy_version: 'published-state-code-100-199:v1' },
      'snapshot_numerical_policy_version_not_current',
    ],
    [{}, 'snapshot_numerical_policy_version_missing'],
  ] as const) {
    assertEquals(await latest({ process_filter: processFilter }), {
      ok: false,
      error,
      status: 409,
    });
  }

  // An empty candidate list keeps the pre-existing not-ready contract.
  assertEquals(await latest(null), { ok: false, error: 'no_ready_snapshot', status: 404 });

  // A lookup failure stays a 500 rather than being reported as absent evidence.
  assertEquals(
    await resolveLatestSnapshotForNewCalculation(
      createSupabaseMock({
        row: null,
        error: { code: 'XX000', message: 'boom' },
        snapshotIds: [],
      }) as never,
      { scope: 'full_library' },
    ),
    { ok: false, error: 'snapshot_lookup_failed', status: 500 },
  );
});

Deno.test('latest-snapshot fallback rejects a candidate without a ready artifact', async () => {
  const state = {
    row: { process_filter: readyProcessFilter() },
    error: null,
    snapshotIds: [] as unknown[],
  };
  const client = {
    rpc(fn: string) {
      assertEquals(fn, 'svc_lca_snapshot_candidates');
      return Promise.resolve({
        data: {
          ok: true,
          data: [
            {
              snapshotId: 'snapshot-1',
              scope: 'full_library',
              processFilter: state.row.process_filter,
              createdAt: '2026-08-07T00:00:00Z',
              isActive: true,
              artifact: { artifactUrl: '' },
            },
          ],
        },
        error: null,
      });
    },
  };
  assertEquals(
    await resolveLatestSnapshotForNewCalculation(client as never, { scope: 'full_library' }),
    { ok: false, error: 'snapshot_not_ready', status: 404 },
  );
});
