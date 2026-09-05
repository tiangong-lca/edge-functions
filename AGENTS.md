---
title: edge-functions Repo Contract
docType: contract
scope: repo
status: active
authoritative: true
owner: edge-functions
language: en
whenToUse:
  - when the task may change Edge Function runtime behavior, auth handling, request or response semantics, deploy scripts, or repo validation flow
  - when routing work from the workspace root into tiangong-lca-edge-functions
  - when deciding which document owns a rule, command, or runtime boundary
whenToUpdate:
  - when repo facts, branch rules, deploy/auth rules, or source-of-truth boundaries change
  - when the repo validation or repo-shape entry docs become inaccurate
  - when documentation ownership becomes redundant or ambiguous
checkPaths:
  - AGENTS.md
  - README.md
  - .docpact/**/*.yaml
  - docs/agents/**
  - package.json
  - pnpm-lock.yaml
  - pnpm-workspace.yaml
  - .nvmrc
  - .tool-versions
  - deno.json
  - .prettierrc.js
  - supabase/config.toml
  - supabase/functions/**
  - test/**
  - scripts/**
  - test.example.http
  - supabase/.env.example
  - .github/workflows/**
  - .github/PULL_REQUEST_TEMPLATE/**
  - .githooks/**
  - scripts/docpact
  - scripts/docpact-gate.sh
  - scripts/install-git-hooks.sh
lastReviewedAt: 2026-09-06
lastReviewedCommit: 4e312f5b2681d4f069bdbf37293cb1e3412d1791
lastReviewedNote: 'Reviewed for Edge #407: legacy Process/Flow RPC arguments and fallback are preserved; two Portal deadline fixtures join owned background cleanup without changing response deadlines, sanitizers or Portal runtime. Matched V2, foundation visibility, auth and deployment contracts remain unchanged.'
related:
  - .docpact/config.yaml
  - docs/agents/repo-validation.md
  - docs/agents/repo-architecture.md
  - README.md
---

## Repo Contract

`tiangong-lca-edge-functions` owns the checked-in Supabase Edge Function runtime contract for TianGong LCA: function entrypoints, shared runtime helpers, repo-level validation tooling, deploy scripts, supporting request collections, and repo-local documentation governance.

Start here when the task may change Edge runtime behavior, auth/deploy semantics, repo proof expectations, or repo documentation ownership.

## Documentation Roles

| Document | Owns | Does not own |
| --- | --- | --- |
| `AGENTS.md` | repo contract, branch and delivery rules, hard boundaries, minimal execution facts | deep runtime path maps, full proof matrix, long setup prose |
| `.docpact/config.yaml` | machine-readable repo facts, routing intents, governed-doc rules, ownership, coverage, freshness | explanatory prose or narrative walkthroughs |
| `docs/agents/repo-validation.md` | minimum proof by change type, probe/deploy proof guidance, PR validation note shape | repo contract, branch policy truth, large setup notes |
| `docs/agents/repo-architecture.md` | compact repo mental model, stable path map, hotspot families, common misreads | checklists or current proof queue |
| `README.md` | human landing context, setup, local serve, operator-facing notes, and request-example guidance | machine-readable routing or lint semantics or the raw request-collection artifact |
| `.github/PULL_REQUEST_TEMPLATE/*.md` | branch-specific PR note shape and handoff prompts | canonical proof rules or repo ownership truth |

## Load Order

Read in this order:

1. `AGENTS.md`
2. `.docpact/config.yaml`
3. `docs/agents/repo-validation.md` or `docs/agents/repo-architecture.md`
4. `README.md` or `.github/PULL_REQUEST_TEMPLATE/*.md` only when the task needs setup or PR handoff details
5. `test.example.http` only when you need concrete local or remote request payloads after the contract surface has already routed the task

Do not start from repo landing prose or raw function inventories when the core contract surface is enough.

## Operational Pointers

- path-level ownership, routing intents, governed-doc inventory, and lint rules live in `.docpact/config.yaml`
- minimum proof and deploy/auth-probe expectations live in `docs/agents/repo-validation.md`
- stable path groups and hotspot families live in `docs/agents/repo-architecture.md`
- human setup and request-example guidance stay in `README.md`
- `test.example.http` is a supporting request collection for concrete payloads, not a governed source doc
- repo-local documentation maintenance is enforced locally by the pre-push docpact gate; `.github/workflows/ai-doc-lint.yml` is manual-dispatch fallback
- the main routing intents are `function-runtime`, `auth-runtime`, `portal-public-runtime`, `command-runtime`, `data-product-runtime`, `review-quality-diagnostic`, `search-and-embedding`, `lca-runtime`, `tidas-package`, `deploy-auth-drift`, `proof`, `repo-docs`, and `root-integration`

## Minimal Execution Facts

Keep these entry-level facts in `AGENTS.md`. Use `README.md` and `docs/agents/repo-validation.md` for the full setup and proof details.

- authoritative runtime/compiler: Deno `2.1.4` with its actual bundled TypeScript `5.6.2`, matching Supabase CLI `2.116.0` and Edge Runtime `1.74.3`; this repository does not install or claim TypeScript 7
- auxiliary package manager/runtime: pnpm `11.24.0` on Node `24.19.0`, retained for the exact Supabase CLI, Prettier, and Node validation wrappers only
- latest reviewed import graph: AWS SDK `3.1121.0`, OpenAI `7.8.0`, Supabase JSR `2.112.4`, Upstash Redis `1.38.3`, Deno Redis `0.41.2`, Zod `4.5.4`, and Prettier `3.9.6`; every Functions JS type import must use the mapped `@supabase/functions-js/edge-runtime.d.ts` alias, while any direct JSR, npm, HTTPS, or other `@supabase/functions-js` specifier is forbidden; `pnpm outdated` and exact-Deno `deno outdated --latest` must remain empty
- local serve command: `pnpm start`
- baseline local validation: non-mutating `pnpm lint` and canonical `pnpm check`
- `pnpm check` validates exact runtime versions, checks all 152 enabled function/test roots through one bounded shared Deno graph, runs 73 Node contract tests, and executes 540 default Deno behavior tests plus one opt-in live Upstash test that remains ignored without explicit credentials
- schema-boundary regression: `test/schema_boundary_contract_test.ts`
- formatting fix command: `pnpm format`
- remote deploy entrypoints:
  - `pnpm deploy:dev <function-name> [more-function-names...]`
  - `pnpm deploy:main <function-name> [more-function-names...]`
  - `pnpm deploy:portal-r0 preview` for the fixed disposable R0 function only
  - `pnpm cleanup:portal-r0 preview` for guarded remote function deletion plus external Redis/credential cleanup checks
- auth and connectivity drift probe: `pnpm probe:auth --remote` or `pnpm probe:auth --local`
- local serve and scripted remote deploys both use `--no-verify-jwt`
- scripted remote deploys pass `supabase/functions/deno.json` as the Supabase CLI import map so remote bundling resolves shared npm/jsr imports consistently
- gateway JWT verification being off does not make runtime auth optional; functions must still authenticate and authorize requests explicitly
- ordinary Supabase JWT authentication defaults to `getClaims(token)` and exposes a minimal principal; only `identity_login_sync` may request `jwtAssurance: 'fresh_user'`
- non-Portal user requests accept only verified Supabase JWT/OAuth claims; service routes may additionally accept their explicit service key. Password-encoded and foreign-issuer bearers have no classifier, cache, or fallback I/O
- Redis in this repository is Portal-only under `PORTAL_*`/`PORTAL_R0_*`. The independently deployed MCP resource server keeps no OAuth state store: it forwards the verified inbound Supabase access JWT, and Edge independently verifies that JWT with `getClaims()`
- TIDAS package endpoints use database `worker_jobs`/Worker contracts and do not import the JavaScript TIDAS SDK; TIDAS SDK 0.2 compatibility is owned and tested by its direct consumers rather than duplicated in Edge

## Ownership Boundaries

The authoritative path-level ownership map lives in `.docpact/config.yaml`.

At a human-readable level, this repo owns:

- `supabase/functions/**` for Edge Function entrypoints, handlers, and runtime request or response behavior
- `supabase/functions/_shared/**` for auth, command runtime, DB-RPC wrappers, OpenAI, Redis, Supabase client helpers, and shared domain utilities
- `portal_r0_hmac_verify_v1` and `_shared/portal_r0_*` for the disposable, non-business EdgeOne/Supabase Web Crypto, current/previous HMAC, isolated publishable-key, `SET NX EX`, and atomic Redis admission fixture
- `portal_data_product_results_v1`, `portal_hybrid_search_v1`, and retained `_shared/portal_*` for raw-body Portal HMAC verification, replay/admission control, the publishable-only public LCIA projection, and the separately budgeted/default-off R2 Hybrid projection
- direct review submission through the stable database command, the Review Admin-only manual quality-diagnostic projection, and compatibility-only handling for already deployed review-submit Gate/coordinator clients
- `test/**` for repo-level Deno tests
- `scripts/**` for deno-check inventory, deploy contract, auth probes, and smoke helpers
- `package.json`, `supabase/config.toml`, and `supabase/.env.example` for repo runtime/deploy/operator configuration
- `README.md`, supporting request collection `test.example.http`, `.github/PULL_REQUEST_TEMPLATE/**`, and repo-local governed docs

This repo does not own:

- database schema, migrations, persistent Supabase branch governance, or SQL regression-test truth
- frontend page behavior, app-side workflow behavior, or frontend env selection
- workspace submodule pointer bumps or delivery completion

Route those tasks to:

- `database-engine` for schema truth, migrations, SQL tests, RPC truth, and persistent branch governance
- `tiangong-lca-next` for frontend behavior and app-side flows
- `lca-workspace` for root integration after merge

## Branch And Delivery Facts

- GitHub default branch: `main`
- true daily trunk: `dev`
- routine branch base: `dev`
- routine PR base: `dev`
- promote path: `dev -> main`
- hotfix path: branch from `main`, merge into `main`, then back-merge `main -> dev`

Do not infer routine workflow from GitHub default-branch UI alone.

## Documentation Update Rules

- if a machine-readable repo fact, routing intent, or governed-doc rule changes, update `.docpact/config.yaml`
- if a human-readable repo contract, branch rule, or hard boundary changes, update `AGENTS.md`
- if proof expectations change, update `docs/agents/repo-validation.md`
- if repo shape, hotspot families, or path ownership explanation changes, update `docs/agents/repo-architecture.md`
- if setup steps or operator-facing guidance change, update `README.md`
- if checked-in request examples change, update `test.example.http`; update `README.md` too only when the human guidance or coverage summary changed
- if PR handoff prompts or M2 branch-note shape changes, update `.github/PULL_REQUEST_TEMPLATE/*.md`
- do not copy the same rule into multiple docs just to make it easier to find

## Hard Boundaries

- Portal V2 is an explicit wire-version opt-in on the same signed endpoint. It calls only the additive public V2 Database API, validates best-version groups plus every exact member, and uses opaque query-bound continuation. V1 callers retain their old public API contract. Never relabel a V1 response as V2.
- Process/Flow matched-version mode requires a verified JWT context before model work, fixes each recall budget at 200, and acknowledges exact-version output with `versionScope=matched`. It validates and forwards state/team context, requires a selected team for `te` before paid work, forwards the reviewed Process dataset type, and validates the canonical Flow type/input/classification contract. The Database V2 RPC owns threshold fallback inside the single matched-mode Edge RPC call; omitted and explicit `latest` mode retain the legacy RPC parameter contract and Edge-owned empty-result retry at threshold zero. Service credentials gain no new RPC grant.
- The bounded full-text selector always reserves the original query and alternates English/Chinese model aliases so OR expansion cannot starve English terms. This does not restrict source-document languages or change the legacy selector.
- do not invent schema truth or migration history in this repo
- do not bypass `supabase/functions/deno.json` with a direct JSR, npm, HTTPS, or other `@supabase/functions-js` specifier; all Functions JS type imports use the exact mapped alias so local checks and remote bundles resolve 2.112.4
- do not interpret `--no-verify-jwt` as permission for anonymous business logic
- do not deploy `portal_r0_hmac_verify_v1` through persistent Dev/Main tooling or let it read any long-lived Portal/generic credential; remote deploy accepts only a live `FUNCTIONS_DEPLOYED` / `ACTIVE_HEALTHY`, nondefault, nonpersistent, no-data Preview branch returned by a read-only `branches list` against the configured Main parent and exactly matching the operator-supplied branch name, Git branch, and optional PR number. It also requires complete `PORTAL_R0_*` configuration, a current-project R0 publishable key, and a `portal:r0:<fixture>:v1` namespace. Local `test` is not a remote deploy target. The function must never call a database, RPC, model, provider, repository, storage, or business kernel
- do not require an identified R0 branch to remain ready or healthy before cleanup; once Main parent, project ref, nondefault/nonpersistent/no-data flags, branch name, Git branch, optional PR, exact SHA, and cleanup acknowledgement still match, cleanup must attempt the fixed function deletion and surface any real delete failure
- do not delete the user-approved shared Upstash database, scan or delete broad prefixes, touch Dev/Main namespaces, or rotate the shared token for one R0 cleanup; remove only the exact receipt-bound fixture keys and disposable Preview secret copies, verify absence, and preserve the shared resource
- do not let Portal runtime use `SERVICE_API_KEY`, a Supabase secret/service-role key, a user JWT/Cookie context, or a database/storage locator; signed Portal routes resolve only `PORTAL_SUPABASE_PUBLISHABLE_KEY`, prove it is present in the platform-owned current-project `SUPABASE_PUBLISHABLE_KEYS` registry, use only the platform-injected `SUPABASE_URL`, and pass that same key from exact inbound `apikey` matching to their reviewed public `api` RPC. They never use generic or `REMOTE_*` key/URL precedence. Authorization is absent in hosted and pinned-CLI `2.116.0` traffic: local Kong maps the matched publishable key into `sb-api-key` and does not inject Authorization. The exact `http://kong:8000` plus configured `SUPABASE_ANON_KEY` Bearer remains only a narrow older-local-client compatibility path after HMAC
- do not let signed Portal routes read unprefixed or unrelated Redis credentials; Portal replay, admission, circuit, and cache storage requires the explicit `PORTAL_REDIS_*` / `PORTAL_UPSTASH_REDIS_*` surface and fails closed when it is absent
- do not change ordinary Supabase JWT routes back to per-request `getUser`; `getClaims` must validate issuer, audience, expiry, issued-at time, authenticated role, UUID subject/session, and optional OAuth `client_id`, while `fresh_user` remains explicit and exclusive to `identity_login_sync`
- do not reintroduce `USER_API_KEY`, an external bearer classifier, password sign-in, generic Redis auth state, or a non-JWT fallback into shared Edge authentication
- do not let signed Portal Hybrid read or fall back to generic OpenAI, SageMaker, or AWS variables; after the exact-lowercase-true kill switch it resolves the complete `PORTAL_OPENAI_*`, `PORTAL_SAGEMAKER_*`, and `PORTAL_AWS_*` configuration and injects it explicitly into shared kernels, while existing login Hybrid and embedding consumers keep their generic defaults
- do not use one shared Portal deployment SHA; LCIA events read only `PORTAL_LCIA_DEPLOYMENT_SHA` and Hybrid events read only `PORTAL_HYBRID_DEPLOYMENT_SHA`, with invalid or missing values normalized to `unknown`
- do not route `portal_hybrid_search_v1` through legacy `hybrid_search_processes`/`hybrid_search_flows`, a service client, or an Edge-side field projection; it remains default-off until the exact Database façade exists, and every guard/circuit/timeout failure returns a fixed signal for the Portal BFF to handle through its separate lexical façade
- do not return a successful Portal Hybrid response after its absolute 25-second Edge application deadline; the checked-in default and maximum retain five seconds of headroom before the Portal BFF's 30-second deadline, every awaited guard/cache/model/database/finalization step consumes the same remaining budget, and the Hybrid-only 35-second lease covers the 500 ms Redis budget plus operation deadline and five-second recovery margin. Lease release remains detached and bounded so Redis TTL is the interrupted-cleanup recovery authority; latency is observed and optimized but is not a release gate
- after Portal Hybrid HMAC/transport, one Hybrid-only atomic Redis begin must execute nonce registration/replay rejection, expired-lease recovery, minute/day budget checks, concurrency/lease acquisition, and circuit check in that exact order; replay stops before recovery/counters, recovery preserves the existing guard's concurrency semantics, budget/concurrency precede circuit, and an admitted open circuit retains a lease for existing cleanup. Only a closed admitted result may proceed to JSON/schema and the separate hash-only model-cache read. On a valid cache miss, complete and validate the OpenAI rewrite before generating a 1024-dimensional SageMaker embedding from its normalized `semantic_query_en`, then overlap the validated model-cache write with the public Database query and settle both outcomes before finalizing any Database rejection so cache-write telemetry is accurate. All operations share the absolute deadline, rewrite failure prevents embedding and any active failure cancels downstream work before lease release, and the rewrite remains the sole model-interpretation/alias source while `portal.hybrid-model-cache.v2` in the separate `portal_hybrid_english_v2` keyspace stores only its bounded interpretation plus the English-query vector and never the raw query. Full-text terms always retain the original query in any language alongside bounded model aliases, deduplicated case-insensitively
- keep the Portal-only Responses rewrite non-stored, explicitly `reasoning.effort=none`, `text.verbosity=low`, and capped at 256 total output tokens under the same strict JSON Schema and AbortSignal; do not apply these settings to generic/login OpenAI wrappers or opt into priority/flex service tiers implicitly
- sanitize the final Portal Hybrid event before the last deadline decision, including only fixed rewrite/embedding outcome enums and nullable bounded stage latencies—never query, model name, endpoint, provider error, or credential—then schedule its allowlisted logger outside the handler promise; use `EdgeRuntime.waitUntil` when available and a handled macrotask fallback locally, so observability cannot delay or change the final response
- do not move repo-level tests into `supabase/functions/**`; this repo keeps Deno tests in `test/**`
- do not treat GitHub default branch `main` as the daily trunk
- do not mark delivery complete if root workspace integration is still pending

## Workspace Integration

A merged PR in `tiangong-lca-edge-functions` is repo-complete, not delivery-complete.

If the change must ship through the workspace:

1. merge the child PR into `tiangong-lca-edge-functions`
2. promote or select an eligible child SHA according to workspace policy
3. update the `lca-workspace` submodule pointer deliberately

## Local Docpact Push Gate

Install the versioned local hook once per checkout:

```bash
./scripts/install-git-hooks.sh
```

The `pre-push` hook runs `scripts/docpact-gate.sh`, which delegates CLI lookup to `scripts/docpact` and performs strict config validation plus enforced lint before the push leaves the machine. It then runs non-mutating `pnpm lint` and canonical `pnpm check` as the local test gate, and aborts if the lint step changes the working tree. The wrapper checks `DOCPACT_BIN`, Cargo install locations, Homebrew install locations, and then `PATH`, so local agent shells should not fail only because bare `docpact` is unavailable. The default comparison base is `origin/dev` for routine branches and `origin/main` for promote or hotfix branches. Override it for unusual stacks with `DOCPACT_BASE_REF=<ref>` or `scripts/docpact-gate.sh --base <ref>`. The gate writes its detailed report to a temporary file so normal pushes do not create `.docpact/runs/` artifacts. The GitHub `CI` workflow is manual-dispatch only.
