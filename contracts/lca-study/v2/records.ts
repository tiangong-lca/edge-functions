import { z } from 'zod';
import {
  cursorSchema,
  idSchema,
  resourceKindSchema as v1ResourceKind,
  text,
  workerJobStatusSchema,
} from '../v1/common.ts';
import {
  analysisSchema,
  exportSchema,
  modelPreparationSchema as v1Preparation,
  methodRefsSchema,
  modelOriginRefSchema,
  modelSourceSnapshotSchema,
  reportRevisionSchema,
  reviewSchema,
  runSchema,
  scenarioRevisionSchema as v1Scenario,
  shareSchema,
  studyRevisionSchema,
  studySchema,
} from '../v1/records.ts';

export const acquisitionSchema = z
  .object({
    acquisitionId: idSchema,
    studyId: idSchema,
    originRef: modelOriginRefSchema,
    execution: z.object({ jobId: idSchema, status: workerJobStatusSchema }).strict(),
    snapshot: modelSourceSnapshotSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.execution.status === 'completed') !== (value.snapshot !== null) ||
      (value.snapshot &&
        (value.snapshot.studyId !== value.studyId ||
          JSON.stringify(value.snapshot.originRef) !== JSON.stringify(value.originRef)))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'acquisition result must bind the exact origin and Study',
      });
  });

const resourceKindSchema = z.enum([...v1ResourceKind.options, 'modelSourceAcquisition']);
export const modelPreparationSchema = v1Preparation.extend({ methodRefs: methodRefsSchema });
export const taskResourceSchema = z
  .object({ type: z.enum(['modelSourceAcquisition', 'modelPreparation', 'run']), id: idSchema })
  .strict();
export const TASK_ERROR_CODES = [
  'source_invalid',
  'boundary_undeclared',
  'normalization_underflow',
  'normalization_overflow',
  'numeric_invalid',
  'resource_limit',
  'model_not_solvable',
  'native_execution_failed',
  'job_timeout',
  'job_lease_lost',
  'runtime_unavailable',
  'runtime_failed',
] as const;
export const taskSchema = z
  .object({
    studyId: idSchema,
    resource: taskResourceSchema,
    execution: z
      .object({
        jobId: idSchema,
        status: workerJobStatusSchema,
        phase: z
          .enum([
            'queued',
            'source_capture',
            'model_prepare',
            'solve',
            'complete',
            'cancelled',
            'study_start',
            'study_native',
            'study_artifact',
            'study_publish',
          ])
          .nullable(),
        progress: z.number().finite().min(0).max(1).nullable(),
      })
      .strict(),
    errorCode: z.enum(TASK_ERROR_CODES).nullable(),
  })
  .strict();
const cutoffPortId = text(128).regex(/^[A-Za-z0-9_-]+$/u);
export const cutoffSchema = z
  .object({
    port: z.object({ instanceId: cutoffPortId, exchangeId: cutoffPortId }).strict(),
    reason: text(1024),
  })
  .strict();
export const cutoffsSchema = z
  .array(cutoffSchema)
  .max(256)
  .superRefine((values, context) => {
    const ports = new Set<string>();
    values.forEach((value, index) => {
      const key = JSON.stringify([value.port.instanceId, value.port.exchangeId]);
      if (ports.has(key))
        context.addIssue({
          code: 'custom',
          path: [index, 'port'],
          message: 'cutoff ports must be unique',
        });
      ports.add(key);
    });
  });
export const overrideSchema = z
  .object({
    path: text(256).regex(/^\/instances\/[A-Za-z0-9_-]+\/exchanges\/[A-Za-z0-9_-]+\/amount$/u),
    value: z.number().finite(),
  })
  .strict();
export const scenarioRevisionSchema = v1Scenario.extend({
  overrides: z.array(overrideSchema).max(256),
});

export const resourceItemSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('modelSourceAcquisition'), value: acquisitionSchema }).strict(),
  z.object({ type: z.literal('studyRevision'), value: studyRevisionSchema }).strict(),
  z.object({ type: z.literal('scenarioRevision'), value: scenarioRevisionSchema }).strict(),
  z.object({ type: z.literal('modelSourceSnapshot'), value: modelSourceSnapshotSchema }).strict(),
  z.object({ type: z.literal('modelPreparation'), value: modelPreparationSchema }).strict(),
  z.object({ type: z.literal('run'), value: runSchema }).strict(),
  z.object({ type: z.literal('analysis'), value: analysisSchema }).strict(),
  z.object({ type: z.literal('reportRevision'), value: reportRevisionSchema }).strict(),
  z.object({ type: z.literal('review'), value: reviewSchema }).strict(),
  z.object({ type: z.literal('export'), value: exportSchema }).strict(),
  z.object({ type: z.literal('share'), value: shareSchema }).strict(),
]);

const identityKeys = {
  modelSourceAcquisition: 'acquisitionId',
  studyRevision: 'revisionId',
  scenarioRevision: 'scenarioRevisionId',
  modelSourceSnapshot: 'snapshotId',
  modelPreparation: 'preparationId',
  run: 'runId',
  analysis: 'analysisId',
  reportRevision: 'reportRevisionId',
  review: 'reviewId',
  export: 'exportId',
  share: 'shareId',
} as const;

export const resourcePageSchema = z
  .object({
    type: z.literal('resourcePage'),
    studyId: idSchema,
    kind: resourceKindSchema,
    items: z.array(resourceItemSchema).max(100),
    nextCursor: cursorSchema,
  })
  .strict()
  .superRefine((page, context) => {
    const ids = new Set<string>();
    page.items.forEach((item, index) => {
      const key = String((item.value as Record<string, unknown>)[identityKeys[item.type]]);
      if (item.type !== page.kind || item.value.studyId !== page.studyId || ids.has(key)) {
        context.addIssue({
          code: 'custom',
          path: ['items', index],
          message: 'page kind, Study and unique resource identity must match',
        });
      }
      ids.add(key);
    });
  });

export const studyPageSchema = z
  .object({
    type: z.literal('studyPage'),
    items: z.array(studySchema).max(100),
    nextCursor: cursorSchema,
  })
  .strict()
  .superRefine((page, context) => {
    if (new Set(page.items.map((item) => item.studyId)).size !== page.items.length) {
      context.addIssue({
        code: 'custom',
        path: ['items'],
        message: 'study IDs must be unique within a page',
      });
    }
  });
