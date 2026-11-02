---
title: LCA Study Runtime v2 Contract
docType: contract
scope: repo
status: active
authoritative: true
owner: edge-functions
language: en
whenToUse:
  - when implementing or consuming the authenticated Study runtime
  - when qualifying a Study operation, producer, profile or artifact boundary
whenToUpdate:
  - when runtime transport, admission, RPC, source acquisition or artifact semantics change
checkPaths:
  - contracts/lca-study/v2/**
  - supabase/functions/app_lca_study/**
  - supabase/functions/_shared/study/**
  - test/study_runtime_test.ts
  - docs/agents/lca-study-runtime-contract.md
lastReviewedAt: 2026-11-03
lastReviewedCommit: 8935708af2d9299ac5d3f5f91d45fb711c247a59
lastReviewedNote: 'Edge #536: runtime v2 adapter and synthetic transport proof; deployment and qualified cross-repository execution remain separate acceptance gates.'
related:
  - lca-study-api-contract.md
  - repo-validation.md
  - ../../contracts/lca-study/v2/index.ts
---

# Study runtime v2

`app_lca_study` accepts authenticated POST JSON under `lca.study-api.v2`, bundle `2.0.0`. Offline P0 `lca.study-api.v1` and its fixtures remain unchanged and are rejected by this endpoint. Version 2 explicitly changes source acquisition, profiles, typed artifact retrieval, supported overrides and team resource grants. It does not negotiate v1 execution or fall back to a legacy numerical route.

## Transport and admission

OPTIONS uses shared CORS without actor/domain work. Other methods return 405. POST verifies a Supabase actor JWT through the existing claims-first boundary before reading domain input. A service API key is not an actor. CLI/MCP carry the same actor access token; no password exchange, private queue or alternate bearer classifier is added.

The body is bounded at 256 KiB of actual bytes, including chunked requests, and must be UTF-8 JSON with `application/json` (optionally UTF-8 charset). One 25-second deadline and request cancellation signal cover authentication, body, RPC and artifact work. Timeout returns `DEADLINE_EXCEEDED`; the SDK requests and stream reader receive cancellation. A synchronous callback is not a qualified runtime dependency.

Every JSON response has version/request identity, `ok` and a strict resource/error union. A valid submitted request ID is echoed after authentication and bounded parsing; malformed or unauthenticated envelopes receive a server-generated ID. HTTP errors retain this v2 envelope, including 401, 405, 413 and 504. Errors contain fixed codes/rules/messages, never SQL/provider details, input values or credentials. Responses use `Cache-Control: no-store`. Unknown schema is `UNSUPPORTED_SCHEMA`; input shape/intent errors are `INVALID_REQUEST`.

`STUDY_RUNTIME_CONFIG` is a strict JSON deployment allowlist with `{type: capabilities, contractVersion: 2.0.0, runtimeEnabled, operations, profiles}`. Each profile is `{profileId, calculationContractRef}`. Missing configuration disables domain operations and admits only authenticated capability read. The database's actor-specific capability projection further narrows this list; it cannot expand deployment admission. Defining a profile or having a parser does not qualify it. Enable only exact Database/Worker/Edge revisions, producer protocol, task wiring and numerical evidence qualified together.

P1 supports Study/Revision/Scenario/source acquisition/preparation/Run recovery and typed artifact retrieval. Analysis, report, review, export and ReportShare production are unavailable. Their v2 request shapes remain recognized so unsupported work fails explicitly; no independent review is downgraded. P1 `member.set` manages Study team grants, not report disclosure: owner-only, current same-team eligible recipients, `editor|viewer|null`, Study CAS and live revocation. Personal Studies remain owner-only; no anonymous grant, account discovery or automatic team grant exists. Database owns current membership and resource-role checks on every command, read, receipt replay and grant update.

## RPC and producer boundaries

Actor reads use `api.qry_study_v1(p_request)`; writes use `api.cmd_study_v1(p_request)`. Their internal function version is independent of the public wire. The SDK forwards the original verified actor Bearer and selects `api`; no actor ID or producer evidence is accepted in public requests. RPC replies are `{ok:true,data:<variant>}` or `{ok:false,code:<fixed Study code>}`. Database owns live permissions, cursor binding, content identity, idempotency, locking, CAS and worker-job transactions. Edge validates the returned variant and its selected identities before disclosure. Reads never submit jobs.

`revision.freeze` obtains a database-minted short-lived `{kind: revisionValidationIntent, intentId, expiresAt, revision, preparation}`. Edge compares the exact CAS/hash/model/definition/preparation and qualified profile. Its server validator obtains the prepared input through an actor-authorized artifact capability, verifies the original bytes and strict Worker `lca.study-prepared-input.v1` wire, and checks model/profile/calculation identities, exact method ID/version membership, reference flow/unit and bounded positive functional amount. Worker owns model compilation and fingerprints; Edge does not recompute them. `PreparedInput.sourceHash` binds exact Worker SourceInput bundle bytes, not the exporter snapshot bytes; W06 owned-task provenance must bind those distinct domains. Normalized source identities retain only eligibility state 0 or 100, not actor/owner IDs, and explicit amount overrides remain in model provenance. Base preparation has no study binding; adoption of a prior Scenario preserves its historical binding. A new Scenario compilation binds its frozen Study definition and selected order.

Only the service client calls `svc_study_revision_freeze_consume_v1(p_intent_id,p_outcome,p_error_code)`. Database consumes the bound intent under the current original actor/client/grant and target lock, rejecting changed content, expired intent or withdrawn authority before atomically storing frozen/passed. Actor requests cannot send an intent, validation outcome or passed marker. Failure/unavailability does not freeze or persist a failed validation state. `passed` is structural/identity qualification, not scientific applicability or factor completeness. Missing factors remain Worker diagnostics.

Model preparation and Run completion use existing owned `worker_jobs`; worker leases and trusted service callbacks install producer results. No public request may set `completed`, model/input hashes or a result artifact. Study team reads/cancellation use the Study façade rather than the generic requester-only worker endpoint. W06 owns exact lease fencing, cancellation/late-result arbitration and task registration.

## Resumable source acquisition and artifacts

`model.source.resolve` retains exact `{studyId, originRef}` input but returns `modelSourceAcquisition` with `{acquisitionId, studyId, originRef, execution:{jobId,status}, snapshot}`. `model.source.read` recovers an acquisition by ID; typed Study resource pages also enumerate acquisitions. Only completed acquisition has a nonnull immutable snapshot, and its Study/origin must match exactly. Failed/queued acquisitions expose no manufactured hash. Server-owned exporter/task mechanisms must bind authorized exact versions, original artifact bytes, issuer and licensing before service completion. A mutable API wrapper, normalization fallback or synthetic specimen cannot issue a source identity. Resolution is enqueue/read recovery, never an infinite blocking export.

For snapshot-source `model.prepare`, ordered exact `methodRefs` are required before the StudyRevision exists. Scenario-source preparation must omit that field and derive methods from the frozen StudyRevision. Every v2 preparation readback retains its exact ordered `methodRefs`, including pending records, so recovery does not depend on a vanished chat/request body. A StudyRevision adopts that exact stored selection. The first qualified `lca.study-explicit-v1` override grammar is only `/instances/{id}/exchanges/{exchangeInternalId}/amount` with finite numeric replacement; unsupported provider/parameter/boolean/null operations fail. Worker owns all interpretation and numerical limits.

`artifact.read` selects one Study and exact typed artifact descriptor, never a URL/bucket/object key. Database returns an internal `{kind: artifactCapability, studyId, artifactRef, storageBucket, storageObjectPath}` only after current resource/source permission and disclosure checks. Edge validates the server-derived locator, uses server Storage credentials, bounds actual downloaded bytes, verifies exact SHA-256 and size, and repeats actor authorization after I/O. It then returns `{type: artifact, studyId, artifactRef, encoding: base64, bytes}` without the locator. P1 kinds are modelSource/modelInput/runResult; report/analysis content requires its later capability.

Inline retrieval has an explicit 4 MiB byte limit. Larger descriptors fail `PAYLOAD_TOO_LARGE`, never truncate or bypass verification with an unchecked URL. This transport limit is distinct from Worker's compiler artifact/source bounds; consumers and rollout qualification must account for it. Streamed or chunked large-artifact delivery requires a separately versioned protocol. Expiring download links and credentials never enter durable public artifact references.

## Proof and rollout

The opt-in `scripts/qualify-study-core.ts` harness addresses only the explicitly owned disposable `study894` project at loopback API port 56421. Coordinate a stable database generation with its owner before provisioning or verification. The private mode-0600 JSON config has `schemaVersion: lca.study-local-core-config.v1`, `projectId: study894`, `supabaseUrl: http://127.0.0.1:56421`, `publishableKey`, `serviceKey`, and an absolute `fixturePath` ending in `.json`. It must never enter Git or tool stdout.

Run with `deno run --cached-only --config supabase/functions/deno.json --allow-read --allow-env --allow-net=127.0.0.1 --allow-write=<owned-private-evidence-directory> scripts/qualify-study-core.ts provision --config <private-config-path>`. This creates three email-confirmed synthetic users through actual local GoTrue and writes their IDs/passwords only to the private fixture. The Database owner then seeds exactly those users' private profile/team roles (owner/member, outsider excluded), and writes `<fixturePath>.seed.json`, also mode 0600, with `{projectId,runId,teamId,actorIds,generation}` matching the fixture order. No prepared models, producer jobs, enabled profiles or numerical evidence are seeded by this harness.

Invoke the same command with `verify` instead of `provision`. Verification signs in through real Auth, starts an ephemeral IPv4 loopback listener running the actual handler and default authentication/SDK adapters, and exercises core capabilities, personal isolation, explicit team grants/revocation, idempotency/conflict, concurrent CAS, bound cursor invalidation, archive and cross-session recovery. It verifies that W06 producers remain unavailable. The private receipt records executed source-file hashes, runtime/dependency versions, database-owner generation, proof groups and fixture retention. Sessions are signed out and the listener's shutdown/finished promises are awaited on success or failure. Generated user/team/Study IDs remain private and explicitly owned until the main task resets that isolated project; never delete frozen history or disable its guards for cleanup. This local core HTTP proof does not qualify W06 production, hosted authentication, report/review/share or a business pilot.

`test/study_runtime_test.ts` exercises the actual handler, pinned SDK RPC/Storage transports, malformed JWT rejection, source recovery, typed selection, profile/capability negatives, validator bytes, deadline cancellation, fixed errors and post-I/O withdrawal. The byte-preserved cement fixture additionally proves consumption of actual W05 compiler output with declared coverage gaps and task-authored-model limitations. Seven actual W03 PostgreSQL 17 actor projections also pass v2 parsing and handler/SDK replay; their synthetic transport does not create live database or gateway authority. Synthetic replies and injected validation outcomes are explicitly local adapter proof. They do not prove SQL/RLS, native Worker execution, real exporter/source licensing, hosted authentication or production readiness. Cross-repository integration must bind actual Database transactions and Worker-produced artifacts before enabling the deployment allowlist. No deployment is performed by these tests or this source change.
