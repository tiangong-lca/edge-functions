---
title: LCA Study API v1 Contract
docType: contract
scope: repo
status: active
authoritative: true
owner: edge-functions
language: en
whenToUse:
  - when designing or consuming Study public requests, responses, permissions or revision bindings
  - when changing the P0 Study executable contract or its offline fixtures
whenToUpdate:
  - when the versioned wire shape, operation semantics, compatibility or ownership changes
  - when a runtime implementation qualifies or enables one of these capabilities
checkPaths:
  - contracts/lca-study/v1/**
  - test/lca_study_api_v1_contract_test.ts
  - test/fixtures/lca-study-api/v1/**
  - docs/agents/lca-study-api-contract.md
  - .docpact/config.yaml
lastReviewedAt: 2026-11-04
lastReviewedCommit: 6684c3fdf542fa624139cc8504b7730a527bd2de
lastReviewedNote: 'Edge #556: reviewed shared V2 archive success binding to exact Study, archived state and safe CAS successor; original receipt replay, wire literals, authorization and historical artifact identities remain unchanged.'
related:
  - ../../AGENTS.md
  - repo-architecture.md
  - repo-validation.md
  - ../../contracts/lca-study/v1/index.ts
---

# LCA Study API v1

P3 adds the separately negotiated [V4 review/finalization/share protocol](lca-study-reporting-contract.md#v4-review-finalization-and-named-shares); V1 remains offline and V2/V3 are unchanged.

Runtime W04 uses the explicit [Study v2 runtime contract](lca-study-runtime-contract.md). This P0 v1 contract and its fixtures remain offline and unchanged.

## Delivery and ownership

This contract defines the proposed authenticated Study API wire, version `lca.study-api.v1`, bundle `1.0.0`. P0 delivers strict request/response schemas, inferred TypeScript types, local request checks and offline fixture relationship checks. `CONTRACT_CAPABILITIES.runtimeEnabled` is `false`. There is no Function entrypoint, HTTP route, RPC, migration, signer, trusted receipt or production resource behind these definitions. Defining an operation is not admitting it for execution.

Edge owns public request/response shape, capability projection, transport admission and report export/share protocol. Database owns persisted identities, compare-and-swap, idempotency, resource permissions, review eligibility, grant epochs and task associations. Worker owns model compilation, numerical semantics, input/analysis/result schemas and existing calculation identity. Platform owns the independently published report view model and renderer. CLI/MCP/Platform consume the same qualified API; no consumer becomes an authorization or numerical authority.

Study results and report finalization do not acquire Release Final Result or dataset publication identity. `sourceRefSchema` distinguishes exact dataset revisions from `releaseFinalResult`; it never accepts `latest`. A final Result reference still requires the existing release reader's current authorization and publication checks.

## Encoding and compatibility

The canonical executable definitions are the seven TypeScript modules in `contracts/lca-study/v1/`. Zod is resolved through the existing exact `4.6.7` import map; P0 adds no dependency. Objects are strict, text/arrays are bounded, hashes are lowercase SHA-256 hex, IDs are opaque bounded strings, and zero is preserved. Input parsing does not normalize or recompute hashes. Numeric override values must be finite; the functional unit is a positive decimal string with an explicit unit and reference flow.

`definition.methodRefs` selects 1–32 exact `{type: datasetRevision, datasetType: lciamethod, id, version}` references in the declared order. Each current LCIAMethod represents one impact category, so a multiple-indicator Study must carry multiple references. IDs are unique: duplicate exact references and different versions of the same category are both rejected. There is no scalar `methodRef` shadow or implicit latest selection. These references do not invent a dataset JSON hash or factor identity; W05 Worker owns the actual method/factor selection, content identity and qualified calculation inputs.

The envelope contains `schemaVersion`, `requestId`, and `operation`. Every mutating intent also contains `idempotencyKey`. A CAS target is `{type, id, expectedRevision}`. `revision` is a positive aggregate generation, not a semantic version or display ordinal. Each operation identifies exactly one mutable target. Changing `Study.currentRevisionId` uses `study.select_revision` and the Study generation; it cannot silently reuse the selected revision's generation.

Unknown versions return `UNSUPPORTED_SCHEMA`; unknown operations/fields and malformed input return `INVALID_REQUEST`. Request errors expose only fixed codes, rule IDs and paths, never submitted values, credentials or provider errors. The versioned response error contains `code`, a sanitized `message`, `retryable` and bounded `issues`. Runtime handlers must map these explicitly; P0 does not modify the existing `commandError` envelope.

All shape, discriminator and enum changes are compatibility changes. V1 consumers are entitled to reject unknown fields, so adding a field is not automatically compatible. Publish a new negotiated schema/bundle version for a changed wire, retain reads of already issued versions, and reject unavailable mutations explicitly. The current v1 source/fixture bundle has no deployed-client compatibility window to retire. A runtime release must name its admitted versions, enabled operations/profiles and retirement window before client adoption; missing capability is not permission to try a fallback.

The source bundle is reviewed and pinned by an exact Edge commit. A future owner-produced distributable must bind these sources, dependency identity, fixtures and contract version in a verifiable immutable release manifest. Consumers qualify that artifact rather than importing a sibling checkout or an internal deployed Function path. P0 neither publishes a registry package nor claims that an unbuilt archive or local checksum establishes release trust.

## Operations and runtime permissions

The actual declared operation list is exported as `OPERATIONS` and each operation has a legal fixture. The following permissions are requirements on the future runtime, not claims proved by parsing a request.

| Operations | Required live runtime admission |
| --- | --- |
| `capability.read` | Verify the actor/client and return only the selected deployment's admitted versions, profiles and operations |
| `study.create` | Derive the personal owner from JWT; team creation requires current team permission; never accept a caller-supplied owner/actor |
| `study.read/list`, `study.resources.list`, `revision.read`, `scenario.read`, `run.read`, `analysis.read`, `report.read` | Current access to every exact Study/resource and requested disclosure scope; bounded list/read recovery does not confer raw Study access through a report share |
| `model.source.resolve` | Current Study edit/source access and an authorized exact LifecycleModel exporter/resolver; issue an immutable typed source snapshot only after licensing and source identity checks |
| `model.prepare/read` | Current Study model capability and access to the exact resolved source; enable only with a qualified Worker producer/profile and owned job adapter |
| `study.archive`, `study.select_revision` | Current Study edit capability and the Study CAS target; head revision must belong to that Study |
| `revision.create/save/freeze` | Current edit/freeze capability; require the explicit same-Study completed `modelPreparationId` and its exact Worker-issued model reference, method/source bindings; saved content is draft, frozen content produces a new revision to change |
| `scenario.create/save/freeze` | Current Study edit/freeze capability; exact frozen base; freeze explicitly selects a completed preparation bound to this draft's CAS/content and qualified Worker override semantics |
| `run.submit/cancel` | Current compute/cancel capability; exact frozen Study/Scenario/model input, accepted calculation contract/profile and resource budget; cancellation follows the existing job arbiter |
| `analysis.request` | Current analysis capability and access to every exact Run; comparison profile must establish comparability |
| `report.create/save/freeze/finalize` | Current report capability, exact facts/content and profile; finalization additionally rechecks current reviewer grants and profile requirements |
| `review.record` | Exact frozen report/hash, current review capability, review class and real authorization evidence; independent review additionally separates reviewer from author |
| `export.request/read` | Current export capability, source license and complete serialized disclosure policy, exact report/facts/renderer/resource bindings and current grant epoch |
| `share.create/read/revoke` | Current share/recipient capability, exact allowed export/projection, epoch, expiry and revocation; resource reads reauthorize on every access |

Future endpoints must authenticate before paid or domain work using the existing JWT boundary, even though deployment tooling uses `--no-verify-jwt`. The current MCP server is a stateless Supabase OAuth resource server; it forwards the same Supabase actor access token, which Edge independently verifies. Service credentials, a local schema pass, an Agent-written approval sentence or an arbitrary `authorizationEvidenceRef` do not grant a Study role. If independent review or another operation is unimplemented/unqualified, return `CAPABILITY_UNAVAILABLE`; never downgrade it to another class.

Database remains authoritative through `api` façades. No new direct table writes, service-client permission bypass, dataset-review reuse or separate task queue is defined here. Idempotency is bound to actor, operation, Study and exact intent. Repeating the same key/content reads the same outcome; differing content returns `IDEMPOTENCY_CONFLICT`. CAS failure returns `REVISION_CONFLICT`, never overwrite/retry. Frozen content updates return `FROZEN_REVISION`. These atomic/live guarantees require Database implementation; the Edge fixture precondition helper is not a substitute.

`revision.create/save` persists draft `validation: not_checked`; save applies the selected qualified model/preparation and definition together and resets that marker. `revision.freeze` synchronously validates the same current CAS, content identity, model/preparation, definition and ordered exact method references through a qualified server-owned validator. Missing validation capability returns `CAPABILITY_UNAVAILABLE`, structural rejection returns `INVALID_REQUEST`, and source/model/method binding rejection returns `REFERENCE_MISMATCH`. No failure freezes the revision, writes `passed`, or partially updates its durable fields. Success atomically commits `status: frozen` and `validation: passed` with the generation change. Validation failure/unavailability are error outcomes, not durable `failed`/prevalidated-draft states; the unpublished v1 retains only `not_checked|passed`. Requests cannot submit validation evidence or a passed marker. Existing idempotent readback is separate from admitting a new freeze mutation.

`passed` means structural/exact-identity/qualified-producer binding checks completed. It is not scientific applicability approval, complete LCIA factor coverage, or a replacement for Worker diagnostics/research review. In particular, missing factors retain the Worker's diagnostic/non-gate policy. P0 defines no new background validation service or endpoint. `RevisionFreezeFixtureEvidence` is only a synthetic internal test seam carrying the exact target/CAS/hash/model/definition binding and `passed|failed|unavailable` outcome; it neither establishes a real trusted validator nor permits a caller to manufacture authorization.

## Model reference production and recovery

No existing public interface issues a production Study ModelRevision today. P0 freezes the missing producer boundary instead of admitting fixture-created model IDs. The planned public flow is `study.create` → `model.source.resolve` → `model.prepare`/`model.read` → `revision.create` → revision freeze → Scenario draft → Scenario `model.prepare`/`model.read` → Scenario freeze → Run. A new private foreground LifecycleModel can first use the existing authorized TIDAS draft authoring path; this contract adds no competing graph-editing or numerical schema.

`model.source.resolve` takes a Study and an exact LifecycleModel dataset ID/version, then returns a `modelSourceSnapshot` with immutable snapshot ID, original identity, `sourceArtifactRef`, `digestScope: artifact_bytes_sha256`, source issuer, license reference and observation time. W04 Edge owns authorized source resolution and the qualified exporter/protocol selection. The source digest is SHA-256 of those exact immutable exported artifact bytes. W05 verifies the artifact bytes and their embedded TIDAS origin ID/version before compilation, and freezes the complete authorized dependency closure in its own input contract. A model source file digest alone does not prove that closure. If no qualified authorized exporter/snapshot issuer exists, resolution returns `CAPABILITY_UNAVAILABLE`; it must not temporarily hash a CLI/API JSON wrapper, use local benchmark documents, or invent a JSON sorting algorithm.

`model.prepare` takes one of two sources: `{type: modelSourceSnapshot, snapshotId, contentHash, digestScope: artifact_bytes_sha256}` or `{type: scenarioRevision, scenarioRevisionId, expectedRevision, contentHash}`. The latter pins the current draft's CAS/content under the Database-owned Study revision identity protocol. W03 must freeze/version that revision protocol before admission; Edge does not derive it from arbitrary reserialization. Profile and existing `calculationContractRef` are explicit. The response `modelPreparation` binds source, Study, profile, calculation identity and an existing `worker_jobs` execution projection. Its `modelRef`, `inputArtifactRef` and `inputHash` are null before completion; only the qualified W05 Worker producer issues them through the reviewed owned-task result path. Base LifecycleModel preparation may leave `inputHash` null; completed Scenario preparation must issue the frozen Run-input identity because the exact Study functional unit, ordered method selection and overrides are then known. `run.submit.expectedInputHash` comes from that public preparation result, and the resulting Run binds the same value. The client cannot submit a prepared model result, guess an input hash from an artifact/wrapper, or mark a preparation completed.

`modelRef.contentHash` has `digestScope: worker_prepared_model`: W05 owns the formal normalized model schema, exact source closure, profile/calculation bindings and versioned fingerprint rules. This is a future qualified producer protocol, not an algorithm implemented by P0. `inputArtifactRef.contentHash` has the distinct artifact-byte domain and verifies actual prepared-input bytes. Neither source bytes, prepared-input file bytes, Database revision identity nor existing calculation fingerprint can be relabeled as a prepared model hash. `source-fingerprint:v5` and Worker's internal JSON hash helpers are not public Study source digest protocols.

StudyRevision explicitly records the completed `modelPreparationId`; same-Study identity/hash equality is mandatory. Model provenance across StudyRevision → preparation → Scenario/base revision or source snapshot, together with both StudyRevision and ScenarioRevision parent edges, must be acyclic and terminate in an existing source snapshot. All branch parents are distinct, same-Study and frozen; edit a draft with save instead of branching from it. A later StudyRevision may adopt an older Scenario's qualified preparation, but a revision cannot bootstrap itself through its own Scenario or a mixed parent/producer cycle. Scenario drafts have null `modelPreparationId` and `effectiveModelRef`. Preparation may complete against a draft without mutating it. `scenario.freeze` supplies the ready preparation ID, expected content hash and the draft CAS target. Its source must match that exact draft; freeze increments the aggregate generation once, so the retained preparation's `source.expectedRevision` is the frozen Scenario's generation minus one. Content identity does not change just because the status freezes. Frozen Scenarios retain the selected preparation and exact effective model; a Run binds that same preparation, profile, calculation identity and model. Changing overrides requires a new preparation for the changed draft. Unselected completed/failed preparations retain their immutable older draft CAS/content as audit history after a save; they are not required to match current content and cannot freeze the newer draft. Source existence/Study and non-future generation checks still apply, and current-generation or selected preparation bindings remain exact. These checks bind provenance; they do not qualify an actor, producer or numerical result from a fixture alone.

The implementation plan owners are W03 Database persistence/atomic invariants, W04 Edge API and source resolver, W05 Worker compiler/model-reference producer, W06 task adaptation, and W07 CLI. These modules can be developed against the P0 contracts in parallel; executable end-to-end admission depends on W05 producer qualification and W06 task wiring. W04 must advertise unavailable capabilities until those exact contracts/profiles are qualified. P0 does not imply that W03–W06 can finish independently of that dependency.

Closing a chat does not lose server-side identities. `study.list` discovers currently authorized Studies; `study.resources.list` selects one Study and one typed resource kind. Both require an explicit limit of 1–100 and nullable opaque cursor; there is no query DSL. `revision.read`, `scenario.read` and `model.read` recover exact records. A resource page contains only its declared kind/Study, unique identities and an optional next cursor; response validation also binds request ID, selected kind/Study, page limit and exact read identity. Study pages reject duplicate Study IDs.

The future Database/API pagination implementation uses stable ascending opaque resource identity within a selected kind, with a cursor bound to authenticated actor/client, schema version, Study/kind selection, ordering and access epoch/expiry. Changing selection or authorization must not reuse a cursor; reauthorize every page. Cursor internals remain server-owned and are not validated by the offline shape checker. Pagination makes no transaction-snapshot or total-history completeness claim while resources/permissions change; callers can restart a bounded scan and resolve known IDs directly.

## Object and state bindings

| Object | State and exact relationship |
| --- | --- |
| Study | `active/archived`; owner/team scope and optional exact current revision; lifecycle is separate from result/review/publication state |
| ModelSourceSnapshot | Immutable exact LifecycleModel origin and licensed authorized artifact-byte snapshot; a source identity is not a compiled model |
| ModelPreparation | Existing job statuses; null result references before completion, then Worker-issued model/input identities; source, profile and calculation bindings remain immutable |
| StudyRevision | `draft/frozen`, validation `not_checked/passed`; a draft is not checked, successful synchronous freeze atomically records passed validation, exact definition/model and a distinct frozen parent if present |
| ScenarioRevision | `draft/frozen`; exact frozen StudyRevision and unique explicit override paths; drafts have no frozen model, freeze binds the ready preparation/effective model; changes create a new revision after freeze |
| Run | Immutable intent with exact Study/Scenario/effective model and input hash; execution is the existing job status projection; completed results and current validity are separate facts |
| Analysis | `requested/ready/failed`; exact same-Study Runs, profile/config and a separately typed Worker facts reference; ready comparison requires completed Runs and `comparable` |
| ReportRevision | `draft/frozen`; exact Runs/Analyses/facts and content/template identity; finalization separately records profile, review requirement, time and exact review snapshot |
| Review | Append-only `comment/approve/request_changes/withdraw`; exact frozen report/hash, actor/client, `self/internal/independent`, authorization evidence and time; substantive decisions form one explicit chain per target/actor/class, annotations do not supersede |
| ReportExport | `requested/ready/failed/expired`; exact frozen report, disclosed projection, facts, renderer/view-model/resources and policy/actor/grant epoch; ready requires an allowed disclosure and receipt envelope |
| ReportShare | `active/revoked/expired`; exact export/report/projection/epoch and one identified recipient; only report viewing and export download are grantable, not Study or raw Run access |

Source, model, report and artifact references are typed; internal object keys, buckets, long-lived download locators and tokens are rejected. A reference hash is a binding supplied by its owning producer, not proof that the parser fetched or hashed those bytes. The same artifact/model ID cannot have contradictory metadata/content identities in one fixture graph. Artifact references must match the kind required by each relation. Worker facts and Platform content/view payloads remain opaque references here: P0 does not manufacture their future schema definitions or inspect numerical/prose correctness.

The Run `calculationContractRef` is exactly:

```json
{
  "kind": "calculation_contract",
  "schema": "lca.calculation-contract.v1",
  "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
}
```

The sample digest is synthetic. Real `sha256` is the existing Worker's `calculation_contract::fingerprint()`, over the exact bytes of its existing `descriptor()` serialization. Edge stores/compares this opaque identity; it must not recanonicalize the JSON, reproduce descriptor fields or invent an artifact ID. `engineId` is `solver-worker`. `lca.study-deterministic-p0.v1` is an offline qualification profile, not an enabled engine/API or replacement calculation identity. Recompute input/closure/algorithm hashes only in their owning contracts.

Run job states preserve `queued/running/waiting/completed/blocked/stale/failed/cancelled`. A completed Run has a typed result reference; other states do not expose a final result. `validity` separately records `current/superseded/withdrawn/unknown`, check time and reasons. A withdrawal does not rewrite a past successful job. Detailed progress, artifacts and cancellation remain under the existing job and Worker contracts, not a new Study scheduler.

An unreviewed report may freeze. Finalization under a no-review profile remains explicitly unreviewed and cannot claim independent approval. Substantive review decisions form one explicit single chain for each actor, exact target/hash and review class: the first approve/request-changes has null `supersedesReviewId`, every later approve/request-changes/withdraw references that chain's current head, and withdraw cannot be first. Cross-target/class/actor links, forks and disconnected roots are rejected. Comments have null supersession, are annotations outside that chain, and never change approval status. Wire `approve/request_changes/withdraw` maps to Database's `approved/changes_requested/withdrawn`; this explicit translation does not create a second latest-decision policy. A profile requiring internal or independent review binds the exact qualifying head approval IDs and `finalizedAt`; a new finalization rechecks current reviewer authority and heads. A later withdrawal or permission loss preserves historical finalization/export snapshots but affects current approval/validity/access. The graph checker verifies only the supplied decision chronology and identity relationships, not current membership or who actually authorized an action.

Every Study grant change increments Database's grant epoch under the v1 conservative policy. Historical exports/shares remain audit records, but new access requires current epoch equality and live rights; old projections/receipts need regranting. Static reference consistency applies to every Share, including expired/revoked history; the ready/allowed Export access gate applies only to active Shares. An expired Export can therefore retain correctly bound expired/revoked Share audit records without authorizing new access. Epoch equality alone does not establish source permission: Export also binds `policyId`, `disclosureContextHash` and actor, and every new download/share must recheck the current Edge-owned source-rights/license context. Historical receipt recovery is not authority to return a previously complete projection. Shares never follow latest or grant the whole Study. Expiry/revocation denials are externally `FORBIDDEN` without disclosing private grant facts.

Export disclosure applies to complete serialized content, embedded drill-down data and attachments. The receipt envelope plans `Ed25519`, independently identified `keyId` and an export binding hash covering exact report, facts, projection, renderer/resources, actor/policy/epoch and historical review/validity snapshots. Signer, canonical receipt bytes, keys, trust-anchor distribution, cryptographic verification and serialized disclosure inspection require a later qualified export implementation. Synthetic fixture signatures and digest syntax are not trusted signatures or license evidence. Offline copies cannot be recalled through later share revocation.

## Validation levels and evidence

1. **Structure/local intent:** strict wire shapes, bounds, typed references, finite numbers and unique local lists. `validateRequest` returns a safe projection and stable redacted errors. A structurally valid save can still target frozen content.
2. **Static fixture relationships:** `validateFixtureGraph` checks supplied exact identities, same-Study links, frozen bases, result/facts states, lineage cycles, review chronology, export/share binding and an explicitly supplied observation time. `validateFixturePrecondition` compares supplied CAS/hash/frozen state. Neither helper mutates state, resolves actor grants, verifies signatures/licenses, downloads blobs or establishes a current database snapshot.
3. **Future runtime enforcement:** current JWT/client/resource permissions, atomic CAS/idempotency, current grant/reviewer state, source license/visibility, actual Worker identities and facts, stored-byte integrity, signing/trust and endpoint behavior. P0 does not prove this level.

The full two-scenario fixture includes every public resource. Negative request and graph fixtures name an expected stable rule/code rather than merely asserting rejection. Additional tests exercise historical review withdrawal, unreviewed finalization, every job status, numerical zero, unknown values, safe errors and response projections. All fixture accounts, hashes, keys and signatures are synthetic. No live provider, database or user credentials are used.

Run the focused suite with:

```bash
deno test --config supabase/functions/deno.json --allow-read test/lca_study_api_v1_contract_test.ts
```

The top-level test imports the pure contract modules, so the existing Deno graph/default test inventory includes them without a Function entrypoint. The ordinary `pnpm lint`, `pnpm check` and strict Docpact checks remain required. Local fixture success does not deploy an API, qualify RLS, prove a real signer, publish a package, or authorize production work.

## P2 reporting contract preparation

The [reporting and portable consumer contract](lca-study-reporting-contract.md) owns pure V2 codec distribution and the separate V3 reporting/signature source protocol. The handler now shares V2 response selection validation with installed consumers. P2 producer integration, actual consumer qualification and immutable artifact publication remain in progress; source schemas and crypto tests enable no hosted operation, grant or signing key.

V5 advanced profiles are governed by [the advanced contract](lca-study-advanced-contract.md). Older version literals and historical artifacts are retained; new numerical schemas and report families require explicit negotiation.
