import type { ActorContext } from '../../command_runtime/actor_context.ts';
import { buildCommandAuditPayload } from '../../command_runtime/audit_log.ts';
import { assertSubmitReviewPolicy } from './policy.ts';
import { createDatasetCommandRepository, type DatasetCommandRepository } from './repository.ts';
import { type DatasetCommandExecutionResult, type SubmitReviewRequest } from './types.ts';
import { parseSubmitReviewRequest, submitReviewRequestSchema } from './validation.ts';

export { submitReviewRequestSchema };

export function parseSubmitReviewCommand(body: unknown, operationKey: string | null = null) {
  const parsed = parseSubmitReviewRequest(body);
  if (!parsed.ok || operationKey === null) return parsed;
  if (!/^[0-9a-f]{64}$/.test(operationKey)) {
    return { ok: false as const, message: 'Invalid review operation key' };
  }
  return { ok: true as const, value: { ...parsed.value, operationKey } };
}

export async function executeSubmitReviewCommand(
  request: SubmitReviewRequest,
  actor: ActorContext,
  repository: DatasetCommandRepository = createDatasetCommandRepository(actor.supabase),
): Promise<DatasetCommandExecutionResult> {
  const policy = assertSubmitReviewPolicy(request);
  if (!policy.ok) {
    return policy;
  }

  const auditPayload: Record<string, unknown> = {};
  if (request.operationKey) {
    auditPayload.review_operation_key = request.operationKey;
  }
  if (request.expectedScopeDigest) {
    auditPayload.expected_scope_digest = request.expectedScopeDigest;
  }
  if (request.expectedScopeTargets) {
    auditPayload.expected_scope_targets = request.expectedScopeTargets.map((target) => ({
      table: target.table,
      id: target.id,
      version: target.version,
      ...(target.proposedStateCode === undefined
        ? {}
        : { proposed_state_code: target.proposedStateCode }),
    }));
  }

  const audit = buildCommandAuditPayload({
    command: 'dataset_submit_review',
    actorUserId: actor.userId,
    targetTable: request.table,
    targetId: request.id,
    targetVersion: request.version,
    payload: auditPayload,
  });

  const result = await repository.submitReview(request, audit);
  if (!result.ok) {
    return result;
  }

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      command: 'dataset_submit_review',
      data: result.data,
    },
  };
}
