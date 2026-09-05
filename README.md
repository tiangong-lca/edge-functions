---
title: TianGong LCA Edge Functions
docType: guide
scope: repo
status: active
authoritative: false
owner: edge-functions
language: en
whenToUse:
  - when setting up or serving edge functions locally
  - when finding human-facing request examples and runtime environment notes
whenToUpdate:
  - when setup, local serve, request examples, or operator-facing runtime guidance changes
checkPaths:
  - .env.example
  - README.md
  - package.json
  - pnpm-lock.yaml
  - pnpm-workspace.yaml
  - .nvmrc
  - .tool-versions
  - deno.json
  - supabase/config.toml
  - supabase/.env.example
  - test.example.http
lastReviewedAt: 2026-09-06
lastReviewedCommit: 4e312f5b2681d4f069bdbf37293cb1e3412d1791
lastReviewedNote: 'Reviewed for Edge #407: legacy Process/Flow RPC arguments and fallback are preserved; two Portal deadline fixtures join owned background cleanup without changing response deadlines, sanitizers or Portal runtime. Matched V2, foundation visibility, auth and deployment contracts remain unchanged.'
---

# TianGong-LCA-Edge-Functions

## Overview

Supabase Edge Functions for LCA search, embedding, TIDAS package orchestration, solving workflows, and the signed public Portal LCIA and R2 Hybrid projections.

Review note, 2026-08-31: Edge #361 replaces 52 unversioned direct Functions JS type specifiers with the repository alias mapped to exact Supabase Functions JS 2.112.4. The executable scan captures JSR, npm, HTTPS, and any other quoted Functions JS specifier and accepts only that alias. The type-only normalization changes no request, response, auth, Redis, Portal, or deploy configuration behavior.

- Runtime/compiler: Deno 2.1.4 with bundled TypeScript 5.6.2
- Functions root: `supabase/functions`
- Local serve command: `pnpm start`

Database clients default RPC calls to the exposed `api` schema. Direct table access always selects `public` explicitly and is restricted to the nine core entity tables; internal worker, identity, review, LCA, TIDAS, and Data Product state is available only through database-engine capability façades.

## AI Docs Entry

For the AI-facing checked-in contract layer, start with:

1. `AGENTS.md`
2. `.docpact/config.yaml`
3. `docs/agents/repo-validation.md`
4. `docs/agents/repo-architecture.md`
5. `.github/PULL_REQUEST_TEMPLATE/*.md` only when you need PR handoff details

These files are the low-token entry path for repo ownership, branch and deploy rules, validation, and cross-repo boundaries. `README.md` remains the human-oriented setup and operations guide. `test.example.http` is a supporting request collection for concrete payloads, not part of the governed AI contract surface.

## Branch & Deployment Contract

- 本仓库采用以下分支规则：Git `dev` 是日常 trunk，routine PR 默认回 `dev`，`dev -> main` 是 promote 路径，hotfix 从 `main` 起并在合并后回合并到 `dev`。
- GitHub default branch 继续保持 `main`，这是平台层例外，不代表日常 trunk 改回 `main`。
- 远端环境映射：
  - `main` project ref：`qgzvkongdjqiiamzbbts`
  - `dev` project ref：`submidrhbtknjxfympna`
- 远端 `main` 与 `dev` 的函数部署都统一使用 `--no-verify-jwt`。这是正式仓库规则，不是临时口头 workaround。
- 安全边界在函数运行时：gateway 不做 JWT 校验，不等于函数可以匿名执行。新函数不得假设 gateway `verify_jwt=true` 已经帮你兜底，必须继续显式做认证与授权。

## Prerequisites

- Deno 2.1.4; `deno --version` must report bundled TypeScript 5.6.2. `.tool-versions` is the shared local/CI version source.
- Node.js 24.19.0 and pnpm 11.24.0 for auxiliary Supabase CLI, formatting, and validation wrappers
- Docker Engine (required if you run local Supabase stack)
- Supabase CLI 2.116.0, installed through this repository's `supabase` dev dependency; it embeds Edge Runtime 1.74.3, whose runtime reports Deno 2.1.4

Initialize/refresh Node dependencies:

```bash
pnpm install --frozen-lockfile
```

## Environment Setup

### 1. Function runtime env (`supabase/.env.local`)

Use the template under `supabase`:

```bash
cp supabase/.env.example supabase/.env.local
```

Required keys are managed in this file. Keep this file local-only; do not copy it to the repository root `.env`.

Core entries:

- `REMOTE_SUPABASE_URL`
- `REMOTE_SUPABASE_PUBLISHABLE_KEY` for claims/JWKS JWT validation and request-scoped user clients. The configured URL and token issuer must belong to the same project.
- `REMOTE_SUPABASE_SECRET_KEY` for privileged RPC / database execution.
- `REMOTE_SERVICE_API_KEY` for routes that allow `AuthMethod.SERVICE_API_KEY`.
- `PORTAL_R0_*` is the complete, disposable R0 verifier surface: current/optional-previous HMAC, current-project publishable key, explicit `preview`/`test` runtime target, R0-only Standard/Upstash Redis configuration, `portal:r0:<fixture>:v1` namespace, and small admission limits. The operator may map the approved shared Upstash endpoint/token into those R0-only names, but the runtime never falls back to the long-lived Portal or generic variables below.
- `PORTAL_HMAC_KEY_ID_CURRENT` / `PORTAL_HMAC_SECRET_CURRENT` and the optional previous pair for Portal-only request verification.
- `PORTAL_SUPABASE_PUBLISHABLE_KEY` for both signed Portal routes. It must be a modern publishable key present in the current project's platform-owned `SUPABASE_PUBLISHABLE_KEYS` JSON registry and is paired only with platform-injected `SUPABASE_URL`; there is no generic or `REMOTE_*` key/URL fallback.
- `PORTAL_REDIS_CLIENT_TYPE`, `PORTAL_REDIS_NAMESPACE`, `PORTAL_REDIS_TIMEOUT_MS`, and the bounded `PORTAL_LCIA_*` guard/cache/timeout settings for the signed public LCIA route. Hosted projects use the Portal-only `PORTAL_UPSTASH_REDIS_URL` / `PORTAL_UPSTASH_REDIS_TOKEN`; local/CI may use `PORTAL_REDIS_URL` plus optional `PORTAL_REDIS_PASSWORD`. Portal routes have no generic Redis fallback. The concurrency lease defaults to 30 seconds, never drops below 20 seconds, and must cover Redis plus upstream timeouts with a five-second recovery margin. The R1 LCIA response cache defaults to and is capped at 60 seconds.
- `PORTAL_HYBRID_ENABLED=false` plus independent `PORTAL_HYBRID_*` minute/day/concurrency/lease/cache/timeout/circuit settings for the R2 signed Hybrid route. Only exact lowercase `true` enables model or database work. `PORTAL_HYBRID_TIMEOUT_MS` defaults to and is capped at 25000 ms, leaving five seconds before the Portal BFF's 30000 ms deadline. Its dedicated lease defaults to 35 seconds, covering the 500 ms Redis budget, operation deadline, and five-second recovery margin. The model cache is capped at 60 seconds and stores no raw query or database candidate.
- `PORTAL_OPENAI_API_KEY`, `PORTAL_OPENAI_CHAT_MODEL`, optional `PORTAL_OPENAI_BASE_URL`, `PORTAL_SAGEMAKER_ENDPOINT_NAME`, `PORTAL_AWS_ACCESS_KEY_ID`, `PORTAL_AWS_SECRET_ACCESS_KEY`, and optional `PORTAL_AWS_SESSION_TOKEN` form one strict Portal-only R2 provider configuration.
- `PORTAL_LCIA_DEPLOYMENT_SHA` and `PORTAL_HYBRID_DEPLOYMENT_SHA` independently bind each route's allowlisted security event to its exact deployed commit.
- `OPENAI_API_KEY`, `OPENAI_CHAT_MODEL`, optional `OPENAI_BASE_URL`, `SAGEMAKER_ENDPOINT_NAME`, and generic AWS credentials remain the unchanged provider surface for existing login Hybrid, embedding, and other non-Portal consumers.
- Feature-specific entries such as TIDAS storage, national-carbon cache, and `embedding_ft` timeout knobs are grouped in `supabase/.env.example`.

Credential contract:

- `REMOTE_SERVICE_API_KEY` / `SERVICE_API_KEY` are custom function-level shared secrets. They are not Supabase client credentials.
- Ordinary Supabase JWT validation uses `getClaims(token)`, validates issuer/audience/expiry/issued-at/role/subject/session and optional OAuth `client_id`, then exposes a minimal principal. Only `identity_login_sync` explicitly opts into `fresh_user`, which adds the online `getUser(token)` check.
- Asymmetric Supabase signing keys allow `getClaims` to use cached JWKS without putting Auth in the per-request hot path. Non-JWT bearers fail without password exchange, an external identity-provider validation path, or generic Redis I/O.
- Supabase secret keys are reserved for privileged Supabase execution paths and must never be exposed to browser clients.
- Keep `REMOTE_SUPABASE_URL`, `REMOTE_SUPABASE_PUBLISHABLE_KEY`, and `REMOTE_SUPABASE_SECRET_KEY` from the same Supabase project. A mismatched or stale secret key causes local RPC calls to fail with `Invalid API key` after request authentication succeeds.
- The Portal HMAC secret is independent of `REMOTE_SERVICE_API_KEY`, Supabase JWT secrets, and every Supabase client key. Keep dev/Preview and main/Production keyrings, Supabase projects, EdgeOne deployments, and `portal:<environment>:v1` namespaces distinct. The user-approved initial deployment shares one Upstash database/token across R0, Dev, and Production; this is a recorded residual risk and never a permission boundary. Only the verifier holds an optional previous HMAC key during rotation.
- The R0 HMAC, publishable key, namespace, and Preview secret copies are one-time fixtures. Current and previous require different key IDs and constant-time-distinct secrets. Both empty optional previous values mean absent; one empty side fails closed. An empty optional Standard Redis password means absent. Under the approved shared-Upstash deployment, the endpoint/token source is retained and coordinated across environments: cleanup removes only its R0 secret copies and exact fixture keys together with `portal_r0_hmac_verify_v1`.
- `PORTAL_SUPABASE_PUBLISHABLE_KEY` is matched in constant time against the inbound `apikey`, checked against the current project's `SUPABASE_PUBLISHABLE_KEYS` registry, paired only with platform-injected `SUPABASE_URL`, and reused unchanged for the downstream public RPC. Remote runtime requires HTTPS; the only non-loopback HTTP origin is exact pinned CLI `http://kong:8000`. `REMOTE_SUPABASE_URL`, generic keys, legacy anon keys, secret/service-role keys, and user credentials cannot replace the Portal key. CLI 2.116.0 maps the local key into `sb-api-key` and leaves Authorization absent. `SUPABASE_ANON_KEY` is consulted only for the narrow older-local-client Bearer compatibility path at that exact local origin; hosted Authorization is rejected.
- Portal Redis provider and credential variables are the only Edge Redis surface. Missing Portal-only values fail closed; provisioning Portal must not create a generic auth Redis fallback.
- Portal Hybrid provider variables are likewise independent of generic OpenAI, SageMaker, and AWS values. Missing, partial, whitespace-bearing, malformed, or unsafe Portal provider configuration fails before Redis, model, AWS, or database calls; an exact-false/unset kill switch returns before that provider configuration is read.
- `portal_data_product_results_v1` uses only the matching project publishable key for its downstream `api.portal_get_published_lcia_values_v1` call. It must never receive or construct a service-role/secret-key client.
- `portal_hybrid_search_v1` uses the same once-resolved dedicated current-project publishable key only for the explicitly selected `api.portal_hybrid_search_v1` or `api.portal_hybrid_search_v2`. It never calls `hybrid_search_processes`, `hybrid_search_flows`, another raw/login Hybrid RPC, or a service client.

### Real Upstash guard fixture

The real network fixture is explicit and excluded from `pnpm check`. Give it a mode-0600 file containing exactly the two official Upstash exports:

```bash
chmod 600 /absolute/path/to/upstash.env
pnpm test:portal-upstash-live -- --env-file /absolute/path/to/upstash.env
# Recovery after interruption or a failed cleanup:
pnpm test:portal-upstash-live -- --env-file /absolute/path/to/upstash.env \
  --cleanup-only --run-id <retained-run-id>
```

The runner accepts only `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, maps them in-memory to the Portal-prefixed runtime names for one minimal-environment Deno child, grants no filesystem access, and restricts network access to the exact Upstash host. Each normal run unconditionally generates and prints one non-secret canonical UUIDv4 receipt before starting the child; supplying `--run-id` on a normal run is rejected. The receipt's 128 bits are losslessly encoded into the runtime-compatible `portal:t<25-char-base36>:v1` namespace, so deterministic keys exist only inside that per-run namespace. Retain the run ID from interrupted output and pass it explicitly to `--cleanup-only`, which reconstructs and removes only that run's exact keys. Normal runs remove their own exact keys before and after proving replay `SET NX EX`, Lua budget/concurrency, lease release, and bounded cache. Neither mode prints the endpoint, token, nonce, Redis keys, or values. Do not load this source file into Portal/Next, a browser build, or the general Edge runtime env. Passing this fixture does not deploy a Function or authorize production enablement.

### 2. HTTP test env (repo root `.env`)

`test.example.http` reads variables from repository root `.env`. Start from the checked-in HTTP-only template:

```bash
cp .env.example .env
```

This root `.env` is only for local HTTP clients and request collections. It should contain endpoint URLs, request credentials, and request ids such as:

- `LOCAL_ENDPOINT` / `REMOTE_ENDPOINT`
- `X_REGION`
- `USER_JWT`
- `SERVICE_API_KEY`
- LCA request ids such as `LCA_PROCESS_ID`, `LCA_PROCESS_VERSION`, `LCA_IMPACT_ID`, `LCA_JOB_ID`, and `LCA_RESULT_ID`
- TIDAS import request ids and artifact metadata

Do not put `REMOTE_SUPABASE_SECRET_KEY`, `REMOTE_SUPABASE_PUBLISHABLE_KEY`, OpenAI keys, AWS keys, Redis credentials, or other function runtime secrets in the repository root `.env`.

## Local Development

### Start the local test environment

Start the local Supabase stack first. This provides the local gateway at `LOCAL_ENDPOINT` and is required before `pnpm start` can serve functions:

```bash
pnpm exec supabase start
```

Typical local endpoints:

- API URL: `http://127.0.0.1:54321`
- Functions URL: `http://127.0.0.1:54321/functions/v1`
- Studio URL: `http://127.0.0.1:54323`
- DB URL: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`

Serve Edge Functions in another terminal:

```bash
pnpm start
```

`pnpm start` is equivalent to:

```bash
pnpm exec supabase functions serve \
  --env-file ./supabase/.env.local \
  --no-verify-jwt
```

Stop the local stack when finished:

```bash
pnpm exec supabase stop
```

The repository serves with `--no-verify-jwt` by design. Gateway JWT verification is disabled for both local and remote deploys; each function must still run its own runtime authentication path. Signed Portal routes verify `portal-hmac-v1` before nonce registration, admission, JSON parsing, cache access, or database work.

### Deploy Edge Functions

Authenticate the Supabase CLI when needed:

```bash
pnpm exec supabase login
```

The existing runtime rejects any timeout above 6000 ms. Expanding to the bounded 25000 ms correctness-first deadline therefore uses code-first rollout: deploy the compatible function while the target still has 6000, expand the Hybrid lease to 35 seconds, set the timeout to 25000, and only then write the exact deployment SHA:

```bash
pnpm deploy:dev portal_hybrid_search_v1
pnpm exec supabase secrets set PORTAL_HYBRID_LEASE_TTL_SECONDS=35 \
  --project-ref submidrhbtknjxfympna
pnpm exec supabase secrets set PORTAL_HYBRID_TIMEOUT_MS=25000 \
  --project-ref submidrhbtknjxfympna

pnpm deploy:main portal_hybrid_search_v1
pnpm exec supabase secrets set PORTAL_HYBRID_LEASE_TTL_SECONDS=35 \
  --project-ref qgzvkongdjqiiamzbbts
pnpm exec supabase secrets set PORTAL_HYBRID_TIMEOUT_MS=25000 \
  --project-ref qgzvkongdjqiiamzbbts
```

Do not set `25000` while the target still runs code capped at `6000`: that mismatch fails closed as `guard_unavailable`. Set `PORTAL_HYBRID_DEPLOYMENT_SHA` to the exact eligible deployed merge only after the corresponding deploy and both configuration updates succeed.

Deploy to the persistent `dev` project (`submidrhbtknjxfympna`) from the Git `dev` line or a reviewed PR branch:

```bash
pnpm deploy:dev portal_data_product_results_v1 portal_hybrid_search_v1 flow_hybrid_search process_hybrid_search lifecyclemodel_hybrid_search contact_hybrid_search flowproperty_hybrid_search source_hybrid_search unitgroup_hybrid_search process_dataset_extraction_jobs embedding_ft
```

Deploy to the production `main` project (`qgzvkongdjqiiamzbbts`) only as part of the `dev -> main` promote flow:

```bash
pnpm deploy:main portal_data_product_results_v1 portal_hybrid_search_v1 flow_hybrid_search process_hybrid_search lifecyclemodel_hybrid_search contact_hybrid_search flowproperty_hybrid_search source_hybrid_search unitgroup_hybrid_search process_dataset_extraction_jobs embedding_ft
```

The deploy script pins the Supabase CLI version from `package.json`, sets the target `--project-ref`, disables gateway JWT verification with `--no-verify-jwt`, and passes `supabase/functions/deno.json` as the import map so server-side bundling resolves shared npm/jsr imports.

The disposable R0 function is deliberately excluded from both commands above. The authenticated CLI account must read the configured Main parent's Preview branches. The guard reruns `supabase branches list --project-ref qgzvkongdjqiiamzbbts --output-format json` and accepts only exactly one target whose parent is Main, `is_default=false`, `persistent=false`, `with_data=false`, `status=FUNCTIONS_DEPLOYED`, and `preview_project_status=ACTIVE_HEALTHY`, with exact branch name/Git branch and optional PR-number binding. A 403, malformed response, or empty list fails closed. From a clean exact commit, export the verified branch identity, matching SHA/expiry, and deploy acknowledgement:

```bash
PORTAL_R0_PROJECT_REF=<isolated-preview-project-ref> \
PORTAL_R0_RUNTIME_TARGET=preview \
PORTAL_R0_SUPABASE_BRANCH_NAME=<exact-supabase-branch-name> \
PORTAL_R0_SUPABASE_GIT_BRANCH=<exact-git-branch> \
PORTAL_R0_DEPLOYMENT_SHA="$(git rev-parse HEAD)" \
PORTAL_R0_DEPLOY_EXPIRES_AT=<ISO-8601-within-24-hours> \
PORTAL_R0_DISPOSABLE_ACK=delete-after-evidence \
pnpm deploy:portal-r0 preview
```

When the Preview is PR-bound, also export `PORTAL_R0_SUPABASE_PR_NUMBER=<exact-pr-number>`; if supplied, it must exactly match the live branch row.

The guard fixes the slug to `portal_r0_hmac_verify_v1`, rejects the persistent Dev/Main refs, rejects dirty or mismatched SHAs, and rejects `main`, `production`, or an expiry beyond 24 hours. Provision its one-time `PORTAL_R0_*` identities and secret copies separately, collect the immutable EdgeOne/Supabase/Redis evidence, then delete the remote function, exact receipt-bound fixture keys, and disposable Preview secret copies. Never delete the shared Upstash database, touch Dev/Main namespaces, or rotate its source token as a single-environment cleanup action.

Using the same guarded environment and exact deployed checkout, delete only the remote function with:

```bash
PORTAL_R0_CLEANUP_ACK=delete-function-and-confirm-external-resources \
pnpm cleanup:portal-r0 preview
```

Set `PORTAL_R0_CLEANUP_DRY_RUN=true` to validate the command without remote mutation. Cleanup repeats the live branch query and separate acknowledgement but does not require future expiry, `FUNCTIONS_DEPLOYED`, or `ACTIVE_HEALTHY`. A paused, unhealthy, or failed branch with the exact immutable identity still receives the fixed function-delete attempt; a real delete failure blocks cleanup. If the branch is absent from a valid nonempty Main-parent response, cleanup reports a verified terminal and skips deletion. Successful delete, terminal, and dry-run paths print only the external exact-key/temporary-secret checklist, including the mandatory shared-resource preservation check, never branch metadata or credential values.

Recommended deploy workflow:

1. Validate locally with `pnpm lint`, `pnpm check`, and targeted smoke requests.
2. Confirm the target project already has the required runtime secrets.
3. Deploy named functions only. Avoid omitting function names or using `--prune` unless the intention is to deploy/delete the whole remote function set.
4. Smoke the deployed endpoint through `test.example.http` or equivalent curl requests.
5. Record any deployment or smoke-test outcome on the PR.

Do not patch remote secrets as part of normal function deployment. With this repository's pinned Supabase CLI, remote function secrets are managed separately through the Supabase Dashboard or explicit `supabase secrets` operations such as:

```bash
pnpm exec supabase secrets list --project-ref <project-ref>
pnpm exec supabase secrets set KEY=value --project-ref <project-ref>
```

Treat `supabase secrets set --env-file ...` as a credential operation, not as a deploy shortcut. It can write many values at once, so use it only with an explicitly reviewed secret file and target project.

## Local Test

### Quick smoke test

```bash
set -a
. ./.env
set +a

curl -i --location --request POST "$LOCAL_ENDPOINT/process_hybrid_search" \
  --header "Authorization: Bearer $USER_JWT" \
  --header 'Content-Type: application/json' \
  --data '{"query":"硅酸盐水泥"}'
```

### Request collection

See `test.example.http` for local and remote examples. Treat it as a supporting artifact for concrete payloads rather than a canonical AI contract doc. It currently includes:

- `flow_hybrid_search`
- `process_hybrid_search`
- `lifecyclemodel_hybrid_search`
- `contact_hybrid_search`
- `flowproperty_hybrid_search`
- `source_hybrid_search`
- `unitgroup_hybrid_search`
- `app_dataset_verify_remote`
- `app_dataset_submit_review`
- `admin_review_quality_diagnostic`
- `app_worker_jobs`
- `ai_suggest`
- `lca_solve` / `lca_jobs` / `lca_results`
- `lca_query_results`
- `lca_contribution_path` / `lca_contribution_path_result`
- `import_tidas_package` / `tidas_package_jobs`

`portal_r0_hmac_verify_v1`, `portal_data_product_results_v1`, and `portal_hybrid_search_v1` are intentionally not represented by reusable static signatures in the request collection. Their caller must generate a fresh timestamp and 128-bit nonce, hash and sign the exact raw body bytes, and send those same bytes once.

### Disposable Portal R0 HMAC/Redis contract

`portal_r0_hmac_verify_v1` exists only to prove EdgeOne Web Crypto signer interoperability against Supabase Deno and isolated Redis. Its sole valid raw JSON body is `{"schemaVersion":"portal.r0-hmac-verify-request.v1"}`. HMAC canonical bytes bind the fixed public path `/functions/v1/portal_r0_hmac_verify_v1`; the exact stripped `/portal_r0_hmac_verify_v1` runtime path is accepted only while retaining that public canonical path.

After raw-byte HMAC, the handler constant-time matches the dedicated current-project `PORTAL_R0_SUPABASE_PUBLISHABLE_KEY`, rejects Authorization and Cookie, registers nonce with `SET NX EX 120`, and invokes the reviewed atomic Lua budget/concurrency primitive under `portal:r0:<fixture>:v1`. Only then does it parse the one-field request. Success returns only `{"schemaVersion":"portal.r0-hmac-redis-receipt.v1","ok":true}`. Failures return the same schema with a fixed code and no secret, nonce, body, Redis key/value, credential, locator, or internal error.

The endpoint has no database, RPC, model, provider, repository, storage, cache, business payload, or logging path. Generic-only or retained Portal configuration, replay, Redis outage/timeout/malformed reply, budget/concurrency contention, and lease-cleanup failure all fail closed. Current+previous rotation is allowed only for the short fixture window. After the recorded Preview proof, delete the endpoint, exact R0 fixture keys, and temporary Preview identities/copies while preserving the shared Upstash database and Dev/Main namespaces.

### Portal signed public LCIA contract

`portal_data_product_results_v1` accepts the public `POST /functions/v1/portal_data_product_results_v1` path and the exact `/portal_data_product_results_v1` path produced after pinned Supabase CLI routing strips `/functions/v1`; no suffix or other function path is accepted. HMAC canonical bytes always contain the public path. The request requires the five `portal-hmac-v1` headers (`x-portal-key-id`, `x-portal-timestamp`, `x-portal-nonce`, `x-portal-body-sha256`, and `x-portal-signature`) plus the exact matching project `apikey`. `x-portal-correlation-id` accepts a canonical UUID; missing or invalid values are replaced, and every response returns the resolved `X-Portal-Correlation-Id`.

The Portal BFF sends no `Authorization` or Cookie. The handler resolves only `PORTAL_SUPABASE_PUBLISHABLE_KEY`, proves it belongs to the current project through `SUPABASE_PUBLISHABLE_KEYS`, constant-time matches it to inbound `apikey`, and passes the same value downstream. Pinned CLI 2.116.0 maps that key into `sb-api-key` while leaving Authorization absent. At exact local `SUPABASE_URL=http://kong:8000`, the handler still tolerates the exact `Bearer <configured legacy anon JWT>` only for older local-client compatibility; hosted HTTPS rejects every Authorization. User, service-role, other Bearer, Cookie, `REMOTE_*` public keys, `SERVICE_API_KEY`, Supabase secret/service-role keys, user context, and storage locators remain forbidden after HMAC and before Redis.

The signed JSON body has one fixed shape:

```json
{
  "mode": "process_all_impacts",
  "processRefs": [{ "id": "<process uuid>", "version": "01.00.000" }],
  "impactCategoryId": null,
  "cursor": null,
  "limit": 50
}
```

`processes_one_impact` and `ranked_processes_one_impact` require a non-empty `impactCategoryId`; `process_all_impacts` requires exactly one Process reference, while the other modes accept 1–50 exact Process ID/version references. The request/response limits remain 32 KiB/512 KiB. A successful response is the exact top-level `portal.published-lcia-page.v1` DTO with `rows`, not an artifact-derived envelope. No current finalized publication returns a stable locator-free `404`; guard/upstream outage returns `503`; budget or concurrency exhaustion returns `429`. Missing or incomplete public evidence is unavailable and is never replaced with numeric zero.

The function validates HMAC over the raw body before transport, Redis, or JSON work, then constant-time matches the inbound public `apikey`, registers nonce with `SET NX EX 120`, acquires an atomic budget/concurrency lease, and releases the lease in `finally`. Only then may it read the hash-key cache or invoke `api.portal_get_published_lcia_values_v1` with explicit `Content-Profile: api` and the same resolved dedicated publishable credential. The LCIA cache is capped at 60 seconds so a revoked publication is rechecked within the visibility SLA; Redis is never a visibility or authorization fact source.

Each request invokes exactly one non-blocking `portal.security-event.v1` logger with only correlation ID, route, mode, cache state, HMAC/transport outcome enums, backend class, bounded latency/row/status fields, current/previous key match, recovered-lease count, error code, and the exact validated `PORTAL_LCIA_DEPLOYMENT_SHA` (or `unknown`). It never reads the Hybrid or retired shared SHA name. Raw bodies, queries, dataset UUIDs, nonce, key ID, body hash, Redis keys, cache values, API keys, secrets, Cookies, and locators are not event fields. A throwing or never-resolving logger cannot alter or delay the response.

### Portal signed public Hybrid contract

The retained `portal.hybrid-search-request.v1` shape below remains compatible. New consumers use `schemaVersion="portal.hybrid-search-request.v2"` and an explicit `cursor: null` for the first page (then echo `nextCursor`). V2 calls only `api.portal_hybrid_search_v2`, returning `portal.hybrid-search-page.v2`. Its `items` are at most 20 best-version dataset representatives; `versionGroups` retains every recalled member with independent exact-key evidence, while `candidateCount` (at most 400) and `datasetCount` distinguish version candidates from datasets. A group is ranked by its best member, never its size. The response remains bounded to 512 KiB.

V2's separate `portal_hybrid_english_query_v3` cache identity hashes kind, original query and non-secret provider/model identity, not filters, limit or cursor. It reuses only validated model output and the English vector for the existing at-most-60-second TTL; every page re-queries public Database truth. An expired continuation returns `400 invalid_request` before provider/DB work, does not trip the circuit, and requires an explicit new search. No cache key or raw query enters logs. Both Portal and Next matched mode reserve the raw original term, then alternate English and Chinese aliases within 12 terms.

For authenticated Next consumers, Process/Flow accept `version_scope="matched"` (fixed `match_count=200`) and select the additive `hybrid_search_{process,flow}_versions_v1` RPCs. A JWT context is required before model work; no service-role grant is added. Success, including empty success, is `{ data, versionScope: "matched" }`. Missing/duplicate/malformed exact identities fail; the old mode and response bytes remain unchanged when this opt-in is omitted.

`portal_hybrid_search_v1` accepts only public `POST /functions/v1/portal_hybrid_search_v1` and the exact `/portal_hybrid_search_v1` path produced by pinned CLI routing. It uses the same five `portal-hmac-v1` headers, dedicated current-project `PORTAL_SUPABASE_PUBLISHABLE_KEY`, absent Cookie/Authorization contract, optional exact pinned-CLI legacy-anon Bearer compatibility, and correlation header as the LCIA route. HMAC and transport validation precede the default-off kill switch; only `PORTAL_HYBRID_ENABLED=true` continues. The complete Portal-only OpenAI/SageMaker/AWS configuration is resolved only after that switch and injected explicitly into the shared kernels, with no generic fallback. Replay registration, independent minute/day budgets, TTL concurrency lease, and circuit check all precede JSON, OpenAI, SageMaker, or database work.

The strict request is:

```json
{
  "schemaVersion": "portal.hybrid-search-request.v1",
  "kind": "process",
  "query": "low-carbon steel production",
  "filters": {
    "accessLevel": "open",
    "geography": "cn",
    "classification": "metals",
    "referenceYearFrom": 2020,
    "referenceYearTo": 2026,
    "processSubtype": "unit process",
    "source": "public source"
  },
  "limit": 20
}
```

The query is trim-nonempty, at most 512 Unicode code points and 2048 UTF-8 bytes, and contains no C0/C1 controls. String filters are first trimmed and lowercased, then limited to 128 code points/1024 bytes each; the fully transformed serialized filter object is at most 4096 bytes. This order ensures Unicode lowercase expansion is included in every bound. `processSubtype` is Process-only. For V1, extra fields—including cursor, sort, state, actor, team, `data_source`, model, weights, threshold, embedding, visitor hash, or notes—fail as `invalid_request`. V1 has no Hybrid cursor; only the explicitly versioned V2 contract above supports continuation.

The route reuses the existing deterministic query-rewrite and 1024-dimensional SageMaker kernels under one absolute 25000 ms Edge deadline that starts at handler entry and retains five seconds of headroom before the Portal BFF's 30000 ms deadline. The Hybrid-only lease is 35 seconds so Redis plus the operation and five-second cleanup recovery remain covered. After HMAC, transport and enablement, one Hybrid-only Lua call performs nonce `SET NX EX 120`/replay rejection, expired-lease recovery, minute/day budget checks, concurrency/TTL lease acquisition and circuit check in the same logical order as the former guard. Replay never reaches recovery or counters; recovery happens before concurrency as in the existing atomic guard; budget/concurrency rejection precedes circuit; an admitted open circuit retains a lease that existing cleanup releases. Only an admitted closed result may proceed to JSON/schema validation and the separate hash-only model-cache read, preserving `invalid_request` before cache faults. A valid model-cache miss first completes and validates the provider-explicit OpenAI rewrite, then generates the SageMaker vector from normalized `semantic_query_en`. Both stages use the same request operation signal inherited from the deadline; rewrite rejection, invalid output or timeout prevents embedding, while later failure cancels downstream work before response/lease release. Full-text requests retain the original query in every language plus bounded, case-insensitively deduplicated aliases; only model-generated interpretation is presented as advisory AI output. The validated model-cache write starts concurrently with the public Database query so their network latency no longer accumulates serially; both remain capped by the same deadline, cache-write failure remains best effort, and both outcomes settle before a Database rejection event is sanitized so `write_failed` cannot be lost. The Portal-only Responses request keeps the same model, prompts, strict JSON Schema, temperature and AbortSignal while setting `store=false`, `reasoning.effort=none`, `text.verbosity=low`, and `max_output_tokens=256`; it does not request a priority/flex service tier and does not change the generic/login OpenAI wrappers. Raw body/HMAC work and every awaited Redis, model, database, cache-write, circuit-record/reset, and final-response operation are capped to the same remaining budget. A late operation cannot start downstream database work or produce HTTP 200. Lease release and owned Redis close are bounded detached cleanup and never delay the response; the lease TTL recovers any unfinished release. After sanitizing the final security event, the handler performs its last deadline decision and schedules the logger in a later macrotask. Supabase tracks the bounded delivery with `EdgeRuntime.waitUntil`; local/test runtimes use a handled fallback outside the handler promise. Synchronously blocking, throwing, rejecting, and never-settling loggers cannot change or delay the response, and the event status/error code matches the response actually returned. The event records only fixed rewrite/embedding outcomes plus nullable bounded stage latency: success marks both `succeeded`, a cache hit marks both `cache_hit`, rewrite failure leaves embedding `not_called`, while embedding failure retains the completed rewrite outcome, and deadline expiry marks pending stages `aborted`. It contains no query, model name, endpoint, provider error, identifier, or credential. Its `portal.hybrid-model-cache.v2` Redis cache uses the separate `portal_hybrid_english_v2` keyspace and holds only bounded model-generated interpretation plus English-query embedding, never the raw query or database candidates, and expires in at most 60 seconds. Every V1 success still calls publishable-only `api.portal_hybrid_search_v1(p_kind,p_query_terms,p_query_embedding,p_filters,p_limit)` with explicit `Content-Profile: api`. Correct semantic completion is the release criterion; elapsed time remains observable for subsequent optimization.

A success is exact `portal.hybrid-search-page.v1`: the Database fingerprint and up to 20 unique R1 public cards, each with exhaustive reference, functional-unit, technology, source/license, and public-quality context, plus `interpretation.source=model_generated`, `advisory=true`, one semantic query, and at most 12 bounded language-tagged terms. Match evidence uses only algorithm `portal-hybrid-rank-v1`, score, actual lexical/semantic ranks, and non-negative canonical semantic distance; reason codes must correspond to present evidence. Missing/malformed context, raw JSON/search text, embeddings, owner/team/model/review fields, locators, and duplicate identities fail the contract.

Stable error codes are `method_not_allowed`, `request_too_large`, `portal_auth_unavailable`, `portal_auth_failed`, `hybrid_disabled`, `guard_unavailable`, `replay_rejected`, `budget_exhausted`, `concurrency_exhausted`, `circuit_open`, `invalid_request`, `hybrid_timeout`, `hybrid_upstream_unavailable`, `contract_failure`, and `internal_error`. Edge returns no lexical results or fallback envelope. The same-origin Portal BFF maps these fixed codes to its observable fallback reason and calls the separate R1 lexical façade. The function emits one allowlisted `portal.hybrid-security-event.v1` with only its exact validated `PORTAL_HYBRID_DEPLOYMENT_SHA` (or `unknown`), fixed provider-stage outcomes, bounded latency, and existing safe request state; it never reads the LCIA or retired shared SHA name, never logs query/model/endpoint/provider-error/identifier/credential/Redis/locator data, and sets no wildcard CORS header.

### TIDAS package artifact download contract

`tidas_package_jobs` returns package artifacts with backward-compatible download fields:

- `signed_download_url` is present only when the artifact is `ready`, not expired, not deleted, has a valid storage path, and storage can create a signed URL.
- `download_status` is one of `available`, `not_ready`, `expired`, `deleted`, `object_missing`, `storage_path_invalid`, or `signed_url_failed`.
- `download_error_code` is `null` for `available`; stable unavailable codes include `PACKAGE_ARTIFACT_EXPIRED`, `PACKAGE_ARTIFACT_DELETED`, `PACKAGE_ARTIFACT_OBJECT_MISSING`, `PACKAGE_ARTIFACT_STORAGE_PATH_INVALID`, `PACKAGE_ARTIFACT_NOT_READY`, `PACKAGE_ARTIFACT_STALE`, and `PACKAGE_ARTIFACT_SIGNED_URL_FAILED`.

Clients should treat `expired`, `deleted`, and `object_missing` as terminal download states and prompt the user to regenerate or re-upload the package. Job lookup itself still returns HTTP `200` when the authenticated user can read the job; missing jobs, auth failures, and business failures keep their existing top-level status and error-code behavior.

### Auth / connectivity probe

当你怀疑远端出现“函数通了，但 auth 行为漂移”这类问题时，优先跑仓库内的统一探测脚本：

```bash
pnpm probe:auth --remote
```

脚本会自动读取：

- 根目录 `.env` 中的 `REMOTE_ENDPOINT` / `LOCAL_ENDPOINT`
- `USER_JWT`
- `supabase/.env.local` 或 shell env 里的 `REMOTE_SERVICE_API_KEY` / `SERVICE_API_KEY`

也可以显式覆盖：

```bash
EDGE_BASE_URL="https://<project-ref>.supabase.co/functions/v1" \
USER_JWT="<your-user-jwt>" \
pnpm probe:auth --base-url "$EDGE_BASE_URL"
```

默认行为：

- 默认跳过仓库中标记为 disabled 的 `antchain_*` 和 legacy 非 `*_ft` embedding / webhook 入口
- 默认跳过仅供本地辅助使用的 `embedding_ft_local`
- 对其余函数至少发一轮无鉴权最小请求，并在有对应凭据时继续发 Supabase JWT / service API key 探测；不存在 user API key 探测或交换路径
- 结果会区分：
  - `gateway_invalid_jwt`：大概率是请求在进入函数前就被平台层拦住
  - `function_auth_failed`：请求已进入函数，但函数内鉴权拒绝了该凭据
  - `reachable_but_payload_invalid`：连通性和鉴权大概率没问题，只是最小 probe body 不满足业务校验

常用参数：

```bash
# 只看 lca_* 这组
pnpm probe:auth --remote --only lca_

# 把默认跳过的 disabled / local-only 入口也带上
pnpm probe:auth --remote --include-disabled --include-local-only

# 输出 JSON 报告，方便留存对比
pnpm probe:auth --remote --json-out ./tmp/edge-probe-report.json

# 不发请求，只看当前脚本会如何分类和选择鉴权方式
pnpm probe:auth --dry-run
```

## AI Suggestion Worker API

`ai_suggest` authenticates a user and hands versioned work to the generic Rust `ai-worker`; Edge does not call LangGraph or an AI provider directly. Enqueue with the legacy-compatible payload (the `options` object is accepted but ignored):

```json
{
  "action": "enqueue",
  "tidasData": "{\"processDataSet\":{}}",
  "dataType": "process",
  "options": {}
}
```

The response is HTTP `202` with `data.jobId`. Poll through the same function:

```json
{ "action": "read", "jobId": "<worker job uuid>" }
```

Queued and running jobs return public progress. A completed job includes `data.result` with schema `ai.tidas_suggestion.result.v1`; `complete` and `partial` are both advisory results that the user may inspect and accept field by field. Requests require a verified Supabase JWT, `tidasData` is capped at 2 MiB, and Process/Flow root shape is checked before enqueue. The response never includes the queued payload, lease, internal diagnostics, or provider details.

## OpenAI Integration Baseline

- No LangChain dependency in active path.
- OpenAI SDK mapping is in `supabase/functions/deno.json`:
  - `@openai/openai -> npm:openai@7.8.0`
- Shared wrappers:
  - `supabase/functions/_shared/openai_structured.ts`
  - `supabase/functions/_shared/openai_chat.ts`
- Default model fallback in code is `gpt-4.1-mini` when env/model option is not provided.
- Signed Portal Hybrid uses separate provider-explicit `portal_hybrid_kernel.ts` and `portal_openai_structured.ts` adapters. They read no generic provider variable; the existing wrappers above remain unchanged for every non-Portal consumer.

The reviewed Edge dependency baseline also pins AWS SDK 3.1121.0, Supabase JSR 2.112.4, Upstash Redis 1.38.3, Deno Redis 0.41.2, Zod 4.5.4, and Prettier 3.9.6. Redis dependencies remain only for isolated Portal runtimes. TIDAS package routes enqueue database `worker_jobs`; they do not import the JavaScript TIDAS SDK.

## Required Development Workflow

After any code or document update:

1. Run the non-mutating formatting check:

```bash
pnpm lint
```

Use `pnpm format` only when you intend to rewrite files with Prettier.

2. Run the repo baseline Deno checks:

```bash
pnpm check
```

This canonical gate validates exact runtime versions, one bounded shared 152-root Deno graph, 73 Node contract tests, and 526 default Deno behavior tests; the one credentialed live Upstash test is ignored unless explicitly selected. It intentionally skips the currently disabled `antchain_*` functions. The retired generic non-FT embedding worker and LLM summary webhooks are no longer part of the source inventory; the deterministic `embedding_ft` family remains active.

3. Run minimal checks for affected files when you need scoped verification during iteration:

```bash
deno check --config supabase/functions/deno.json <changed-file>
```

4. Keep docs synced:

- Update `README.md` for human-facing workflow changes.
- Update `AGENTS.md` for repo contract, boundaries, or minimal execution-fact changes.
- Update `.docpact/config.yaml` when routing, ownership, governed-doc rules, or freshness coverage changes.

## Worker Jobs RPC Prerequisite

LCA solve/snapshot/contribution path, TIDAS package import/export, the Review Admin quality diagnostic, and compatibility-only review-submit orchestration use database-owned `worker_jobs` for canonical task lifecycle state. The target database must include the `database-engine` worker job contract migrations before these Edge Functions are deployed:

- `public.worker_enqueue_job(...)`
- `public.worker_read_job(...)`
- `public.worker_list_jobs(...)`
- `public.worker_cancel_job(...)`
- `api.svc_ai_tidas_suggestion_enqueue(...)`
- `api.svc_ai_tidas_suggestion_read(...)`

Review submission and the dedicated administrator projection additionally require:

- `api.cmd_review_submit(...)`
- `api.cmd_review_quality_diagnostic_start()`
- `api.qry_review_quality_diagnostic(...)`

Retained domain tables such as `lca_jobs`, `lca_result_cache`, `lca_package_jobs`, `lca_package_artifacts`, and `dataset_review_submit_jobs` still carry result/cache/artifact/history metadata, but Edge no longer accesses them directly. New LCA solve/snapshot/contribution and TIDAS package import/export submissions use service-only capability RPCs that atomically manage canonical `worker_jobs` and compatibility state. Legacy `lca_enqueue_job` / `lca_package_enqueue_job` must not be used as enqueue fallback. If `LCA_WORKER_JOBS_ENABLED=false`, `TIDAS_PACKAGE_WORKER_JOBS_ENABLED=false`, or `WORKER_JOBS_CUTOVER_ENABLED=false`, new worker-owned submissions fail closed with `legacy_queue_disabled` / `LEGACY_QUEUE_DISABLED` instead of writing to the legacy queue path.

## Review Submission And Review Admin Quality Diagnostic

`app_dataset_submit_review` is the current authenticated review-submission endpoint. It calls stable database RPC `cmd_review_submit` directly:

```json
{
  "table": "processes",
  "id": "<dataset uuid>",
  "version": "01.00.000"
}
```

Process submission does not start or wait for a Worker job. Database authorization, current-version checks, conflicting active Review checks, Root/Reference Review creation, state transitions, concurrency, and audit remain server-side blockers. Retired Gate metadata is rejected as an unexpected request field.

`admin_review_quality_diagnostic` is a separate Review Admin-only, manual, informational endpoint. It accepts exactly two actions:

```json
{ "action": "start" }
```

```json
{ "action": "read", "runId": "<optional diagnostic run uuid>" }
```

Omitting `runId` reads the latest run. `start` creates or reuses the one active pending-review diagnostic and returns HTTP `202`; `read` returns HTTP `200` for any found run, including `completed`, `failed`, `findings`, or `not_evaluable` states. The browser cannot send Review IDs, Process IDs, states, or a custom scope. Database RPCs derive the pending-review scope and enforce Review Admin membership; a Review Member receives `REVIEW_ADMIN_REQUIRED` with HTTP `403`.

Diagnostic reports are never Review workflow authority. `informationalOnly=true`, `affectsReviewState=false`, and finding `workflowBlocking=false` mean that no diagnostic state may disable assignment, approval, or rejection.

The retired review-submit Gate, coordinator, and job endpoints are no longer deployed. Historical request and worker-job rows remain database audit records; new submissions use `app_dataset_submit_review` directly.

`app_worker_jobs` remains the authenticated task-center API for user-visible `worker_jobs`. The Review Admin diagnostic uses its dedicated projection because its job visibility is operator-only.

## LCA Function Call Patterns

- `lca_solve`: `POST` only.
  - optional `data_scope`: `"current_user"` (default), `"open_data"`, `"all_data"`, `"public_plus_owner_draft"`
  - body can combine `data_scope` with normal solve payload, for example `{ "data_scope": "current_user", "demand": { "process_id": "<uuid>", "process_version": "00.00.001", "amount": 1.0 } }`
  - legacy snapshot family semantics: `current_user`, `open_data`, and `all_data` reuse the same user-enhanced snapshot family, i.e. published data plus the current user's private data
  - root-process semantics stay distinct: `current_user` only accepts current-user processes, `open_data` only accepts published processes, `all_data` accepts published plus current-user processes
  - `public_plus_owner_draft` is a separate versioned scope: it admits exactly public `state_code=100` rows plus all authenticated-owner `state_code=0` rows regardless of team/review workflow metadata, and rejects public 101–199, foreign drafts, and owner nonzero states
  - its actor-bound scope manifest applies only to process and flow visibility. LCIA methods/factors are a separate reviewed static-cache source: Edge embeds exact `lciamethods/cache_manifest.json` bytes and SHA-256, while the worker alone resolves the trusted base URL; callers cannot supply a source URL, path, or hash
  - its LCIA coverage contract counts `exchange_method_pair` outcomes for every one of the 25 reviewed method identities. Every method row must cover the same nonzero exchange-pair cardinality, aggregate counts must equal the row sums, and unmatched, invalid, or unsupported-direction pairs mean incomplete coverage rather than zero impact
  - without an explicit snapshot, single-process solve derives exactly one normalized request root from authenticated `demand.process_id` plus `demand.process_version`; the root must exist in the actor's exact data scope before any snapshot job is enqueued
  - callers cannot provide `request_roots` / `requestRoots`; Edge derives roots from the authenticated demand and binds them into the Worker payload, build hash/idempotency, and snapshot process-filter identity
  - request-root snapshots and filtered full-library snapshots are separate identities and are never auto-reused for each other. Different roots are also separate identities
  - if the exact root snapshot is not ready, the first valid request returns HTTP `409` with `error=snapshot_build_queued`; retry the same solve only after that exact snapshot becomes ready
  - a snapshot-less single request that supplies only `process_index`, or a `process_id` without `process_version`, does not enqueue a full-library fallback. `process_index` remains compatible when an eligible full-library snapshot is already ready, and explicit snapshot requests retain their existing index/ID resolution behavior
  - explicit snapshot IDs are accepted for this scope only when their stored process filter matches the same actor-bound data-scope manifest and hash; explicit selection identity may be full-library or request-root, but the demanded process is still checked against actor scope
  - solve, query, and contribution-path routes fail closed unless the snapshot index returns exact `lca.calculation_evidence.v2`, static source snapshot v2, and 25-row method coverage evidence. V1 database-source/union evidence and the superseded combined-scope hash are rejected
  - incomplete evidence binds a `lcia-uncharacterized-jsonl:v2` artifact URL, SHA-256, and record count. The immutable raw private-storage URL is not a browser download contract; clients must not expose it as a production link until an authenticated signed projection is available
  - missing snapshot auto-build is attempted for every `data_scope`: exact request-root closure for snapshot-less single-process ID/version demand, and filtered-library scope for `all_unit`
- `lca_jobs`: retained compatibility route, supports `GET` and `POST`.
  - `GET`: `/functions/v1/lca_jobs/{jobId}` or `?job_id=...`
  - `POST`: body `{ "job_id": "<uuid>" }`
- `lca_results`: supports `GET` and `POST`.
  - `GET`: `/functions/v1/lca_results/{resultId}` or `?result_id=...`
  - `POST`: body `{ "result_id": "<uuid>" }`
- `lca_query_results`: `POST` only.
  - reads both the historical inline `all-unit-query:v1` artifact and the chunked `all-unit-query:v2` index emitted by current workers; callers do not select the storage format
  - v2 reads verify the persisted index byte size and SHA-256, Calculation Bundle binding, safe chunk paths, contiguous process coverage, per-chunk byte size/SHA-256, gzip decoding, record counts, and exact process/method order before returning values
  - row queries download only the chunks covering the requested processes; hotspot queries stream the selected impact column across chunks and do not reconstruct or persist the complete matrix in Edge
- Data Product package preview uses the same verified `all-unit-query:v1` / `all-unit-query:v2` reader. For v2 it reads only the LCIA chunks covering the requested page and selected impact category, instead of requiring the removed inline `h_matrix`.

## LCI/LCIA Release Function Call Patterns

- `app_lca_release_commands`: authenticated `POST` command endpoint. It accepts a verified Supabase access JWT and delegates authorization/state changes to the database-owned release RPCs. The public CLI obtains that JWT through its client-local OAuth session; an approved headless orchestrator may inject a separately verified short-lived actor token. There is no User API-key exchange, and the Supabase service-role key is never included in command payloads.
  - lifecycle actions: `prepare`, `create_artifact_uploads`, `finalize_artifacts`, `approve`, `publish`, `readback_verify`, `unpublish`
  - authenticated reads: `get_release`, `get_current`, `get_calculation_bundle`, `create_artifact_download`
  - exactly four ZIPs are accepted: Unit Process and standalone LifecycleModel+Result, each in TIDAS and ILCD. Maximum size is 50 MiB per ZIP.
  - `create_artifact_uploads` returns short-lived signed upload URLs for private, content-addressed, server-derived paths. The signed upload permits idempotent replacement at the same immutable plan/profile/format/hash identity so an interrupted upload can be retried; `finalize_artifacts` still downloads every object and verifies its exact byte size and SHA-256 before the service-only finalize RPC.
  - `get_calculation_bundle` accepts the historical `tiangong.calculation-bundle.v1` and current `tiangong.calculation-bundle.v2`, verifies that the durable schema exactly matches the private manifest together with byte size, SHA-256, content hash, artifact count, and safe relative paths, then returns 15-minute signed URLs for preview shards plus the database-projected LCIA XLSX/CSV, LCI Parquet/CSV, and whole-bundle audit downloads. Semantic filenames are bound into `Content-Disposition`; private object locators are removed.
- `lca_release_results`: `GET` or `POST` read endpoint.
  - no payload or `mode=current` returns the current public release
  - `mode=process&processId=<uuid>&processVersion=<XX.XX.XXX>` returns the current public release plus the exact Unit Process, generated LifecycleModel, and Result Process identities for that source Process
  - `mode=release&releaseRunId=<uuid>` returns public/superseded metadata anonymously and private metadata only to an authenticated manager
  - `mode=artifact_download&artifactId=<uuid>` returns a 15-minute signed download URL only after the database authorizes the artifact projection. The response includes a server-derived `downloadFilename`, and the signed URL sets the same semantic filename in `Content-Disposition`; internal storage locators are omitted.
  - standard Supabase browser clients may send the matching project publishable key (or configured legacy anon key) as both `apikey` and Bearer Authorization; this remains a public read and is not treated as an authenticated actor. Other Authorization credentials must authenticate normally.

Set `LCA_RELEASE_STORAGE_BUCKET` only when release artifacts should not use the normal `S3_BUCKET`/`lca_results` private bucket. The interactive release CLI needs only the public API URL, publishable key, public OAuth client ID, and its private client-local OAuth session for a `data_product_manager`; it must never receive `REMOTE_SUPABASE_SECRET_KEY`.
