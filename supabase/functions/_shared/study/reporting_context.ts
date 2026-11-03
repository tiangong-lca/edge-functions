import { z } from 'zod';
import {
  artifactRefSchema,
  hashSchema,
  idSchema,
  timestampSchema,
} from '../../../../contracts/lca-study/v1/common.ts';
import { runSchema, studyRevisionSchema } from '../../../../contracts/lca-study/v1/records.ts';
import {
  modelPreparationSchema,
  scenarioRevisionSchema,
} from '../../../../contracts/lca-study/v2/records.ts';
import {
  analysisSchema,
  reportRevisionSchema,
  reportingArtifactRefSchema,
  requestSchema,
} from '../../../../contracts/lca-study/v3/report.ts';
import { artifactCapabilitySchema } from './repository.ts';

export const reportIntentSchema = z
  .object({
    kind: z.literal('reportCommandIntent'),
    intentId: idSchema,
    expiresAt: timestampSchema,
    operation: z.enum(['report.create', 'report.save', 'report.freeze', 'export.request']),
  })
  .strict();
const privateArtifact = artifactCapabilitySchema
  .omit({ kind: true })
  .extend({ artifactRef: reportingArtifactRefSchema.or(artifactRefSchema) });
export const exportProfileSchema = z
  .object({
    issuerId: idSchema,
    keyId: idSchema,
    rendererVersion: z.literal('1.0.0'),
    viewModelVersion: z.literal('lca.study-report-view.v1'),
    rendererArtifactHash: hashSchema,
    policyId: z.literal('lca.study-report-disclosure.v1'),
  })
  .strict();
export const reportContextSchema = z
  .object({
    kind: z.literal('reportCommandContext'),
    intentId: idSchema,
    expiresAt: timestampSchema,
    operation: z.enum(['report.create', 'report.save', 'report.freeze', 'export.request']),
    request: requestSchema,
    studyId: idSchema,
    actorId: idSchema,
    clientId: idSchema.nullable(),
    grantEpoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    generatedAt: timestampSchema,
    reportRevisionId: idSchema,
    contentArtifactId: idSchema.nullable(),
    exportId: idSchema.nullable(),
    projectionArtifactId: idSchema.nullable(),
    resourcesArtifactId: idSchema.nullable(),
    bundleArtifactId: idSchema.nullable(),
    report: reportRevisionSchema.nullable(),
    contentArtifact: privateArtifact.nullable(),
    runs: z
      .array(
        z
          .object({
            run: runSchema,
            revision: studyRevisionSchema,
            scenario: scenarioRevisionSchema,
            preparation: modelPreparationSchema,
            preparedArtifact: privateArtifact,
            resultArtifact: privateArtifact,
          })
          .strict(),
      )
      .min(1)
      .max(2),
    analyses: z
      .array(z.object({ analysis: analysisSchema, factsArtifact: privateArtifact }).strict())
      .min(1)
      .max(2),
    factsBindingHash: hashSchema,
    disclosureContextHash: hashSchema.nullable(),
    exportProfile: exportProfileSchema.nullable(),
  })
  .strict();
export type ReportContext = z.infer<typeof reportContextSchema>;
export type ReportIntent = z.infer<typeof reportIntentSchema>;
