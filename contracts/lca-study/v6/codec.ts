import {
  API_SCHEMA,
  CONTRACT_VERSION,
  requestSchema,
  OPERATIONS,
  isMethodReviewRequest,
  type MethodRequest,
} from './requests.ts';
import { responseSchema, type MethodResponse } from './responses.ts';
import { StudyCodecError } from '../v2/codec.ts';
import { sameMethodJson } from './authoring.ts';
import { validateResponseForRequest as validateReview } from './review_codec.ts';
import type { ReviewRequest } from './review.ts';
import { methodConfigHash } from './schemas.ts';
import { methodEvidenceHash } from './evidence_contract.ts';
import { canonicalBytes } from '../v3/canonical.ts';
export { API_SCHEMA, CONTRACT_VERSION, OPERATIONS, StudyCodecError };
export { methodConfigHash } from './schemas.ts';
export { methodEvidenceHash } from './evidence_contract.ts';
export * from './export.ts';
export type { MethodRequest as StudyApiRequest, MethodResponse as StudyApiResponse };
export function parseRequest(input: unknown): MethodRequest {
  if (
    input &&
    typeof input === 'object' &&
    'schemaVersion' in input &&
    input.schemaVersion !== API_SCHEMA
  )
    throw new StudyCodecError('UNSUPPORTED_SCHEMA', 'schema.version');
  try {
    const parsed = requestSchema.safeParse(input);
    if (parsed.success) return parsed.data;
  } catch {}
  throw new StudyCodecError('INVALID_REQUEST', 'request.structure');
}
export function parseResponse(input: unknown): MethodResponse {
  try {
    const parsed = responseSchema.safeParse(input);
    if (parsed.success) return parsed.data;
  } catch {}
  throw new StudyCodecError('REFERENCE_MISMATCH', 'response.structure');
}
export function validateResponseForRequest(request: MethodRequest, response: MethodResponse): void {
  if (response.schemaVersion !== API_SCHEMA || response.requestId !== request.requestId)
    throw new StudyCodecError('REFERENCE_MISMATCH', 'response.envelope');
  if (!response.ok) return;
  if (isMethodReviewRequest(request)) {
    validateReview(request as ReviewRequest, response);
    const data = response.data;
    if (
      (data.type === 'exportDownload' &&
        decodedLength(data.bytes) !== data.export.bundleRef.byteSize) ||
      (data.type === 'download' && decodedLength(data.bytes) !== data.share.bundleRef.byteSize)
    )
      throw new StudyCodecError('REFERENCE_MISMATCH', 'response.inline_byte_size');
    return;
  }
  const d = response.data;
  let valid = false;
  switch (request.operation) {
    case 'capability.read':
      valid = d.type === 'capabilities';
      break;
    case 'method.assessment.request':
      valid =
        d.type === 'methodAssessment' &&
        d.value.studyId === request.studyId &&
        d.value.profileId === request.profileId &&
        d.value.configHash === request.configHash &&
        sameMethodJson(d.value.config, request.config);
      break;
    case 'method.assessment.read':
      valid = d.type === 'methodAssessment' && d.value.assessmentId === request.assessmentId;
      break;
    case 'method.evidence.create':
      valid =
        d.type === 'methodEvidence' &&
        d.value.studyId === request.studyId &&
        d.value.requirementId === request.content.requirementId &&
        d.value.declaredKind === request.content.declaredKind;
      break;
    case 'method.evidence.read':
      valid = d.type === 'methodEvidence' && d.value.evidenceId === request.evidenceId;
      break;
    case 'task.read':
    case 'task.cancel':
      valid =
        d.type === 'task' &&
        d.value.studyId === request.studyId &&
        sameMethodJson(d.value.resource, request.resource);
      break;
    case 'study.resources.list':
      valid =
        d.type === 'resourcePage' &&
        d.studyId === request.studyId &&
        d.kind === request.kind &&
        d.items.length <= request.limit;
      break;
    case 'resource.actions':
      valid =
        d.type === 'actions' &&
        sameMethodJson(d.resource, request.resource) &&
        d.allowedMemberRoles.length === 0;
      break;
    case 'artifact.read':
      valid =
        d.type === 'artifact' &&
        d.studyId === request.studyId &&
        sameMethodJson(d.artifactRef, request.artifactRef) &&
        decodedLength(d.bytes) === request.artifactRef.byteSize;
      break;
    case 'report.create':
      valid =
        d.type === 'reportRevision' &&
        d.value.studyId === request.studyId &&
        d.value.parentReportRevisionId === request.parentReportRevisionId &&
        d.value.revision === 1 &&
        d.value.status === 'draft' &&
        sameMethodJson(d.value.runIds, request.runIds) &&
        sameMethodJson(d.value.methodAssessmentIds, request.methodAssessmentIds) &&
        d.value.templateId === request.templateId;
      break;
    case 'report.save':
    case 'report.freeze':
      valid =
        d.type === 'reportRevision' &&
        d.value.reportRevisionId === request.target.id &&
        Number.isSafeInteger(request.target.expectedRevision + 1) &&
        d.value.revision === request.target.expectedRevision + 1 &&
        d.value.status === (request.operation === 'report.freeze' ? 'frozen' : 'draft') &&
        (request.operation !== 'report.freeze' ||
          d.value.contentHash === request.expectedContentHash);
      break;
    case 'report.read':
      valid = d.type === 'reportRevision' && d.value.reportRevisionId === request.reportRevisionId;
      break;
  }
  if (!valid) throw new StudyCodecError('REFERENCE_MISMATCH', 'response.selection');
}
function decodedLength(bytes: string): number {
  return (bytes.length / 4) * 3 - (bytes.endsWith('==') ? 2 : bytes.endsWith('=') ? 1 : 0);
}
/** Async owner identity checks complement structural/selection validation.
 * Callers use these exact owner hashes; they never rebuild domain canonicalization.
 */
export async function validateResponseContentForRequest(
  request: MethodRequest,
  response: MethodResponse,
): Promise<void> {
  validateResponseForRequest(request, response);
  if (
    request.operation === 'method.assessment.request' &&
    (await methodConfigHash(request.config)) !== request.configHash
  )
    throw new StudyCodecError('REFERENCE_MISMATCH', 'request.config_hash');
  if (!response.ok) return;
  if (request.operation === 'method.evidence.create') {
    const data = response.data;
    if (
      data.type !== 'methodEvidence' ||
      data.value.artifactRef.contentHash !== (await methodEvidenceHash(request.content)) ||
      data.value.artifactRef.byteSize !== canonicalBytes(request.content).length
    )
      throw new StudyCodecError('REFERENCE_MISMATCH', 'response.evidence_bytes');
  }
}
const queries = [
  'capability.read',
  'resource.actions',
  'report.current',
  'report.view',
  'export.download',
  'share.view',
  'share.download',
];
export const operationMetadata = Object.freeze(
  Object.fromEntries(
    OPERATIONS.map((operation) => [
      operation,
      Object.freeze({
        operation,
        kind:
          operation.endsWith('.read') || operation.endsWith('.list') || queries.includes(operation)
            ? ('query' as const)
            : ('mutation' as const),
      }),
    ]),
  ),
);
