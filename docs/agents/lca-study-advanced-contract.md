---
title: Study V5 Advanced Analysis and Report Contract
docType: contract
scope: repo
status: active
authoritative: true
owner: edge-functions
language: en
whenToUse:
  - when consuming or producing separate OAT sensitivity and bounded uncertainty evidence
whenToUpdate:
  - when V5 wire, Worker schema pins, advanced report or review/export seams change
checkPaths:
  - contracts/lca-study/v5/**
  - contracts/lca-study/worker/*v2*
  - supabase/functions/_shared/study/advanced_*.ts
  - test/study_advanced*
  - scripts/study-advanced-build.test.cjs
lastReviewedAt: 2026-11-04
lastReviewedCommit: e8dc3a5f195ebb0d5403d5d1800bd5bac4a178eb
lastReviewedNote: 'Edge #553: initial explicit V5 advanced analysis/report contract; actual integrated runtime and hosted admission remain separately qualified.'
related:
  - lca-study-reporting-contract.md
  - lca-study-runtime-contract.md
  - repo-validation.md
---

# Advanced evidence

`lca.study-api.v5` / consumer `5.0.0` separately negotiates OAT sensitivity and bounded uncertainty. Worker owns exact `lca.study-analysis-config.v2`, input, facts, record and completion schemas. The hash-bound consumption manifest records their immutable source and exact bytes; portable build fails on drift. V1–V4 codecs, saved request identities and historical export artifacts stay strict. V5 is independently default-off through `STUDY_ADVANCED_CONFIG` and `STUDY_ADVANCED_REVIEW_CONFIG`; each allowlist intersects its actual Database capability projection. No configuration in this change enables a hosted operation or establishes capacity.

Config hash is SHA-256 of UTF-8 `study.analysis-config.v2`, NUL and sorted compact canonical JSON. Scientific settings are canonical strings. Edge checks closed profile/design/field shapes, finite range ordering, exact empirical row widths/support and ordered unique paths; Worker owns shortest-roundtrip issuance and numerical execution. Config selects one completed frozen baseline Run. Evaluations carry local identities and effective-input hashes; they never become invented Runs or Scenario revisions. OAT and uncertainty retain separate profiles. Uniform independence is explicitly declared; empirical joint rows retain dependence. Fixed sample budget, mean MCSE and empirical quantiles do not establish convergence, tail precision or scientific ranking.

Actor analysis/report reads and writes use `qry_study_advanced_v1` / `cmd_study_advanced_v1`. Worker uses the exact distinct `study.analysis_advanced` payload and service seams recorded in the owner fixture. Database owns current actor/client/Study/source authority, canonical queue lease/cancel arbitration and immutable completion. Generic job paths confer no advanced authority. Old resource lists filter incompatible analysis/report families before pagination, and old direct/task/artifact routes reject those families. Registered metadata and historical receipts remain distinct from current disclosure permission.

# Catalog and report production

`analysis.parameters.read` selects exact Study/baseline identities and obtains a two-minute `advancedParameterIntent`. Service-only `svc_study_analysis_parameters_resolve_v1` returns its actor/client-bound baseline and source context. Edge resolves before and after bounded prepared-byte I/O, verifies actual size/hash, and projects only normalized non-reference exchange amount paths with Flow/unit/support identities. Baseline amount spellings come from original Worker JSON tokens, normalized without a JavaScript Number serialization. Raw source packets, owner metadata, storage locators and authorization records never enter the actor catalog.

V5 authoring uses template `lca.study-report.v2`, draft/content/claims-validation v2, one baseline Run and one or two advanced Analyses bound to that baseline. Opaque `reportAdvancedCommandIntent` resolves through `svc_study_report_advanced_intent_resolve_v1`; consume and reconcile retain corresponding versioned names and existing argument roles. Each strict context binds exact registered source snapshot, prepared/result and facts references, allocations, original request/CAS and current source rights. Every I/O is enclosed by fresh context resolution. Unknown upload outcomes retain bytes; they never authorize overwrite or deletion.

Each claim selects the exact issued facts.v2 bundle and Worker catalog fact ID, canonical value and unit. Its full Worker context/unit identity is retained in canonical content. Edge verifies prepared/model/calculation/method-source and source-snapshot bindings, then generates mandatory complete settings, limits, counts, coverage, quality and provenance sections. Author prose cannot suppress them. Facts-binding hash retains its ordered-ref v1 domain. Freeze renders the complete selected view before commit, and any field/aggregate size failure rejects rather than truncates evidence.

# Reviewed presentation and detached export

P4 uses renderer `2.0.0`, the explicit view.v2 protocol, and new exact renderer/view validation separating numeric undefinedness from characterization coverage. Renderer1.0.0's activity/inventory parenthetical for every null-method fact is inappropriate for exchange parameters; there is no historical-renderer fallback. All catalog fact classes remain selectable. View.v2 facts require exact Worker `reasonCodes` (including an empty array). Null undefined values display no numeric value with explicit producer reasons, while characterization coverage and convergence remain separate; null may retain complete or partial coverage, and a numeric value cannot claim unknown coverage. Charts render supplied scalar values only.

V5 report-scoped comments, decisions, delegations, finalization, views, exports and named shares preserve P3 review semantics through separate `cmd_study_advanced_review_v1` / `qry_study_advanced_review_v1` and `studyAdvancedReviewIntent/Context`. Study member management stays V4. Review service resolve/consume names are `svc_study_review_advanced_intent_resolve_v1` / `svc_study_review_advanced_intent_consume_v1`. Old V4 cannot disclose the incompatible new renderer family. Current acceptance and authority remain freshly projected beside immutable historical evidence.

Manifest `lca.study-export-manifest.v3` and bundle.v3 retain exact HTML/projection file binding, finalization, actor/client/grant/disclosure identity and trusted renderer hash. Renderer version is exactly2.0.0. The signature domain remains `lca.study-export-signature.v1`: explicit canonical manifest schemaVersion is inside the signed payload, so the new schema remains unambiguous without changing Ed25519. Receipt v2 stays unchanged. Versioned verification dispatches retained manifest1/2 and bundle1/2 to their unchanged verifiers. Independently trusted keys/renderer artifact pins remain external to the report; offline copies cannot prove current acceptance or permission.

Pure codec/fixture/crypto tests do not prove actual Database issuance, source rights, native Worker lease/cancel behavior, Storage, OAuth, UI/CLI installation, supported-host capacity or workspace inclusion. Those require the parent integration qualification and exact source receipts.
