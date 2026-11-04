import { z } from 'zod';
import {
  artifactRefSchema,
  idSchema,
  hashSchema,
  timestampSchema,
} from '../../../../contracts/lca-study/v1/common.ts';
import { runSchema, studyRevisionSchema } from '../../../../contracts/lca-study/v1/records.ts';
import {
  modelPreparationSchema,
  scenarioRevisionSchema,
} from '../../../../contracts/lca-study/v2/records.ts';
import {
  reportCommandSchema,
  reportRevisionSchema,
  contentRefSchema,
  methodReportArtifactRefSchema,
  evidenceCreateSchema,
  assessmentSchema,
} from '../../../../contracts/lca-study/v6/authoring.ts';
import {
  producerRequestSchema,
  requestSchema as reviewRequest,
  reportStateSchema,
  shareSchema,
  exportSchema,
} from '../../../../contracts/lca-study/v6/review.ts';
import { methodFactsRefSchema } from '../../../../contracts/lca-study/v6/schemas.ts';
import { artifactCapabilitySchema, artifactReadIntentSchema } from './repository.ts';
export const methodCapabilitySchema = artifactCapabilitySchema.extend({
  artifactRef: z.union([methodReportArtifactRefSchema, artifactRefSchema]),
});
export type MethodCapability = z.infer<typeof methodCapabilitySchema>;
export type MethodPrivateArtifact = Omit<MethodCapability, 'kind'>;
const privateArtifact = methodCapabilitySchema.omit({ kind: true });
export const methodReadIntentSchema = artifactReadIntentSchema.extend({
  artifactRef: methodReportArtifactRefSchema,
});
export const reportIntentSchema = z
  .object({
    kind: z.literal('reportMethodCommandIntent'),
    intentId: idSchema,
    expiresAt: timestampSchema,
    operation: z.enum(['report.create', 'report.save', 'report.freeze']),
  })
  .strict();
export const evidenceIntentSchema = z
  .object({
    kind: z.literal('methodEvidenceCommandIntent'),
    intentId: idSchema,
    expiresAt: timestampSchema,
    operation: z.literal('method.evidence.create'),
  })
  .strict();
export const evidenceContextSchema = z
  .object({
    kind: z.literal('methodEvidenceCommandContext'),
    intentId: idSchema,
    expiresAt: timestampSchema,
    request: evidenceCreateSchema,
    studyId: idSchema,
    actorId: idSchema,
    clientId: idSchema.nullable(),
    evidenceId: idSchema,
    artifactId: idSchema,
    recordedAt: timestampSchema,
    byteSize: z.number().int().min(1).max(65536),
    contentHash: hashSchema,
  })
  .strict();
const exportProfile = z
  .object({
    issuerId: idSchema,
    keyId: idSchema,
    rendererVersion: z.literal('3.0.0'),
    viewModelVersion: z.literal('lca.study-report-view.v3'),
    rendererArtifactHash: hashSchema,
    policyId: z.literal('lca.study-report-disclosure.v1'),
  })
  .strict();
export const reportContextSchema = z
  .object({
    kind: z.literal('reportMethodCommandContext'),
    intentId: idSchema,
    expiresAt: timestampSchema,
    operation: z.enum([
      'report.create',
      'report.save',
      'report.freeze',
      'report.view',
      'export.request',
    ]),
    request: z.union([reportCommandSchema, producerRequestSchema]),
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
    contentArtifact: privateArtifact.extend({ artifactRef: contentRefSchema }).nullable(),
    runs: z
      .array(
        z
          .object({
            run: runSchema,
            revision: studyRevisionSchema,
            scenario: scenarioRevisionSchema,
            preparation: modelPreparationSchema,
            preparedArtifact: privateArtifact.extend({
              artifactRef: artifactRefSchema.extend({
                type: z.literal('modelInput'),
                schemaVersion: z.literal('lca.study-prepared-input.v1'),
                mediaType: z.literal('application/json'),
              }),
            }),
            resultArtifact: privateArtifact.extend({
              artifactRef: artifactRefSchema.extend({
                type: z.literal('runResult'),
                schemaVersion: z.literal('lca.study-result.v1'),
                mediaType: z.literal('application/json'),
              }),
            }),
          })
          .strict(),
      )
      .length(1),
    methodAssessments: z
      .array(
        z
          .object({
            assessment: assessmentSchema,
            factsArtifact: privateArtifact.extend({ artifactRef: methodFactsRefSchema }),
            sourceSnapshotRef: artifactRefSchema.extend({
              type: z.literal('modelSource'),
              schemaVersion: z.literal('lca.study-source-snapshot.v1'),
              mediaType: z.literal('application/json'),
            }),
          })
          .strict(),
      )
      .length(1),
    factsBindingHash: hashSchema,
    disclosureContextHash: hashSchema.nullable(),
    exportProfile: exportProfile.nullable(),
  })
  .strict();
export const reviewIntentSchema = z
  .object({
    kind: z.literal('studyMethodReviewIntent'),
    intentId: idSchema,
    operation: z.enum([
      'report.view',
      'export.request',
      'export.download',
      'share.view',
      'share.download',
    ]),
    expiresAt: timestampSchema,
  })
  .strict();
export const reviewContextSchema = z
  .object({
    kind: z.literal('studyMethodReviewContext'),
    intentId: idSchema,
    operation: z.enum([
      'report.view',
      'export.request',
      'export.download',
      'share.view',
      'share.download',
    ]),
    expiresAt: timestampSchema,
    actorId: idSchema,
    clientId: idSchema.nullable(),
    request: reviewRequest,
    currentState: reportStateSchema,
    producerContext: reportContextSchema.nullable(),
    share: shareSchema.nullable(),
    export: exportSchema.nullable(),
    artifact: methodCapabilitySchema.nullable(),
  })
  .strict();
export type MethodReportContext = z.infer<typeof reportContextSchema>;
export type MethodReviewContext = z.infer<typeof reviewContextSchema>;
export type MethodEvidenceContext = z.infer<typeof evidenceContextSchema>;
