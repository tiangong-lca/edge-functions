import { z } from 'zod';
import {
  parseRequest,
  validateResponseForRequest,
} from '../../../../contracts/lca-study/v6/codec.ts';
import { isMethodReviewRequest } from '../../../../contracts/lca-study/v6/requests.ts';
import {
  API_SCHEMA,
  capabilitiesSchema as authoringCaps,
  DISABLED_CAPABILITIES as authoringDisabled,
} from '../../../../contracts/lca-study/v6/authoring.ts';
import {
  capabilitiesSchema as reviewCaps,
  DISABLED_CAPABILITIES as reviewDisabled,
} from '../../../../contracts/lca-study/v6/review.ts';
import {
  capabilitiesSchema,
  DISABLED_CAPABILITIES,
} from '../../../../contracts/lca-study/v6/capabilities.ts';
import { responseSchema } from '../../../../contracts/lca-study/v6/responses.ts';
import {
  executeMethodAuthoring,
  type MethodOptions as AuthoringOptions,
} from './method_executor.ts';
import { executeMethodReview, type MethodReviewOptions } from './method_review_executor.ts';
import { createMethodRepository } from './method_repository.ts';
import { unpack } from './repository.ts';
import type { ActorContext } from '../command_runtime/actor_context.ts';

export type MethodOptions = AuthoringOptions & { review?: MethodReviewOptions };
export function methodAuthoringConfig(): z.infer<typeof authoringCaps> {
  const raw = Deno.env.get('STUDY_METHOD_CONFIG');
  return raw ? authoringCaps.parse(JSON.parse(raw)) : authoringDisabled;
}
export function methodReviewConfig(): z.infer<typeof reviewCaps> {
  const raw = Deno.env.get('STUDY_METHOD_REVIEW_CONFIG');
  return raw ? reviewCaps.parse(JSON.parse(raw)) : reviewDisabled;
}
export async function executeMethod(
  input: unknown,
  actor: ActorContext,
  signal: AbortSignal,
  assertActive: () => void,
  options: MethodOptions = {},
) {
  const request = parseRequest(input);
  if (request.operation !== 'capability.read')
    return isMethodReviewRequest(request)
      ? executeMethodReview(request, actor, signal, assertActive, options.review)
      : executeMethodAuthoring(request, actor, signal, assertActive, options);
  const a = authoringCaps.parse((options.config ?? methodAuthoringConfig)());
  const b = reviewCaps.parse((options.review?.config ?? methodReviewConfig)());
  let av = a,
    bv = b;
  if (a.operations.some((op) => op !== 'capability.read') || a.runtimeEnabled) {
    assertActive();
    const db = authoringCaps.parse(
      unpack(
        await (options.repository ?? ((v) => createMethodRepository(v.supabase)))(actor).dispatch(
          request,
          signal,
          'authoring',
        ),
      ),
    );
    assertActive();
    const runtimeEnabled = a.runtimeEnabled && db.runtimeEnabled;
    av = {
      ...a,
      runtimeEnabled,
      operations: a.operations.filter((op) => db.operations.includes(op)),
      methodProfiles: runtimeEnabled
        ? a.methodProfiles.filter((p) => db.methodProfiles.includes(p))
        : [],
      reportTemplates: runtimeEnabled
        ? a.reportTemplates.filter((p) => db.reportTemplates.includes(p))
        : [],
      limits: {
        ...a.limits,
        maxEvidenceRefs: Math.min(a.limits.maxEvidenceRefs, db.limits.maxEvidenceRefs),
        maxSelectedFactorRecords: Math.min(
          a.limits.maxSelectedFactorRecords,
          db.limits.maxSelectedFactorRecords,
        ),
      },
    };
  }
  if (b.operations.some((op) => op !== 'capability.read') || b.runtimeEnabled) {
    assertActive();
    const db = reviewCaps.parse(
      unpack(
        await (options.review?.repository ?? ((v) => createMethodRepository(v.supabase)))(
          actor,
        ).dispatch(request, signal, 'review'),
      ),
    );
    assertActive();
    const runtimeEnabled = b.runtimeEnabled && db.runtimeEnabled;
    bv = {
      ...b,
      runtimeEnabled,
      operations: b.operations.filter((op) => db.operations.includes(op)),
      finalizationProfiles: runtimeEnabled
        ? b.finalizationProfiles.filter((p) => db.finalizationProfiles.includes(p))
        : [],
      reviewClasses: runtimeEnabled
        ? b.reviewClasses.filter((p) => db.reviewClasses.includes(p))
        : [],
      disclosurePolicies: runtimeEnabled
        ? b.disclosurePolicies.filter((p) => db.disclosurePolicies.includes(p))
        : [],
    };
  }
  const operations = [...new Set([...av.operations, ...bv.operations])];
  const data = capabilitiesSchema.parse(
    operations.some((op) => op !== 'capability.read')
      ? { ...av, ...bv, runtimeEnabled: av.runtimeEnabled || bv.runtimeEnabled, operations }
      : DISABLED_CAPABILITIES,
  );
  const response = responseSchema.parse({
    schemaVersion: API_SCHEMA,
    requestId: request.requestId,
    ok: true,
    data,
  });
  validateResponseForRequest(request, response);
  return response;
}
