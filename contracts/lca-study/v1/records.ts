import { z } from 'zod';
import {
  artifactRefSchema,
  calculationContractRefSchema,
  contentStatusSchema,
  generationSchema,
  hashSchema,
  idSchema,
  modelRefSchema,
  sourceRefSchema,
  text,
  timestampSchema,
  validitySchema,
  workerJobStatusSchema,
} from './common.ts';

const positiveDecimal = text(64).regex(/^(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)$/u);
export const definitionSchema = z
  .object({
    goal: text(4096),
    functionalUnit: z
      .object({ amount: positiveDecimal, unit: text(128), referenceFlowId: idSchema })
      .strict(),
    systemBoundary: text(4096),
    methodRef: sourceRefSchema.refine(
      (ref) => ref.type === 'datasetRevision' && ref.datasetType === 'lciamethod',
      'exact LCIA method required',
    ),
    assumptions: z
      .array(z.object({ id: idSchema, statement: text(4096), evidenceRef: idSchema }).strict())
      .max(128),
  })
  .strict();

export const studySchema = z
  .object({
    studyId: idSchema,
    revision: generationSchema,
    scope: z.object({ kind: z.enum(['user', 'team']), id: idSchema }).strict(),
    title: text(512),
    status: z.enum(['active', 'archived']),
    currentRevisionId: idSchema.nullable(),
  })
  .strict();

export const studyRevisionSchema = z
  .object({
    revisionId: idSchema,
    studyId: idSchema,
    revision: generationSchema,
    parentRevisionId: idSchema.nullable(),
    status: contentStatusSchema,
    contentHash: hashSchema,
    definition: definitionSchema,
    modelRef: modelRefSchema,
    validation: z.enum(['not_checked', 'passed', 'failed']),
  })
  .strict();

export const overrideSchema = z
  .object({
    path: text(256).regex(
      /^\/(?:parameters\/[A-Za-z0-9_-]+\/value|providers\/[A-Za-z0-9_-]+|exchanges\/[A-Za-z0-9_-]+\/amount)$/u,
    ),
    value: z.union([text(512), z.number().finite(), z.boolean(), z.null()]),
  })
  .strict();

export const scenarioRevisionSchema = z
  .object({
    scenarioId: idSchema,
    scenarioRevisionId: idSchema,
    studyId: idSchema,
    studyRevisionId: idSchema,
    parentScenarioRevisionId: idSchema.nullable(),
    revision: generationSchema,
    status: contentStatusSchema,
    contentHash: hashSchema,
    overrides: z.array(overrideSchema).max(256),
    effectiveModelRef: modelRefSchema,
  })
  .strict();

export const runSchema = z
  .object({
    runId: idSchema,
    studyId: idSchema,
    studyRevisionId: idSchema,
    scenarioRevisionId: idSchema,
    inputHash: hashSchema,
    effectiveModelRef: modelRefSchema,
    calculationContractRef: calculationContractRefSchema,
    engineId: z.literal('solver-worker'),
    profileId: idSchema,
    execution: z.object({ jobId: idSchema, status: workerJobStatusSchema }).strict(),
    resultRef: artifactRefSchema.nullable(),
    validity: validitySchema,
  })
  .strict();

export const analysisSchema = z
  .object({
    analysisId: idSchema,
    studyId: idSchema,
    runIds: z.array(idSchema).min(1).max(32),
    profileId: idSchema,
    configHash: hashSchema,
    status: z.enum(['requested', 'ready', 'failed']),
    comparability: z
      .object({
        status: z.enum(['not_assessed', 'comparable', 'not_comparable']),
        reasonCodes: z.array(idSchema).max(32),
      })
      .strict(),
    factsRef: artifactRefSchema.nullable(),
  })
  .strict();

export const reportRevisionSchema = z
  .object({
    reportRevisionId: idSchema,
    studyId: idSchema,
    parentReportRevisionId: idSchema.nullable(),
    authorId: idSchema,
    revision: generationSchema,
    status: contentStatusSchema,
    contentHash: hashSchema,
    runIds: z.array(idSchema).min(1).max(32),
    analysisIds: z.array(idSchema).max(32),
    factsRefs: z.array(artifactRefSchema).min(1).max(64),
    contentRef: artifactRefSchema,
    templateId: idSchema,
    finalization: z
      .object({
        status: z.enum(['not_finalized', 'finalized']),
        profileId: idSchema,
        reviewRequirement: z.enum(['none', 'internal', 'independent']),
        finalizedAt: timestampSchema.nullable(),
        reviewIds: z.array(idSchema).max(64),
      })
      .strict(),
    validitySnapshot: validitySchema,
  })
  .strict();

export const reviewSchema = z
  .object({
    reviewId: idSchema,
    studyId: idSchema,
    target: z
      .object({ type: z.literal('reportRevision'), revisionId: idSchema, contentHash: hashSchema })
      .strict(),
    reviewClass: z.enum(['self', 'internal', 'independent']),
    decision: z.enum(['comment', 'approve', 'request_changes', 'withdraw']),
    actorId: idSchema,
    clientId: idSchema,
    authorizationEvidenceRef: idSchema,
    decidedAt: timestampSchema,
    supersedesReviewId: idSchema.nullable(),
  })
  .strict();

export const exportSchema = z
  .object({
    exportId: idSchema,
    studyId: idSchema,
    reportRevisionId: idSchema,
    reportContentHash: hashSchema,
    status: z.enum(['requested', 'ready', 'failed', 'expired']),
    projectionRef: artifactRefSchema,
    grantEpoch: generationSchema,
    factsRefs: z.array(artifactRefSchema).min(1).max(64),
    rendererVersion: idSchema,
    viewModelVersion: idSchema,
    resourcesRef: artifactRefSchema,
    actorId: idSchema,
    policyId: idSchema,
    disclosureContextHash: hashSchema,
    disclosureDecision: z.enum(['allowed', 'denied']),
    generatedAt: timestampSchema,
    validitySnapshot: validitySchema,
    reviewIds: z.array(idSchema).max(64),
    receipt: z
      .object({
        schemaVersion: z.literal('lca.study-export-receipt.v1'),
        exportBindingHash: hashSchema,
        keyId: idSchema,
        algorithm: z.literal('Ed25519'),
        signature: z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/u),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const shareSchema = z
  .object({
    shareId: idSchema,
    studyId: idSchema,
    reportRevisionId: idSchema,
    exportId: idSchema,
    projectionHash: hashSchema,
    grantEpoch: generationSchema,
    recipientId: idSchema,
    status: z.enum(['active', 'revoked', 'expired']),
    expiresAt: timestampSchema,
    capabilities: z
      .array(z.enum(['view_report', 'download_export']))
      .min(1)
      .max(2),
  })
  .strict();

export const graphSchema = z
  .object({
    schemaVersion: z.literal('lca.study-api-fixture-graph.v1'),
    studies: z.array(studySchema).max(128),
    studyRevisions: z.array(studyRevisionSchema).max(256),
    scenarioRevisions: z.array(scenarioRevisionSchema).max(256),
    runs: z.array(runSchema).max(256),
    analyses: z.array(analysisSchema).max(256),
    reports: z.array(reportRevisionSchema).max(256),
    reviews: z.array(reviewSchema).max(256),
    exports: z.array(exportSchema).max(256),
    shares: z.array(shareSchema).max(256),
  })
  .strict();

export type FixtureGraph = z.infer<typeof graphSchema>;
