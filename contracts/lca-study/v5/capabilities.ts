import { z } from 'zod';
import {
  capabilitiesSchema as authoring,
  DISABLED_CAPABILITIES as a,
  HISTORICAL_OPERATIONS,
} from './advanced.ts';
import { capabilitiesSchema as review, DISABLED_CAPABILITIES as b } from './review.ts';
import { OPERATIONS } from './requests.ts';
export const capabilitiesSchema = z
  .object({
    ...authoring.shape,
    ...review.shape,
    operations: z.array(z.enum(OPERATIONS)).min(1).max(OPERATIONS.length),
  })
  .strict()
  .refine(
    (v) =>
      v.operations.includes('capability.read') &&
      new Set(v.operations).size === v.operations.length &&
      (v.runtimeEnabled ||
        (v.operations.every((op) => (HISTORICAL_OPERATIONS as readonly string[]).includes(op)) &&
          v.analysisProfiles.length === 0 &&
          v.reportTemplates.length === 0 &&
          v.finalizationProfiles.length === 0 &&
          v.reviewClasses.length === 0 &&
          v.disclosurePolicies.length === 0)),
    'explicit disabled admission required',
  );
export const DISABLED_CAPABILITIES = { ...a, ...b };
