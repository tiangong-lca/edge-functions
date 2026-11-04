import {
  API_SCHEMA,
  CONTRACT_VERSION,
  OPERATIONS,
  requestSchema,
  type ReviewRequest,
} from './review.ts';
import { responseSchema, type MethodResponse as ReviewResponse } from './responses.ts';
import { StudyCodecError } from '../v2/codec.ts';
import { canonicalJson } from '../v3/canonical.ts';
export { API_SCHEMA, CONTRACT_VERSION, OPERATIONS, StudyCodecError };
export {
  verifyExport,
  verifyVersionedExport,
  parseExportBundle,
  canonicalReceiptBytes,
  validateExportViewBindings,
  exportTrustAnchorSchema,
  exportManifestSchema,
  exportReceiptSchema,
} from './export.ts';
export type { ReviewRequest as StudyApiRequest, ReviewResponse as StudyApiResponse };
export function parseRequest(input: unknown): ReviewRequest {
  if (
    input &&
    typeof input === 'object' &&
    'schemaVersion' in input &&
    input.schemaVersion !== API_SCHEMA
  )
    throw new StudyCodecError('UNSUPPORTED_SCHEMA', 'schema.version');
  const r = requestSchema.safeParse(input);
  if (!r.success) throw new StudyCodecError('INVALID_REQUEST', 'request.structure');
  return r.data;
}
export function parseResponse(input: unknown): ReviewResponse {
  const r = responseSchema.safeParse(input);
  if (!r.success) throw new StudyCodecError('REFERENCE_MISMATCH', 'response.structure');
  return r.data;
}
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const sameTime = (a: string, b: string) => Date.parse(a) === Date.parse(b);
export const QUERY_OPERATIONS = [
  'capability.read',
  'resource.actions',
  'comment.list',
  'review.list',
  'review.delegation.list',
  'report.current',
  'report.view',
  'export.read',
  'export.download',
  'share.read',
  'share.view',
  'share.download',
  'share.list',
] as const;
export const operationMetadata = Object.freeze(
  Object.fromEntries(
    OPERATIONS.map((operation) => [
      operation,
      Object.freeze({
        operation,
        kind: (QUERY_OPERATIONS as readonly string[]).includes(operation)
          ? ('query' as const)
          : ('mutation' as const),
      }),
    ]),
  ),
);
export function validateResponseForRequest(request: ReviewRequest, response: ReviewResponse): void {
  if (response.schemaVersion !== API_SCHEMA || response.requestId !== request.requestId)
    throw new StudyCodecError('REFERENCE_MISMATCH', 'response.envelope');
  if (!response.ok) return;
  const d = response.data;
  let valid = false;
  const report = (v: { reportRevisionId: string; reportContentHash: string }) =>
    'reportRevisionId' in request &&
    'expectedContentHash' in request &&
    v.reportRevisionId === request.reportRevisionId &&
    v.reportContentHash === request.expectedContentHash;
  switch (request.operation) {
    case 'capability.read':
      valid = d.type === 'capabilities';
      break;
    case 'resource.actions':
      valid =
        d.type === 'actions' &&
        same(d.resource, request.resource) &&
        new Set(d.actions).size === d.actions.length &&
        !d.corePermissions.read &&
        !d.corePermissions.write &&
        d.allowedMemberRoles.length === 0;
      break;
    case 'comment.append':
      valid = d.type === 'comment' && report(d.value) && d.value.text === request.text;
      break;
    case 'review.record':
      valid =
        d.type === 'review' &&
        report(d.value) &&
        d.value.reviewClass === request.reviewClass &&
        d.value.decision === request.decision &&
        d.value.comment === request.comment &&
        d.value.predecessorReviewId === request.predecessorReviewId &&
        d.value.delegationId === request.delegationId &&
        report(d.state) &&
        d.state.studyId === d.value.studyId;
      break;
    case 'review.delegation.issue':
      valid =
        d.type === 'delegation' &&
        report(d.value) &&
        d.value.clientId === request.clientId &&
        d.value.reviewClass === request.reviewClass &&
        d.value.decision === request.decision &&
        d.value.predecessorReviewId === request.predecessorReviewId &&
        sameTime(d.value.expiresAt, request.expiresAt);
      break;
    case 'review.delegation.revoke':
      valid =
        d.type === 'delegation' &&
        d.value.delegationId === request.delegationId &&
        d.value.revokedAt !== null;
      break;
    case 'report.finalize':
      valid =
        d.type === 'finalization' &&
        d.value.reportRevisionId === request.target.id &&
        d.value.reportContentHash === request.expectedContentHash &&
        d.value.expectedReviewStateHash === request.expectedReviewStateHash &&
        d.value.profileId === request.profileId &&
        same(d.value.acceptedReviewIds, request.acceptedReviewIds) &&
        d.state.reportRevisionId === request.target.id &&
        d.state.reportContentHash === request.expectedContentHash &&
        d.state.reportRevision === request.target.expectedRevision &&
        d.state.studyId === d.value.studyId;
      break;
    case 'report.current':
      valid = d.type === 'reportState' && report(d.value);
      break;
    case 'report.view':
      valid =
        d.type === 'view' &&
        d.share === null &&
        report(d.state) &&
        d.view.report.studyId === d.state.studyId &&
        d.view.report.reportRevisionId === d.state.reportRevisionId &&
        d.view.report.contentHash === d.state.reportContentHash;
      break;
    case 'export.request':
      valid =
        d.type === 'export' &&
        report(d.value) &&
        d.value.finalization.finalizationId === request.finalizationId &&
        d.value.finalization.reportContentHash === request.expectedContentHash &&
        d.value.finalization.expectedReviewStateHash === request.expectedReviewStateHash;
      break;
    case 'export.read':
      valid = d.type === 'export' && d.value.exportId === request.exportId;
      break;
    case 'export.download':
      valid = d.type === 'exportDownload' && d.export.exportId === request.exportId;
      break;
    case 'share.create':
      valid =
        d.type === 'share' &&
        report(d.value) &&
        d.value.exportId === request.exportId &&
        d.value.recipientId === request.recipientId &&
        d.value.disclosurePolicyId === request.disclosurePolicyId &&
        sameTime(d.value.expiresAt, request.expiresAt);
      break;
    case 'share.read':
    case 'share.revoke':
      valid =
        d.type === 'share' &&
        d.value.shareId === request.shareId &&
        (request.operation !== 'share.revoke' || d.value.revokedAt !== null);
      break;
    case 'share.view':
      valid =
        d.type === 'view' &&
        d.share?.shareId === request.shareId &&
        d.share.reportRevisionId === d.view.report.reportRevisionId &&
        d.share.reportContentHash === d.view.report.contentHash &&
        d.share.studyId === d.view.report.studyId &&
        d.state.reportRevisionId === d.share.reportRevisionId &&
        d.state.reportContentHash === d.share.reportContentHash;
      break;
    case 'share.download':
      valid = d.type === 'download' && d.share.shareId === request.shareId;
      break;
    case 'comment.list':
    case 'review.list':
    case 'review.delegation.list':
    case 'share.list': {
      const kind =
        request.operation === 'review.delegation.list'
          ? 'delegation'
          : request.operation.split('.')[0];
      valid =
        d.type === 'history' &&
        report(d) &&
        d.kind === kind &&
        d.items.length <= request.limit &&
        d.items.every(
          (v) =>
            v.studyId === d.studyId &&
            report(v) &&
            ((kind === 'comment' && 'commentId' in v) ||
              (kind === 'review' && 'reviewId' in v) ||
              (kind === 'delegation' && 'delegationId' in v) ||
              (kind === 'share' && 'shareId' in v)),
        ) &&
        new Set(
          d.items.map((v) =>
            'commentId' in v
              ? v.commentId
              : 'reviewId' in v
                ? v.reviewId
                : 'delegationId' in v
                  ? v.delegationId
                  : v.shareId,
          ),
        ).size === d.items.length;
      break;
    }
  }
  if (!valid) throw new StudyCodecError('REFERENCE_MISMATCH', 'response.selection');
}
