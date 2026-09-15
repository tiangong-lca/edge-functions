import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.112.4';
import {
  queryLcaSnapshotCandidates,
  type LcaSnapshotScope,
  type LcaSnapshotCandidate,
} from './lca_snapshot_capabilities.ts';

import {
  buildSnapshotProcessFilter,
  evaluateSnapshotEvidenceForNewCalculation,
  matchesSnapshotDataScopeFilter,
  type LcaDataScope,
  type SnapshotProcessFilter,
} from './lca_snapshot_scope.ts';

export type SnapshotScopeVerificationResult =
  | { ok: true; matches: true; process_filter: SnapshotProcessFilter }
  | { ok: true; matches: false }
  | { ok: false; error: 'snapshot_scope_lookup_failed'; status: 500 };

export type SnapshotEvidenceVerificationResult =
  | { ok: true; matches: true; candidate: LcaSnapshotCandidate }
  | { ok: true; matches: false }
  | { ok: false; error: string; status: number };

/**
 * Verifies that a **stored ready** snapshot may back a new calculation.
 *
 * Reuse of an already-persisted snapshot is a decision about stored evidence, not about the filter a
 * caller proposed: the candidate row must carry the Worker-authored current
 * `numerical_policy_version`. Callers must run this before returning a cached result or enqueuing
 * work, so a pre-policy snapshot can never be served from cache. A missing candidate row reports
 * `matches: false` so callers keep their existing `snapshot_not_ready` handling; a present but
 * non-current row reports the policy reason instead.
 */
export async function verifySnapshotEvidenceForNewCalculation(
  supabase: SupabaseClient,
  args: { snapshotId: string },
): Promise<SnapshotEvidenceVerificationResult> {
  const result = await queryLcaSnapshotCandidates(supabase, {
    scope: 'full_library',
    snapshotId: args.snapshotId,
    limit: 1,
  });
  if (!result.ok) {
    console.warn('read snapshot evidence failed', {
      code: result.code,
      snapshot_id: args.snapshotId,
    });
    return { ok: false, error: 'snapshot_artifact_lookup_failed', status: 500 };
  }

  const row = result.data[0];
  if (!row) {
    return { ok: true, matches: false };
  }

  const decision = evaluateSnapshotEvidenceForNewCalculation(row);
  if (!decision.ok) {
    console.warn('stored snapshot is not current numerical evidence', {
      reason: decision.error,
      snapshot_id: args.snapshotId,
    });
    return { ok: false, error: decision.error, status: decision.status };
  }
  return { ok: true, matches: true, candidate: row };
}

export type LatestSnapshotResolution =
  { ok: true; candidate: LcaSnapshotCandidate } | { ok: false; error: string; status: number };

/**
 * Resolves the most recent stored snapshot for a caller with no actor context.
 *
 * This is the same reuse decision as the actor-scoped lookup: the chosen row may back a new
 * calculation only when it carries the Worker-authored current policy marker. The evidence check
 * runs **before** any caller can see the snapshot id, so a cached result or enqueue can never be
 * reached for a non-current snapshot. Extracted from the three LCA read paths so the ordering is
 * exercised by tests instead of asserted against source text.
 */
export async function resolveLatestSnapshotForNewCalculation(
  supabase: SupabaseClient,
  args: { scope: LcaSnapshotScope },
): Promise<LatestSnapshotResolution> {
  const candidates = await queryLcaSnapshotCandidates(supabase, {
    scope: args.scope,
    limit: 1,
  });
  if (!candidates.ok) {
    console.error('read latest ready snapshot failed', { code: candidates.code });
    return { ok: false, error: 'snapshot_lookup_failed', status: 500 };
  }

  const latest = candidates.data[0];
  if (!latest) {
    return { ok: false, error: 'no_ready_snapshot', status: 404 };
  }

  const decision = evaluateSnapshotEvidenceForNewCalculation(latest);
  if (!decision.ok) {
    console.warn('latest stored snapshot is not current numerical evidence', {
      reason: decision.error,
      snapshot_id: latest.snapshotId,
    });
    return { ok: false, error: decision.error, status: decision.status };
  }
  return { ok: true, candidate: latest };
}

export async function verifySnapshotMatchesDataScope(
  supabase: SupabaseClient,
  args: {
    snapshotId: string;
    dataScope: LcaDataScope;
    userId: string;
  },
): Promise<SnapshotScopeVerificationResult> {
  const expectedProcessFilter = await buildSnapshotProcessFilter(args.dataScope, args.userId);
  const result = await queryLcaSnapshotCandidates(supabase, {
    scope: 'full_library',
    snapshotId: args.snapshotId,
    limit: 1,
  });

  if (!result.ok) {
    console.warn('read explicit snapshot process filter failed', {
      code: result.code,
      snapshot_id: args.snapshotId,
      data_scope: args.dataScope,
      user_id: args.userId,
    });
    return { ok: false, error: 'snapshot_scope_lookup_failed', status: 500 };
  }

  const processFilter = result.data[0]?.processFilter;
  if (!matchesSnapshotDataScopeFilter(processFilter, expectedProcessFilter)) {
    return { ok: true, matches: false };
  }

  return {
    ok: true,
    matches: true,
    process_filter: expectedProcessFilter,
  };
}
