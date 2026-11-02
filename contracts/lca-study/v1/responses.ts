import { z } from 'zod';
import { API_SCHEMA, ERROR_CODES, idSchema, issueSchema, text } from './common.ts';
import { studySchema } from './records.ts';
import { resourceItemSchema, resourcePageSchema, studyPageSchema } from './pages.ts';
import { OPERATIONS } from './requests.ts';

const capabilitiesSchema = z
  .object({
    type: z.literal('capabilities'),
    contractVersion: z.literal('1.0.0'),
    runtimeEnabled: z.boolean(),
    operations: z.array(z.enum(OPERATIONS as [string, ...string[]])).max(64),
  })
  .strict();

export const responseDataSchema = z.union([
  capabilitiesSchema,
  z.object({ type: z.literal('study'), value: studySchema }).strict(),
  resourceItemSchema,
  resourcePageSchema,
  studyPageSchema,
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
