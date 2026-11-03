import { z } from 'zod';
import { cursorSchema, idSchema, text } from '../v1/common.ts';
import { errorCodeSchema } from '../v2/common.ts';
import { isCanonicalBase64 } from '../v2/responses.ts';
import {
  API_SCHEMA,
  capabilitiesSchema,
  commentSchema,
  delegationSchema,
  exportSchema,
  finalizationSchema,
  OPERATIONS,
  reportBindingSchema,
  reportStateSchema,
  resourceSelectorSchema,
  reviewSchema,
  shareSchema,
} from './review.ts';
import { reportViewSchema } from './view.ts';
export const responseDataSchema = z.union([
  capabilitiesSchema,
  z
    .object({
      type: z.literal('actions'),
      resource: resourceSelectorSchema,
      actions: z.array(z.enum(OPERATIONS)).max(OPERATIONS.length),
    })
    .strict(),
  z
    .object({
      type: z.literal('member'),
      studyId: idSchema,
      studyRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      memberId: idSchema,
      role: z.enum(['editor', 'reviewer', 'viewer']).nullable(),
    })
    .strict(),
  z.object({ type: z.literal('comment'), value: commentSchema }).strict(),
  z.object({ type: z.literal('review'), value: reviewSchema }).strict(),
  z.object({ type: z.literal('delegation'), value: delegationSchema }).strict(),
  z
    .object({
      type: z.literal('finalization'),
      value: finalizationSchema,
      state: reportStateSchema,
    })
    .strict(),
  z.object({ type: z.literal('reportState'), value: reportStateSchema }).strict(),
  z.object({ type: z.literal('export'), value: exportSchema }).strict(),
  z.object({ type: z.literal('share'), value: shareSchema }).strict(),
  z
    .object({
      type: z.literal('history'),
      ...reportBindingSchema.shape,
      kind: z.enum(['comment', 'review', 'delegation', 'share']),
      items: z
        .array(z.union([commentSchema, reviewSchema, delegationSchema, shareSchema]))
        .max(100),
      nextCursor: cursorSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('view'),
      view: reportViewSchema,
      state: reportStateSchema,
      share: shareSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal('download'),
      share: shareSchema,
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
export type ReviewResponse = z.infer<typeof responseSchema>;
