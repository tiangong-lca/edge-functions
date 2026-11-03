import { z } from 'zod';
import {
  cursorSchema,
  generationSchema,
  hashSchema,
  idSchema,
  target,
  text,
  timestampSchema,
  validitySchema,
} from '../v1/common.ts';
import { reportingArtifactRefSchema } from '../v3/report.ts';
import { exportReceiptSchema } from '../v3/export.ts';

export const API_SCHEMA = 'lca.study-api.v4' as const;
export const CONTRACT_VERSION = '4.0.0' as const;
export const REVIEW_CLASS = 'internal' as const;
export const FINALIZATION_PROFILES = [
  'lca.study-report-unreviewed.v1',
  'lca.study-report-internal-review.v1',
] as const;
export const profileSchema = z.enum(FINALIZATION_PROFILES);
export const uuidSchema = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u);
export const plainText = text(4096).refine((v) => !/[<>]/u.test(v), 'plain text required');
export const reportBindingSchema = z
  .object({ studyId: idSchema, reportRevisionId: idSchema, reportContentHash: hashSchema })
  .strict();
const binding = reportBindingSchema.shape;
const uniqueIds = z
  .array(idSchema)
  .max(64)
  .refine((v) => new Set(v).size === v.length, 'unique identities required');
export const reviewSchema = z
  .object({
    ...binding,
    reviewId: idSchema,
    actorId: uuidSchema,
    clientId: uuidSchema.nullable(),
    reviewClass: z.literal(REVIEW_CLASS),
    decision: z.enum(['approve', 'reject', 'withdraw']),
    comment: plainText,
    predecessorReviewId: idSchema.nullable(),
    delegationId: idSchema.nullable(),
    authorityKind: z.enum(['first_party_actor', 'oauth_delegated_actor']),
    createdAt: timestampSchema,
  })
  .strict()
  .superRefine((v, c) => {
    if (
      (v.authorityKind === 'first_party_actor') !==
        (v.clientId === null && v.delegationId === null) ||
      (v.authorityKind === 'oauth_delegated_actor' && (!v.clientId || !v.delegationId))
    )
      c.addIssue({ code: 'custom', message: 'exact actor authority binding required' });
  });
export const commentSchema = z
  .object({
    ...binding,
    commentId: idSchema,
    actorId: uuidSchema,
    clientId: uuidSchema.nullable(),
    text: plainText,
    createdAt: timestampSchema,
  })
  .strict();
export const delegationSchema = z
  .object({
    ...binding,
    delegationId: idSchema,
    actorId: uuidSchema,
    clientId: uuidSchema,
    reviewClass: z.literal(REVIEW_CLASS),
    decision: z.enum(['approve', 'reject', 'withdraw']),
    predecessorReviewId: idSchema.nullable(),
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    revokedAt: timestampSchema.nullable(),
    consumedReviewId: idSchema.nullable(),
  })
  .strict()
  .refine(
    (v) =>
      Date.parse(v.expiresAt) > Date.parse(v.issuedAt) &&
      Date.parse(v.expiresAt) - Date.parse(v.issuedAt) <= 15 * 60 * 1000,
    'delegation lifetime must be at most fifteen minutes',
  );
export const finalizationSchema = z
  .object({
    ...binding,
    finalizationId: idSchema,
    actorId: uuidSchema,
    profileId: profileSchema,
    expectedReviewStateHash: hashSchema,
    acceptedReviewIds: uniqueIds,
    finalizedAt: timestampSchema,
  })
  .strict()
  .superRefine((v, c) => {
    if ((v.profileId === 'lca.study-report-unreviewed.v1') !== (v.acceptedReviewIds.length === 0))
      c.addIssue({ code: 'custom', message: 'profile requires exact accepted review identities' });
  });
/** Current state is mutable authority. Finalization is a retained historical record. */
export const reportStateSchema = z
  .object({
    ...binding,
    reportRevision: generationSchema,
    authorId: uuidSchema,
    reviewStateHash: hashSchema,
    currentReviewIds: uniqueIds,
    acceptedReviewIds: uniqueIds,
    finalization: finalizationSchema.nullable(),
    acceptance: z.enum(['not_finalized', 'current', 'invalidated']),
    validity: validitySchema,
    checkedAt: timestampSchema,
  })
  .strict()
  .superRefine((v, c) => {
    if (
      (v.finalization === null) !== (v.acceptance === 'not_finalized') ||
      (v.finalization &&
        (v.finalization.studyId !== v.studyId ||
          v.finalization.reportRevisionId !== v.reportRevisionId ||
          v.finalization.reportContentHash !== v.reportContentHash)) ||
      v.acceptedReviewIds.some((id) => !v.currentReviewIds.includes(id))
    )
      c.addIssue({ code: 'custom', message: 'exact current report state required' });
  });
export const shareSchema = z
  .object({
    ...binding,
    shareId: idSchema,
    exportId: idSchema,
    finalizationId: idSchema,
    issuerId: uuidSchema,
    recipientId: uuidSchema,
    disclosurePolicyId: z.literal('lca.study-report-summary-share.v1'),
    disclosureContextHash: hashSchema,
    grantEpoch: generationSchema,
    projectionRef: reportingArtifactRefSchema.refine(
      (v) =>
        v.type === 'reportProjection' &&
        v.schemaVersion === 'lca.study-report-view.v1' &&
        v.mediaType === 'application/json',
    ),
    bundleRef: reportingArtifactRefSchema.refine(
      (v) =>
        v.type === 'reportExportBundle' &&
        v.schemaVersion === 'lca.study-export-bundle.v2' &&
        v.mediaType === 'application/json',
    ),
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
    revokedAt: timestampSchema.nullable(),
    status: z.enum(['active', 'revoked', 'expired', 'invalidated']),
  })
  .strict()
  .refine(
    (v) =>
      Date.parse(v.expiresAt) > Date.parse(v.createdAt) &&
      (v.status === 'revoked') === (v.revokedAt !== null),
    'exact share lifetime and revocation required',
  );
export const exportSchema = z
  .object({
    ...binding,
    exportId: idSchema,
    finalization: finalizationSchema,
    generatedAt: timestampSchema,
    projectionRef: reportingArtifactRefSchema.refine(
      (v) =>
        v.type === 'reportProjection' &&
        v.schemaVersion === 'lca.study-report-view.v1' &&
        v.mediaType === 'application/json',
    ),
    resourcesRef: reportingArtifactRefSchema.refine(
      (v) =>
        v.type === 'renderResources' &&
        v.schemaVersion === 'lca.study-export-manifest.v2' &&
        v.mediaType === 'application/json',
    ),
    bundleRef: reportingArtifactRefSchema.refine(
      (v) =>
        v.type === 'reportExportBundle' &&
        v.schemaVersion === 'lca.study-export-bundle.v2' &&
        v.mediaType === 'application/json',
    ),
    receipt: exportReceiptSchema,
  })
  .strict()
  .refine(
    (v) =>
      v.finalization.studyId === v.studyId &&
      v.finalization.reportRevisionId === v.reportRevisionId &&
      v.finalization.reportContentHash === v.reportContentHash,
    'exact export finalization binding required',
  );
const envelope = { schemaVersion: z.literal(API_SCHEMA), requestId: idSchema };
const write = { ...envelope, idempotencyKey: idSchema };
const report = { reportRevisionId: idSchema, expectedContentHash: hashSchema };
const history = { ...report, cursor: cursorSchema, limit: z.number().int().min(1).max(100) };
export const resourceSelectorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('study'), id: idSchema }).strict(),
  z.object({ type: z.literal('reportRevision'), id: idSchema }).strict(),
  z.object({ type: z.literal('share'), id: idSchema }).strict(),
  z.object({ type: z.literal('export'), id: idSchema }).strict(),
]);
const variants = [
  z.object({ ...envelope, operation: z.literal('capability.read') }).strict(),
  z
    .object({
      ...envelope,
      operation: z.literal('resource.actions'),
      resource: resourceSelectorSchema,
    })
    .strict(),
  z
    .object({
      ...write,
      operation: z.literal('member.set'),
      target: target('study'),
      memberId: uuidSchema,
      role: z.enum(['editor', 'reviewer', 'viewer']).nullable(),
    })
    .strict(),
  z
    .object({ ...write, operation: z.literal('comment.append'), ...report, text: plainText })
    .strict(),
  z.object({ ...envelope, operation: z.literal('comment.list'), ...history }).strict(),
  z
    .object({
      ...write,
      operation: z.literal('review.record'),
      ...report,
      reviewClass: z.literal(REVIEW_CLASS),
      decision: z.enum(['approve', 'reject', 'withdraw']),
      comment: plainText,
      predecessorReviewId: idSchema.nullable(),
      delegationId: idSchema.nullable(),
    })
    .strict(),
  z.object({ ...envelope, operation: z.literal('review.list'), ...history }).strict(),
  z
    .object({
      ...write,
      operation: z.literal('review.delegation.issue'),
      ...report,
      clientId: uuidSchema,
      reviewClass: z.literal(REVIEW_CLASS),
      decision: z.enum(['approve', 'reject', 'withdraw']),
      predecessorReviewId: idSchema.nullable(),
      expiresAt: timestampSchema,
    })
    .strict(),
  z
    .object({ ...write, operation: z.literal('review.delegation.revoke'), delegationId: idSchema })
    .strict(),
  z.object({ ...envelope, operation: z.literal('review.delegation.list'), ...history }).strict(),
  z
    .object({
      ...write,
      operation: z.literal('report.finalize'),
      target: target('reportRevision'),
      expectedContentHash: hashSchema,
      expectedReviewStateHash: hashSchema,
      profileId: profileSchema,
      acceptedReviewIds: uniqueIds,
    })
    .strict()
    .superRefine((v, c) => {
      if ((v.profileId === 'lca.study-report-unreviewed.v1') !== (v.acceptedReviewIds.length === 0))
        c.addIssue({ code: 'custom', message: 'profile requires exact accepted reviews' });
    }),
  z.object({ ...envelope, operation: z.literal('report.current'), ...report }).strict(),
  z.object({ ...envelope, operation: z.literal('report.view'), ...report }).strict(),
  z
    .object({
      ...write,
      operation: z.literal('export.request'),
      ...report,
      finalizationId: idSchema,
      expectedReviewStateHash: hashSchema,
      rendererVersion: z.literal('1.0.0'),
      viewModelVersion: z.literal('lca.study-report-view.v1'),
    })
    .strict(),
  z.object({ ...envelope, operation: z.literal('export.read'), exportId: idSchema }).strict(),
  z.object({ ...envelope, operation: z.literal('export.download'), exportId: idSchema }).strict(),
  z
    .object({
      ...write,
      operation: z.literal('share.create'),
      ...report,
      exportId: idSchema,
      recipientId: uuidSchema,
      disclosurePolicyId: z.literal('lca.study-report-summary-share.v1'),
      expiresAt: timestampSchema,
    })
    .strict(),
  z.object({ ...envelope, operation: z.literal('share.read'), shareId: idSchema }).strict(),
  z.object({ ...envelope, operation: z.literal('share.view'), shareId: idSchema }).strict(),
  z.object({ ...envelope, operation: z.literal('share.download'), shareId: idSchema }).strict(),
  z
    .object({
      ...write,
      operation: z.literal('share.revoke'),
      shareId: idSchema,
      reason: plainText,
    })
    .strict(),
  z.object({ ...envelope, operation: z.literal('share.list'), ...history }).strict(),
] as const;
export const requestSchema = z.discriminatedUnion('operation', variants);
export const OPERATIONS = variants.map((v) => v.shape.operation.value);
export type ReviewRequest = z.infer<typeof requestSchema>;
export const capabilitiesSchema = z
  .object({
    type: z.literal('capabilities'),
    contractVersion: z.literal(CONTRACT_VERSION),
    runtimeEnabled: z.boolean(),
    operations: z.array(z.enum(OPERATIONS)).min(1).max(OPERATIONS.length),
    finalizationProfiles: z.array(profileSchema).max(2),
    reviewClasses: z.array(z.literal(REVIEW_CLASS)).max(1),
    disclosurePolicies: z.array(z.literal('lca.study-report-summary-share.v1')).max(1),
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.operations).size === v.operations.length &&
      v.operations.includes('capability.read') &&
      (v.runtimeEnabled ||
        (v.operations.length === 1 &&
          v.finalizationProfiles.length === 0 &&
          v.reviewClasses.length === 0 &&
          v.disclosurePolicies.length === 0)),
    'explicit disabled admission required',
  );
export const DISABLED_CAPABILITIES: z.infer<typeof capabilitiesSchema> = {
  type: 'capabilities',
  contractVersion: CONTRACT_VERSION,
  runtimeEnabled: false,
  operations: ['capability.read'],
  finalizationProfiles: [],
  reviewClasses: [],
  disclosurePolicies: [],
};
