---
title: Study V6 Method Assessment Evidence and Report Contract
docType: contract
scope: repo
status: active
authoritative: true
owner: edge-functions
language: en
whenToUse:
  - when producing or consuming V6 method assessments, registered evidence and mandatory method reports
whenToUpdate:
  - when V6 wire, Worker pins, report summary, hash domains, producer contexts or rendering/export seams change
checkPaths:
  - contracts/lca-study/v6/**
  - contracts/lca-study/worker/method/**
  - supabase/functions/_shared/study/method_*.ts
  - test/study_method*
  - test/fixtures/lca-study-v6/**
  - scripts/build-study-method-*.mjs
  - scripts/study-method-*.test.cjs
lastReviewedAt: 2026-11-04
lastReviewedCommit: f1a36ceee7d6efb9499e0edecfdd5278c27ab8e2
lastReviewedNote: 'Edge #557: reviewed early strict portable V6 request/response, exact export CAS binding, generated schemas/types, immutable Worker/component and renderer3 input hashes, actor/service DTO seams and bounded producer/view tests. The source-bound consumer interface does not complete the unfinished handler/executors, actual installed runtime, hosted admission or scientific qualification; old protocols/renderers remain exact.'
related:
  - lca-study-runtime-contract.md
  - lca-study-reporting-contract.md
  - lca-study-advanced-contract.md
  - repo-validation.md
---

# Explicit V6 family

This contract defines the required V6 family. The first source milestone freezes only owner-schema consumption and the pure summary/view component; public facade, persistence producers and actual integrated qualification remain tracked in Edge557 and its owning repository partners. No source milestone alone advertises or enables the endpoint.

`lca.study-api.v6` and contained consumer `6.0.0` introduce `methodAssessment`, never an `analysis` alias. Worker owns the pinned `lca.study-method-assessment-{config,input,facts,record}.v1`, job/context/completion/failure/reconcile, evidence body/record and 58-entry fact-catalog contracts. Initial source is exact Worker `13a749e619d7ef348e9298bb049e8c01c60e9086`. Edge contains unchanged owner schemas and records their source/file identities; only allowlisted contained references may resolve. No registry/latest/network schema lookup or parallel hand-authored Worker wire types is allowed. Existing declaration generation consumes those same schemas. Schema validity is neither current authority nor scientific approval.

Zod4.6.7 in the exact Node24.19.0/Deno2.1.4 graph counts Unicode code points, matching owner string bounds. Its JSON-Schema converter uses identity-based object literals and ignores a pattern-only untyped allOf branch; the contained derived schema therefore expresses the one frozen object constant as equivalent closed property constants and makes the inherited string type explicit inside string allOf patterns. Owner schema bytes remain unchanged. Positive deep-equality/Unicode and changed/missing/extra/nonblank negative fixtures qualify those equivalences. JavaScript unpaired UTF-16 surrogates are rejected before canonical bytes/hashes; no Unicode normalization or replacement occurs. Method evidence is also bounded to 65536 actual canonical UTF-8 bytes, independently of its per-field scalar limits and 32-citation bound. Existing V2–V5 source protocols, stored identities and retained renderer packages remain unchanged.

Authoring operations are explicit `method.assessment.request/read`, `method.evidence.create/read`, family-bound `study.resources.list`, minimal `task.read/cancel`, authorized `artifact.read`, method-report `report.create/save/freeze/read`. Report-scoped `resource.actions`, `comment.append/list`, `review.record/list`, `review.delegation.issue/revoke/list`, `report.current/view/finalize`, `export.request/read/download`, `share.create/read/view/download/list/revoke` keep their established roles under V6-only records and types. V6 contains no Study/member management; retained V2/V4 own those. Unknown fields, incompatible old-family records and cross-resource substitutions are rejected before protected I/O or pagination.

Capability has exact contract6.0.0, explicit operations/methodProfiles/reportTemplates/finalizationProfiles/reviewClasses/disclosurePolicies and qualified limits for evidence refs, selected-factor records, facts bytes and projection bytes. Edge allowlists intersect actual Database admission. Missing configuration enables only capability read; explicit rollback may retain authorized historical reads and current-authority cancellation while authoring/profile arrays remain empty. Capability is not permission or capacity proof. Default method and review admission remain off; no source change activates a hosted profile.

# Registered declared evidence

`method.evidence.create` accepts `{studyId,content}` plus the closed V6 mutation envelope. `content` is the unchanged Worker evidence-body schema, including requirementId, declaredKind, title, statement and typed citations. It accepts no factor values, totals, approved/waiver flags, credentials, raw source packets, private locators or transport URL. `method.evidence.read` selects the registered logical evidence ID.

Database `cmd/qry_study_method_v1` issue an opaque two-minute `methodEvidenceCommandIntent`. Service-only `svc_study_method_evidence_intent_{resolve,consume,reconcile}_v1` bind its original request/actor/client/Study and exact evidence/artifact IDs, byte size/hash and recordedAt. Edge resolves current authority before and after bounded immutable upload/readback and consume. Evidence canonical content is sorted-key compact literal-Unicode JSON, no newline; contentHash is SHA256 of those exact bytes. Same-key recovery preserves the original identity. Any ambiguous possible attachment retains exact bytes and identity; reconcile never grants deletion permission.

`evidenceId` identifies the logical evidence record and is distinct from `artifactRef.id`. Config `declarations.categoryRule.evidenceId` selects that registered logical record, corresponding to PEF-01/applicabilityRecord. Every exact config evidence artifact ref must be registered in the same Study under current source/disclosure rights; a caller ref/hash alone is not a record. Status remains `recorded_unverified`; a professionalRecord declaration cannot mint professional approval, suitability, a waiver or new factors. An admitted maxEvidenceRefs0 is an explicit execution limit, never a full evidence-support claim.

# Exact report source and private producer contexts

Database912 and Edge557 agree on `reportMethodCommandContext` with one completed baseline Run and exactly one `methodAssessments:[{assessment,factsArtifact,sourceSnapshotRef}]`. The public report has `runIds:[baselineRunId]`, `methodAssessmentIds:[assessmentId]`, exact `lca.study-method-report.v1` template and no analysisIds. Complete existing Run/revision/Scenario/preparation/prepared/result bindings remain required. Full facts/config/module/source identity is checked after actual byte/hash readback; report claims select only the exact Worker catalog factId/canonicalValue/unit/context. No arithmetic or method assessment is repeated in Edge.

`svc_study_report_method_intent_{resolve,consume,reconcile}_v1` retain actor/service separation and original request/CAS/current authority. `svc_study_review_method_intent_{resolve,consume,reconcile}_v1` use `studyMethodReviewIntent/Context`. Both `report.view` and `export.request` producer contexts carry the complete original V6 request. View is a real query, with null newly allocated export/artifact IDs; it is not a fabricated export request. Export preserves finalizationId and expectedReviewStateHash. Reconcile schemas are separately `lca.study-method-report-reconcile.v1` and `lca.study-method-review-reconcile.v1`, always deletionPermitted:false.

The factsBindingHash domain is UTF-8 `lca.study-method-report-facts-binding.v1`, NUL, then canonical JSON of exactly `{studyId,runIds,methodAssessmentIds,factsRefs,baseline,assessment}`. Baseline contains exactly runId,studyId,studyRevisionId,scenarioRevisionId,effectiveModelRef,inputHash,profileId,engineId,calculationContractRef,resultRef,preparedArtifactRef,sourceSnapshotRef. It excludes execution, validity and observation times. Assessment contains exactly assessmentId,profileId,configHash,moduleRef. Array order and all exact nested references are retained.

Report contentHash is SHA256 of exact canonical stored UTF-8 bytes, no newline and **no semantic/domain prefix**. The new content schema supplies family separation. This supersedes the older design proposal's tentative content-prefix wording; historical content hash algorithms are not altered. Validation has exactly11 keys: schemaVersion=`lca.study-method-report-validation.v1`, profileId=`lca.study-method-report-claims.v1`, reportRevisionId,contentHash,claimCount,factsBindingHash,methodAssessmentId,configHash,requirementCount20,categoryCount25,factCount58.

Stored content is exactly `{schemaVersion:'lca.study-method-report-content.v1',reportRevisionId,studyId,templateId:'lca.study-method-report.v1',runIds,methodAssessmentIds,factsRefs,factsBindingHash,content,claims,methodAssessment}`. Draft retains the closed authored fields of V5 under `lca.study-method-report-draft.v1`, replacing analysisFacts references with exact methodAssessmentFacts. Mandatory method evidence is generated separately and cannot be removed or rewritten by authored paragraphs or fake numerical0/1 status facts.

# Mandatory method summary and view3

The required `methodAssessment` block uses the **new** schema `lca.study-method-report-summary.v1`, with sourceFactsSchemaVersion=`lca.study-method-assessment-facts.v1` and the exact full factsRef. It copies every other Worker facts top-level field unchanged: profileId,assessorVersion,identityKind,studyId,assessmentId,config,configHash,moduleRef,moduleSourceStatus,baseline,frozenEvidence,categories25,requirements20,candidateNormalisationWeighting,factCatalog58,outcome,limitations and all three false qualification flags.

Only `methodSourceEvidence.selectedFactors` is replaced. All other methodSourceEvidence policy, source/version/corrigendum/interim, default, bridge, geographic and limitation evidence stays exact. Replacement `methodSourceEvidence.selectedFactorEvidence` is exactly `{factsRef,selectedFactorRecordCount,embedded:false,disposition:'complete_selected_factor_records_in_exact_method_facts_artifact'}`; count is the original selectedFactors length. The full authorized facts artifact remains downloadable by exact reference. This summary never claims to embed the complete selected-factor list or original source catalog, and never relabels modified content as unchanged Worker facts.

`lca.study-report-view.v3` / renderer3.0.0 retain closed presentation fields and add methodAssessmentFacts fact provenance `{type,id,contentHash,sourceFactId}` plus this required typed methodAssessment block. `sourceFactId` is the exact Worker catalog selector, distinct from the authored view factId alias; supplied value/unit/method/coverage/reasons must match that catalog entry. Retained provenance variants keep their prior three fields. Renderer3 displays all20 requirement source/machine/professional states, all25 primary/decomposition roles/values, all58 catalog facts, frozen evidence/config/module/source, N/W availability/basis/units/scaling, limitations and false qualifications independently of authored sections. Generic facts may remain selected claims≤256; the mandatory58 catalog remains inside the typed summary. Rendering may escape, filter/sort or expand supplied evidence; it performs no N/W arithmetic or approval decision. A pure immutable Edge summary-validator artifact permits Platform to consume the same exact summary schema before its independently owned renderer artifact exists; no fake renderer hash or activation is allowed.

The fixed profile also checks a small public metadata projection reproducibly extracted from the exact Worker-contained PCR package b19ba5754b0bc20c44c8c65966bafafd5984cd74636f2c805c0fa4373f5554ad (payload407314bc364e5cfeddc8a44696118ee20cc696db5e9ef93812fd02516097a0a1). It retains raw/payload/projection provenance and the exact25 category identities/names/roles/parents/quantities/units, ordered16 source NF/weight parameters and20 source requirement descriptors. Coupled self-consistent substitutions cannot retain a fixed module identity with a different roster or source parameters. No characterization factors, original documents/PDFs, numerical algorithm, geographical-suitability inference or approval is included. The extraction command takes an explicitly supplied exact public package, fails on hash drift, and does not use sibling files or network at runtime.

Available N/W requires verified frozen-source metadata and all sixteen primary categories selected, source-compatible, complete and non-null, with exact method-axis membership/unit, source quantity and characterised-value correspondence to ordered N/W rows. normalisationWeightingIncluded is true exactly for primary categories when arithmetic is available; decompositions are never included. Catalog quantity/source-reference links must remain exact. These are mechanical owner relationships, not Edge arithmetic or approval. An independently pinned isolated Native arithmetic oracle provides relation-positive and substitution tests, explicitly not a source-verified Study or industry positive.

Missing or incompatible categories remain explicit null/unknown with exact producer reasons. The16 primary N/W roles and9 decomposition roles are distinct; decompositions never enter a candidate single score. Evidence/source hash equality, a complete machine predicate or recorded declared evidence never establishes professional approval. PEF conformity, scientific ranking and business pilot qualification stay false under this initial profile.

Complete view projection is bounded to2,000,000 UTF-8 bytes and report/artifact/export to4MiB. A legal source artifact that cannot be represented faithfully within the complete report bounds fails explicitly; nothing is silently truncated, dropped or reclassified as reportable. Source rights and current authority are checked separately from frozen historical evidence.

# Export/review qualification

The early portable6 consumer is built with `pnpm build:study-contract --api-version v6 --out <new-absolute-directory>` from a clean committed source milestone. It contains dependency-contained `index.mjs`, generated self-contained `index.d.ts`, exact request/response JSON schemas, licenses and a manifest binding every output and its source inputs. The builder verifies the unchanged Worker schema pins, public module metadata and all31 files of the adopted renderer3 candidate. Structural schemas do not encode every relationship: consumers must also use `parseRequest`, `parseResponse` and `validateResponseForRequest`, including exact export finalization/review-state CAS binding. Deterministic outside-source Node/Deno, declaration and signed manifest/bundle1–4 tests are required. This artifact freezes a consumer interface; unfinished handler/executor work, current Database admission, installed consumers and actual runtime qualification remain separate and must not be advertised from its existence.

New manifest4 and bundle4 bind actual renderer3/view3, exact HTML/projection files, report/facts/finalization and actor/client/grant/disclosure identities. Receipt.v2 and signature domain `lca.study-export-signature.v1` remain: the distinct canonical manifest schema/version is signed. New versioned verification retains exact old manifest/bundle validators, independently trusted keys and renderer pins; embedded flags cannot grant trust. Existing downloaded bytes cannot be recalled through later revocation.

Internal reviews remain exact report/hash/CAS-bound. A new method report inherits no prior approval; OAuth review requires its current one-use firstparty delegation and cannot selfapprove. Finalization binds current review state and accepted IDs. Named-recipient summary shares retain expiry/revoke/issuer/source/current report rights and exact export identity, granting neither core Study nor raw method/source access.

Source/schema fixtures, copied byte equality and pure crypto checks do not prove current Database issuance, actual native/queue/Storage execution, installed consumer behavior, hosted admission, supported-host capacity or scientific validity. Each owning repository must pass its canonical local/hosted checks and independent review, eligible Dev/Main delivery and exact workspace2181 integration. Parent owns actual shared runtime; Edge557 performs no shared reset, deployment, grant or activation.

The retained real cement baseline with2methods/4cutoffs/5gaps remains incomplete and yields unavailable N/W. A complete real16-category positive and professional/industry qualification remain unmet and unwaived. Existing numerical software cohort2208 and complete method qualification2181 are separate. P5 remains excluded.
