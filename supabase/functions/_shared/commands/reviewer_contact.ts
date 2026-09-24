import { createContact } from 'npm:@tiangong-lca/tidas-sdk@0.4.1/core';
import { z } from 'zod';

import type { ActorContext } from '../command_runtime/actor_context.ts';
import type { CommandExecutionResult, CommandParseResult } from '../command_runtime/command.ts';

const versionPattern = /^\d{2}\.\d{2}\.\d{3}$/;

export const reviewerContactRequestSchema = z
  .object({
    mode: z.enum(['create', 'createVersion']),
    id: z.string().uuid(),
    jsonOrdered: z.record(z.string(), z.unknown()),
    operationId: z.string().uuid(),
    sourceVersion: z.string().regex(versionPattern).optional(),
    bind: z.boolean().optional(),
    expectedContact: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === 'createVersion' && !value.sourceVersion) {
      context.addIssue({
        code: 'custom',
        path: ['sourceVersion'],
        message: 'sourceVersion is required for createVersion',
      });
    }
  });

export type ReviewerContactRequest = z.infer<typeof reviewerContactRequestSchema>;

export function parseReviewerContactCommand(
  body: unknown,
): CommandParseResult<ReviewerContactRequest> {
  const parsed = reviewerContactRequestSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      message: 'Invalid reviewer contact payload',
      details: parsed.error.flatten(),
    };
  }
  return { ok: true, value: parsed.data };
}

function withSelfOwnership(request: ReviewerContactRequest) {
  const payload = structuredClone(request.jsonOrdered) as Record<string, any>;
  const contact = payload.contactDataSet;
  if (!contact || typeof contact !== 'object') return payload;

  const publication = ((contact.administrativeInformation ??= {}).publicationAndOwnership ??= {});
  const version = publication['common:dataSetVersion'] ?? request.sourceVersion ?? '01.00.000';
  publication['common:referenceToOwnershipOfDataSet'] = {
    '@refObjectId': request.id,
    '@type': 'contact data set',
    '@uri': `../contacts/${request.id}.xml`,
    '@version': version,
    'common:shortDescription':
      contact.contactInformation?.dataSetInformation?.['common:shortName'] ?? [],
  };
  return payload;
}

function mapRpcFailure(data: any, error: any): CommandExecutionResult | null {
  if (error) {
    return {
      ok: false,
      code: error.code ?? 'RPC_ERROR',
      message: error.message ?? 'Reviewer profile activation failed',
      status: error.code === '42501' ? 403 : 400,
      details: error.details ?? null,
    };
  }
  if (data?.ok === false) {
    return {
      ok: false,
      code: data.code ?? 'REVIEWER_CONTACT_ACTIVATION_FAILED',
      message: data.message ?? 'Reviewer profile activation failed',
      status: data.status ?? 400,
      details: data.details,
    };
  }
  return null;
}

export async function executeReviewerContactCommand(
  request: ReviewerContactRequest,
  actor: ActorContext,
): Promise<CommandExecutionResult> {
  const jsonOrdered = withSelfOwnership(request);
  let validation: {
    success: boolean;
    issues?: unknown;
    validationIssues?: unknown;
  };
  try {
    validation = createContact(jsonOrdered as any).validateEnhanced();
  } catch (error) {
    return {
      ok: false,
      code: 'REVIEWER_CONTACT_INVALID',
      message: 'Reviewer profile data validation failed',
      status: 400,
      details: error instanceof Error ? error.message : String(error),
    };
  }

  if (!validation.success) {
    return {
      ok: false,
      code: 'REVIEWER_CONTACT_INVALID',
      message: 'Reviewer profile data validation failed',
      status: 400,
      details: validation.validationIssues ?? validation.issues,
    };
  }

  const { data, error } = await actor.supabase.rpc('cmd_review_contact_activate', {
    p_mode: request.mode,
    p_id: request.id,
    p_json_ordered: jsonOrdered,
    p_operation_id: request.operationId,
    p_source_version: request.sourceVersion ?? null,
    p_bind: request.mode === 'create' ? true : (request.bind ?? true),
    p_expected_contact: request.expectedContact ?? null,
    p_audit: {
      command: 'review_contact_activate',
      actorUserId: actor.userId,
      sdkVersion: '0.4.1',
    },
  });

  const failure = mapRpcFailure(data, error);
  if (failure) return failure;

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      command: 'review_contact_activate',
      data: data?.data ?? data,
      idempotentReplay: data?.idempotent_replay ?? false,
    },
  };
}
