# Stable owner draft validation

Public validation notes for [Edge #500](https://github.com/tiangong-lca/edge-functions/issues/500), paired with [CLI #372](https://github.com/tiangong-lca/cli/issues/372) and [Database #855](https://github.com/tiangong-lca/database/issues/855). [execution.log](execution.log) is a curated, sanitized summary, rather than a complete raw transcript. It contains no real dataset identities, account details, content digests, credentials or machine paths.

## Handler and transport proof

The public handler factories are exercised by [`test/stable_draft_command_test.ts`](../../../test/stable_draft_command_test.ts), using synthetic identities and responses. Both handlers use the existing JWT-only command runtime and the verified actor's client:

| Handler                            | Sole Database RPC                      |
| ---------------------------------- | -------------------------------------- |
| `app_dataset_prepare_stable_draft` | `api.cmd_dataset_prepare_stable_draft` |
| `app_dataset_stable_draft_request` | `api.get_dataset_stable_draft_request` |

The 10 focused test groups cover complete source and draft-census forwarding, explicit draft selection, all four supported tables, actor binding, strict request rejection, error projection, authentication before body/RPC, and preflight/method handling. Dataset identity parsing accepts the SDK's lowercase fixed UUID shape, including UUIDv7 and historical identities, while actor and request UUID validation remains unchanged. Review conflicts preserve every structured review point, including nullable review identifiers.

The final group uses the pinned real Supabase client with injected `fetch`. For each handler, a disconnected response and an HTTP 503 each produce exactly one transport POST to its exact RPC URL, with the original body, `api` schema and actor Authorization. It asserts no automatic retry or fallback. The other failure fixtures separately cover missing capability and a lost RPC response.

## Recorded checkpoints

- The retained full check before the real-client transport test was added passed exact toolchain validation, the shared type graph, 152 Node tests, and 666 Deno tests; one credential-dependent test remained ignored. That run included the first nine focused groups.
- A subsequent focused execution passed all 10 groups, including the real-client transport regression, with zero failures. The final commit's canonical gate result must be recorded separately; the earlier full check does not qualify a later commit.
- The companion CLI's accepted native read-only checks covered generic source-based selection with zero existing drafts and with one existing draft. Both reported zero writes. These selection observations do not execute either preparation RPC or prove database allocation.

## Proof boundaries

Database #855 owns source/census/content revalidation, owner-family concurrency, atomic allocation, receipt persistence and native-owner protections. Its compatible RPCs must be deployed before hosted use. Edge tests preserve Database responses; they do not execute the Database implementation or establish its deployment state.

An uncertain preparation outcome requires the read-only endpoint with the exact original request. A receipt and the current target status are separate facts; `REQUEST_NOT_RECORDED` does not authorize replay. Missing capability and transport failure fail closed.

These notes establish no hosted capability, deployment, original data-flow write/readback or scientific acceptance. No production deployment was performed for this evidence.
