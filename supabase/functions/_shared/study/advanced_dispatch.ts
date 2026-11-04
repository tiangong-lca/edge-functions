import {
  parseRequest,
  validateResponseForRequest,
} from '../../../../contracts/lca-study/v5/codec.ts';
import {
  API_SCHEMA,
  OPERATIONS as authoringOps,
  capabilitiesSchema as authoringCaps,
  DISABLED_CAPABILITIES as authoringDisabled,
} from '../../../../contracts/lca-study/v5/advanced.ts';
import {
  capabilitiesSchema as reviewCaps,
  DISABLED_CAPABILITIES as reviewDisabled,
} from '../../../../contracts/lca-study/v5/review.ts';
import { responseSchema } from '../../../../contracts/lca-study/v5/responses.ts';
import {
  capabilitiesSchema,
  DISABLED_CAPABILITIES,
} from '../../../../contracts/lca-study/v5/capabilities.ts';
import type { ActorContext } from '../command_runtime/actor_context.ts';
import {
  executeAdvancedAuthoring,
  type AdvancedOptions as AuthoringOptions,
} from './advanced_executor.ts';
import { executeAdvancedReview, type AdvancedReviewOptions } from './advanced_review_executor.ts';
import { createAdvancedRepository } from './advanced_repository.ts';
import { createAdvancedReviewRepository } from './advanced_review_repository.ts';
import { unpack } from './repository.ts';
export type AdvancedOptions = AuthoringOptions & { review?: AdvancedReviewOptions };
export async function executeAdvanced(
  input: unknown,
  actor: ActorContext,
  signal: AbortSignal,
  assertActive: () => void,
  options: AdvancedOptions = {},
) {
  const r = parseRequest(input);
  if (r.operation !== 'capability.read')
    return (authoringOps as readonly string[]).includes(r.operation)
      ? executeAdvancedAuthoring(r, actor, signal, assertActive, options)
      : executeAdvancedReview(r, actor, signal, assertActive, options.review);
  const loadA = () => {
      const v = Deno.env.get('STUDY_ADVANCED_CONFIG');
      return v ? authoringCaps.parse(JSON.parse(v)) : authoringDisabled;
    },
    loadR = () => {
      const v = Deno.env.get('STUDY_ADVANCED_REVIEW_CONFIG');
      return v ? reviewCaps.parse(JSON.parse(v)) : reviewDisabled;
    };
  const a = authoringCaps.parse((options.config ?? loadA)()),
    b = reviewCaps.parse((options.review?.config ?? loadR)());
  let av = a,
    bv = b;
  if (a.runtimeEnabled || a.operations.some((op) => op !== 'capability.read')) {
    const db = authoringCaps.parse(
      unpack(
        await (options.repository ?? ((a) => createAdvancedRepository(a.supabase)))(actor).dispatch(
          r,
          signal,
        ),
      ),
    );
    assertActive();
    av = {
      ...a,
      runtimeEnabled: a.runtimeEnabled && db.runtimeEnabled,
      operations: a.operations.filter((op) => db.operations.includes(op)),
      analysisProfiles: a.analysisProfiles.filter((p) => db.analysisProfiles.includes(p)),
      reportTemplates: a.reportTemplates.filter((p) => db.reportTemplates.includes(p)),
    };
  }
  if (b.runtimeEnabled) {
    const db = reviewCaps.parse(
      unpack(
        await (options.review?.repository ?? ((a) => createAdvancedReviewRepository(a.supabase)))(
          actor,
        ).dispatch(r, signal),
      ),
    );
    assertActive();
    bv = {
      ...b,
      runtimeEnabled: db.runtimeEnabled,
      operations: b.operations.filter((op) => db.operations.includes(op)),
      finalizationProfiles: b.finalizationProfiles.filter((p) =>
        db.finalizationProfiles.includes(p),
      ),
      reviewClasses: b.reviewClasses.filter((p) => db.reviewClasses.includes(p)),
      disclosurePolicies: b.disclosurePolicies.filter((p) => db.disclosurePolicies.includes(p)),
    };
  }
  const operations = [...new Set([...av.operations, ...bv.operations])];
  const data = capabilitiesSchema.parse(
    operations.some((op) => op !== 'capability.read')
      ? { ...av, ...bv, runtimeEnabled: av.runtimeEnabled || bv.runtimeEnabled, operations }
      : DISABLED_CAPABILITIES,
  );
  const out = responseSchema.parse({
    schemaVersion: API_SCHEMA,
    requestId: r.requestId,
    ok: true,
    data,
  });
  validateResponseForRequest(r, out);
  return out;
}
