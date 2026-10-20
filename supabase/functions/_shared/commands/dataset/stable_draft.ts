import { z } from 'zod';

import type { ActorContext } from '../../command_runtime/actor_context.ts';
import type { CommandParseResult } from '../../command_runtime/command.ts';
import { callStableDraftRpc, type StableDraftRpcClient } from '../../db_rpc/stable_draft.ts';
import type { DatasetCommandExecutionResult } from './types.ts';

const versionSchema = z.string().regex(/^\d{2}\.\d{2}\.\d{3}$/);
// Dataset UUIDs follow the SDK shape, including historical fixed identities.
const datasetIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const bodySchema = z.record(z.string(), z.unknown());
const draftSchema = z.object({ version: versionSchema, jsonOrdered: bodySchema }).strict();

export const stableDraftRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    request: z
      .object({
        table: z.enum(['contacts', 'sources', 'flows', 'processes']),
        id: datasetIdSchema,
        expectedActorId: z.string().uuid(),
        expectedDrafts: z
          .array(draftSchema)
          .refine(
            (drafts) => new Set(drafts.map((draft) => draft.version)).size === drafts.length,
            'expectedDrafts must contain each version exactly once',
          ),
        selectedVersion: versionSchema.nullable().optional(),
        source: z
          .object({
            version: versionSchema,
            userId: z.string().uuid(),
            stateCode: z.union([z.literal(100), z.literal(200)]),
            jsonOrdered: bodySchema,
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export type StableDraftRequest = z.infer<typeof stableDraftRequestSchema>;

export function parseStableDraftCommand(body: unknown): CommandParseResult<StableDraftRequest> {
  const parsed = stableDraftRequestSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      message: 'Invalid stable draft request payload',
      details: parsed.error.flatten(),
    };
  }
  return { ok: true, value: parsed.data };
}

async function executeStableDraft(
  input: StableDraftRequest,
  actor: ActorContext,
  readOnly: boolean,
  client: StableDraftRpcClient,
): Promise<DatasetCommandExecutionResult> {
  if (input.request.expectedActorId !== actor.userId) {
    return {
      ok: false,
      code: 'DATASET_ACTOR_MISMATCH',
      status: 403,
      message: 'expectedActorId must match the authenticated actor',
    };
  }
  const result = await callStableDraftRpc(client, input, readOnly);
  if (!result.ok) return result;
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      command: readOnly ? 'dataset_stable_draft_request' : 'dataset_prepare_stable_draft',
      data: result.data,
    },
  };
}

export function executePrepareStableDraftCommand(
  input: StableDraftRequest,
  actor: ActorContext,
  client: StableDraftRpcClient = actor.supabase,
): Promise<DatasetCommandExecutionResult> {
  return executeStableDraft(input, actor, false, client);
}

export function executeStableDraftRequestCommand(
  input: StableDraftRequest,
  actor: ActorContext,
  client: StableDraftRpcClient = actor.supabase,
): Promise<DatasetCommandExecutionResult> {
  return executeStableDraft(input, actor, true, client);
}
