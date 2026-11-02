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
lastReviewedAt: 2026-11-02
lastReviewedCommit: e88449593f8cbd57c3a08b35ca4368789371673f
lastReviewedNote: 'Edge #521 P0: versioned wire definitions and offline relationship fixtures only; no Study endpoint, migration, deployment, signer, runtime authorization or numerical capability is enabled.'
related:
  - ../../AGENTS.md
  - repo-architecture.md
  - repo-validation.md
  - ../../contracts/lca-study/v1/index.ts
---

# LCA Study API v1

## Delivery and ownership

This contract defines the proposed authenticated Study API wire, version `lca.study-api.v1`, bundle `1.0.0`. P0 delivers strict request/response schemas, inferred TypeScript types, local request checks and offline fixture relationship checks. `CONTRACT_CAPABILITIES.runtimeEnabled` is `false`. There is no Function entrypoint, HTTP route, RPC, migration, signer, trusted receipt or production resource behind these definitions. Defining an operation is not admitting it for execution.

Edge owns public request/response shape, capability projection, transport admission and report export/share protocol. Database owns persisted identities, compare-and-swap, idempotency, resource permissions, review eligibility, grant epochs and task associations. Worker owns model compilation, numerical semantics, input/analysis/result schemas and existing calculation identity. Platform owns the independently published report view model and renderer. CLI/MCP/Platform consume the same qualified API; no consumer becomes an authorization or numerical authority.

Study results and report finalization do not acquire Release Final Result or dataset publication identity. `sourceRefSchema` distinguishes exact dataset revisions from `releaseFinalResult`; it never accepts `latest`. A final Result reference still requires the existing release reader's current authorization and publication checks.

## Encoding and compatibility

The canonical executable definitions are the six TypeScript modules in `contracts/lca-study/v1/`. Zod is resolved through the existing exact `4.6.7` import map; P0 adds no dependency. Objects are strict, text/arrays are bounded, hashes are lowercase SHA-256 hex, IDs are opaque bounded strings, and zero is preserved. Input parsing does not normalize or recompute hashes. Numeric override values must be finite; the functional unit is a positive decimal string with an explicit unit and reference flow.

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
| `study.read`, `run.read`, `analysis.read`, `report.read` | Current access to the exact Study/resource and requested disclosure scope |
| `study.archive`, `study.select_revision` | Current Study edit capability and the Study CAS target; head revision must belong to that Study |
| `revision.create/save/freeze` | Current edit/freeze capability; validate exact model/method/source bindings; saved content is draft, frozen content produces a new revision to change |
| `scenario.create/save/freeze` | Current Study edit/freeze capability; exact frozen base; resolve overrides using the qualified Worker input semantics |
| `run.submit/cancel` | Current compute/cancel capability; exact frozen Study/Scenario/model input, accepted calculation contract/profile and resource budget; cancellation follows the existing job arbiter |
| `analysis.request` | Current analysis capability and access to every exact Run; comparison profile must establish comparability |
| `report.create/save/freeze/finalize` | Current report capability, exact facts/content and profile; finalization additionally rechecks current reviewer grants and profile requirements |
| `review.record` | Exact frozen report/hash, current review capability, review class and real authorization evidence; independent review additionally separates reviewer from author |
| `export.request/read` | Current export capability, source license and complete serialized disclosure policy, exact report/facts/renderer/resource bindings and current grant epoch |
| `share.create/read/revoke` | Current share/recipient capability, exact allowed export/projection, epoch, expiry and revocation; resource reads reauthorize on every access |

Future endpoints must authenticate before paid or domain work using the existing JWT boundary, even though deployment tooling uses `--no-verify-jwt`. A remote MCP bearer is independently verified by Edge. Service credentials, a local schema pass, an Agent-written approval sentence or an arbitrary `authorizationEvidenceRef` do not grant a Study role. If independent review or another operation is unimplemented/unqualified, return `CAPABILITY_UNAVAILABLE`; never downgrade it to another class.

Database remains authoritative through `api` façades. No new direct table writes, service-client permission bypass, dataset-review reuse or separate task queue is defined here. Idempotency is bound to actor, operation, Study and exact intent. Repeating the same key/content reads the same outcome; differing content returns `IDEMPOTENCY_CONFLICT`. CAS failure returns `REVISION_CONFLICT`, never overwrite/retry. Frozen content updates return `FROZEN_REVISION`. These atomic/live guarantees require Database implementation; the Edge fixture precondition helper is not a substitute.

## Object and state bindings

| Object | State and exact relationship |
| --- | --- |
| Study | `active/archived`; owner/team scope and optional exact current revision; lifecycle is separate from result/review/publication state |
| StudyRevision | `draft/frozen`, validation `not_checked/passed/failed`; a frozen revision requires passed validation, exact definition/model and a distinct frozen parent if present |
| ScenarioRevision | `draft/frozen`; exact frozen StudyRevision, unique explicit override paths and an effective model identity; changes create a new revision after freeze |
| Run | Immutable intent with exact Study/Scenario/effective model and input hash; execution is the existing job status projection; completed results and current validity are separate facts |
| Analysis | `requested/ready/failed`; exact same-Study Runs, profile/config and a separately typed Worker facts reference; ready comparison requires completed Runs and `comparable` |
| ReportRevision | `draft/frozen`; exact Runs/Analyses/facts and content/template identity; finalization separately records profile, review requirement, time and exact review snapshot |
| Review | Append-only `comment/approve/request_changes/withdraw`; exact frozen report/hash, actor/client, `self/internal/independent`, authorization evidence and time; supersession stays on the same target/actor and is acyclic |
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

An unreviewed report may freeze. Finalization under a no-review profile remains explicitly unreviewed and cannot claim independent approval. A profile requiring internal or independent review binds the exact qualifying approval IDs and `finalizedAt`; future finalization rechecks reviewer authority and current decisions. A later withdrawal or permission loss preserves historical finalization/export snapshots but affects current approval/validity/access. The graph checker verifies only the supplied decision chronology and identity relationships, not current membership or who actually authorized an action.

Every Study grant change increments Database's grant epoch under the v1 conservative policy. Historical exports/shares remain audit records, but new access requires current epoch equality and live rights; old projections/receipts need regranting. Epoch equality alone does not establish source permission: Export also binds `policyId`, `disclosureContextHash` and actor, and every new download/share must recheck the current Edge-owned source-rights/license context. Historical receipt recovery is not authority to return a previously complete projection. Shares never follow latest or grant the whole Study. Expiry/revocation denials are externally `FORBIDDEN` without disclosing private grant facts.

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
