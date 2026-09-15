import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.112.4';

import {
  OWNER_DRAFT_PROCESS_STATE,
  PUBLIC_PLUS_OWNER_DRAFT_SCOPE,
  PUBLIC_NUMERICAL_PROCESS_STATES,
  PUBLIC_PROCESS_STATE,
  PUBLISHED_RESULT_PROCESS_STATE,
  isTidasVersion,
  isUuid,
  type LcaDataScope,
  type LcaSnapshotRequestRoot,
} from './lca_snapshot_scope.ts';

export type ProcessScopeMeta = {
  state_code: number | null;
  user_id: string | null;
  team_id: string | null;
  review_id: string | null;
};

export type ProcessScopeEntry = {
  process_id: string;
  process_version?: string;
};

export type ProcessScopeValidationResult =
  { ok: true } | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Rejection reasons a numerically inadmissible Process reports.
 *
 * Aligned with Worker `solver_worker::process_state_numerical_rejection_reason`: the published
 * Result state names itself so a caller pointing a numerical request at a Result gets a
 * locatable eligibility error instead of a generic out-of-scope Process.
 */
export const PUBLISHED_RESULT_PROCESS_REJECTION =
  'published_result_process_is_not_a_numerical_input';

/** Reason for a scope that decides by published state alone, so the state is the whole denial. */
const PROCESS_NOT_NUMERICALLY_ELIGIBLE_REJECTION = 'process_state_is_not_numerically_eligible';

/**
 * True when the state is never a numerical Process input in any scope, independent of ownership.
 *
 * Only these states carry a state-derived rejection reason. A foreign owner draft and any other
 * ownership-shaped denial keep the existing generic out-of-scope reporting, because there the
 * owner identity — not the state — decided the outcome.
 */
export function numericalStateRejectionReason(stateCode: number | null | undefined): string | null {
  if (stateCode === PUBLISHED_RESULT_PROCESS_STATE) {
    return PUBLISHED_RESULT_PROCESS_REJECTION;
  }
  return null;
}

/** True when the scope has no owner-draft branch, so a non-published state is decided by state. */
function scopeAdmitsOnlyNumericalPublishedStates(dataScope: LcaDataScope): boolean {
  return dataScope === 'open_data';
}

export type NormalizedSingleProcessDemand =
  | {
      selector: 'process_id';
      process_id: string;
      process_version?: string;
      amount: number;
    }
  | {
      selector: 'process_index';
      process_index: number;
      amount: number;
    };

export type SingleProcessDemandNormalizationResult =
  | { ok: true; demand: NormalizedSingleProcessDemand }
  | { ok: false; status: 400; body: { error: string } };

export function processScopeLookupKey(processId: string, processVersion?: string): string {
  return `${processId}:${String(processVersion ?? '').trim()}`;
}

export function normalizeSingleProcessDemand(raw: unknown): SingleProcessDemandNormalizationResult {
  const demand = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rawIndex = (demand as { process_index?: unknown }).process_index;
  const processId = String((demand as { process_id?: unknown }).process_id ?? '')
    .trim()
    .toLowerCase();
  const processVersion = String(
    (demand as { process_version?: unknown }).process_version ?? '',
  ).trim();
  const amountRaw = (demand as { amount?: unknown }).amount;
  const amount = amountRaw === undefined || amountRaw === null ? 1 : amountRaw;

  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    return { ok: false, status: 400, body: { error: 'invalid_amount' } };
  }

  const hasIndexDemand = rawIndex !== undefined && rawIndex !== null;
  const hasProcessIdDemand = processId.length > 0;
  if (!hasIndexDemand && !hasProcessIdDemand) {
    return {
      ok: false,
      status: 400,
      body: { error: 'process_index_or_process_id_required' },
    };
  }
  if (hasIndexDemand && hasProcessIdDemand) {
    return {
      ok: false,
      status: 400,
      body: { error: 'provide_process_index_or_process_id' },
    };
  }

  if (hasProcessIdDemand) {
    if (!isUuid(processId)) {
      return { ok: false, status: 400, body: { error: 'invalid_process_id' } };
    }
    if (processVersion && !isTidasVersion(processVersion)) {
      return { ok: false, status: 400, body: { error: 'invalid_process_version' } };
    }
    return {
      ok: true,
      demand: {
        selector: 'process_id',
        process_id: processId,
        ...(processVersion ? { process_version: processVersion } : {}),
        amount,
      },
    };
  }

  if (!Number.isInteger(rawIndex) || Number(rawIndex) < 0) {
    return { ok: false, status: 400, body: { error: 'invalid_process_index' } };
  }
  return {
    ok: true,
    demand: {
      selector: 'process_index',
      process_index: Number(rawIndex),
      amount,
    },
  };
}

export function requestRootFromSingleProcessDemand(
  demand: NormalizedSingleProcessDemand,
): LcaSnapshotRequestRoot | null {
  if (demand.selector !== 'process_id' || !demand.process_version) {
    return null;
  }
  return {
    process_id: demand.process_id,
    process_version: demand.process_version,
  };
}

export function hasClientSuppliedSnapshotRoots(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return false;
  }
  return (
    Object.prototype.hasOwnProperty.call(raw, 'request_roots') ||
    Object.prototype.hasOwnProperty.call(raw, 'requestRoots')
  );
}

export function matchesProcessDataScope(
  meta: ProcessScopeMeta | undefined,
  dataScope: LcaDataScope,
  userId: string,
): boolean {
  if (!meta) {
    return false;
  }

  // Published numerical Process eligibility is exactly state `100`. The reserved publication
  // segment `101..199` and the published Result state `120` are not numerical inputs, and owner
  // identity never converts one into an input: each scope still requires the exact published
  // state plus, where applicable, ownership.
  const isNumericallyPublished =
    meta.state_code !== null && PUBLIC_NUMERICAL_PROCESS_STATES.includes(meta.state_code);
  const isOwnedByCurrentUser = meta.user_id === userId;

  switch (dataScope) {
    case PUBLIC_PLUS_OWNER_DRAFT_SCOPE:
      // The v2 actor-bound scope manifest admits exactly public state `100` plus every
      // state-`0` row owned by the authenticated actor, irrespective of `team_id`/`review_id`
      // workflow metadata (that metadata stays collaboration context, not an ownership gate).
      // Owner identity still never admits `120` or any other owner state.
      return (
        meta.state_code === PUBLIC_PROCESS_STATE ||
        (meta.state_code === OWNER_DRAFT_PROCESS_STATE && isOwnedByCurrentUser)
      );
    case 'open_data':
      return isNumericallyPublished;
    case 'all_data':
      return (
        isNumericallyPublished ||
        (isOwnedByCurrentUser && meta.state_code === OWNER_DRAFT_PROCESS_STATE)
      );
    case 'current_user':
    default:
      // This scope keeps its own "only the caller's own Process" rule, so a foreign published row
      // stays out even though it is in the shared snapshot family. Within that rule the admitted
      // states are the numerically eligible published `100` and the caller's own state-`0` draft.
      // Ownership alone is a visibility fact, not numerical eligibility: it must not admit `120`,
      // the reserved segment, the review state `20`, or any other non-draft owner state.
      return (
        isOwnedByCurrentUser &&
        (isNumericallyPublished || meta.state_code === OWNER_DRAFT_PROCESS_STATE)
      );
  }
}

export async function fetchProcessScopeLookup(
  entries: ProcessScopeEntry[],
  client?: SupabaseClient,
): Promise<{ ok: true; data: Map<string, ProcessScopeMeta> } | { ok: false; error: string }> {
  const uniqueIds = [...new Set(entries.map((entry) => entry.process_id).filter(Boolean))];
  if (uniqueIds.length === 0) {
    return { ok: true, data: new Map<string, ProcessScopeMeta>() };
  }

  const supabaseClient = client ?? (await import('./supabase_client.ts')).supabaseClient;
  const lookup = new Map<string, ProcessScopeMeta>();
  const chunkSize = 500;

  for (let index = 0; index < uniqueIds.length; index += chunkSize) {
    const chunk = uniqueIds.slice(index, index + chunkSize);
    const { data, error } = await supabaseClient
      .schema('public')
      .from('processes')
      .select('id,version,state_code,user_id,team_id,review_id')
      .in('id', chunk);

    if (error) {
      console.error('fetch process scope metadata failed', {
        error: error.message,
        code: error.code,
      });
      return { ok: false, error: 'process_scope_lookup_failed' };
    }

    for (const row of data ?? []) {
      const processId = String((row as { id?: unknown }).id ?? '').trim();
      const processVersion = String((row as { version?: unknown }).version ?? '').trim();
      if (!processId || !processVersion) {
        continue;
      }

      const stateCodeRaw = (row as { state_code?: unknown }).state_code;
      const stateCodeCandidate =
        typeof stateCodeRaw === 'number'
          ? stateCodeRaw
          : typeof stateCodeRaw === 'string' && stateCodeRaw.trim().length > 0
            ? Number(stateCodeRaw)
            : Number.NaN;
      const stateCode = Number.isInteger(stateCodeCandidate) ? stateCodeCandidate : null;
      const userId =
        typeof (row as { user_id?: unknown }).user_id === 'string'
          ? String((row as { user_id?: unknown }).user_id).trim() || null
          : null;
      const teamId =
        typeof (row as { team_id?: unknown }).team_id === 'string'
          ? String((row as { team_id?: unknown }).team_id).trim() || null
          : null;
      const reviewId =
        typeof (row as { review_id?: unknown }).review_id === 'string'
          ? String((row as { review_id?: unknown }).review_id).trim() || null
          : null;

      lookup.set(processScopeLookupKey(processId, processVersion), {
        state_code: stateCode,
        user_id: userId,
        team_id: teamId,
        review_id: reviewId,
      });
    }
  }

  return { ok: true, data: lookup };
}

export async function validateProcessEntriesInDataScope(
  entries: ProcessScopeEntry[],
  dataScope: LcaDataScope,
  userId: string,
  client?: SupabaseClient,
): Promise<ProcessScopeValidationResult> {
  const scopeMeta = await fetchProcessScopeLookup(entries, client);
  if (!scopeMeta.ok) {
    return {
      ok: false,
      status: 500,
      body: { error: scopeMeta.error },
    };
  }

  const outOfScopeProcessIds: string[] = [];
  const numericalRejection = { reason: null as string | null, processId: null as string | null };
  for (const entry of entries) {
    const meta = scopeMeta.data.get(processScopeLookupKey(entry.process_id, entry.process_version));
    if (matchesProcessDataScope(meta, dataScope, userId)) {
      continue;
    }
    outOfScopeProcessIds.push(entry.process_id);

    // Only a state that is never a numerical input reports a state-derived reason; every other
    // denial keeps the existing generic scope error.
    const reason =
      numericalStateRejectionReason(meta?.state_code) ??
      (scopeAdmitsOnlyNumericalPublishedStates(dataScope) && meta
        ? PROCESS_NOT_NUMERICALLY_ELIGIBLE_REJECTION
        : null);
    if (reason && numericalRejection.reason === null) {
      numericalRejection.reason = reason;
      numericalRejection.processId = entry.process_id;
    }
  }

  const distinctOutOfScopeProcessIds = [...new Set(outOfScopeProcessIds)];
  if (distinctOutOfScopeProcessIds.length === 0) {
    return { ok: true };
  }

  if (numericalRejection.reason !== null) {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'process_not_in_data_scope',
        reason: numericalRejection.reason,
        data_scope: dataScope,
        process_id: numericalRejection.processId,
      },
    };
  }

  if (distinctOutOfScopeProcessIds.length === 1) {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'process_not_in_data_scope',
        data_scope: dataScope,
        process_id: distinctOutOfScopeProcessIds[0],
      },
    };
  }

  return {
    ok: false,
    status: 403,
    body: {
      error: 'processes_not_in_data_scope',
      data_scope: dataScope,
      process_ids: distinctOutOfScopeProcessIds,
    },
  };
}
