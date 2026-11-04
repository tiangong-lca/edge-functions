---
title: LCA Study reporting and portable consumer contract
docType: contract
scope: repo
status: active
authoritative: true
owner: edge-functions
language: en
whenToUse:
  - implementing or consuming Study analysis and report producer interfaces
  - building portable Study codecs or verifying detached report exports
whenToUpdate:
  - reporting wire, fact binding, portable artifact or signature protocol changes
checkPaths:
  - contracts/lca-study/v2/codec.ts
  - contracts/lca-study/v3/**
  - contracts/lca-study/v4/**
  - supabase/functions/_shared/study/review_*.ts
  - test/study_review_contract_test.ts
  - test/study_review_runtime_test.ts
  - supabase/functions/_shared/study/reporting_*.ts
  - scripts/build-study-contract.mjs
  - scripts/study-contract-build.test.cjs
  - test/study_codec_test.ts
  - test/study_export_signature_test.ts
lastReviewedAt: 2026-11-05
lastReviewedCommit: 47fa6ab6d9ba221f77f18552de081570994b8f50
lastReviewedNote: 'Edge #557: reviewed exact evidence consume three-key DTO projection distinct from private/report/export four-key artifacts, and early V6 authored Unicode-scalar rejection with permanent400 before repository I/O. Red/green real SDK transport/golden, create/save scalar negatives and valid astral roundtrip tests pass. Prior artifacts remain immutable; actual cohort, final independent recheck and source delivery remain pending.'
related:
  - ../../AGENTS.md
  - lca-study-runtime-contract.md
  - lca-study-api-contract.md
  - repo-validation.md
---

# Study reporting and portable consumers

P1 core remains `lca.study-api.v2` / bundle `2.0.0`. P2 has separately negotiated `lca.study-api.v3` / bundle `3.0.0` reporting operations at the same authenticated endpoint. Its producer is explicitly default-off. `STUDY_REPORTING_CONFIG` selects the bounded runtime operation/profile/template allowlists and intersects them with Database admission. `STUDY_EXPORT_SIGNING_KEY` supplies only the configured issuer/key-bound private signing material. Until the actual Database, Worker, Edge, renderer and installed consumer are qualified together, hosted admission remains unavailable. V2 reserved P2 shapes are not silently translated into V3, and saved mutation identities retain their original version.

## Portable V2 codec

`contracts/lca-study/v2/codec.ts` is pure wire validation shared with the handler. It exports request/response parsers, exact request-response binding checks and query/mutation metadata. None establishes authorization or current capability. Errors contain fixed codes/rules, without submitted values. The consumer still checks current capability, transport budgets and actual artifact size/hash.

`pnpm build:study-contract --out <new-absolute-directory>` builds dependency-contained ESM, declarations generated from the exact owner schemas, JSON Schema, license and an immutable source/dependency/file manifest. JSON Schema/declarations describe structure; the executable codec retains refinements. Deno remains the authoritative compiler. Auxiliary build-only esbuild `0.28.2` and Zod `4.6.7` produce the portable artifact; the latter must equal the Deno import-map pin. No npm TypeScript compiler is introduced. Registry metadata verified esbuild as latest stable and compatible with the selected Node 24 runtime when added.

Release builds require a clean checkout. `--allow-dirty` marks a development candidate `sourceStatus: worktree`; this is not release trust. Consumers qualify the exact archive/manifest from its reviewed immutable publication, bundle its bytes and execute without sibling imports or runtime code downloads. A checksum alone is not source authenticity. Package publication and actual installation remain separate from source merge.

## Analysis and report content

Worker owns `lca.study-analysis-config.v1`, its ordered Run selection/hash and `lca.study-analysis-facts.v1`. V3 submits explicit configuration, not a hash without content. `contribution` takes one Run; `comparison` takes two ordered distinct canonical lowercase UUIDs. Config identity is SHA-256 of UTF-8 `study.analysis-config.v1`, NUL and compact sorted-key JSON. Existing P1 numerical identities are unchanged. Mechanical comparability, source coverage and scientific ranking qualification remain distinct.

`report.create/save` accepts bounded inline `lca.study-report-draft.v1`. Initial claims select exact registered Analysis bundles/fact IDs and preserve the producer's canonical decimal string or unknown, exact unit and `display: exact`. There is no local recalculation or implicit rounding. Free-text interpretation is not a validated numerical fact or independent scientific review. Its status and limitations remain visible. Tables/charts select declared claims; they do not derive new facts. Exact authorized sources and coverage are projected by the server, not invented by the submitted narrative.

The actor command returns an opaque `reportCommandIntent`. Database preallocates identities and binds the complete request, current target/CAS, actor/client, Run/Analysis references, configuration and source authority. Service-only `svc_study_report_intent_resolve_v1` returns the strict context in `reporting_context.ts`; it rechecks current authority before and after I/O. `svc_study_report_intent_consume_v1` accepts only the trusted producer's `validatedContent`, `validatedFreeze` or `validatedExport`, then rechecks/commits under the domain lock. Public callers cannot submit these results.

Content registration stores real canonical `lca.study-report-content.v1` bytes whose envelope binds report/Study identity, exact input/facts/template and draft content. `ReportRevision.contentHash` equals that artifact's byte SHA-256. No synthetic client contentRef or DB placeholder stands in for a produced artifact. `factsBindingHash` is SHA-256 of UTF-8 `lca.study-report-facts-binding.v1`, NUL and canonical JSON of the exact ordered factsRefs. All non-scientific numbers in this protocol are safe integers; scientific values are strings. Failed or stale validation cannot freeze a report. Same-key committed recovery rechecks current rights and returns the original result without repeating generation after TTL.

P2 reports have `not_finalized`, profile `lca.study-report-unreviewed.v1`, review requirement `none`, null finalization time and no review IDs. Freeze, approval and publication are different states; P3 owns actual review/finalization/sharing.

## Detached export authenticity

The exact Platform renderer artifact is portable and deterministic: only supplied view/context bytes determine `report.html`; it has no current clock, random input or application-shell dependency. Edge approves the complete minimal view, renders the actual HTML and signs a detached manifest covering both `report.html` and `projection.json`. Each file has exact byte size and SHA-256, and the manifest also binds issuer, export/Study/report/content, actor/client/grant epoch, policy/security context, generation-time validity and renderer artifact/schema/version. The two files together are bounded to 4 MiB. HTML contains no self hash or detached receipt.

The signature bytes are UTF-8 `lca.study-export-signature.v1`, NUL and canonical manifest JSON. Ed25519 signs those exact bytes; `receipt.manifestHash` hashes the same signed bytes. The separate `renderResources` artifact contains canonical manifest bytes and therefore has its own ordinary byte hash. A `reportExportBundle` contains files, manifest and receipt; its outer hash is not included in its own receipt. The trusted verifier rejects noncanonical JSON, duplicate keys, ambiguous or unknown anchors, altered files, transplanted identities and unsupported renderer hashes. Keys come from independently trusted configuration/publication, never from the report. Historical key validity is checked against signed generation time.

The private storage bucket is `study-artifacts`; producer objects use exact preallocated IDs under `study/<studyId>/<artifactId>/content.json`, `projection.json`, `resources.json` or `bundle.json`. Uploads do not overwrite; recovery may reuse only byte-identical content at the same bound destination. Database owns current disclosure rights and the opaque security-context identity. Signing private keys stay in Edge configuration. Source merge neither configures keys nor grants clients access.

The installed CLI verifies the complete detached package with independently trusted keys, then writes the HTML and detached evidence. A modified HTML file must fail even when its embedded JSON is unchanged. The HTML itself is a historical reading copy and cannot authenticate itself or prove current permissions, withdrawals or review status. Downloaded copies cannot be recalled.

## Qualification

Run portable Node/Deno outside-source tests, strict request/selection tests and `study_export_signature_test.ts` before the canonical full Edge gate. Signature tests also use Node crypto to verify WebCrypto output and exercise modified visible HTML, data, identities, keys and canonical encoding. Actual SQL/RLS/queue/producer, revocation, installed consumer, offline browser and cleanup evidence are required separately before P2 delivery. Pure schema, crypto and fixture tests do not prove those integrations.

## Owned local P2 qualification

`scripts/qualify-study-reporting.ts` prepares actual local OAuth/PKCE and serves the production Study handler on the receipt-owned `study894` loopback stack. Its fixed mode-0600 configuration supports `readiness`, `provision`, `oauth` and `gateway`; importing it performs no I/O. Only task-owned synthetic accounts and a real local public OAuth client participate. Database source seeding, client admission, CAS configuration and native Worker launch remain separately owned and receipt-bound. No actor/service authentication stub substitutes for GoTrue or the normal RPC adapters.

Run its explicit Deno check and the ordinary canonical gate. Installed CLI login, source acquisition, native preparation/run/analysis, report claim validation, signed export and offline browser verification require actual execution receipts. Successful OAuth alone does not prove those later steps. Retain exact process/resource ownership and private credentials only for the scoped qualification; close listeners and reconcile actual DB/Storage state before removing owned auth identities.

Pending intent recovery ignores only transport `requestId` when comparing semantic requests; original idempotency, actor/client and content remain bound. Freeze validates and renders the bounded final view before committing, so unsupported view size cannot produce a frozen but unexportable report. Native Worker schema/golden fixture bytes and the renderer inventory are hash-bound producer artifacts; formatting must preserve those bytes.

## V4 review, finalization and named shares

P3 is additive `lca.study-api.v4` / bundle `4.0.0`. Its exact schemas live in `contracts/lca-study/v4/`; `protocol.json` and `view.json` under the V4 fixtures bind the agreed Database #906 / Edge #550 wire. V2/V3 request/recovery identities, frozen P2 reports and signed P2 packages retain their original versions. The same consumer builder supports `--api-version v4` with contained Node/Deno ESM, JSON Schema and generated declarations. It never imports a sibling repository.

`STUDY_REVIEW_CONFIG` separately admits explicit operations, finalization profiles, review classes and disclosure policies. Absence permits only capability read, with no profiles/classes/policies. The actual Database capability projection intersects that allowlist; `resource.actions` returns only Database-authorized actions further narrowed by deployment admission. Consumers display these actions rather than reconstructing role policy. `resource.actions.allowedMemberRoles` supplies exact role choices: personal owners may manage reviewer grants only; team owners may manage editor/reviewer/viewer grants. Removal is explicit `role:null`. V2 source/model/Run roles remain unchanged, including for personal reviewers.

Database owns reviewer membership, append-only comments, exact predecessor review chains, one-use actor delegation, profile acceptance, finalization and shares. V4 adds reviewer through `member.set`; V2 source/model/Run permissions do not expand. Comments never approve. Internal review requires at least one current approving reviewer distinct from the report author. The only other initial finalization profile is explicit unreviewed finalization. Independent review is unavailable. Records are authenticated actor decisions and cannot establish human judgment or independent scientific review.

OAuth review requires a distinct first-party-issued grant by that exact reviewing actor, bound to client, frozen report/hash, class, decision and predecessor, with at most fifteen minutes to consume. Explicit revocation, client admission and current reviewer eligibility remain live checks. Expiry limits first consumption; it does not erase an already committed historical actor decision. The exact original semantic request and one consumed review survive same-key recovery under current authorization. Caller-written evidence strings confer no authority.

Actor `qry_study_review_v1` / `cmd_study_review_v1` preserve the ordinary verified JWT and `api` schema. Only service `svc_study_review_intent_resolve_v1` receives opaque read/producer intent IDs. Its strict `studyReviewContext` binds the original V4 request, actor/client, report/hash and current state. For report views/export it carries a service-only P2 producer context under the Study owner's current source/disclosure authority. A reviewer receives only the allowlisted report view, never raw source/model/full-facts artifacts. The read-only producer validator relaxes only export-allocation/profile presence; frozen identities and actual Worker/content bytes still undergo the P2 validator. Every bounded read/upload is enclosed by fresh service resolution; changed contexts fail before disclosure/commit. Database clocks govern domain expiry while the existing monotonic Edge deadline bounds all I/O.

Finalization is a separate immutable record. It binds frozen report ID/hash/CAS, profile, expected current review-state hash and exact accepted review IDs. Later withdrawal changes current acceptance without rewriting that record or the frozen report. Current online state travels separately from a historical view. The exact existing Platform view.v1 / renderer 1.0.0 supports reviewed and finalized snapshots and remains byte unchanged.

New exports use `lca.study-export-manifest.v2` and bundle v2. The manifest binds the immutable finalization record and actual accepted review IDs to the view snapshot and exact visible HTML/projection bytes. Signature domain and receipt v2 stay unchanged; strict manifest version discrimination preserves historical manifest v1 verification as P2 unreviewed evidence. V4 verification validates the actual canonical projection against its manifest after signature/file checks. Offline proof cannot establish current acceptance or permission.

Named shares bind recipient UUID, persisted exact export/projection, disclosure policy/context, expiry and grant epoch. Initial summary disclosure permits public sources or exact issuer-owned private sources; borrowed private read permission cannot authorize redistribution. Only the named recipient resolves share view/download; issuers use report views, export metadata and share management. Recipients acquire no Study membership or raw-artifact access. Service resolution checks current issuer/source/client/share authority around Storage I/O. Responses contain bounded view/base64 bytes and current state, never an anonymous URL or locator. Downloaded copies remain historical and cannot be recalled.

Run `study_review_contract_test.ts`, `study_review_runtime_test.ts`, the portable build tests and all retained V2/V3/signature suites before the canonical gate. Actual SQL/RLS, OAuth grant races, installed CLI/browser and cross-repository proof remain separate acceptance evidence. Source tests do not enable a hosted operation or complete P3 delivery.

V4 `export.download` resolves an existing owner-authorized export by exact `exportId` and returns only its immutable bundle as bounded base64 in a distinct `exportDownload` response. Its strict service context binds the original actor, client, export, report/hash and exact bundle capability. Current export-read source/grant/client authority is rechecked around Storage I/O. It grants no raw artifact access and does not broaden V3 artifact registration.

Same-key mutation recovery retains original immutable IDs, decisions, finalization and export receipts. Fields named current are freshly hydrated: `review.record` returns the original review with current report state; `report.finalize` returns its original finalization with current state, whose latest finalization may differ; share/delegation records retain their original identity with live revocation/expiry/consumption metadata. Current authority precedes replay. A successful old receipt cannot claim current acceptance after withdrawal or an active share after revocation.

Online pre-finalization report previews have no export identity. Platform owns an additive preview rendering entrypoint sharing the view/content presentation with online framing. It must not pass a report ID as an export ID or claim an export receipt. The pinned renderer 1.0.0 and historical signed export bytes stay unchanged; current status/actions remain application state outside that view.

Withdrawal requests and withdrawal-delegation issue requests require a nonnull `predecessorReviewId`. This structural rule rejects a first withdrawal before Edge dispatch (`INVALID_REQUEST`). Database still owns exact current-head validation and returns `REVISION_CONFLICT` for missing/stale heads through its direct RPC surface. Initial approve/reject decisions retain nullable predecessor semantics; replay, actor and source authorization rules are unchanged.

`resource.actions.corePermissions` is a strict `{read:boolean,write:boolean}` projection for a Study target only; both values are false for report, export or share targets. Database obtains each value from its existing V2 `private.study_authorize` semantics, with archived Studies never reporting write permission. Reviewer and named-share authority cannot become core Study access through this projection. The UI intersects these coarse flags with current V2 capabilities and the fetched target state. They do not authorize any exact source, mutation target, cancellation or I/O; normal commands recheck all current domain/source permissions. Edge forwards the server result without reconstructing role policy, and V2 wire/roles remain unchanged.

V5 adds separately versioned advanced facts/content and view2/renderer2.0/export3 in [the advanced contract](lca-study-advanced-contract.md). The retained V3/V4 producer/export semantics remain strict; older consumers cannot receive incompatible P4 resources.
