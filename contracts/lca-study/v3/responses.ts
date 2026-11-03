import { z } from 'zod';
import { cursorSchema, idSchema, text } from '../v1/common.ts';
import { errorCodeSchema } from '../v2/common.ts';
import { taskSchema as coreTask } from '../v2/records.ts';
import { isCanonicalBase64 } from '../v2/responses.ts';
import {
  API_SCHEMA,
  analysisSchema,
  capabilitiesSchema,
  exportSchema,
  reportingArtifactRefSchema,
  reportRevisionSchema,
} from './report.ts';
export const taskSchema = coreTask.extend({
  resource: z.object({ type: z.literal('analysis'), id: idSchema }).strict(),
});
export const resourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('analysis'), value: analysisSchema }).strict(),
  z.object({ type: z.literal('reportRevision'), value: reportRevisionSchema }).strict(),
  z.object({ type: z.literal('export'), value: exportSchema }).strict(),
]);
const page = z
  .object({
    type: z.literal('resourcePage'),
    studyId: idSchema,
    kind: z.enum(['analysis', 'reportRevision', 'export']),
    items: z.array(resourceSchema).max(100),
    nextCursor: cursorSchema,
  })
  .strict()
  .superRefine((v, c) => {
    const ids = v.items.map((i) =>
      i.type === 'analysis'
        ? i.value.analysisId
        : i.type === 'export'
          ? i.value.exportId
          : i.value.reportRevisionId,
    );
    if (
      new Set(ids).size !== ids.length ||
      v.items.some((i) => i.type !== v.kind || i.value.studyId !== v.studyId)
    )
      c.addIssue({ code: 'custom', message: 'page identities must match selection' });
  });
export const responseDataSchema = z.union([
  resourceSchema,
  page,
  capabilitiesSchema,
  z.object({ type: z.literal('task'), value: taskSchema }).strict(),
  z
    .object({
      type: z.literal('artifact'),
      studyId: idSchema,
      artifactRef: reportingArtifactRefSchema,
      encoding: z.literal('base64'),
      bytes: z.string().max(5592408).refine(isCanonicalBase64),
    })
    .strict(),
]);
export const responseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      schemaVersion: z.literal(API_SCHEMA),
      requestId: idSchema,
      ok: z.literal(true),
      data: responseDataSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(API_SCHEMA),
      requestId: idSchema,
      ok: z.literal(false),
      code: errorCodeSchema,
      message: text(512),
      retryable: z.boolean(),
      issues: z
        .array(z.object({ code: errorCodeSchema, path: text(512), ruleId: idSchema }).strict())
        .max(64),
    })
    .strict(),
]);
export type ReportingResponse = z.infer<typeof responseSchema>;
