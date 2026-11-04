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
} from '../../../../contracts/lca-study/v5/advanced.ts';
import { artifactCapabilitySchema } from './repository.ts';

export const reportIntentSchema = z
  .object({
    kind: z.literal('reportAdvancedCommandIntent'),
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
    rendererVersion: z.literal('2.0.0'),
    viewModelVersion: z.literal('lca.study-report-view.v2'),
    rendererArtifactHash: hashSchema,
    policyId: z.literal('lca.study-report-disclosure.v1'),
  })
  .strict();
const serviceExport = z
  .object({
    schemaVersion: z.literal('lca.study-api.v5'),
    requestId: idSchema,
    idempotencyKey: idSchema,
    operation: z.literal('export.request'),
    reportRevisionId: idSchema,
    expectedContentHash: hashSchema,
    rendererVersion: z.literal('2.0.0'),
    viewModelVersion: z.literal('lca.study-report-view.v2'),
  })
  .strict();
export const reportContextSchema = z
  .object({
    kind: z.literal('reportAdvancedCommandContext'),
    intentId: idSchema,
    expiresAt: timestampSchema,
    operation: z.enum(['report.create', 'report.save', 'report.freeze', 'export.request']),
    request: z.union([requestSchema, serviceExport]),
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
      .max(1),
    analyses: z
      .array(
        z
          .object({
            analysis: analysisSchema,
            factsArtifact: privateArtifact,
            sourceSnapshotRef: artifactRefSchema,
          })
          .strict(),
      )
      .min(1)
      .max(2),
    factsBindingHash: hashSchema,
    disclosureContextHash: hashSchema.nullable(),
    exportProfile: exportProfileSchema.nullable(),
  })
  .strict();
export type ReportContext = z.infer<typeof reportContextSchema>;
export type ReportIntent = z.infer<typeof reportIntentSchema>;
