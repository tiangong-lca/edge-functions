import { z } from 'zod';
import { API_SCHEMA, ERROR_CODES, idSchema, issueSchema, text } from './common.ts';
import {
  analysisSchema,
  exportSchema,
  reportRevisionSchema,
  reviewSchema,
  runSchema,
  scenarioRevisionSchema,
  shareSchema,
  studyRevisionSchema,
  studySchema,
} from './records.ts';
import { OPERATIONS } from './requests.ts';

const capabilitiesSchema = z
  .object({
    type: z.literal('capabilities'),
    contractVersion: z.literal('1.0.0'),
    runtimeEnabled: z.boolean(),
    operations: z.array(z.enum(OPERATIONS as [string, ...string[]])).max(64),
  })
  .strict();

export const responseDataSchema = z.discriminatedUnion('type', [
  capabilitiesSchema,
  z.object({ type: z.literal('study'), value: studySchema }).strict(),
  z.object({ type: z.literal('studyRevision'), value: studyRevisionSchema }).strict(),
  z.object({ type: z.literal('scenarioRevision'), value: scenarioRevisionSchema }).strict(),
  z.object({ type: z.literal('run'), value: runSchema }).strict(),
  z.object({ type: z.literal('analysis'), value: analysisSchema }).strict(),
  z.object({ type: z.literal('reportRevision'), value: reportRevisionSchema }).strict(),
  z.object({ type: z.literal('review'), value: reviewSchema }).strict(),
  z.object({ type: z.literal('export'), value: exportSchema }).strict(),
  z.object({ type: z.literal('share'), value: shareSchema }).strict(),
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
      code: z.enum(ERROR_CODES),
      message: text(512),
      retryable: z.boolean(),
      issues: z.array(issueSchema).max(64),
    })
    .strict(),
]);

export type StudyApiResponse = z.infer<typeof responseSchema>;
