import { z } from 'zod';
import {
  API_SCHEMA,
  artifactRefSchema,
  calculationContractRefSchema,
  cursorSchema,
  hashSchema,
  idSchema,
  modelRefSchema,
  resourceKindSchema,
  target,
  text,
  timestampSchema,
} from './common.ts';
import {
  definitionSchema,
  modelOriginRefSchema,
  modelPreparationSourceSchema,
  overrideSchema,
} from './records.ts';

const envelope = { schemaVersion: z.literal(API_SCHEMA), requestId: idSchema };
const write = { ...envelope, idempotencyKey: idSchema };
const pagination = { cursor: cursorSchema, limit: z.number().int().min(1).max(100) };
const scope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('personal') }).strict(),
  z.object({ kind: z.literal('team'), teamId: idSchema }).strict(),
]);

const variants = [
  z.object({ ...envelope, operation: z.literal('capability.read') }).strict(),
  z.object({ ...write, operation: z.literal('study.create'), scope, title: text(512) }).strict(),
  z.object({ ...envelope, operation: z.literal('study.read'), studyId: idSchema }).strict(),
  z.object({ ...envelope, operation: z.literal('study.list'), ...pagination }).strict(),
  z
    .object({
      ...envelope,
      operation: z.literal('study.resources.list'),
      studyId: idSchema,
      kind: resourceKindSchema,
      ...pagination,
    })
    .strict(),
  z.object({ ...envelope, operation: z.literal('revision.read'), revisionId: idSchema }).strict(),
  z
    .object({ ...envelope, operation: z.literal('scenario.read'), scenarioRevisionId: idSchema })
    .strict(),
  z
    .object({
      ...write,
      operation: z.literal('model.source.resolve'),
      studyId: idSchema,
      originRef: modelOriginRefSchema,
    })
    .strict(),
  z
    .object({
      ...write,
      operation: z.literal('model.prepare'),
      studyId: idSchema,
      source: modelPreparationSourceSchema,
      profileId: idSchema,
      calculationContractRef: calculationContractRefSchema,
    })
    .strict(),
  z.object({ ...envelope, operation: z.literal('model.read'), preparationId: idSchema }).strict(),
  z.object({ ...write, operation: z.literal('study.archive'), target: target('study') }).strict(),
  z
    .object({
      ...write,
      operation: z.literal('study.select_revision'),
      target: target('study'),
      revisionId: idSchema,
    })
    .strict(),
  z
    .object({
      ...write,
      operation: z.literal('revision.create'),
      studyId: idSchema,
      parentRevisionId: idSchema.nullable(),
      definition: definitionSchema,
      modelPreparationId: idSchema,
      modelRef: modelRefSchema,
    })
    .strict(),
  z
    .object({
      ...write,
      operation: z.literal('revision.save'),
      target: target('studyRevision'),
      definition: definitionSchema,
      modelPreparationId: idSchema,
      modelRef: modelRefSchema,
    })
    .strict(),
  z
    .object({
      ...write,
      operation: z.literal('revision.freeze'),
      target: target('studyRevision'),
      expectedContentHash: hashSchema,
    })
    .strict(),
  z
    .object({
      ...write,
      operation: z.literal('scenario.create'),
      studyRevisionId: idSchema,
      parentScenarioRevisionId: idSchema.nullable(),
      overrides: z.array(overrideSchema).max(256),
    })
    .strict(),
  z
    .object({
      ...write,
      operation: z.literal('scenario.save'),
      target: target('scenarioRevision'),
      overrides: z.array(overrideSchema).max(256),
    })
    .strict(),
  z
    .object({
      ...write,
      operation: z.literal('scenario.freeze'),
      target: target('scenarioRevision'),
      expectedContentHash: hashSchema,
      modelPreparationId: idSchema,
    })
    .strict(),
  z
    .object({
      ...write,
      operation: z.literal('run.submit'),
      studyRevisionId: idSchema,
      scenarioRevisionId: idSchema,
      expectedInputHash: hashSchema,
      calculationContractRef: calculationContractRefSchema,
      profileId: idSchema,
    })
    .strict(),
  z.object({ ...envelope, operation: z.literal('run.read'), runId: idSchema }).strict(),
  z
    .object({ ...write, operation: z.literal('run.cancel'), runId: idSchema, reason: text(512) })
    .strict(),
  z
    .object({
      ...write,
      operation: z.literal('analysis.request'),
      runIds: z.array(idSchema).min(1).max(32),
      profileId: idSchema,
      configHash: hashSchema,
    })
    .strict(),
  z.object({ ...envelope, operation: z.literal('analysis.read'), analysisId: idSchema }).strict(),
  z
    .object({
      ...write,
      operation: z.literal('report.create'),
      studyId: idSchema,
      parentReportRevisionId: idSchema.nullable(),
      runIds: z.array(idSchema).min(1).max(32),
      analysisIds: z.array(idSchema).max(32),
      contentRef: artifactRefSchema,
      templateId: idSchema,
    })
    .strict(),
  z
    .object({
      ...write,
      operation: z.literal('report.save'),
      target: target('reportRevision'),
      contentRef: artifactRefSchema,
    })
    .strict(),
  z
    .object({
      ...write,
      operation: z.literal('report.freeze'),
      target: target('reportRevision'),
      expectedContentHash: hashSchema,
    })
    .strict(),
  z
    .object({
      ...write,
      operation: z.literal('report.finalize'),
      target: target('reportRevision'),
      expectedContentHash: hashSchema,
      profileId: idSchema,
    })
    .strict(),
  z
    .object({ ...envelope, operation: z.literal('report.read'), reportRevisionId: idSchema })
    .strict(),
  z
    .object({
      ...write,
      operation: z.literal('review.record'),
      reportRevisionId: idSchema,
      expectedContentHash: hashSchema,
      reviewClass: z.enum(['self', 'internal', 'independent']),
      decision: z.enum(['comment', 'approve', 'request_changes', 'withdraw']),
      authorizationEvidenceRef: idSchema,
      supersedesReviewId: idSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ...write,
      operation: z.literal('export.request'),
      reportRevisionId: idSchema,
      expectedContentHash: hashSchema,
      rendererVersion: idSchema,
      viewModelVersion: idSchema,
    })
    .strict(),
  z.object({ ...envelope, operation: z.literal('export.read'), exportId: idSchema }).strict(),
  z
    .object({
      ...write,
      operation: z.literal('share.create'),
      exportId: idSchema,
      recipientId: idSchema,
      expiresAt: timestampSchema,
      capabilities: z
        .array(z.enum(['view_report', 'download_export']))
        .min(1)
        .max(2),
    })
    .strict(),
  z.object({ ...write, operation: z.literal('share.revoke'), shareId: idSchema }).strict(),
  z.object({ ...envelope, operation: z.literal('share.read'), shareId: idSchema }).strict(),
] as const;

export const requestSchema = z.union(variants);
export type StudyApiRequest = z.infer<typeof requestSchema>;
export const OPERATIONS = variants.map((variant) => variant.shape.operation.value);

/** Only exact, published profiles may later be enabled by the deployment owner. */
export const CONTRACT_CAPABILITIES = Object.freeze({
  schemaVersion: API_SCHEMA,
  contractVersion: '1.0.0',
  runtimeEnabled: false as const,
  operations: Object.freeze(OPERATIONS),
});
