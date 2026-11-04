import { z } from 'zod';
import { cursorSchema, idSchema, text } from '../v1/common.ts';
import { errorCodeSchema } from '../v2/common.ts';
import { isCanonicalBase64 } from '../v2/responses.ts';
import { taskSchema as previousTask } from '../v2/records.ts';
import {
  API_SCHEMA,
  assessmentSchema,
  reportRevisionSchema,
  publicArtifactRefSchema,
} from './authoring.ts';
import { methodEvidenceRecordSchema } from './schemas.ts';
import { capabilitiesSchema } from './capabilities.ts';
import { OPERATIONS } from './requests.ts';
import {
  commentSchema,
  reviewSchema,
  delegationSchema,
  finalizationSchema,
  reportStateSchema,
  exportSchema,
  shareSchema,
  resourceSelectorSchema as reviewResource,
} from './review.ts';
import { reportViewSchema as methodViewSchema } from './view.ts';
export const taskSchema = previousTask.extend({
  resource: z.object({ type: z.literal('methodAssessment'), id: idSchema }).strict(),
});
export const resourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('methodAssessment'), value: assessmentSchema }).strict(),
  z.object({ type: z.literal('reportRevision'), value: reportRevisionSchema }).strict(),
]);
const page = z
  .object({
    type: z.literal('resourcePage'),
    studyId: idSchema,
    kind: z.enum(['methodAssessment', 'reportRevision']),
    items: z.array(resourceSchema).max(100),
    nextCursor: cursorSchema,
  })
  .strict()
  .superRefine((v, ctx) => {
    const ids = v.items.map((i) =>
      i.type === 'methodAssessment' ? i.value.assessmentId : i.value.reportRevisionId,
    );
    if (
      new Set(ids).size !== ids.length ||
      v.items.some((i) => i.type !== v.kind || i.value.studyId !== v.studyId)
    )
      ctx.addIssue({ code: 'custom', message: 'exact method resource page selection required' });
  });
const resource = z.union([
  reviewResource,
  z.object({ type: z.literal('methodAssessment'), id: idSchema }).strict(),
]);
export const actionsSchema = z
  .object({
    type: z.literal('actions'),
    resource,
    actions: z
      .array(z.enum(OPERATIONS as [(typeof OPERATIONS)[number], ...(typeof OPERATIONS)[number][]]))
      .max(OPERATIONS.length),
    corePermissions: z.object({ read: z.boolean(), write: z.boolean() }).strict(),
    allowedMemberRoles: z.array(z.enum(['editor', 'reviewer', 'viewer'])).max(0),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      new Set(v.actions).size !== v.actions.length ||
      (v.resource.type !== 'methodAssessment' &&
        (v.corePermissions.read || v.corePermissions.write))
    )
      ctx.addIssue({ code: 'custom', message: 'method/report permission scopes remain distinct' });
  });
export const responseDataSchema = z.union([
  capabilitiesSchema,
  resourceSchema,
  page,
  actionsSchema,
  z.object({ type: z.literal('methodEvidence'), value: methodEvidenceRecordSchema }).strict(),
  z.object({ type: z.literal('task'), value: taskSchema }).strict(),
  z
    .object({
      type: z.literal('artifact'),
      studyId: idSchema,
      artifactRef: publicArtifactRefSchema,
      encoding: z.literal('base64'),
      bytes: z.string().max(5592408).refine(isCanonicalBase64),
    })
    .strict(),
  z.object({ type: z.literal('comment'), value: commentSchema }).strict(),
  z.object({ type: z.literal('review'), value: reviewSchema, state: reportStateSchema }).strict(),
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
      studyId: idSchema,
      reportRevisionId: idSchema,
      reportContentHash: z.string().regex(/^[a-f0-9]{64}$/u),
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
      view: methodViewSchema,
      state: reportStateSchema,
      share: shareSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal('exportDownload'),
      export: exportSchema,
      encoding: z.literal('base64'),
      bytes: z.string().max(5592408).refine(isCanonicalBase64),
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
export type MethodResponse = z.infer<typeof responseSchema>;
