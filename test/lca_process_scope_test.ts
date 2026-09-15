import { assertEquals } from 'jsr:@std/assert';

import {
  hasClientSuppliedSnapshotRoots,
  matchesProcessDataScope,
  normalizeSingleProcessDemand,
  numericalStateRejectionReason,
  processScopeLookupKey,
  requestRootFromSingleProcessDemand,
  validateProcessEntriesInDataScope,
} from '../supabase/functions/_shared/lca_process_scope.ts';

Deno.test('processScopeLookupKey normalizes missing versions', () => {
  assertEquals(processScopeLookupKey('process-1', '01.00.000'), 'process-1:01.00.000');
  assertEquals(processScopeLookupKey('process-1'), 'process-1:');
  assertEquals(processScopeLookupKey('process-1', '  '), 'process-1:');
});

Deno.test('matchesProcessDataScope enforces root-process semantics per scope', () => {
  const publishedOwnedByOtherUser = {
    state_code: 100,
    user_id: 'user-2',
    team_id: 'team-2',
    review_id: 'review-2',
  };
  const publishedRangeOwnedByOtherUser = {
    state_code: 150,
    user_id: 'user-2',
    team_id: null,
    review_id: null,
  };
  const privateOwnedByCurrentUser = {
    state_code: 0,
    user_id: 'user-1',
    team_id: null,
    review_id: null,
  };
  const privateOwnedByOtherUser = {
    state_code: 0,
    user_id: 'user-2',
    team_id: null,
    review_id: null,
  };
  const ownerReviewState = {
    state_code: 10,
    user_id: 'user-1',
    team_id: null,
    review_id: null,
  };
  const ownerWithdrawnState = {
    state_code: -1,
    user_id: 'user-1',
    team_id: null,
    review_id: null,
  };
  const ownerDraftSharedWithTeam = {
    state_code: 0,
    user_id: 'user-1',
    team_id: 'team-1',
    review_id: null,
  };
  const ownerDraftLinkedToReview = {
    state_code: 0,
    user_id: 'user-1',
    team_id: null,
    review_id: 'review-1',
  };

  assertEquals(matchesProcessDataScope(publishedOwnedByOtherUser, 'open_data', 'user-1'), true);
  assertEquals(
    matchesProcessDataScope(publishedRangeOwnedByOtherUser, 'open_data', 'user-1'),
    false,
  );
  assertEquals(matchesProcessDataScope(privateOwnedByCurrentUser, 'open_data', 'user-1'), false);

  assertEquals(matchesProcessDataScope(privateOwnedByCurrentUser, 'current_user', 'user-1'), true);
  // The caller's own published state-100 Process stays solvable under `current_user`; it is in the
  // shared snapshot family and is numerically eligible. Only the owner's non-draft states are out.
  assertEquals(
    matchesProcessDataScope(
      { ...publishedOwnedByOtherUser, user_id: 'user-1' },
      'current_user',
      'user-1',
    ),
    true,
  );
  assertEquals(matchesProcessDataScope(publishedOwnedByOtherUser, 'current_user', 'user-1'), false);
  assertEquals(
    matchesProcessDataScope(publishedRangeOwnedByOtherUser, 'current_user', 'user-1'),
    false,
  );

  assertEquals(matchesProcessDataScope(privateOwnedByCurrentUser, 'all_data', 'user-1'), true);
  assertEquals(matchesProcessDataScope(publishedOwnedByOtherUser, 'all_data', 'user-1'), true);
  assertEquals(
    matchesProcessDataScope(publishedRangeOwnedByOtherUser, 'all_data', 'user-1'),
    false,
  );
  assertEquals(matchesProcessDataScope(privateOwnedByOtherUser, 'all_data', 'user-1'), false);
  assertEquals(matchesProcessDataScope(undefined, 'all_data', 'user-1'), false);

  assertEquals(
    matchesProcessDataScope(publishedOwnedByOtherUser, 'public_plus_owner_draft', 'user-1'),
    true,
  );
  assertEquals(
    matchesProcessDataScope(publishedRangeOwnedByOtherUser, 'public_plus_owner_draft', 'user-1'),
    false,
  );
  assertEquals(
    matchesProcessDataScope(privateOwnedByCurrentUser, 'public_plus_owner_draft', 'user-1'),
    true,
  );
  assertEquals(
    matchesProcessDataScope(privateOwnedByOtherUser, 'public_plus_owner_draft', 'user-1'),
    false,
  );
  assertEquals(
    matchesProcessDataScope(ownerReviewState, 'public_plus_owner_draft', 'user-1'),
    false,
  );
  assertEquals(
    matchesProcessDataScope(ownerWithdrawnState, 'public_plus_owner_draft', 'user-1'),
    false,
  );
  // The v2 actor-bound manifest admits every actor-owned state-0 row; `team_id`/`review_id` stay
  // collaboration workflow metadata rather than ownership gates.
  assertEquals(
    matchesProcessDataScope(ownerDraftSharedWithTeam, 'public_plus_owner_draft', 'user-1'),
    true,
  );
  assertEquals(
    matchesProcessDataScope(ownerDraftLinkedToReview, 'public_plus_owner_draft', 'user-1'),
    true,
  );
  assertEquals(matchesProcessDataScope(undefined, 'public_plus_owner_draft', 'user-1'), false);
});

Deno.test('owner identity never admits the published Result state or the reserved segment', () => {
  const ownerResult = {
    state_code: 120,
    user_id: 'user-1',
    team_id: null,
    review_id: null,
  };
  const foreignResult = { ...ownerResult, user_id: 'user-2' };
  const ownerReserved = { ...ownerResult, state_code: 150 };
  const ownerReviewState = { ...ownerResult, state_code: 20 };

  for (const dataScope of [
    'open_data',
    'all_data',
    'current_user',
    'public_plus_owner_draft',
  ] as const) {
    assertEquals(matchesProcessDataScope(ownerResult, dataScope, 'user-1'), false);
    assertEquals(matchesProcessDataScope(foreignResult, dataScope, 'user-1'), false);
    assertEquals(matchesProcessDataScope(ownerReserved, dataScope, 'user-1'), false);
  }

  // Review state 20 is reachable only through its existing dedicated Review Admin quality
  // diagnostic, never through a generic numerical scope or an owner branch.
  for (const dataScope of [
    'open_data',
    'all_data',
    'current_user',
    'public_plus_owner_draft',
  ] as const) {
    assertEquals(matchesProcessDataScope(ownerReviewState, dataScope, 'user-1'), false);
  }
});

Deno.test('numerical state rejection names the published Result state only', () => {
  assertEquals(
    numericalStateRejectionReason(120),
    'published_result_process_is_not_a_numerical_input',
  );
  assertEquals(numericalStateRejectionReason(100), null);
  assertEquals(numericalStateRejectionReason(0), null);
  assertEquals(numericalStateRejectionReason(20), null);
  assertEquals(numericalStateRejectionReason(150), null);
  assertEquals(numericalStateRejectionReason(null), null);
  assertEquals(numericalStateRejectionReason(undefined), null);
});

Deno.test('single-process demand derives one exact root and rejects malformed selectors', () => {
  const exact = normalizeSingleProcessDemand({
    process_id: '11111111-1111-4111-8111-111111111111',
    process_version: '00.00.001',
    amount: 2,
  });
  assertEquals(exact, {
    ok: true,
    demand: {
      selector: 'process_id',
      process_id: '11111111-1111-4111-8111-111111111111',
      process_version: '00.00.001',
      amount: 2,
    },
  });
  if (exact.ok) {
    assertEquals(requestRootFromSingleProcessDemand(exact.demand), {
      process_id: '11111111-1111-4111-8111-111111111111',
      process_version: '00.00.001',
    });
  }

  const indexDemand = normalizeSingleProcessDemand({ process_index: 7 });
  assertEquals(indexDemand, {
    ok: true,
    demand: { selector: 'process_index', process_index: 7, amount: 1 },
  });
  if (indexDemand.ok) {
    assertEquals(requestRootFromSingleProcessDemand(indexDemand.demand), null);
  }

  const versionless = normalizeSingleProcessDemand({
    process_id: '11111111-1111-4111-8111-111111111111',
  });
  assertEquals(versionless.ok, true);
  if (versionless.ok) {
    assertEquals(requestRootFromSingleProcessDemand(versionless.demand), null);
  }

  assertEquals(
    normalizeSingleProcessDemand({
      process_id: '11111111-1111-4111-8111-111111111111',
      process_version: '1',
    }),
    { ok: false, status: 400, body: { error: 'invalid_process_version' } },
  );
  assertEquals(normalizeSingleProcessDemand({ process_id: 'not-a-uuid' }), {
    ok: false,
    status: 400,
    body: { error: 'invalid_process_id' },
  });
  assertEquals(normalizeSingleProcessDemand({ process_index: -1 }), {
    ok: false,
    status: 400,
    body: { error: 'invalid_process_index' },
  });
});

Deno.test('client-supplied snapshot roots are detected instead of trusted', () => {
  assertEquals(hasClientSuppliedSnapshotRoots({ request_roots: [] }), true);
  assertEquals(hasClientSuppliedSnapshotRoots({ requestRoots: [] }), true);
  assertEquals(
    hasClientSuppliedSnapshotRoots({
      demand: {
        process_id: '11111111-1111-4111-8111-111111111111',
        process_version: '00.00.001',
      },
    }),
    false,
  );
});

Deno.test(
  'pre-enqueue process scope validation rejects foreign drafts and non-numerical states',
  async () => {
    const root = {
      process_id: '11111111-1111-4111-8111-111111111111',
      process_version: '00.00.001',
    };
    const createClient = (row: Record<string, unknown> | null) => ({
      schema(schema: string) {
        assertEquals(schema, 'public');
        return this;
      },
      from(table: string) {
        assertEquals(table, 'processes');
        return {
          select(columns: string) {
            assertEquals(columns, 'id,version,state_code,user_id,team_id,review_id');
            return this;
          },
          in(column: string, values: unknown[]) {
            assertEquals(column, 'id');
            assertEquals(values, [root.process_id]);
            return Promise.resolve({ data: row ? [row] : [], error: null });
          },
        };
      },
    });
    const row = (overrides: Record<string, unknown>) => ({
      id: root.process_id,
      version: root.process_version,
      state_code: 0,
      user_id: 'user-1',
      team_id: null,
      review_id: null,
      ...overrides,
    });

    assertEquals(
      await validateProcessEntriesInDataScope(
        [root],
        'public_plus_owner_draft',
        'user-1',
        createClient(row({})) as never,
      ),
      { ok: true },
    );

    // The v2 actor-bound manifest keeps its agreed semantics: every actor-owned state-0 row is
    // admitted irrespective of team/review workflow metadata.
    for (const admitted of [row({ team_id: 'team-1' }), row({ review_id: 'review-1' })]) {
      assertEquals(
        await validateProcessEntriesInDataScope(
          [root],
          'public_plus_owner_draft',
          'user-1',
          createClient(admitted) as never,
        ),
        { ok: true },
      );
    }

    for (const rejected of [
      row({ user_id: 'user-2' }),
      row({ state_code: 10 }),
      row({ state_code: -1 }),
      row({ state_code: 20 }),
      null,
    ]) {
      assertEquals(
        await validateProcessEntriesInDataScope(
          [root],
          'public_plus_owner_draft',
          'user-1',
          createClient(rejected) as never,
        ),
        {
          ok: false,
          status: 403,
          body: {
            error: 'process_not_in_data_scope',
            data_scope: 'public_plus_owner_draft',
            process_id: root.process_id,
          },
        },
      );
    }

    // A published Result owned by the requesting actor is still not a numerical input, and the
    // rejection is locatable instead of a generic scope error.
    assertEquals(
      await validateProcessEntriesInDataScope(
        [root],
        'public_plus_owner_draft',
        'user-1',
        createClient(row({ state_code: 120 })) as never,
      ),
      {
        ok: false,
        status: 403,
        body: {
          error: 'process_not_in_data_scope',
          reason: 'published_result_process_is_not_a_numerical_input',
          data_scope: 'public_plus_owner_draft',
          process_id: root.process_id,
        },
      },
    );
  },
);
