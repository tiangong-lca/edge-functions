import { z } from 'zod';
import { cursorSchema, idSchema, resourceKindSchema } from './common.ts';
import {
  analysisSchema,
  exportSchema,
  modelPreparationSchema,
  modelSourceSnapshotSchema,
  reportRevisionSchema,
  reviewSchema,
  runSchema,
  scenarioRevisionSchema,
  shareSchema,
  studyRevisionSchema,
  studySchema,
} from './records.ts';

export const resourceItemSchema = z.discriminatedUnion('type', [
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
