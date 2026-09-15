import { assert, assertEquals, assertMatch } from 'jsr:@std/assert';

import { ensureLcaSnapshotBuildQueued } from '../supabase/functions/_shared/lca_snapshot_build_queue.ts';
import {
  buildSnapshotBuildPayloadFields,
  buildSnapshotProcessFilter,
  LCA_STATIC_CACHE_BUNDLE_MANIFEST_PATH,
  LCA_STATIC_CACHE_BUNDLE_MANIFEST_SHA256,
  NUMERICAL_SNAPSHOT_POLICY_VERSION,
} from '../supabase/functions/_shared/lca_snapshot_scope.ts';

type MockState = {
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
};

function createSupabaseMock(state: MockState) {
  return {
    rpc(fn: string, args: Record<string, unknown>) {
      state.rpcCalls.push({ fn, args });
      return Promise.resolve({
        data: {
          ok: true,
          mode: 'queued',
          job_id: 'lca-job-1',
          snapshot_id: 'snapshot-1',
          worker_job_id: 'worker-job-1',
        },
        error: null,
      });
    },
  };
}

Deno.test(
  'snapshot queue sends exact scope, actor, LCIA source, and coverage proof to worker',
  async () => {
    const state: MockState = { rpcCalls: [] };
    const result = await ensureLcaSnapshotBuildQueued(createSupabaseMock(state) as never, {
      scope: 'full_library',
      dataScope: 'public_plus_owner_draft',
      userId: 'user-1',
    });

    assert(result.ok);
    assertEquals(result.worker_job_id, 'worker-job-1');
    assertEquals(result.calculation_contract.data_scope, 'public_plus_owner_draft');
    assertEquals(result.calculation_contract.process_filter.process_states, [100]);
    assertEquals(result.calculation_contract.process_filter.include_user_state_codes, [0]);
    assertEquals(
      result.calculation_contract.process_filter.include_user_unassigned_only,
      undefined,
    );
    assertEquals(
      result.calculation_contract.process_filter.include_user_review_free_only,
      undefined,
    );
    assertEquals(result.calculation_contract.process_filter.selection_mode, 'filtered_library');
    assertEquals(result.calculation_contract.process_filter.request_roots, []);
    assertMatch(result.calculation_contract.scope_manifest_sha256 ?? '', /^[0-9a-f]{64}$/);
    assertEquals(
      result.calculation_contract.lcia_factor_coverage_contract?.missing_factor_semantics,
      'incomplete_coverage_not_zero',
    );

    assertEquals(state.rpcCalls.length, 1);
    const rpcArgs = state.rpcCalls[0].args;
    assertEquals(state.rpcCalls[0].fn, 'svc_lca_snapshot_build_enqueue');
    assertEquals(rpcArgs.p_scope, 'full_library');
    assertEquals(rpcArgs.p_process_filter, result.calculation_contract.process_filter);
    assertEquals(rpcArgs.p_payload_schema_version, 'lca.build_snapshot.request.v2');
    assertEquals(rpcArgs.p_requested_by, 'user-1');

    const payload = rpcArgs.p_payload as Record<string, unknown>;
    assertEquals(payload.data_scope, 'public_plus_owner_draft');
    assertEquals(payload.process_states, '100');
    assertEquals(payload.include_user_id, 'user-1');
    assertEquals(payload.include_user_state_codes, '0');
    assertEquals('include_user_unassigned_only' in payload, false);
    assertEquals('include_user_review_free_only' in payload, false);
    assertEquals('request_roots' in payload, false);
    assertEquals(payload.scope_manifest, result.calculation_contract.scope_manifest);
    assertEquals(payload.scope_manifest_sha256, result.calculation_contract.scope_manifest_sha256);
    assertEquals(
      (payload.lcia_method_factor_source as { snapshot_binding: { required: boolean } })
        .snapshot_binding.required,
      true,
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
      (payload.lcia_factor_coverage_contract as { missing_factor_semantics: string })
        .missing_factor_semantics,
      'incomplete_coverage_not_zero',
    );
  },
);

Deno.test(
  'snapshot queue binds the numerical policy marker into request identity only',
  async () => {
    const state: MockState = { rpcCalls: [] };
    const result = await ensureLcaSnapshotBuildQueued(createSupabaseMock(state) as never, {
      scope: 'full_library',
      dataScope: 'public_plus_owner_draft',
      userId: 'user-1',
    });
    assert(result.ok);

    const processFilter = await buildSnapshotProcessFilter('public_plus_owner_draft', 'user-1');
    const payload = {
      scope: 'full_library',
      ...buildSnapshotBuildPayloadFields(processFilter),
      reference_normalization_mode: 'lenient',
      allocation_fraction_mode: 'lenient',
      self_loop_cutoff: 0.999999,
      singular_eps: 1e-12,
      no_lcia: false,
    };
    const identity = JSON.stringify({
      version: 'lca_snapshot_build_v2',
      numerical_policy_version: NUMERICAL_SNAPSHOT_POLICY_VERSION,
      scope: 'full_library',
      process_filter: processFilter,
      payload,
    });
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
    const expectedRequestKey = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');

    const rpcArgs = state.rpcCalls[0].args;
    assertEquals(rpcArgs.p_request_key, expectedRequestKey);
    // The marker is Edge lookup and request identity. Worker owns and records
    // `numerical_policy_version` in its own build config and authors it into the stored ready
    // `process_filter`, so Edge must not pass it as a caller-controlled payload field.
    assertEquals(
      'numerical_policy_version' in (rpcArgs.p_payload as Record<string, unknown>),
      false,
    );
    // The proposed process filter stays payload-shaped; the marker lives in the lookup containment
    // view and in the request hash, not in the object handed to the enqueue RPC.
    assertEquals(
      'numerical_policy_version' in (rpcArgs.p_process_filter as Record<string, unknown>),
      false,
    );
  },
);

Deno.test('snapshot queue ignores client source locator and no-LCIA override fields', async () => {
  const state: MockState = { rpcCalls: [] };
  const enqueue = ensureLcaSnapshotBuildQueued as unknown as (
    supabase: ReturnType<typeof createSupabaseMock>,
    args: Record<string, unknown>,
  ) => ReturnType<typeof ensureLcaSnapshotBuildQueued>;
  const result = await enqueue(createSupabaseMock(state), {
    scope: 'full_library',
    dataScope: 'public_plus_owner_draft',
    userId: 'user-1',
    no_lcia: true,
    bundle_manifest_path: '../../attacker.json',
    bundle_manifest_sha256: '0'.repeat(64),
    base_url: 'https://attacker.invalid/',
  });

  assert(result.ok);
  const payload = state.rpcCalls[0].args.p_payload as Record<string, unknown>;
  const source = payload.lcia_method_factor_source as Record<string, unknown>;
  assertEquals(payload.no_lcia, false);
  assertEquals(source.bundle_manifest_path, LCA_STATIC_CACHE_BUNDLE_MANIFEST_PATH);
  assertEquals(source.bundle_manifest_sha256, LCA_STATIC_CACHE_BUNDLE_MANIFEST_SHA256);
  assertEquals(source.base_url_binding, 'worker_trusted_configuration');
  assertEquals('base_url' in source, false);
});

Deno.test(
  'root-scoped queue binds roots into payload, snapshot identity, and idempotency',
  async () => {
    const rootA = {
      process_id: '11111111-1111-4111-8111-111111111111',
      process_version: '00.00.001',
    };
    const rootB = {
      process_id: '22222222-2222-4222-8222-222222222222',
      process_version: '01.00.000',
    };

    const enqueue = async (requestRoots?: Array<typeof rootA>) => {
      const state: MockState = { rpcCalls: [] };
      const result = await ensureLcaSnapshotBuildQueued(createSupabaseMock(state) as never, {
        scope: 'full_library',
        dataScope: 'public_plus_owner_draft',
        userId: 'user-1',
        requestRoots,
      });
      assert(result.ok);
      return { state, result };
    };

    const canonical = await enqueue([rootA, rootB, rootA]);
    const reordered = await enqueue([rootB, rootA]);
    const onlyA = await enqueue([rootA]);
    const onlyB = await enqueue([rootB]);
    const full = await enqueue();

    const canonicalArgs = canonical.state.rpcCalls[0].args;
    const canonicalPayload = canonicalArgs.p_payload as Record<string, unknown>;
    assertEquals(
      canonical.result.calculation_contract.process_filter.selection_mode,
      'request_roots_closure',
    );
    assertEquals(canonical.result.calculation_contract.process_filter.request_roots, [
      rootA,
      rootB,
    ]);
    assertEquals(canonicalPayload.request_roots, [rootA, rootB]);
    assertEquals(
      canonicalArgs.p_process_filter,
      canonical.result.calculation_contract.process_filter,
    );

    const field = 'p_request_key';
    assertEquals(canonicalArgs[field], reordered.state.rpcCalls[0].args[field]);
    assert(canonicalArgs[field] !== onlyA.state.rpcCalls[0].args[field]);
    assert(onlyA.state.rpcCalls[0].args[field] !== onlyB.state.rpcCalls[0].args[field]);
    assert(onlyA.state.rpcCalls[0].args[field] !== full.state.rpcCalls[0].args[field]);
  },
);
