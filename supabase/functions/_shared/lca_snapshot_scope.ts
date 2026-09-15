import reviewedStaticCacheBundleManifest from './lca_static_cache_bundle_manifest.json' with { type: 'json' };

export const PUBLIC_PROCESS_STATE = 100;
export const OWNER_DRAFT_PROCESS_STATE = 0;
export const REVIEW_IN_PROGRESS_PROCESS_STATE = 20;
export const PUBLISHED_RESULT_PROCESS_STATE = 120;

/**
 * Reserved publication segment `100..199`.
 *
 * The reserved range grants no numerical eligibility: `buildSnapshotProcessFilter` uses
 * [`PUBLIC_NUMERICAL_PROCESS_STATES`]. These constants survive only so already deployed
 * range-shaped payloads still parse and can be recognized as retired.
 */
export const DEFAULT_PUBLISHED_PROCESS_STATE_START = 100;
export const DEFAULT_PUBLISHED_PROCESS_STATE_END = 199;
export const DEFAULT_PUBLISHED_PROCESS_STATES: readonly number[] = Array.from(
  {
    length: DEFAULT_PUBLISHED_PROCESS_STATE_END - DEFAULT_PUBLISHED_PROCESS_STATE_START + 1,
  },
  (_, index) => DEFAULT_PUBLISHED_PROCESS_STATE_START + index,
);

/**
 * Public numerical Process eligibility: exactly the published state `100`.
 *
 * `101..199` is a reserved publication segment that carries no computation capability. In
 * particular the published Result state `120` is never a root, provider, demand target or
 * snapshot axis. Support datasets (flows, flowproperties, unitgroups, sources, contacts,
 * lifecyclemodels) keep their own state rules; this constant applies to Processes only.
 */
export const PUBLIC_NUMERICAL_PROCESS_STATES: readonly number[] = [PUBLIC_PROCESS_STATE];

/**
 * Worker/Database-owned identity of the current numerical eligibility policy.
 *
 * Bound to Worker `solver_worker::NUMERICAL_SNAPSHOT_POLICY_VERSION` and recorded in the
 * snapshot build request hash, so a snapshot requested under the retired `100..199` membership can
 * never be matched to a request built under the current policy. The literal is not sent as a
 * payload field: Worker owns and records the field `numerical_policy_version` in its own snapshot
 * build config and does not accept that marker from a caller.
 */
export const NUMERICAL_SNAPSHOT_POLICY_VERSION =
  'public-numerical-state-100-excluding-result-120:v1';

/**
 * The retired reserved-range membership still reaches some snapshot builders as an explicit
 * `100..199` process-state argument (the legacy CLI default). It is not new-compute evidence.
 */
export function isRetiredNumericalStateArgument(states: readonly number[]): boolean {
  return (
    states.length ===
      DEFAULT_PUBLISHED_PROCESS_STATE_END - DEFAULT_PUBLISHED_PROCESS_STATE_START + 1 &&
    states.every((state, index) => state === DEFAULT_PUBLISHED_PROCESS_STATE_START + index)
  );
}

export const PUBLIC_PLUS_OWNER_DRAFT_SCOPE = 'public_plus_owner_draft';
export const FILTERED_LIBRARY_SELECTION_MODE = 'filtered_library';
export const REQUEST_ROOTS_CLOSURE_SELECTION_MODE = 'request_roots_closure';
export const LCA_SCOPE_MANIFEST_SCHEMA_VERSION = 'lca.data_scope.manifest.v2';
export const PUBLIC_PLUS_OWNER_DRAFT_PREDICATE_VERSION =
  'public_state_100_or_authenticated_owner_state_0.v2';
export const LCA_METHOD_FACTOR_SOURCE_CONTRACT_SCHEMA_VERSION =
  'lca.method_factor_source.request.v2';
export const LCIA_FACTOR_COVERAGE_CONTRACT_SCHEMA_VERSION =
  'lcia.method_factor_coverage.contract.v2';
export const LCA_CALCULATION_EVIDENCE_SCHEMA_VERSION = 'lca.calculation_evidence.v2';
export const LCA_METHOD_FACTOR_SOURCE_SNAPSHOT_SCHEMA_VERSION =
  'lca.method_factor_source.snapshot.v2';
export const LCIA_FACTOR_COVERAGE_EVIDENCE_SCHEMA_VERSION = 'lcia.method_factor_coverage.matrix.v1';
export const LCA_STATIC_CACHE_BUNDLE_SCHEMA_VERSION = 'lcia.static_cache_bundle.v1';
export const LCA_STATIC_CACHE_BUNDLE_MANIFEST_PATH = 'lciamethods/cache_manifest.json';
export const LCA_STATIC_CACHE_BUNDLE_MANIFEST_SHA256 =
  'e9b4e7f9a5125bb921efbffba9a4b50711f9ea982e22b500f35211884a0479c5';
export const LCA_STATIC_CACHE_BUNDLE_VERSION = '1.2.4';
export const LCA_STATIC_CACHE_SOURCE_SNAPSHOT_SHA256 =
  '4efbe0b027969dc2b3b151a84422b3fb749bf1fc2d334c60d1fcf37bf7cc2c11';
export const LCA_STATIC_CACHE_METHOD_MANIFEST_SHA256 =
  '801e886d2d02fc57c6815cfae2f33904139597c1665b55ee0f57bcacdd6be609';
export const LCA_STATIC_CACHE_METHOD_IDENTITY_MANIFEST_SHA256 =
  'dedd7f932f8418a2babb0a9b3ac93c7c812bda4988f974859ac6981e855a0b19';
export const LCA_STATIC_CACHE_FACTOR_MANIFEST_SHA256 =
  '40ffd33323c9882dbd0b0d9c99982bad1752e311062231bcf1f490ee96f92e96';
export const LCA_STATIC_CACHE_METHOD_COUNT = 25;
export const LCA_METHOD_FACTOR_SOURCE_BASE_URL_BINDING = 'worker_trusted_configuration';
export const LCIA_FACTOR_COVERAGE_COUNT_UNIT = 'exchange_method_pair';
export const LCIA_UNCHARACTERIZED_ARTIFACT_FORMAT = 'lcia-uncharacterized-jsonl:v2';

export type LcaDataScope =
  'current_user' | 'open_data' | 'all_data' | typeof PUBLIC_PLUS_OWNER_DRAFT_SCOPE;

export type LcaSnapshotSelectionMode =
  typeof FILTERED_LIBRARY_SELECTION_MODE | typeof REQUEST_ROOTS_CLOSURE_SELECTION_MODE;

export type LcaSnapshotRequestRoot = {
  process_id: string;
  process_version: string;
};

export type LcaScopeManifest = {
  schema_version: typeof LCA_SCOPE_MANIFEST_SCHEMA_VERSION;
  scope: typeof PUBLIC_PLUS_OWNER_DRAFT_SCOPE;
  predicate_version: typeof PUBLIC_PLUS_OWNER_DRAFT_PREDICATE_VERSION;
  actor: {
    kind: 'authenticated_user';
    user_id: string;
  };
  applies_to: ['processes', 'flows'];
  predicate: {
    operator: 'or';
    clauses: [
      { state_code: { eq: typeof PUBLIC_PROCESS_STATE } },
      {
        operator: 'and';
        clauses: [
          { user_id: { eq: string } },
          { state_code: { eq: typeof OWNER_DRAFT_PROCESS_STATE } },
        ];
      },
    ];
  };
};

export type LcaScopeBinding = {
  manifest: LcaScopeManifest;
  manifest_sha256: string;
};

export type LcaStaticCacheBundleMethod = {
  method_id: string;
  method_version: string;
  artifact_locator_id: string;
  artifact_filename: string;
  factor_entry_count: number;
  unique_flow_direction_key_count: number;
  duplicate_entry_count: number;
};

export type LcaStaticCacheBundleManifest = {
  schema_version: typeof LCA_STATIC_CACHE_BUNDLE_SCHEMA_VERSION;
  source_kind: 'static_cache_bundle';
  bundle_version: typeof LCA_STATIC_CACHE_BUNDLE_VERSION;
  source_snapshot_sha256: typeof LCA_STATIC_CACHE_SOURCE_SNAPSHOT_SHA256;
  method_manifest_sha256: typeof LCA_STATIC_CACHE_METHOD_MANIFEST_SHA256;
  method_identity_manifest_sha256: typeof LCA_STATIC_CACHE_METHOD_IDENTITY_MANIFEST_SHA256;
  factor_manifest_sha256: typeof LCA_STATIC_CACHE_FACTOR_MANIFEST_SHA256;
  methods: LcaStaticCacheBundleMethod[];
  [key: string]: unknown;
};

const REVIEWED_STATIC_CACHE_BUNDLE_MANIFEST =
  reviewedStaticCacheBundleManifest as unknown as LcaStaticCacheBundleManifest;
const REVIEWED_STATIC_CACHE_METHODS_BY_IDENTITY = new Map(
  REVIEWED_STATIC_CACHE_BUNDLE_MANIFEST.methods.map((method) => [
    methodIdentityKey(method.method_id, method.method_version),
    method,
  ]),
);

export type LcaMethodFactorSourceContract = {
  schema_version: typeof LCA_METHOD_FACTOR_SOURCE_CONTRACT_SCHEMA_VERSION;
  source_kind: 'static_cache_bundle';
  bundle_manifest_path: typeof LCA_STATIC_CACHE_BUNDLE_MANIFEST_PATH;
  bundle_manifest_sha256: typeof LCA_STATIC_CACHE_BUNDLE_MANIFEST_SHA256;
  bundle_manifest: LcaStaticCacheBundleManifest;
  base_url_binding: typeof LCA_METHOD_FACTOR_SOURCE_BASE_URL_BINDING;
  evidence_schema_version: typeof LCA_METHOD_FACTOR_SOURCE_SNAPSHOT_SCHEMA_VERSION;
  snapshot_binding: {
    required: true;
    hash_algorithm: 'sha256';
    required_fields: [
      'bundle_manifest_sha256',
      'bundle_version',
      'source_snapshot_sha256',
      'method_manifest_sha256',
      'factor_manifest_sha256',
      'method_identity_manifest_sha256',
      'method_count',
    ];
  };
};

export type LciaFactorCoverageContract = {
  schema_version: typeof LCIA_FACTOR_COVERAGE_CONTRACT_SCHEMA_VERSION;
  count_unit: typeof LCIA_FACTOR_COVERAGE_COUNT_UNIT;
  require_non_empty_pair_matrix: true;
  match_key: ['method_id', 'method_version', 'flow_uuid', 'direction'];
  required_counts: ['matched', 'unmatched', 'invalid', 'unsupported_direction'];
  required_uncharacterized_fields: [
    'method_id',
    'method_version',
    'artifact_locator_id',
    'flow_uuid',
    'flow_version',
    'direction',
    'exchange_id',
    'amount',
    'reason',
  ];
  evidence_delivery: 'artifact';
  evidence_artifact_format: typeof LCIA_UNCHARACTERIZED_ARTIFACT_FORMAT;
  incomplete_when_any: ['unmatched', 'invalid', 'unsupported_direction'];
  status_field: 'coverage_status';
  complete_status: 'complete';
  incomplete_status: 'incomplete_coverage';
  missing_factor_semantics: 'incomplete_coverage_not_zero';
};

export type LciaFactorCoverageCounts = {
  matched: number;
  unmatched: number;
  invalid: number;
  unsupported_direction: number;
};

export type LcaMethodFactorSourceSnapshot = {
  schema_version: typeof LCA_METHOD_FACTOR_SOURCE_SNAPSHOT_SCHEMA_VERSION;
  source_kind: 'static_cache_bundle';
  bundle_manifest_path: typeof LCA_STATIC_CACHE_BUNDLE_MANIFEST_PATH;
  bundle_manifest_sha256: typeof LCA_STATIC_CACHE_BUNDLE_MANIFEST_SHA256;
  bundle_version: typeof LCA_STATIC_CACHE_BUNDLE_VERSION;
  source_snapshot_sha256: typeof LCA_STATIC_CACHE_SOURCE_SNAPSHOT_SHA256;
  method_manifest_sha256: typeof LCA_STATIC_CACHE_METHOD_MANIFEST_SHA256;
  factor_manifest_sha256: typeof LCA_STATIC_CACHE_FACTOR_MANIFEST_SHA256;
  method_identity_manifest_sha256: typeof LCA_STATIC_CACHE_METHOD_IDENTITY_MANIFEST_SHA256;
  method_count: typeof LCA_STATIC_CACHE_METHOD_COUNT;
};

export type LciaUncharacterizedEvidenceArtifact = {
  artifact_url: string;
  artifact_format: typeof LCIA_UNCHARACTERIZED_ARTIFACT_FORMAT;
  artifact_sha256: string;
  record_count: number;
};

export type LciaMethodFactorCoverage = {
  method_id: string;
  method_version: string;
  artifact_locator_id: string;
  counts: LciaFactorCoverageCounts;
};

export type LciaFactorCoverageEvidence = {
  schema_version: typeof LCIA_FACTOR_COVERAGE_EVIDENCE_SCHEMA_VERSION;
  source_snapshot_sha256: typeof LCA_STATIC_CACHE_SOURCE_SNAPSHOT_SHA256;
  method_manifest_sha256: typeof LCA_STATIC_CACHE_METHOD_MANIFEST_SHA256;
  factor_manifest_sha256: typeof LCA_STATIC_CACHE_FACTOR_MANIFEST_SHA256;
  method_identity_manifest_sha256: typeof LCA_STATIC_CACHE_METHOD_IDENTITY_MANIFEST_SHA256;
  count_unit: typeof LCIA_FACTOR_COVERAGE_COUNT_UNIT;
  key_dimensions: ['method_id', 'method_version', 'flow_uuid', 'direction'];
  coverage_status: 'complete' | 'incomplete_coverage';
  missing_factor_semantics: 'incomplete_coverage_not_zero';
  counts: LciaFactorCoverageCounts;
  by_method: LciaMethodFactorCoverage[];
  uncharacterized_evidence: LciaUncharacterizedEvidenceArtifact | null;
};

export type LcaCalculationEvidence = {
  schema_version: typeof LCA_CALCULATION_EVIDENCE_SCHEMA_VERSION;
  scope_manifest_sha256: string;
  lcia_method_factor_source: LcaMethodFactorSourceSnapshot;
  lcia_factor_coverage: LciaFactorCoverageEvidence;
};

export type LcaCalculationEvidenceBinding = {
  schema_version: typeof LCA_CALCULATION_EVIDENCE_SCHEMA_VERSION;
  scope_manifest_sha256: string;
  lcia_method_factor_source: LcaMethodFactorSourceSnapshot;
  lcia_factor_coverage: LciaFactorCoverageEvidence;
};

export type LcaCalculationEvidenceValidation =
  | { ok: true; evidence: LcaCalculationEvidence | null }
  | {
      ok: false;
      error:
        | 'calculation_evidence_missing'
        | 'calculation_evidence_scope_mismatch'
        | 'lcia_method_factor_source_invalid'
        | 'lcia_factor_coverage_invalid';
    };

export type SnapshotProcessFilter = {
  all_states: boolean;
  process_states?: number[];
  include_user_id?: string;
  include_user_state_codes?: number[];
  include_user_unassigned_only?: boolean;
  include_user_review_free_only?: boolean;
  scope_manifest?: LcaScopeManifest;
  scope_manifest_sha256?: string;
  selection_mode: LcaSnapshotSelectionMode;
  request_roots: LcaSnapshotRequestRoot[];
};

export type ParsedSnapshotProcessFilter = {
  allStates: boolean;
  processStates: number[];
  includeUserId: string | null;
  includeUserStateCodes: number[];
  includeUserUnassignedOnly: boolean;
  includeUserReviewFreeOnly: boolean;
  scopeManifest: LcaScopeManifest | null;
  scopeManifestSha256: string | null;
  selectionMode: LcaSnapshotSelectionMode;
  requestRoots: LcaSnapshotRequestRoot[];
};

export function parseLcaDataScope(raw: unknown): LcaDataScope {
  if (
    raw === 'open_data' ||
    raw === 'all_data' ||
    raw === 'current_user' ||
    raw === PUBLIC_PLUS_OWNER_DRAFT_SCOPE
  ) {
    return raw;
  }
  return 'current_user';
}

/**
 * Numerical-policy marker of a **proposed** snapshot filter.
 *
 * Distinct from [`rejectNonCurrentSnapshotEvidence`], which validates a persisted ready snapshot.
 * A proposed filter carrying this marker proves nothing about any stored row: it participates in
 * the request hash and in snapshot lookup, and it is deliberately **not** added to
 * `buildSnapshotBuildPayloadFields`, because Worker's payload contract does not accept it from a
 * caller. Worker authors the persisted `process_filter` at upsert time and records the marker in
 * its own `SnapshotBuildConfig`, so a marker present on a proposed filter can never authorize a
 * pre-existing artifact.
 */
export function buildSnapshotNumericalPolicyFields(): { numerical_policy_version: string } {
  return { numerical_policy_version: NUMERICAL_SNAPSHOT_POLICY_VERSION };
}

export function buildPublicPlusOwnerDraftScopeManifest(userId: string): LcaScopeManifest {
  const actorUserId = normalizeRequiredUserId(userId);
  return {
    schema_version: LCA_SCOPE_MANIFEST_SCHEMA_VERSION,
    scope: PUBLIC_PLUS_OWNER_DRAFT_SCOPE,
    predicate_version: PUBLIC_PLUS_OWNER_DRAFT_PREDICATE_VERSION,
    actor: {
      kind: 'authenticated_user',
      user_id: actorUserId,
    },
    applies_to: ['processes', 'flows'],
    predicate: {
      operator: 'or',
      clauses: [
        { state_code: { eq: PUBLIC_PROCESS_STATE } },
        {
          operator: 'and',
          clauses: [
            { user_id: { eq: actorUserId } },
            { state_code: { eq: OWNER_DRAFT_PROCESS_STATE } },
          ],
        },
      ],
    },
  };
}

export async function buildPublicPlusOwnerDraftScopeBinding(
  userId: string,
): Promise<LcaScopeBinding> {
  const manifest = buildPublicPlusOwnerDraftScopeManifest(userId);
  return {
    manifest,
    manifest_sha256: await sha256Hex(canonicalJson(manifest)),
  };
}

export async function buildSnapshotProcessFilter(
  dataScope: LcaDataScope,
  userId: string,
  requestRoots: readonly LcaSnapshotRequestRoot[] = [],
): Promise<SnapshotProcessFilter> {
  const normalizedRequestRoots = normalizeSnapshotRequestRoots(requestRoots);
  const selectionFields = {
    selection_mode:
      normalizedRequestRoots.length > 0
        ? REQUEST_ROOTS_CLOSURE_SELECTION_MODE
        : FILTERED_LIBRARY_SELECTION_MODE,
    request_roots: normalizedRequestRoots,
  } as const;

  if (dataScope === PUBLIC_PLUS_OWNER_DRAFT_SCOPE) {
    const binding = await buildPublicPlusOwnerDraftScopeBinding(userId);
    return {
      all_states: false,
      process_states: [PUBLIC_PROCESS_STATE],
      include_user_id: binding.manifest.actor.user_id,
      include_user_state_codes: [OWNER_DRAFT_PROCESS_STATE],
      scope_manifest: binding.manifest,
      scope_manifest_sha256: binding.manifest_sha256,
      ...selectionFields,
    };
  }

  // Existing scopes continue to reuse the current user-enhanced snapshot family.
  // The published candidate universe is exactly state `100`: `101..199` is a reserved
  // publication segment and the published Result state `120` is never a numerical input.
  // Root-process eligibility remains distinct and is validated per request.
  return {
    all_states: false,
    process_states: [...PUBLIC_NUMERICAL_PROCESS_STATES],
    include_user_id: userId,
    ...selectionFields,
  };
}

export function shouldAutoBuildSnapshot(dataScope: LcaDataScope): boolean {
  return (
    dataScope === 'current_user' ||
    dataScope === 'all_data' ||
    dataScope === 'open_data' ||
    dataScope === PUBLIC_PLUS_OWNER_DRAFT_SCOPE
  );
}

export type SnapshotProcessFilterRejection =
  | 'snapshot_all_states_not_numerical'
  | 'snapshot_process_filter_missing'
  | 'snapshot_process_filter_malformed'
  | 'snapshot_process_states_missing'
  | 'snapshot_published_result_process_state_not_numerical'
  | 'snapshot_review_diagnostic_process_state_not_numerical'
  | 'snapshot_retired_published_state_range_not_numerical'
  | 'snapshot_process_state_not_numerical';

export type SnapshotEvidenceRejection =
  | 'snapshot_numerical_policy_version_missing'
  | 'snapshot_numerical_policy_version_not_current'
  | SnapshotProcessFilterRejection;

/**
 * Numerical-policy marker of a **stored ready** snapshot, authored by the Worker at upsert time.
 *
 * Cross-repo contract (Worker #289 produces it): `upsert_snapshot_artifact_row` writes
 * `numerical_policy_version` into the `ready` `private.lca_network_snapshots.process_filter` object
 * with the same literal it records in the artifact's `SnapshotBuildConfig`. `Edge` reads only that
 * field from the existing `processFilter` projection — no new Database field, RPC, or metadata
 * shape is required, because `api.svc_lca_snapshot_candidates` already returns `processFilter`
 * verbatim.
 *
 * A marker is never inferred from a `100`-shaped state list. An older owner-all-states filter also
 * used `process_states = [100]`, so `process_states` alone is not policy evidence.
 */
export function parseStoredNumericalPolicyMarker(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const value = (raw as Record<string, unknown>).numerical_policy_version;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Gate for accepting a **stored** snapshot as current numerical evidence for a new calculation.
 *
 * This is deliberately separate from [`rejectNonNumericalSnapshotProcessFilter`]:
 * - the filter validator answers "is this proposed filter numerically shaped?", and a proposed
 *   filter may legitimately carry the marker without proving anything about a stored row;
 * - this validator answers "does this already-persisted ready snapshot carry current policy
 *   evidence?", and therefore requires the marker and requires it to be the current literal.
 *
 * A missing or retired marker fails closed. Historical artifact reads and administrative routes do
 * not call this function, so old bytes stay readable.
 */
export function rejectNonCurrentSnapshotEvidence(raw: unknown): SnapshotEvidenceRejection | null {
  const marker = parseStoredNumericalPolicyMarker(raw);
  if (marker === null) {
    return 'snapshot_numerical_policy_version_missing';
  }
  if (marker !== NUMERICAL_SNAPSHOT_POLICY_VERSION) {
    return 'snapshot_numerical_policy_version_not_current';
  }
  return rejectNonNumericalSnapshotProcessFilter(raw);
}

export type SnapshotEvidenceDecision =
  | { ok: true }
  | { ok: false; status: 404; error: 'snapshot_not_ready' }
  | { ok: false; status: 409; error: SnapshotEvidenceRejection };

/**
 * Whether a candidate row from `api.svc_lca_snapshot_candidates` may be used for a new calculation.
 *
 * Callers must reach this decision **before** any cached-result return or enqueue side effect, on
 * both the automatic-lookup and explicit-snapshot paths, so a non-current snapshot can never be
 * served from cache. The row shape is the existing `api.svc_lca_snapshot_candidates` projection:
 * `{ processFilter, artifact: { artifactUrl } }`. A row without a ready artifact URL is reported as
 * `snapshot_not_ready` rather than as a policy failure.
 */
export function evaluateSnapshotEvidenceForNewCalculation(
  candidate: { processFilter?: unknown; artifact?: unknown } | null | undefined,
): SnapshotEvidenceDecision {
  if (!candidate) {
    return { ok: false, status: 404, error: 'snapshot_not_ready' };
  }
  const artifact = candidate.artifact;
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return { ok: false, status: 404, error: 'snapshot_not_ready' };
  }
  const artifactUrl = (artifact as { artifactUrl?: unknown }).artifactUrl;
  if (typeof artifactUrl !== 'string' || artifactUrl.trim().length === 0) {
    // The candidate RPC only joins `status = 'ready'` artifacts, so this is a defensive check: a
    // draft enqueue row or an artifact-less row must not be treated as evidence either way.
    return { ok: false, status: 404, error: 'snapshot_not_ready' };
  }
  const rejection = rejectNonCurrentSnapshotEvidence(candidate.processFilter);
  if (rejection) {
    return { ok: false, status: 409, error: rejection };
  }
  return { ok: true };
}

/**
 * Numerical-shape admission for a **proposed** snapshot `processFilter`.
 *
 * Proposed-filter validation only. It never requires the stored-evidence marker, which is
 * Worker-authored into the stored `ready` row and is checked by
 * [`rejectNonCurrentSnapshotEvidence`]; keeping the two apart is what lets a proposed filter carry
 * lookup identity while no marker can ever authorize a stored row.
 *
 * Validates the **raw** value, not a normalized one: `parseSnapshotProcessFilter` maps an absent,
 * non-array, or empty state list to `[]`, which would admit missing or malformed evidence. A
 * positive admission therefore requires an object, an explicit boolean `all_states: false`, and a
 * non-empty integer-array `process_states`. The comma-separated string form belongs to the Worker
 * payload contract and is not accepted here.
 *
 * Owner state `0` is the owner branch of every non-versioned scope and is *not* required to be
 * listed: those scopes send only `include_user_id`, and Worker materializes owner state `0` from
 * its own predicate. When owner codes are listed explicitly they must be exactly `0` and must be
 * accompanied by an owner id. The owner/scopes contract itself lives in
 * `_shared/lca_process_scope.ts`.
 */
export function rejectNonNumericalSnapshotProcessFilter(
  raw: unknown,
): SnapshotProcessFilterRejection | null {
  if (raw === null || raw === undefined) {
    return 'snapshot_process_filter_missing';
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return 'snapshot_process_filter_malformed';
  }

  const record = raw as Record<string, unknown>;
  if (!Object.hasOwn(record, 'all_states') || typeof record.all_states !== 'boolean') {
    return 'snapshot_process_filter_malformed';
  }
  if (record.all_states) {
    return 'snapshot_all_states_not_numerical';
  }

  const processStates = parseRawStateList(record.process_states);
  if (processStates === null) {
    return 'snapshot_process_states_missing';
  }
  // `include_user_state_codes` is optional: the non-versioned scopes send only `include_user_id`
  // and the Worker materializes that as owner state `0`.
  const ownerStateCodes = Object.hasOwn(record, 'include_user_state_codes')
    ? parseRawStateList(record.include_user_state_codes)
    : [];
  if (ownerStateCodes === null) {
    return 'snapshot_process_filter_malformed';
  }
  const includeUserId =
    typeof record.include_user_id === 'string' ? record.include_user_id.trim() : '';

  const numericalStates = [...processStates, ...ownerStateCodes];
  // The retired reserved-range membership is checked first: `100..199` contains `120`, so the
  // range has to name itself instead of being reported as a single Result-state request.
  if (isRetiredNumericalStateArgument(processStates)) {
    return 'snapshot_retired_published_state_range_not_numerical';
  }
  if (numericalStates.includes(PUBLISHED_RESULT_PROCESS_STATE)) {
    return 'snapshot_published_result_process_state_not_numerical';
  }
  // The Review Admin quality diagnostic owns its own dedicated job family and runner. A generic
  // snapshot filter carrying the in-review state `20` must fail closed here rather than let a
  // caller widen the numerical universe through this module.
  if (numericalStates.includes(REVIEW_IN_PROGRESS_PROCESS_STATE)) {
    return 'snapshot_review_diagnostic_process_state_not_numerical';
  }
  if (
    processStates.some((state) => !PUBLIC_NUMERICAL_PROCESS_STATES.includes(state)) ||
    ownerStateCodes.some((state) => state !== OWNER_DRAFT_PROCESS_STATE)
  ) {
    return 'snapshot_process_state_not_numerical';
  }
  if (ownerStateCodes.length > 0 && !includeUserId) {
    return 'snapshot_process_state_not_numerical';
  }
  return null;
}

/**
 * Strict integer-list reader for a raw stored filter field.
 *
 * Returns `null` for anything that is not a non-empty array of integers. `normalizeIntegerList`
 * would instead coerce a missing, empty, or malformed value to `[]`, which is exactly the
 * fail-open behavior this guard must not inherit. The comma-separated string form is refused too,
 * because it belongs to the Worker payload contract and no writer of the persisted column
 * produces it.
 */
function parseRawStateList(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    return null;
  }
  const values: number[] = [];
  for (const item of raw) {
    if (typeof item !== 'number' || !Number.isInteger(item)) {
      return null;
    }
    values.push(item);
  }
  return values;
}

export function buildSnapshotContainsFilter(
  filter: SnapshotProcessFilter,
): Record<string, unknown> {
  const parsed = parseSnapshotProcessFilter(filter);
  const containsFilter: Record<string, unknown> = {
    all_states: parsed.allStates,
    // Any stored snapshot that can be reused for new compute must have been authored by the Worker
    // under the current numerical policy. Sending the marker in the containment filter makes the
    // candidate lookup skip pre-policy rows instead of matching them on the state list alone.
    ...buildSnapshotNumericalPolicyFields(),
  };

  if (!parsed.allStates && parsed.processStates.length > 0) {
    containsFilter.process_states = parsed.processStates;
  }
  if (!parsed.allStates && parsed.includeUserId) {
    containsFilter.include_user_id = parsed.includeUserId;
  }
  if (!parsed.allStates && parsed.includeUserStateCodes.length > 0) {
    containsFilter.include_user_state_codes = parsed.includeUserStateCodes;
  }
  if (!parsed.allStates && parsed.includeUserUnassignedOnly) {
    containsFilter.include_user_unassigned_only = true;
  }
  if (!parsed.allStates && parsed.includeUserReviewFreeOnly) {
    containsFilter.include_user_review_free_only = true;
  }
  if (!parsed.allStates && parsed.scopeManifest) {
    containsFilter.scope_manifest = parsed.scopeManifest;
  }
  if (!parsed.allStates && parsed.scopeManifestSha256) {
    containsFilter.scope_manifest_sha256 = parsed.scopeManifestSha256;
  }
  containsFilter.selection_mode = parsed.selectionMode;
  containsFilter.request_roots = parsed.requestRoots;

  return containsFilter;
}

export function buildSnapshotBuildPayloadFields(
  filter: SnapshotProcessFilter,
): Record<string, unknown> {
  const parsed = parseSnapshotProcessFilter(filter);
  const payloadFields: Record<string, unknown> = {
    all_states: parsed.allStates,
  };

  if (!parsed.allStates && parsed.processStates.length > 0) {
    payloadFields.process_states = parsed.processStates.join(',');
  }
  if (!parsed.allStates && parsed.includeUserId) {
    payloadFields.include_user_id = parsed.includeUserId;
  }
  if (!parsed.allStates && parsed.includeUserStateCodes.length > 0) {
    payloadFields.include_user_state_codes = parsed.includeUserStateCodes.join(',');
  }
  if (!parsed.allStates && parsed.includeUserUnassignedOnly) {
    payloadFields.include_user_unassigned_only = true;
  }
  if (!parsed.allStates && parsed.includeUserReviewFreeOnly) {
    payloadFields.include_user_review_free_only = true;
  }
  if (!parsed.allStates && parsed.scopeManifest && parsed.scopeManifestSha256) {
    payloadFields.data_scope = parsed.scopeManifest.scope;
    payloadFields.scope_manifest = parsed.scopeManifest;
    payloadFields.scope_manifest_sha256 = parsed.scopeManifestSha256;
    payloadFields.lcia_method_factor_source = buildLcaMethodFactorSourceContract();
    payloadFields.lcia_factor_coverage_contract = buildLciaFactorCoverageContract();
  }
  if (parsed.selectionMode === REQUEST_ROOTS_CLOSURE_SELECTION_MODE) {
    payloadFields.request_roots = parsed.requestRoots;
  }

  return payloadFields;
}

export function buildLcaMethodFactorSourceContract(): LcaMethodFactorSourceContract {
  return {
    schema_version: LCA_METHOD_FACTOR_SOURCE_CONTRACT_SCHEMA_VERSION,
    source_kind: 'static_cache_bundle',
    bundle_manifest_path: LCA_STATIC_CACHE_BUNDLE_MANIFEST_PATH,
    bundle_manifest_sha256: LCA_STATIC_CACHE_BUNDLE_MANIFEST_SHA256,
    bundle_manifest: cloneReviewedStaticCacheBundleManifest(),
    base_url_binding: LCA_METHOD_FACTOR_SOURCE_BASE_URL_BINDING,
    evidence_schema_version: LCA_METHOD_FACTOR_SOURCE_SNAPSHOT_SCHEMA_VERSION,
    snapshot_binding: {
      required: true,
      hash_algorithm: 'sha256',
      required_fields: [
        'bundle_manifest_sha256',
        'bundle_version',
        'source_snapshot_sha256',
        'method_manifest_sha256',
        'factor_manifest_sha256',
        'method_identity_manifest_sha256',
        'method_count',
      ],
    },
  };
}

export function buildLciaFactorCoverageContract(): LciaFactorCoverageContract {
  return {
    schema_version: LCIA_FACTOR_COVERAGE_CONTRACT_SCHEMA_VERSION,
    count_unit: LCIA_FACTOR_COVERAGE_COUNT_UNIT,
    require_non_empty_pair_matrix: true,
    match_key: ['method_id', 'method_version', 'flow_uuid', 'direction'],
    required_counts: ['matched', 'unmatched', 'invalid', 'unsupported_direction'],
    required_uncharacterized_fields: [
      'method_id',
      'method_version',
      'artifact_locator_id',
      'flow_uuid',
      'flow_version',
      'direction',
      'exchange_id',
      'amount',
      'reason',
    ],
    evidence_delivery: 'artifact',
    evidence_artifact_format: LCIA_UNCHARACTERIZED_ARTIFACT_FORMAT,
    incomplete_when_any: ['unmatched', 'invalid', 'unsupported_direction'],
    status_field: 'coverage_status',
    complete_status: 'complete',
    incomplete_status: 'incomplete_coverage',
    missing_factor_semantics: 'incomplete_coverage_not_zero',
  };
}

export async function validateCalculationEvidenceForDataScope(
  dataScope: LcaDataScope,
  userId: string,
  raw: unknown,
): Promise<LcaCalculationEvidenceValidation> {
  if (dataScope !== PUBLIC_PLUS_OWNER_DRAFT_SCOPE) {
    return { ok: true, evidence: null };
  }

  const binding = await buildPublicPlusOwnerDraftScopeBinding(userId);
  return validateLcaCalculationEvidence(raw, binding.manifest_sha256);
}

export function validateLcaCalculationEvidence(
  raw: unknown,
  expectedScopeManifestSha256: string,
): LcaCalculationEvidenceValidation {
  const evidence = recordValue(raw);
  if (
    !evidence ||
    !hasExactKeys(evidence, [
      'schema_version',
      'scope_manifest_sha256',
      'lcia_method_factor_source',
      'lcia_factor_coverage',
    ]) ||
    evidence.schema_version !== LCA_CALCULATION_EVIDENCE_SCHEMA_VERSION
  ) {
    return { ok: false, error: 'calculation_evidence_missing' };
  }

  const scopeManifestSha256 = normalizeSha256(evidence.scope_manifest_sha256);
  if (!scopeManifestSha256 || scopeManifestSha256 !== expectedScopeManifestSha256) {
    return { ok: false, error: 'calculation_evidence_scope_mismatch' };
  }

  const source = parseLcaMethodFactorSourceSnapshot(evidence.lcia_method_factor_source);
  if (!source) {
    return { ok: false, error: 'lcia_method_factor_source_invalid' };
  }

  const coverage = parseLciaFactorCoverageEvidence(evidence.lcia_factor_coverage);
  if (!coverage) {
    return { ok: false, error: 'lcia_factor_coverage_invalid' };
  }

  return {
    ok: true,
    evidence: {
      schema_version: LCA_CALCULATION_EVIDENCE_SCHEMA_VERSION,
      scope_manifest_sha256: scopeManifestSha256,
      lcia_method_factor_source: source,
      lcia_factor_coverage: coverage,
    },
  };
}

export function buildLcaCalculationEvidenceBinding(
  evidence: LcaCalculationEvidence,
): LcaCalculationEvidenceBinding {
  return {
    schema_version: evidence.schema_version,
    scope_manifest_sha256: evidence.scope_manifest_sha256,
    lcia_method_factor_source: evidence.lcia_method_factor_source,
    lcia_factor_coverage: evidence.lcia_factor_coverage,
  };
}

export function parseSnapshotProcessFilter(raw: unknown): ParsedSnapshotProcessFilter {
  const obj = (raw ?? {}) as {
    all_states?: unknown;
    process_states?: unknown;
    include_user_id?: unknown;
    include_user_state_codes?: unknown;
    include_user_unassigned_only?: unknown;
    include_user_review_free_only?: unknown;
    scope_manifest?: unknown;
    scope_manifest_sha256?: unknown;
    selection_mode?: unknown;
    request_roots?: unknown;
  };

  const requestRoots = normalizeSnapshotRequestRoots(obj.request_roots, { strict: false });
  const selectionMode =
    obj.selection_mode === REQUEST_ROOTS_CLOSURE_SELECTION_MODE
      ? REQUEST_ROOTS_CLOSURE_SELECTION_MODE
      : FILTERED_LIBRARY_SELECTION_MODE;

  if (obj.all_states === true) {
    return {
      allStates: true,
      processStates: [],
      includeUserId: null,
      includeUserStateCodes: [],
      includeUserUnassignedOnly: false,
      includeUserReviewFreeOnly: false,
      scopeManifest: null,
      scopeManifestSha256: null,
      selectionMode,
      requestRoots,
    };
  }

  return {
    allStates: false,
    processStates: normalizeIntegerList(obj.process_states),
    includeUserId: normalizeIncludeUserId(obj.include_user_id),
    includeUserStateCodes: normalizeIntegerList(obj.include_user_state_codes),
    includeUserUnassignedOnly: obj.include_user_unassigned_only === true,
    includeUserReviewFreeOnly: obj.include_user_review_free_only === true,
    scopeManifest: normalizeScopeManifest(obj.scope_manifest),
    scopeManifestSha256: normalizeSha256(obj.scope_manifest_sha256),
    selectionMode,
    requestRoots,
  };
}

export function matchesSnapshotDataScopeFilter(
  raw: unknown,
  expected: SnapshotProcessFilter,
): boolean {
  const actual = parseSnapshotProcessFilter(raw);
  const normalizedExpected = parseSnapshotProcessFilter(expected);

  if (actual.allStates !== normalizedExpected.allStates) {
    return false;
  }
  if (actual.includeUserId !== normalizedExpected.includeUserId) {
    return false;
  }
  if (actual.scopeManifestSha256 !== normalizedExpected.scopeManifestSha256) {
    return false;
  }
  if (!sameNumberList(actual.processStates, normalizedExpected.processStates)) {
    return false;
  }
  if (!sameNumberList(actual.includeUserStateCodes, normalizedExpected.includeUserStateCodes)) {
    return false;
  }
  if (actual.includeUserUnassignedOnly !== normalizedExpected.includeUserUnassignedOnly) {
    return false;
  }
  if (actual.includeUserReviewFreeOnly !== normalizedExpected.includeUserReviewFreeOnly) {
    return false;
  }

  return canonicalJson(actual.scopeManifest) === canonicalJson(normalizedExpected.scopeManifest);
}

export function matchesSnapshotProcessFilter(
  raw: unknown,
  expected: SnapshotProcessFilter,
): boolean {
  const actual = parseSnapshotProcessFilter(raw);
  const normalizedExpected = parseSnapshotProcessFilter(expected);

  return (
    matchesSnapshotDataScopeFilter(raw, expected) &&
    actual.selectionMode === normalizedExpected.selectionMode &&
    canonicalJson(actual.requestRoots) === canonicalJson(normalizedExpected.requestRoots)
  );
}

export function normalizeSnapshotRequestRoots(
  raw: unknown,
  options: { strict?: boolean } = {},
): LcaSnapshotRequestRoot[] {
  const strict = options.strict !== false;
  if (!Array.isArray(raw)) {
    if (strict && raw !== undefined && raw !== null) {
      throw new Error('request_roots must be an array');
    }
    return [];
  }

  const normalized: LcaSnapshotRequestRoot[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      if (strict) {
        throw new Error('request root must be an object');
      }
      continue;
    }
    const processId = String((item as { process_id?: unknown }).process_id ?? '')
      .trim()
      .toLowerCase();
    const processVersion = String(
      (item as { process_version?: unknown }).process_version ?? '',
    ).trim();
    if (!isUuid(processId) || !isTidasVersion(processVersion)) {
      if (strict) {
        throw new Error('request root must contain a valid process_id and process_version');
      }
      continue;
    }
    normalized.push({ process_id: processId, process_version: processVersion });
  }

  normalized.sort(
    (left, right) =>
      left.process_id.localeCompare(right.process_id) ||
      left.process_version.localeCompare(right.process_version),
  );
  return normalized.filter(
    (root, index) =>
      index === 0 ||
      root.process_id !== normalized[index - 1].process_id ||
      root.process_version !== normalized[index - 1].process_version,
  );
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isTidasVersion(value: string): boolean {
  return /^\d{2}\.\d{2}\.\d{3}$/.test(value);
}

export function buildSnapshotVisibilityOrExpression(
  filter: ParsedSnapshotProcessFilter,
  options: { supportsCollaborationColumns?: boolean } = {},
): string | null {
  if (filter.allStates) {
    return null;
  }

  const branches: string[] = [];
  if (filter.processStates.length > 0) {
    branches.push(`state_code.in.(${filter.processStates.join(',')})`);
  }
  if (filter.includeUserId) {
    // The owner branch always carries an explicit owner state code. An owner clause without one
    // would describe "every non-public state this actor can see", which is not the numerical
    // owner-draft rule the Worker executes. The non-versioned snapshot payload sends exactly
    // `process_states=100` plus `include_user_id`, and the Worker selects
    // `state_code = 100 OR (user_id = actor AND state_code = 0)`; this expression mirrors that
    // predicate so the freshness probe cannot be freshened by an unrelated owner state.
    const ownerStateCodes =
      filter.includeUserStateCodes.length > 0
        ? filter.includeUserStateCodes
        : [OWNER_DRAFT_PROCESS_STATE];
    const ownerClauses = [
      `user_id.eq.${filter.includeUserId}`,
      `state_code.in.(${ownerStateCodes.join(',')})`,
    ];
    if (options.supportsCollaborationColumns !== false) {
      if (filter.includeUserUnassignedOnly) {
        ownerClauses.push('team_id.is.null');
      }
      if (filter.includeUserReviewFreeOnly) {
        ownerClauses.push('review_id.is.null');
      }
    }
    branches.push(`and(${ownerClauses.join(',')})`);
  }

  return branches.length > 0 ? branches.join(',') : null;
}

function normalizeIntegerList(raw: unknown): number[] {
  const values: number[] = [];

  if (Array.isArray(raw)) {
    for (const item of raw) {
      const value = Number(item);
      if (Number.isInteger(value)) {
        values.push(value);
      }
    }
  } else if (typeof raw === 'string') {
    for (const token of raw.split(',')) {
      const value = Number(token.trim());
      if (Number.isInteger(value)) {
        values.push(value);
      }
    }
  }

  return [...new Set(values)].sort((left, right) => left - right);
}

function normalizeIncludeUserId(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }

  const value = raw.trim();
  return value.length > 0 ? value : null;
}

function normalizeRequiredUserId(raw: string): string {
  const value = raw.trim();
  if (!value) {
    throw new Error('authenticated user id is required for public_plus_owner_draft');
  }
  return value;
}

function normalizeScopeManifest(raw: unknown): LcaScopeManifest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  return raw as LcaScopeManifest;
}

function parseLcaMethodFactorSourceSnapshot(raw: unknown): LcaMethodFactorSourceSnapshot | null {
  const value = recordValue(raw);
  if (
    !value ||
    !hasExactKeys(value, [
      'schema_version',
      'source_kind',
      'bundle_manifest_path',
      'bundle_manifest_sha256',
      'bundle_version',
      'source_snapshot_sha256',
      'method_manifest_sha256',
      'factor_manifest_sha256',
      'method_identity_manifest_sha256',
      'method_count',
    ]) ||
    value.schema_version !== LCA_METHOD_FACTOR_SOURCE_SNAPSHOT_SCHEMA_VERSION ||
    value.source_kind !== 'static_cache_bundle' ||
    value.bundle_manifest_path !== LCA_STATIC_CACHE_BUNDLE_MANIFEST_PATH ||
    value.bundle_manifest_sha256 !== LCA_STATIC_CACHE_BUNDLE_MANIFEST_SHA256 ||
    value.bundle_version !== LCA_STATIC_CACHE_BUNDLE_VERSION ||
    value.source_snapshot_sha256 !== LCA_STATIC_CACHE_SOURCE_SNAPSHOT_SHA256 ||
    value.method_manifest_sha256 !== LCA_STATIC_CACHE_METHOD_MANIFEST_SHA256 ||
    value.factor_manifest_sha256 !== LCA_STATIC_CACHE_FACTOR_MANIFEST_SHA256 ||
    value.method_identity_manifest_sha256 !== LCA_STATIC_CACHE_METHOD_IDENTITY_MANIFEST_SHA256 ||
    value.method_count !== LCA_STATIC_CACHE_METHOD_COUNT
  ) {
    return null;
  }

  return {
    schema_version: LCA_METHOD_FACTOR_SOURCE_SNAPSHOT_SCHEMA_VERSION,
    source_kind: 'static_cache_bundle',
    bundle_manifest_path: LCA_STATIC_CACHE_BUNDLE_MANIFEST_PATH,
    bundle_manifest_sha256: LCA_STATIC_CACHE_BUNDLE_MANIFEST_SHA256,
    bundle_version: LCA_STATIC_CACHE_BUNDLE_VERSION,
    source_snapshot_sha256: LCA_STATIC_CACHE_SOURCE_SNAPSHOT_SHA256,
    method_manifest_sha256: LCA_STATIC_CACHE_METHOD_MANIFEST_SHA256,
    factor_manifest_sha256: LCA_STATIC_CACHE_FACTOR_MANIFEST_SHA256,
    method_identity_manifest_sha256: LCA_STATIC_CACHE_METHOD_IDENTITY_MANIFEST_SHA256,
    method_count: LCA_STATIC_CACHE_METHOD_COUNT,
  };
}

function parseLciaFactorCoverageEvidence(raw: unknown): LciaFactorCoverageEvidence | null {
  const value = recordValue(raw);
  if (
    !value ||
    !hasExactKeys(value, [
      'schema_version',
      'source_snapshot_sha256',
      'method_manifest_sha256',
      'factor_manifest_sha256',
      'method_identity_manifest_sha256',
      'count_unit',
      'key_dimensions',
      'coverage_status',
      'missing_factor_semantics',
      'counts',
      'by_method',
      'uncharacterized_evidence',
    ]) ||
    value.schema_version !== LCIA_FACTOR_COVERAGE_EVIDENCE_SCHEMA_VERSION ||
    value.source_snapshot_sha256 !== LCA_STATIC_CACHE_SOURCE_SNAPSHOT_SHA256 ||
    value.method_manifest_sha256 !== LCA_STATIC_CACHE_METHOD_MANIFEST_SHA256 ||
    value.factor_manifest_sha256 !== LCA_STATIC_CACHE_FACTOR_MANIFEST_SHA256 ||
    value.method_identity_manifest_sha256 !== LCA_STATIC_CACHE_METHOD_IDENTITY_MANIFEST_SHA256 ||
    value.count_unit !== LCIA_FACTOR_COVERAGE_COUNT_UNIT ||
    !sameStringList(value.key_dimensions, [
      'method_id',
      'method_version',
      'flow_uuid',
      'direction',
    ]) ||
    (value.coverage_status !== 'complete' && value.coverage_status !== 'incomplete_coverage') ||
    value.missing_factor_semantics !== 'incomplete_coverage_not_zero'
  ) {
    return null;
  }

  const counts = parseCoverageCounts(value.counts);
  if (!counts || !Array.isArray(value.by_method)) {
    return null;
  }
  if (value.by_method.length !== LCA_STATIC_CACHE_METHOD_COUNT) {
    return null;
  }

  const byMethod: LciaMethodFactorCoverage[] = [];
  const seenMethodIdentities = new Set<string>();
  const aggregateCounts: LciaFactorCoverageCounts = {
    matched: 0,
    unmatched: 0,
    invalid: 0,
    unsupported_direction: 0,
  };
  let exchangePairTotal: number | null = null;
  for (const rawMethod of value.by_method) {
    const method = recordValue(rawMethod);
    if (
      !method ||
      !hasExactKeys(method, ['method_id', 'method_version', 'artifact_locator_id', 'counts'])
    ) {
      return null;
    }
    const methodId = strictNonemptyString(method.method_id);
    const methodVersion = strictNonemptyString(method.method_version);
    const artifactLocatorId = strictNonemptyString(method.artifact_locator_id);
    const methodCounts = parseCoverageCounts(method.counts);
    if (!methodId || !methodVersion || !artifactLocatorId || !methodCounts) {
      return null;
    }
    const identity = methodIdentityKey(methodId, methodVersion);
    const reviewedMethod = REVIEWED_STATIC_CACHE_METHODS_BY_IDENTITY.get(identity);
    if (
      !reviewedMethod ||
      reviewedMethod.artifact_locator_id !== artifactLocatorId ||
      seenMethodIdentities.has(identity)
    ) {
      return null;
    }
    seenMethodIdentities.add(identity);

    const methodPairTotal = sumCoverageCounts(methodCounts);
    if (
      methodPairTotal === null ||
      methodPairTotal === 0 ||
      (exchangePairTotal !== null && methodPairTotal !== exchangePairTotal)
    ) {
      return null;
    }
    exchangePairTotal = methodPairTotal;
    if (!addCoverageCounts(aggregateCounts, methodCounts)) {
      return null;
    }
    byMethod.push({
      method_id: reviewedMethod.method_id,
      method_version: reviewedMethod.method_version,
      artifact_locator_id: reviewedMethod.artifact_locator_id,
      counts: methodCounts,
    });
  }
  const aggregatePairTotal = sumCoverageCounts(counts);
  if (
    seenMethodIdentities.size !== REVIEWED_STATIC_CACHE_METHODS_BY_IDENTITY.size ||
    !sameCoverageCounts(counts, aggregateCounts) ||
    aggregatePairTotal === null ||
    aggregatePairTotal === 0
  ) {
    return null;
  }

  const incompleteCount = sumIncompleteCoverageCounts(counts);
  if (incompleteCount === null) {
    return null;
  }
  if (
    (incompleteCount > 0 && value.coverage_status !== 'incomplete_coverage') ||
    (incompleteCount === 0 && value.coverage_status !== 'complete')
  ) {
    return null;
  }

  const uncharacterizedEvidence = parseUncharacterizedEvidenceArtifact(
    value.uncharacterized_evidence,
  );
  if (incompleteCount > 0 && !uncharacterizedEvidence) {
    return null;
  }
  if (incompleteCount > 0 && uncharacterizedEvidence?.record_count !== incompleteCount) {
    return null;
  }
  if (incompleteCount === 0 && value.uncharacterized_evidence !== null) {
    return null;
  }

  return {
    schema_version: LCIA_FACTOR_COVERAGE_EVIDENCE_SCHEMA_VERSION,
    source_snapshot_sha256: LCA_STATIC_CACHE_SOURCE_SNAPSHOT_SHA256,
    method_manifest_sha256: LCA_STATIC_CACHE_METHOD_MANIFEST_SHA256,
    factor_manifest_sha256: LCA_STATIC_CACHE_FACTOR_MANIFEST_SHA256,
    method_identity_manifest_sha256: LCA_STATIC_CACHE_METHOD_IDENTITY_MANIFEST_SHA256,
    count_unit: LCIA_FACTOR_COVERAGE_COUNT_UNIT,
    key_dimensions: ['method_id', 'method_version', 'flow_uuid', 'direction'],
    coverage_status: value.coverage_status,
    missing_factor_semantics: 'incomplete_coverage_not_zero',
    counts,
    by_method: byMethod,
    uncharacterized_evidence: uncharacterizedEvidence,
  };
}

function parseUncharacterizedEvidenceArtifact(
  raw: unknown,
): LciaUncharacterizedEvidenceArtifact | null {
  const value = recordValue(raw);
  if (
    !value ||
    !hasExactKeys(value, ['artifact_url', 'artifact_format', 'artifact_sha256', 'record_count'])
  ) {
    return null;
  }
  const artifactUrl = nonemptyString(value.artifact_url);
  const artifactSha256 = normalizeSha256(value.artifact_sha256);
  const recordCount = nonnegativeInteger(value.record_count);
  if (
    !artifactUrl ||
    value.artifact_format !== LCIA_UNCHARACTERIZED_ARTIFACT_FORMAT ||
    !artifactSha256 ||
    recordCount === null ||
    recordCount === 0
  ) {
    return null;
  }
  return {
    artifact_url: artifactUrl,
    artifact_format: LCIA_UNCHARACTERIZED_ARTIFACT_FORMAT,
    artifact_sha256: artifactSha256,
    record_count: recordCount,
  };
}

function cloneReviewedStaticCacheBundleManifest(): LcaStaticCacheBundleManifest {
  return JSON.parse(
    JSON.stringify(REVIEWED_STATIC_CACHE_BUNDLE_MANIFEST),
  ) as LcaStaticCacheBundleManifest;
}

function methodIdentityKey(methodId: string, methodVersion: string): string {
  return `${methodId}\u0000${methodVersion}`;
}

function parseCoverageCounts(raw: unknown): LciaFactorCoverageCounts | null {
  const value = recordValue(raw);
  if (
    !value ||
    !hasExactKeys(value, ['matched', 'unmatched', 'invalid', 'unsupported_direction'])
  ) {
    return null;
  }
  const matched = nonnegativeInteger(value.matched);
  const unmatched = nonnegativeInteger(value.unmatched);
  const invalid = nonnegativeInteger(value.invalid);
  const unsupportedDirection = nonnegativeInteger(value.unsupported_direction);
  if (matched === null || unmatched === null || invalid === null || unsupportedDirection === null) {
    return null;
  }
  return {
    matched,
    unmatched,
    invalid,
    unsupported_direction: unsupportedDirection,
  };
}

function sumCoverageCounts(counts: LciaFactorCoverageCounts): number | null {
  const total = counts.matched + counts.unmatched + counts.invalid + counts.unsupported_direction;
  return Number.isSafeInteger(total) ? total : null;
}

function sumIncompleteCoverageCounts(counts: LciaFactorCoverageCounts): number | null {
  const total = counts.unmatched + counts.invalid + counts.unsupported_direction;
  return Number.isSafeInteger(total) ? total : null;
}

function addCoverageCounts(
  target: LciaFactorCoverageCounts,
  addition: LciaFactorCoverageCounts,
): boolean {
  const next = {
    matched: target.matched + addition.matched,
    unmatched: target.unmatched + addition.unmatched,
    invalid: target.invalid + addition.invalid,
    unsupported_direction: target.unsupported_direction + addition.unsupported_direction,
  };
  if (Object.values(next).some((count) => !Number.isSafeInteger(count))) {
    return false;
  }
  Object.assign(target, next);
  return true;
}

function sameCoverageCounts(
  left: LciaFactorCoverageCounts,
  right: LciaFactorCoverageCounts,
): boolean {
  return (
    left.matched === right.matched &&
    left.unmatched === right.unmatched &&
    left.invalid === right.invalid &&
    left.unsupported_direction === right.unsupported_direction
  );
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function sameStringList(raw: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(raw) &&
    raw.length === expected.length &&
    raw.every((value, index) => value === expected[index])
  );
}

function recordValue(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function nonemptyString(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

function strictNonemptyString(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 && raw === raw.trim() ? raw : null;
}

function nonnegativeInteger(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
}

function normalizeSha256(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const value = raw.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function sameNumberList(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
