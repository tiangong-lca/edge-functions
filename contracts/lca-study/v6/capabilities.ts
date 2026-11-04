import { z } from 'zod';
import {
  capabilitiesSchema as authoring,
  DISABLED_CAPABILITIES as a,
  HISTORICAL_OPERATIONS,
} from './authoring.ts';
import {
  capabilitiesSchema as review,
  DISABLED_CAPABILITIES as b,
  HISTORICAL_REVIEW_OPERATIONS,
} from './review.ts';
import { OPERATIONS } from './requests.ts';
export const capabilitiesSchema = z
  .object({
    ...authoring.shape,
    ...review.shape,
    operations: z
      .array(z.enum(OPERATIONS as [(typeof OPERATIONS)[number], ...(typeof OPERATIONS)[number][]]))
      .min(1)
      .max(OPERATIONS.length),
  })
  .strict()
  .superRefine((v, ctx) => {
    const historical: readonly string[] = [
      ...HISTORICAL_OPERATIONS,
      ...HISTORICAL_REVIEW_OPERATIONS,
    ];
    if (
      !v.operations.includes('capability.read') ||
      new Set(v.operations).size !== v.operations.length ||
      (v.methodProfiles.length > 0 && v.limits.maxSelectedFactorRecords === 0) ||
      new Set(v.finalizationProfiles).size !== v.finalizationProfiles.length ||
      (!v.runtimeEnabled &&
        (v.operations.some((op) => !historical.includes(op)) ||
          v.methodProfiles.length !== 0 ||
          v.reportTemplates.length !== 0 ||
          v.finalizationProfiles.length !== 0 ||
          v.reviewClasses.length !== 0 ||
          v.disclosurePolicies.length !== 0))
    )
      ctx.addIssue({ code: 'custom', message: 'explicit method family admission required' });
  });
export const DISABLED_CAPABILITIES = { ...a, ...b };
