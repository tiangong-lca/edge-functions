import { assert, assertFalse } from 'jsr:@std/assert';

const LCA_READ_PATH_ENTRYPOINTS = [
  '../supabase/functions/lca_solve/index.ts',
  '../supabase/functions/lca_query_results/index.ts',
  '../supabase/functions/lca_contribution_path/index.ts',
] as const;

async function source(relativePath: string): Promise<string> {
  return await Deno.readTextFile(new URL(relativePath, import.meta.url));
}

Deno.test('every LCA read path wires the shared evidence gate into both branches', async () => {
  // Wiring only. This test cannot prove control flow; runtime behavior is covered by the
  // callable-helper tests in `test/lca_snapshot_scope_db_test.ts`, which drive
  // `verifySnapshotEvidenceForNewCalculation` and `resolveLatestSnapshotForNewCalculation` directly.
  for (const path of LCA_READ_PATH_ENTRYPOINTS) {
    const text = await source(path);
    assert(
      text.includes('verifySnapshotEvidenceForNewCalculation(supabaseClient'),
      `${path} must gate an explicit snapshot`,
    );
    assertFalse(
      text.includes('fetchSnapshotArtifactMeta(explicit)'),
      `${path} must not look up an explicit snapshot without gating its evidence`,
    );
    assert(
      text.includes('evaluateSnapshotEvidenceForNewCalculation(row)'),
      `${path} must re-check each automatic-lookup candidate`,
    );
    assert(
      text.includes('resolveLatestSnapshotForNewCalculation(supabaseClient'),
      `${path} must gate the no-user latest-snapshot fallback`,
    );
    assert(
      text.includes('buildSnapshotContainsFilter('),
      `${path} must ask the database for the marker in the containment filter`,
    );
    // Reading the latest candidate directly is the pre-gate shape; the gated resolver owns it.
    assertFalse(
      text.includes('const latest = candidates.data[0]'),
      `${path} must not bypass the gated fallback resolver`,
    );
  }
});

Deno.test('the evidence gate is distinct from proposed-filter validation', async () => {
  const scope = await source('../supabase/functions/_shared/lca_snapshot_scope.ts');
  // Proposed-filter validation must never mention the marker: a proposed filter may carry one
  // without proving anything about a stored row.
  const proposed = scope.slice(
    scope.indexOf('export function rejectNonNumericalSnapshotProcessFilter'),
    scope.indexOf('export function buildSnapshotContainsFilter'),
  );
  assertFalse(proposed.includes('numerical_policy_version'));

  // The stored-evidence gate requires the current marker before any filter-shape acceptance.
  const stored = scope.slice(
    scope.indexOf('export function rejectNonCurrentSnapshotEvidence'),
    scope.indexOf('export type SnapshotEvidenceDecision'),
  );
  assert(stored.includes('snapshot_numerical_policy_version_missing'));
  assert(stored.includes('snapshot_numerical_policy_version_not_current'));

  // Payload fields stay Worker-owned: Edge must not emit the marker as a caller-supplied field.
  const payloadBuilder = scope.slice(
    scope.indexOf('export function buildSnapshotBuildPayloadFields'),
    scope.indexOf('export function buildLcaMethodFactorSourceContract'),
  );
  assertFalse(payloadBuilder.includes('numerical_policy_version'));
});
