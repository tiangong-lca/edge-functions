import { z } from 'zod';
import { artifactRefSchema, calculationContractRefSchema, idSchema, text } from '../v1/common.ts';
import {
  resourceItemSchema,
  resourcePageSchema,
  acquisitionSchema,
  taskSchema,
} from './records.ts';
import { studySchema } from '../v1/records.ts';
import { studyPageSchema } from '../v1/pages.ts';
import { API_SCHEMA, CONTRACT_VERSION, errorCodeSchema } from './common.ts';
import { OPERATIONS } from './requests.ts';

export const profileSchema = z
  .object({ profileId: idSchema, calculationContractRef: calculationContractRefSchema })
  .strict();
export const capabilitiesSchema = z
  .object({
    type: z.literal('capabilities'),
    contractVersion: z.literal(CONTRACT_VERSION),
    runtimeEnabled: z.boolean(),
    operations: z.array(z.enum(OPERATIONS as [string, ...string[]])).max(64),
    profiles: z.array(profileSchema).max(32),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.operations).size !== value.operations.length ||
      new Set(value.profiles.map((p) => p.profileId)).size !== value.profiles.length
    )
      ctx.addIssue({ code: 'custom', message: 'capabilities must be unique' });
  });

/** Linear validation avoids regexp stack exhaustion at the documented 4 MiB boundary. */
export function isCanonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const length = value.length - padding;
  for (let i = 0; i < length; i++) {
    const c = value.charCodeAt(i);
    if (!(
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      (c >= 48 && c <= 57) ||
      c === 43 ||
      c === 47
    ))
      return false;
  }
  if (padding === 2 && (alphabet.indexOf(value[length - 1]) & 15) !== 0) return false;
  if (padding === 1 && (alphabet.indexOf(value[length - 1]) & 3) !== 0) return false;
  return length > 0 || value.length === 0;
}

export const responseDataSchema = z.union([
  z.object({ type: z.literal('study'), value: studySchema }).strict(),
  resourceItemSchema,
  resourcePageSchema,
  studyPageSchema,
  capabilitiesSchema,
  z.object({ type: z.literal('task'), value: taskSchema }).strict(),
  z.object({ type: z.literal('modelSourceAcquisition'), value: acquisitionSchema }).strict(),
  z
    .object({
      type: z.literal('artifact'),
      studyId: idSchema,
      artifactRef: artifactRefSchema,
      encoding: z.literal('base64'),
      bytes: z.string().max(5592408).refine(isCanonicalBase64, 'canonical base64 required'),
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
export type SourceAcquisition = z.infer<typeof acquisitionSchema>;
export type StudyApiResponse = z.infer<typeof responseSchema>;
export type QualifiedProfile = z.infer<typeof profileSchema>;

export { acquisitionSchema };
