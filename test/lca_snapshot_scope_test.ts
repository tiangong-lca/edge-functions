import { assertEquals, assertMatch, assertNotEquals } from 'jsr:@std/assert';

import {
  DEFAULT_PUBLISHED_PROCESS_STATES,
  LCA_METHOD_FACTOR_SOURCE_CONTRACT_SCHEMA_VERSION,
  LCA_SCOPE_MANIFEST_SCHEMA_VERSION,
  LCA_STATIC_CACHE_BUNDLE_MANIFEST_PATH,
  LCA_STATIC_CACHE_BUNDLE_MANIFEST_SHA256,
  LCA_STATIC_CACHE_METHOD_COUNT,
  LCIA_FACTOR_COVERAGE_CONTRACT_SCHEMA_VERSION,
  LCIA_UNCHARACTERIZED_ARTIFACT_FORMAT,
  NUMERICAL_SNAPSHOT_POLICY_VERSION,
  PUBLIC_NUMERICAL_PROCESS_STATES,
  PUBLIC_PLUS_OWNER_DRAFT_PREDICATE_VERSION,
  PUBLISHED_RESULT_PROCESS_STATE,
  REQUEST_ROOTS_CLOSURE_SELECTION_MODE,
  buildSnapshotNumericalPolicyFields,
  buildLcaCalculationEvidenceBinding,
  buildPublicPlusOwnerDraftScopeBinding,
  buildSnapshotBuildPayloadFields,
  buildSnapshotContainsFilter,
  buildSnapshotProcessFilter,
  buildSnapshotVisibilityOrExpression,
  matchesSnapshotDataScopeFilter,
  matchesSnapshotProcessFilter,
  normalizeSnapshotRequestRoots,
  parseLcaDataScope,
  parseSnapshotProcessFilter,
  parseStoredNumericalPolicyMarker,
  rejectNonCurrentSnapshotEvidence,
  rejectNonNumericalSnapshotProcessFilter,
  evaluateSnapshotEvidenceForNewCalculation,
  shouldAutoBuildSnapshot,
  validateCalculationEvidenceForDataScope,
  validateLcaCalculationEvidence,
} from '../supabase/functions/_shared/lca_snapshot_scope.ts';
import { buildCalculationEvidenceV2 } from './lca_calculation_evidence_fixture.ts';

Deno.test(
  'parseLcaDataScope accepts the named private-incubation scope and keeps safe default',
  () => {
    assertEquals(parseLcaDataScope(undefined), 'current_user');
    assertEquals(parseLcaDataScope(''), 'current_user');
    assertEquals(parseLcaDataScope('open_data'), 'open_data');
    assertEquals(parseLcaDataScope('all_data'), 'all_data');
    assertEquals(parseLcaDataScope('public_plus_owner_draft'), 'public_plus_owner_draft');
    assertEquals(parseLcaDataScope('unexpected_scope'), 'current_user');
  },
);

Deno.test('buildSnapshotProcessFilter preserves existing shared snapshot family', async () => {
  // The shared family keeps its identity/activation semantics but its published Process universe
  // is now exactly state 100, not the reserved 100..199 segment.
  const expectedStates = PUBLIC_NUMERICAL_PROCESS_STATES;
  assertEquals(await buildSnapshotProcessFilter('current_user', 'user-1'), {
    all_states: false,
    process_states: [...expectedStates],
    include_user_id: 'user-1',
    selection_mode: 'filtered_library',
    request_roots: [],
  });
  assertEquals(await buildSnapshotProcessFilter('open_data', 'user-1'), {
    all_states: false,
    process_states: [...expectedStates],
    include_user_id: 'user-1',
    selection_mode: 'filtered_library',
    request_roots: [],
  });
  assertEquals(await buildSnapshotProcessFilter('all_data', 'user-1'), {
    all_states: false,
    process_states: [...expectedStates],
    include_user_id: 'user-1',
    selection_mode: 'filtered_library',
    request_roots: [],
  });
});

Deno.test(
  'public_plus_owner_draft freezes exact actor predicate and deterministic hash',
  async () => {
    const first = await buildSnapshotProcessFilter('public_plus_owner_draft', 'user-1');
    const second = await buildSnapshotProcessFilter('public_plus_owner_draft', 'user-1');
    const otherActor = await buildSnapshotProcessFilter('public_plus_owner_draft', 'user-2');

    assertEquals(first, second);
    assertEquals(first.all_states, false);
    assertEquals(first.process_states, [100]);
    assertEquals(first.include_user_id, 'user-1');
    assertEquals(first.include_user_state_codes, [0]);
    assertEquals(first.include_user_unassigned_only, undefined);
    assertEquals(first.include_user_review_free_only, undefined);
    assertEquals(first.selection_mode, 'filtered_library');
    assertEquals(first.request_roots, []);
    assertEquals(first.scope_manifest?.schema_version, LCA_SCOPE_MANIFEST_SCHEMA_VERSION);
    assertEquals(first.scope_manifest?.scope, 'public_plus_owner_draft');
    assertEquals(
      first.scope_manifest?.predicate_version,
      PUBLIC_PLUS_OWNER_DRAFT_PREDICATE_VERSION,
    );
    assertEquals(first.scope_manifest?.actor, {
      kind: 'authenticated_user',
      user_id: 'user-1',
    });
    assertEquals(first.scope_manifest?.applies_to, ['processes', 'flows']);
    assertEquals('owner_draft_collaboration_guards' in first.scope_manifest!, false);
    assertEquals(first.scope_manifest?.predicate, {
      operator: 'or',
      clauses: [
        { state_code: { eq: 100 } },
        {
          operator: 'and',
          clauses: [{ user_id: { eq: 'user-1' } }, { state_code: { eq: 0 } }],
        },
      ],
    });
    assertMatch(first.scope_manifest_sha256 ?? '', /^[0-9a-f]{64}$/);
    assertNotEquals(first.scope_manifest_sha256, otherActor.scope_manifest_sha256);
  },
);

Deno.test('scope binding hashes canonical manifest content', async () => {
  const first = await buildPublicPlusOwnerDraftScopeBinding(' user-1 ');
  const second = await buildPublicPlusOwnerDraftScopeBinding('user-1');
  assertEquals(first, second);
  assertEquals(first.manifest.actor.user_id, 'user-1');
});

Deno.test('BAFU actor scope hash rejects the superseded combined LCIA scope hash', async () => {
  const binding = await buildPublicPlusOwnerDraftScopeBinding(
    'dab05739-1a42-421b-8170-3b77146d1d64',
  );
  assertEquals(
    binding.manifest_sha256,
    '40bf56e121cfd1dd82cf55cf429609fc5d481d08a20364fe7625de0698e789a3',
  );
  assertNotEquals(
    binding.manifest_sha256,
    '348b347f1bc962707aa69010b1e8e2e9f1cdfbc9eff2ca075d4bb625a4309f7d',
  );
});

Deno.test('DEFAULT_PUBLISHED_PROCESS_STATES covers 100 through 199', () => {
  assertEquals(DEFAULT_PUBLISHED_PROCESS_STATES.length, 100);
  assertEquals(DEFAULT_PUBLISHED_PROCESS_STATES[0], 100);
  assertEquals(DEFAULT_PUBLISHED_PROCESS_STATES.at(-1), 199);
});

Deno.test(
  'published numerical Process eligibility is exactly 100, never the reserved range',
  () => {
    assertEquals(PUBLIC_NUMERICAL_PROCESS_STATES, [100]);
    assertEquals(PUBLIC_NUMERICAL_PROCESS_STATES.includes(PUBLISHED_RESULT_PROCESS_STATE), false);
    assertEquals(PUBLIC_NUMERICAL_PROCESS_STATES.includes(101), false);
    assertEquals(PUBLIC_NUMERICAL_PROCESS_STATES.includes(199), false);
  },
);

Deno.test('every scope list or range producer carries exact 100 and never 120', async () => {
  for (const dataScope of ['current_user', 'open_data', 'all_data'] as const) {
    const filter = await buildSnapshotProcessFilter(dataScope, 'user-1');
    assertEquals(filter.process_states, [100]);
    assertEquals(filter.process_states?.includes(PUBLISHED_RESULT_PROCESS_STATE), false);
    assertEquals(filter.all_states, false);
    assertEquals(buildSnapshotBuildPayloadFields(filter).process_states, '100');
    assertEquals(buildSnapshotContainsFilter(filter).process_states, [100]);
    assertEquals(rejectNonNumericalSnapshotProcessFilter(filter), null);
  }

  const versioned = await buildSnapshotProcessFilter('public_plus_owner_draft', 'user-1');
  assertEquals(versioned.process_states, [100]);
  assertEquals(rejectNonNumericalSnapshotProcessFilter(versioned), null);
  // The proposed filter stays payload-shaped and carries no marker; the containment view used for
  // snapshot lookup adds it. The distinction is deliberate: a proposed marker proves nothing about
  // a stored row.
  assertEquals('numerical_policy_version' in versioned, false);
  assertEquals(buildSnapshotContainsFilter(versioned), {
    ...versioned,
    numerical_policy_version: NUMERICAL_SNAPSHOT_POLICY_VERSION,
  });
});

Deno.test('Edge binds the Worker-owned numerical policy marker verbatim', () => {
  // The literal is owned by Worker `solver_worker::NUMERICAL_SNAPSHOT_POLICY_VERSION`. Edge uses
  // it only as request/cache identity; it is never sent as a caller-supplied payload field, and
  // Edge does not restate Database or Worker eligibility-predicate versions it does not consume.
  assertEquals(
    NUMERICAL_SNAPSHOT_POLICY_VERSION,
    'public-numerical-state-100-excluding-result-120:v1',
  );
  assertEquals(buildSnapshotNumericalPolicyFields(), {
    numerical_policy_version: 'public-numerical-state-100-excluding-result-120:v1',
  });
});

Deno.test('snapshot lookup asks the database for the current policy marker', async () => {
  const filter = await buildSnapshotProcessFilter('current_user', 'user-1');
  const contains = buildSnapshotContainsFilter(filter);
  // The containment filter must include the marker so a pre-policy row is not even a candidate.
  assertEquals(contains.numerical_policy_version, NUMERICAL_SNAPSHOT_POLICY_VERSION);
  assertEquals(contains.process_states, [100]);
  assertEquals(contains.all_states, false);
});

Deno.test('stored snapshot evidence requires a current marker, never a 100-shaped filter', () => {
  const currentMarker = NUMERICAL_SNAPSHOT_POLICY_VERSION;
  const statesOnly = {
    all_states: false,
    process_states: [100],
    include_user_id: 'user-1',
    selection_mode: 'filtered_library',
    request_roots: [],
  };

  // A `100`-shaped filter with no marker is an older owner-all-states row: readable, not usable.
  assertEquals(parseStoredNumericalPolicyMarker(statesOnly), null);
  assertEquals(
    rejectNonCurrentSnapshotEvidence(statesOnly),
    'snapshot_numerical_policy_version_missing',
  );
  assertEquals(
    rejectNonCurrentSnapshotEvidence({ ...statesOnly, numerical_policy_version: '' }),
    'snapshot_numerical_policy_version_missing',
  );
  assertEquals(
    rejectNonCurrentSnapshotEvidence({ ...statesOnly, numerical_policy_version: 100 }),
    'snapshot_numerical_policy_version_missing',
  );
  assertEquals(
    rejectNonCurrentSnapshotEvidence(undefined),
    'snapshot_numerical_policy_version_missing',
  );
  assertEquals(rejectNonCurrentSnapshotEvidence(null), 'snapshot_numerical_policy_version_missing');

  // A retired marker is readable history, never new-compute evidence.
  for (const retired of [
    'published-state-code-100-199:v1',
    'public-numerical-state-100-199:v1',
    'public-numerical-state-100-excluding-result-120:v0',
  ]) {
    assertEquals(
      rejectNonCurrentSnapshotEvidence({ ...statesOnly, numerical_policy_version: retired }),
      'snapshot_numerical_policy_version_not_current',
    );
  }

  // The current marker is accepted, and filter-shape failures still surface through it.
  assertEquals(
    rejectNonCurrentSnapshotEvidence({ ...statesOnly, numerical_policy_version: currentMarker }),
    null,
  );
  assertEquals(
    rejectNonCurrentSnapshotEvidence({
      ...statesOnly,
      process_states: [100, 120],
      numerical_policy_version: currentMarker,
    }),
    'snapshot_published_result_process_state_not_numerical',
  );
  assertEquals(
    rejectNonCurrentSnapshotEvidence({
      ...statesOnly,
      process_states: DEFAULT_PUBLISHED_PROCESS_STATES,
      numerical_policy_version: currentMarker,
    }),
    'snapshot_retired_published_state_range_not_numerical',
  );
  assertEquals(
    rejectNonCurrentSnapshotEvidence({ all_states: true, numerical_policy_version: currentMarker }),
    'snapshot_all_states_not_numerical',
  );
});

Deno.test('candidate evidence decision fails closed before cache or enqueue', () => {
  const candidate = (processFilter: unknown, artifactUrl = 's3://snapshot/index.json') => ({
    processFilter,
    artifact: { artifactUrl },
  });
  const current = {
    all_states: false,
    process_states: [100],
    include_user_id: 'user-1',
    numerical_policy_version: NUMERICAL_SNAPSHOT_POLICY_VERSION,
  };

  assertEquals(evaluateSnapshotEvidenceForNewCalculation(candidate(current)), { ok: true });
  // No marker, retired marker, and no ready artifact all fail closed.
  assertEquals(
    evaluateSnapshotEvidenceForNewCalculation(
      candidate({ ...current, numerical_policy_version: undefined }),
    ),
    {
      ok: false,
      status: 409,
      error: 'snapshot_numerical_policy_version_missing',
    },
  );
  assertEquals(
    evaluateSnapshotEvidenceForNewCalculation(
      candidate({ ...current, numerical_policy_version: 'published-state-code-100-199:v1' }),
    ),
    {
      ok: false,
      status: 409,
      error: 'snapshot_numerical_policy_version_not_current',
    },
  );
  assertEquals(evaluateSnapshotEvidenceForNewCalculation(candidate(current, '')), {
    ok: false,
    status: 404,
    error: 'snapshot_not_ready',
  });
  assertEquals(evaluateSnapshotEvidenceForNewCalculation(undefined), {
    ok: false,
    status: 404,
    error: 'snapshot_not_ready',
  });
  // A draft enqueue-time row (`coalesce(p_process_filter,'{}')`) can never authorize a ready build.
  assertEquals(evaluateSnapshotEvidenceForNewCalculation(candidate({})), {
    ok: false,
    status: 409,
    error: 'snapshot_numerical_policy_version_missing',
  });
});

Deno.test(
  'snapshot filters fail closed on all-states, 120, retired range, and stray states',
  () => {
    // Exact shape the Worker writes for the non-versioned scopes (`snapshot_builder`
    // `upsert_snapshot_artifact_row`): plain numeric list plus the owner id.
    const workerNonVersioned = {
      all_states: false,
      process_states: [100],
      include_user_id: 'user-1',
      selection_mode: 'filtered_library',
      request_roots: [],
      scope_hash: 'a'.repeat(64),
      resolved_scope: { public_process_count: 1, private_process_count: 0, process_count: 1 },
      artifact_lifecycle: { expires_at_utc: null },
    };
    assertEquals(rejectNonNumericalSnapshotProcessFilter(workerNonVersioned), null);
    // The versioned scope additionally carries `include_user_state_codes`.
    assertEquals(
      rejectNonNumericalSnapshotProcessFilter({
        ...workerNonVersioned,
        include_user_state_codes: [0],
      }),
      null,
    );
    const base = workerNonVersioned;
    assertEquals(
      rejectNonNumericalSnapshotProcessFilter({ ...base, all_states: true }),
      'snapshot_all_states_not_numerical',
    );
    assertEquals(
      rejectNonNumericalSnapshotProcessFilter({ ...base, process_states: [100, 120] }),
      'snapshot_published_result_process_state_not_numerical',
    );
    assertEquals(
      rejectNonNumericalSnapshotProcessFilter({ ...base, process_states: [120] }),
      'snapshot_published_result_process_state_not_numerical',
    );
    assertEquals(
      rejectNonNumericalSnapshotProcessFilter({
        ...base,
        process_states: DEFAULT_PUBLISHED_PROCESS_STATES,
      }),
      'snapshot_retired_published_state_range_not_numerical',
    );
    assertEquals(
      rejectNonNumericalSnapshotProcessFilter({ ...base, process_states: [100, 150] }),
      'snapshot_process_state_not_numerical',
    );
    assertEquals(
      rejectNonNumericalSnapshotProcessFilter({
        ...base,
        include_user_state_codes: [20],
      }),
      'snapshot_review_diagnostic_process_state_not_numerical',
    );
    assertEquals(
      rejectNonNumericalSnapshotProcessFilter({
        all_states: false,
        process_states: [100],
        selection_mode: 'filtered_library',
        request_roots: [],
        include_user_state_codes: [0],
      }),
      'snapshot_process_state_not_numerical',
    );
    assertEquals(
      rejectNonNumericalSnapshotProcessFilter({
        ...base,
        include_user_state_codes: [0],
      }),
      null,
    );
  },
);

Deno.test(
  'matchesSnapshotProcessFilter rejects scope, actor, state, hash, or manifest drift',
  async () => {
    const expected = await buildSnapshotProcessFilter('public_plus_owner_draft', 'user-1');
    assertEquals(matchesSnapshotProcessFilter(expected, expected), true);
    assertEquals(
      matchesSnapshotProcessFilter({ ...expected, include_user_state_codes: [0, 10] }, expected),
      false,
    );
    assertEquals(
      matchesSnapshotProcessFilter({ ...expected, include_user_unassigned_only: true }, expected),
      false,
    );
    assertEquals(
      matchesSnapshotProcessFilter(
        { ...expected, scope_manifest_sha256: '0'.repeat(64) },
        expected,
      ),
      false,
    );
    assertEquals(
      matchesSnapshotProcessFilter(
        {
          ...expected,
          scope_manifest: {
            ...expected.scope_manifest!,
            actor: { kind: 'authenticated_user', user_id: 'user-2' },
          },
        },
        expected,
      ),
      false,
    );

    const legacy = await buildSnapshotProcessFilter('current_user', 'user-1');
    assertEquals(matchesSnapshotProcessFilter(legacy, legacy), true);
    assertEquals(matchesSnapshotProcessFilter(legacy, expected), false);
  },
);

Deno.test(
  'snapshot identity strictly separates full library and canonical request roots',
  async () => {
    const rootA = {
      process_id: '11111111-1111-4111-8111-111111111111',
      process_version: '00.00.001',
    };
    const rootB = {
      process_id: '22222222-2222-4222-8222-222222222222',
      process_version: '01.00.000',
    };
    const full = await buildSnapshotProcessFilter('public_plus_owner_draft', 'user-1');
    const rootedA = await buildSnapshotProcessFilter('public_plus_owner_draft', 'user-1', [rootA]);
    const rootedB = await buildSnapshotProcessFilter('public_plus_owner_draft', 'user-1', [rootB]);

    assertEquals(rootedA.selection_mode, REQUEST_ROOTS_CLOSURE_SELECTION_MODE);
    assertEquals(rootedA.request_roots, [rootA]);
    assertEquals(matchesSnapshotProcessFilter(rootedA, full), false);
    assertEquals(matchesSnapshotProcessFilter(full, rootedA), false);
    assertEquals(matchesSnapshotProcessFilter(rootedA, rootedB), false);
    assertEquals(matchesSnapshotDataScopeFilter(rootedA, full), true);

    const canonical = normalizeSnapshotRequestRoots([
      rootB,
      { ...rootA, process_id: rootA.process_id.toUpperCase() },
      rootA,
    ]);
    assertEquals(canonical, [rootA, rootB]);
    const rootedCanonical = await buildSnapshotProcessFilter('public_plus_owner_draft', 'user-1', [
      rootB,
      rootA,
      rootA,
    ]);
    const rootedSorted = await buildSnapshotProcessFilter('public_plus_owner_draft', 'user-1', [
      rootA,
      rootB,
    ]);
    assertEquals(rootedCanonical, rootedSorted);
  },
);

Deno.test('query/build helpers carry exact worker and LCIA proof contracts', async () => {
  const filter = await buildSnapshotProcessFilter('public_plus_owner_draft', 'user-1');
  assertEquals(buildSnapshotContainsFilter(filter), {
    ...filter,
    numerical_policy_version: NUMERICAL_SNAPSHOT_POLICY_VERSION,
  });

  const payload = buildSnapshotBuildPayloadFields(filter);
  // The marker is Edge lookup/hash identity only; Worker does not accept it as a payload field.
  assertEquals('numerical_policy_version' in payload, false);
  assertEquals(payload.all_states, false);
  assertEquals(payload.process_states, '100');
  assertEquals(payload.include_user_id, 'user-1');
  assertEquals(payload.include_user_state_codes, '0');
  assertEquals('include_user_unassigned_only' in payload, false);
  assertEquals('include_user_review_free_only' in payload, false);
  assertEquals(payload.data_scope, 'public_plus_owner_draft');
  assertEquals(payload.scope_manifest, filter.scope_manifest);
  assertEquals(payload.scope_manifest_sha256, filter.scope_manifest_sha256);
  assertEquals(
    (payload.lcia_method_factor_source as { schema_version: string }).schema_version,
    LCA_METHOD_FACTOR_SOURCE_CONTRACT_SCHEMA_VERSION,
  );
  assertEquals(
    (payload.lcia_method_factor_source as { source_kind: string }).source_kind,
    'static_cache_bundle',
  );
  assertEquals(
    (payload.lcia_method_factor_source as { bundle_manifest_path: string }).bundle_manifest_path,
    LCA_STATIC_CACHE_BUNDLE_MANIFEST_PATH,
  );
  assertEquals(
    (payload.lcia_method_factor_source as { bundle_manifest_sha256: string })
      .bundle_manifest_sha256,
    LCA_STATIC_CACHE_BUNDLE_MANIFEST_SHA256,
  );
  assertEquals(
    (payload.lcia_method_factor_source as { bundle_manifest: { methods: unknown[] } })
      .bundle_manifest.methods.length,
    LCA_STATIC_CACHE_METHOD_COUNT,
  );
  assertEquals(
    (payload.lcia_factor_coverage_contract as { schema_version: string }).schema_version,
    LCIA_FACTOR_COVERAGE_CONTRACT_SCHEMA_VERSION,
  );
  assertEquals(
    (payload.lcia_factor_coverage_contract as { missing_factor_semantics: string })
      .missing_factor_semantics,
    'incomplete_coverage_not_zero',
  );
});

Deno.test('root-scoped build payload sends normalized request_roots to Worker', async () => {
  const root = {
    process_id: '11111111-1111-4111-8111-111111111111',
    process_version: '00.00.001',
  };
  const filter = await buildSnapshotProcessFilter('public_plus_owner_draft', 'user-1', [root]);
  const payload = buildSnapshotBuildPayloadFields(filter);

  assertEquals(filter.selection_mode, 'request_roots_closure');
  assertEquals(filter.request_roots, [root]);
  assertEquals(payload.request_roots, [root]);
  assertEquals(buildSnapshotContainsFilter(filter).selection_mode, 'request_roots_closure');
  assertEquals(buildSnapshotContainsFilter(filter).request_roots, [root]);
});

Deno.test('freshness visibility expression includes every actor-owned state-zero row', async () => {
  const exact = parseSnapshotProcessFilter(
    await buildSnapshotProcessFilter('public_plus_owner_draft', 'user-1'),
  );
  assertEquals(
    buildSnapshotVisibilityOrExpression(exact),
    'state_code.in.(100),and(user_id.eq.user-1,state_code.in.(0))',
  );
  assertEquals(
    buildSnapshotVisibilityOrExpression(exact, { supportsCollaborationColumns: false }),
    'state_code.in.(100),and(user_id.eq.user-1,state_code.in.(0))',
  );

  const legacy = parseSnapshotProcessFilter(
    await buildSnapshotProcessFilter('current_user', 'user-1'),
  );
  assertEquals(
    buildSnapshotVisibilityOrExpression(legacy),
    'state_code.in.(100),and(user_id.eq.user-1,state_code.in.(0))',
  );
});

Deno.test('shouldAutoBuildSnapshot includes the exact private-incubation scope', () => {
  assertEquals(shouldAutoBuildSnapshot('current_user'), true);
  assertEquals(shouldAutoBuildSnapshot('all_data'), true);
  assertEquals(shouldAutoBuildSnapshot('open_data'), true);
  assertEquals(shouldAutoBuildSnapshot('public_plus_owner_draft'), true);
});

Deno.test(
  'calculation evidence binds exact scope, reviewed static source, and 25-method matrix',
  async () => {
    const scope = await buildPublicPlusOwnerDraftScopeBinding('user-1');
    const evidence = buildCalculationEvidenceV2(scope.manifest_sha256);
    const validation = validateLcaCalculationEvidence(evidence, scope.manifest_sha256);
    assertEquals(validation.ok, true);
    if (!validation.ok || !validation.evidence) {
      throw new Error('expected valid calculation evidence');
    }
    assertEquals(buildLcaCalculationEvidenceBinding(validation.evidence), evidence);
    assertEquals(validation.evidence.lcia_factor_coverage.by_method.length, 25);
    assertEquals(validation.evidence.lcia_factor_coverage.counts, {
      matched: 225,
      unmatched: 25,
      invalid: 0,
      unsupported_direction: 0,
    });
    assertEquals(
      validation.evidence.lcia_factor_coverage.uncharacterized_evidence?.artifact_format,
      LCIA_UNCHARACTERIZED_ARTIFACT_FORMAT,
    );

    const complete = buildCalculationEvidenceV2(scope.manifest_sha256, { complete: true });
    assertEquals(validateLcaCalculationEvidence(complete, scope.manifest_sha256).ok, true);

    assertEquals(await validateCalculationEvidenceForDataScope('current_user', 'user-1', null), {
      ok: true,
      evidence: null,
    });
  },
);

Deno.test(
  'calculation evidence fails closed on v1, source, method-matrix, or artifact drift',
  async () => {
    const scope = await buildPublicPlusOwnerDraftScopeBinding('user-1');
    const evidence = buildCalculationEvidenceV2(scope.manifest_sha256);

    assertEquals(validateLcaCalculationEvidence(null, scope.manifest_sha256), {
      ok: false,
      error: 'calculation_evidence_missing',
    });
    assertEquals(validateLcaCalculationEvidence(evidence, 'f'.repeat(64)), {
      ok: false,
      error: 'calculation_evidence_scope_mismatch',
    });

    const oldTopLevel = structuredClone(evidence) as Record<string, unknown>;
    oldTopLevel.schema_version = 'lca.calculation_evidence.v1';
    assertEquals(validateLcaCalculationEvidence(oldTopLevel, scope.manifest_sha256), {
      ok: false,
      error: 'calculation_evidence_missing',
    });

    const sourceDrift = structuredClone(evidence);
    sourceDrift.lcia_method_factor_source.factor_manifest_sha256 = '0'.repeat(64) as never;
    assertEquals(validateLcaCalculationEvidence(sourceDrift, scope.manifest_sha256), {
      ok: false,
      error: 'lcia_method_factor_source_invalid',
    });

    const sourceV1 = structuredClone(evidence) as unknown as {
      lcia_method_factor_source: Record<string, unknown>;
    };
    sourceV1.lcia_method_factor_source = {
      schema_version: 'lca.method_factor_source.snapshot.v1',
      source_kind: 'database',
      relation: 'public.lciamethods',
      source_snapshot_sha256: 'a'.repeat(64),
      method_manifest_sha256: 'b'.repeat(64),
      factor_manifest_sha256: 'c'.repeat(64),
    };
    assertEquals(validateLcaCalculationEvidence(sourceV1, scope.manifest_sha256), {
      ok: false,
      error: 'lcia_method_factor_source_invalid',
    });

    const unionCoverageV1 = structuredClone(evidence) as unknown as {
      lcia_factor_coverage: Record<string, unknown>;
    };
    unionCoverageV1.lcia_factor_coverage = {
      schema_version: 'lcia.factor_coverage.v1',
      coverage_status: 'complete',
      missing_factor_semantics: 'incomplete_coverage_not_zero',
      counts: { matched: 10, unmatched: 0, invalid: 0, unsupported_direction: 0 },
      uncharacterized_evidence: null,
    };
    assertEquals(validateLcaCalculationEvidence(unionCoverageV1, scope.manifest_sha256), {
      ok: false,
      error: 'lcia_factor_coverage_invalid',
    });

    for (const mutate of [
      (candidate: ReturnType<typeof buildCalculationEvidenceV2>) => {
        candidate.lcia_factor_coverage.coverage_status = 'complete';
      },
      (candidate: ReturnType<typeof buildCalculationEvidenceV2>) => {
        candidate.lcia_factor_coverage.by_method.pop();
      },
      (candidate: ReturnType<typeof buildCalculationEvidenceV2>) => {
        candidate.lcia_factor_coverage.by_method[1] = structuredClone(
          candidate.lcia_factor_coverage.by_method[0],
        );
      },
      (candidate: ReturnType<typeof buildCalculationEvidenceV2>) => {
        candidate.lcia_factor_coverage.by_method[0].artifact_locator_id = 'wrong-locator';
      },
      (candidate: ReturnType<typeof buildCalculationEvidenceV2>) => {
        candidate.lcia_factor_coverage.by_method[0].method_id = ` ${candidate.lcia_factor_coverage.by_method[0].method_id}`;
      },
      (candidate: ReturnType<typeof buildCalculationEvidenceV2>) => {
        candidate.lcia_factor_coverage.by_method[0].counts.matched += 1;
        candidate.lcia_factor_coverage.counts.matched += 1;
      },
      (candidate: ReturnType<typeof buildCalculationEvidenceV2>) => {
        candidate.lcia_factor_coverage.counts.matched -= 1;
      },
      (candidate: ReturnType<typeof buildCalculationEvidenceV2>) => {
        candidate.lcia_factor_coverage.uncharacterized_evidence!.artifact_format =
          'lcia-uncharacterized-jsonl:v1' as never;
      },
    ]) {
      const candidate = structuredClone(evidence);
      mutate(candidate);
      assertEquals(validateLcaCalculationEvidence(candidate, scope.manifest_sha256), {
        ok: false,
        error: 'lcia_factor_coverage_invalid',
      });
    }

    const zeroMatrix = buildCalculationEvidenceV2(scope.manifest_sha256, { complete: true });
    zeroMatrix.lcia_factor_coverage.counts = {
      matched: 0,
      unmatched: 0,
      invalid: 0,
      unsupported_direction: 0,
    };
    zeroMatrix.lcia_factor_coverage.by_method.forEach((method) => {
      method.counts = { matched: 0, unmatched: 0, invalid: 0, unsupported_direction: 0 };
    });
    assertEquals(validateLcaCalculationEvidence(zeroMatrix, scope.manifest_sha256), {
      ok: false,
      error: 'lcia_factor_coverage_invalid',
    });

    const unsafeAggregate = buildCalculationEvidenceV2(scope.manifest_sha256);
    const perCategory = Math.floor(Number.MAX_SAFE_INTEGER / (25 * 2)) + 1;
    unsafeAggregate.lcia_factor_coverage.by_method.forEach((method) => {
      method.counts = {
        matched: perCategory,
        unmatched: perCategory,
        invalid: 0,
        unsupported_direction: 0,
      };
    });
    unsafeAggregate.lcia_factor_coverage.counts = {
      matched: perCategory * 25,
      unmatched: perCategory * 25,
      invalid: 0,
      unsupported_direction: 0,
    };
    unsafeAggregate.lcia_factor_coverage.uncharacterized_evidence!.record_count = perCategory * 25;
    assertEquals(validateLcaCalculationEvidence(unsafeAggregate, scope.manifest_sha256), {
      ok: false,
      error: 'lcia_factor_coverage_invalid',
    });
  },
);
Deno.test('snapshot filters are rejected before lossy normalization', () => {
  const valid = {
    all_states: false,
    process_states: [100],
    include_user_id: 'user-1',
    selection_mode: 'filtered_library',
    request_roots: [],
  };
  assertEquals(rejectNonNumericalSnapshotProcessFilter(valid), null);

  // `parseSnapshotProcessFilter` maps all of these to "no state filter", which would otherwise be
  // admitted as numerical. Missing or malformed policy evidence must fail closed instead.
  for (const raw of [
    undefined,
    null,
    {},
    [],
    'all_states:false',
    42,
    { ...valid, all_states: undefined },
    { ...valid, all_states: 'false' },
    { ...valid, all_states: 0 },
    { process_states: [100] },
    { ...valid, process_states: undefined },
    { ...valid, process_states: null },
    { ...valid, process_states: [] },
    { ...valid, process_states: '' },
    { ...valid, process_states: '  ' },
    { ...valid, process_states: 100 },
    { ...valid, process_states: ['100'] },
    { ...valid, process_states: [100.5] },
    { ...valid, process_states: [Number.NaN] },
    { ...valid, process_states: '100,120x' },
    { ...valid, process_states: '100,,101' },
    { ...valid, process_states: '100' },
    { ...valid, include_user_state_codes: [] },
    { ...valid, include_user_state_codes: '0,' },
    { ...valid, include_user_state_codes: '0' },
    { ...valid, include_user_state_codes: ['0'] },
    { ...valid, include_user_state_codes: [0.5] },
  ]) {
    assertNotEquals(
      rejectNonNumericalSnapshotProcessFilter(raw),
      null,
      `raw filter must not be admitted: ${JSON.stringify(raw)}`,
    );
  }

  assertEquals(
    rejectNonNumericalSnapshotProcessFilter({ ...valid, process_states: undefined }),
    'snapshot_process_states_missing',
  );
  assertEquals(
    rejectNonNumericalSnapshotProcessFilter(undefined),
    'snapshot_process_filter_missing',
  );
  assertEquals(rejectNonNumericalSnapshotProcessFilter(null), 'snapshot_process_filter_missing');
  assertEquals(rejectNonNumericalSnapshotProcessFilter({}), 'snapshot_process_filter_malformed');
  assertEquals(
    rejectNonNumericalSnapshotProcessFilter({ ...valid, all_states: 'false' }),
    'snapshot_process_filter_malformed',
  );
  assertEquals(
    rejectNonNumericalSnapshotProcessFilter({ ...valid, include_user_state_codes: [] }),
    'snapshot_process_filter_malformed',
  );
});

Deno.test('snapshot filters admit only explicit well-typed numerical evidence', () => {
  // An older Edge producer wrote exactly this shape: `process_states: [100]` with `include_user_id`
  // and **no** `include_user_state_codes` (Worker materializes the owner branch as state `0` from
  // its own predicate). The filter itself is numerically consistent, and Edge cannot re-derive its
  // own past semantics, so it is admitted here. It is *not* accepted as current numerical evidence:
  // only the artifact's Worker-recorded `numerical_policy_version` proves that, and Worker applies
  // that check whenever it decodes a snapshot for new compute.
  assertEquals(
    rejectNonNumericalSnapshotProcessFilter({
      all_states: false,
      process_states: [100],
      include_user_id: 'user-1',
      selection_mode: 'filtered_library',
      request_roots: [],
      scope_hash: 'f'.repeat(64),
    }),
    null,
  );

  // Positive shapes actually written by the two producers of `private.lca_network_snapshots`.
  assertEquals(
    rejectNonNumericalSnapshotProcessFilter({
      all_states: false,
      process_states: [100],
      selection_mode: 'filtered_library',
      request_roots: [],
      scope_hash: 'b'.repeat(64),
      resolved_scope: { public_process_count: 2, private_process_count: 0, process_count: 2 },
    }),
    null,
  );
  assertEquals(
    rejectNonNumericalSnapshotProcessFilter({
      all_states: false,
      process_states: [100],
      include_user_id: 'user-1',
      selection_mode: 'filtered_library',
      request_roots: [],
      scope_hash: 'c'.repeat(64),
      resolved_scope: { public_process_count: 2, private_process_count: 1, process_count: 3 },
      artifact_lifecycle: { expires_at_utc: null },
    }),
    null,
  );
  assertEquals(
    rejectNonNumericalSnapshotProcessFilter({
      all_states: false,
      process_states: [100],
      include_user_id: 'user-1',
      include_user_state_codes: [0],
      include_user_unassigned_only: false,
      include_user_review_free_only: false,
      data_scope: 'public_plus_owner_draft',
      scope_manifest: { schema_version: 'lca.data_scope.manifest.v2' },
      scope_manifest_sha256: 'd'.repeat(64),
      selection_mode: 'filtered_library',
      request_roots: [],
      scope_hash: 'e'.repeat(64),
      resolved_scope: { public_process_count: 2, private_process_count: 1, process_count: 3 },
    }),
    null,
  );
  // The string form is a Worker-payload shape, not a persisted-column shape; accepting it here
  // would be an unverified widening, so it stays out.
  assertEquals(
    rejectNonNumericalSnapshotProcessFilter({
      all_states: false,
      process_states: '100',
      include_user_id: 'user-1',
      include_user_state_codes: '0',
    }),
    'snapshot_process_states_missing',
  );
});
