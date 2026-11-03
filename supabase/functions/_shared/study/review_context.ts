import { z } from 'zod';
import { idSchema, timestampSchema } from '../../../../contracts/lca-study/v1/common.ts';
import {
  exportSchema,
  reportStateSchema,
  requestSchema,
  shareSchema,
} from '../../../../contracts/lca-study/v4/review.ts';
import { reportContextSchema } from './reporting_context.ts';
import { reportingCapabilitySchema } from './reporting_repository.ts';
export const reviewIntentSchema = z
  .object({
    kind: z.literal('studyReviewIntent'),
    intentId: idSchema,
    operation: z.enum(['report.view', 'export.request', 'share.view', 'share.download']),
    expiresAt: timestampSchema,
  })
  .strict();
export const reviewContextSchema = z
  .object({
    kind: z.literal('studyReviewContext'),
    intentId: idSchema,
    operation: z.enum(['report.view', 'export.request', 'share.view', 'share.download']),
    expiresAt: timestampSchema,
    actorId: idSchema,
    clientId: idSchema.nullable(),
    request: requestSchema,
    currentState: reportStateSchema,
    producerContext: reportContextSchema.nullable(),
    share: shareSchema.nullable(),
    export: exportSchema.nullable(),
    artifact: reportingCapabilitySchema.nullable(),
  })
  .strict();
export type ReviewContext = z.infer<typeof reviewContextSchema>;
