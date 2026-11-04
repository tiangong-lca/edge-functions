import {
  API_SCHEMA,
  CONTRACT_VERSION,
  OPERATIONS,
  requestSchema,
  analysisConfigSchema,
  type AdvancedRequest,
} from './advanced.ts';
import { responseSchema, type AdvancedResponse } from './authoring_responses.ts';
import { StudyCodecError } from '../v2/codec.ts';
import { canonicalJson, domainBytes, sha256 } from '../v3/canonical.ts';
export { API_SCHEMA, CONTRACT_VERSION, OPERATIONS, StudyCodecError };

export type { AdvancedRequest as StudyApiRequest, AdvancedResponse as StudyApiResponse };
export function parseRequest(input: unknown): AdvancedRequest {
  if (
    input &&
    typeof input === 'object' &&
    'schemaVersion' in input &&
    input.schemaVersion !== API_SCHEMA
  )
    throw new StudyCodecError('UNSUPPORTED_SCHEMA', 'schema.version');
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) throw new StudyCodecError('INVALID_REQUEST', 'request.structure');
  return parsed.data;
}
export function parseResponse(input: unknown): AdvancedResponse {
  const parsed = responseSchema.safeParse(input);
  if (!parsed.success) throw new StudyCodecError('REFERENCE_MISMATCH', 'response.structure');
  return parsed.data;
}
export async function analysisConfigHash(input: unknown): Promise<string> {
  return await sha256(domainBytes('study.analysis-config.v2', analysisConfigSchema.parse(input)));
}
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export function validateResponseForRequest(
  request: AdvancedRequest,
  value: AdvancedResponse,
): void {
  if (value.schemaVersion !== API_SCHEMA || value.requestId !== request.requestId)
    throw new StudyCodecError('REFERENCE_MISMATCH', 'response.envelope');
  if (!value.ok) return;
  const d = value.data;
  let valid = false;
  switch (request.operation) {
    case 'capability.read':
      valid = d.type === 'capabilities';
      break;
    case 'analysis.request':
      valid =
        d.type === 'analysis' &&
        (d.value as { studyId: string }).studyId === request.studyId &&
        (d.value as { profileId: string }).profileId === request.profileId &&
        (d.value as { configHash: string }).configHash === request.configHash &&
        same((d.value as { config: unknown }).config, request.config);
      break;
    case 'analysis.parameters.read':
      valid =
        d.type === 'parameterCatalog' &&
        d.studyId === request.studyId &&
        d.baselineRunId === request.baselineRunId;
      break;
    case 'analysis.read':
      valid =
        d.type === 'analysis' &&
        (d.value as { analysisId: string }).analysisId === request.analysisId;
      break;
    case 'task.read':
    case 'task.cancel':
      valid =
        d.type === 'task' &&
        (d.value as { studyId: string }).studyId === request.studyId &&
        same(d.value.resource, request.resource);
      break;
    case 'study.resources.list':
      valid =
        d.type === 'resourcePage' &&
        d.studyId === request.studyId &&
        d.kind === request.kind &&
        d.items.length <= request.limit;
      break;
    case 'report.create':
      valid =
        d.type === 'reportRevision' &&
        (d.value as { studyId: string }).studyId === request.studyId &&
        d.value.parentReportRevisionId === request.parentReportRevisionId &&
        d.value.revision === 1 &&
        d.value.status === 'draft' &&
        same(d.value.runIds, request.runIds) &&
        same(d.value.analysisIds, request.analysisIds) &&
        d.value.templateId === request.templateId;
      break;
    case 'report.save':
    case 'report.freeze':
      valid =
        d.type === 'reportRevision' &&
        d.value.reportRevisionId === request.target.id &&
        d.value.revision === request.target.expectedRevision + 1 &&
        d.value.status === (request.operation === 'report.freeze' ? 'frozen' : 'draft') &&
        (request.operation !== 'report.freeze' ||
          d.value.contentHash === request.expectedContentHash);
      break;
    case 'report.read':
      valid = d.type === 'reportRevision' && d.value.reportRevisionId === request.reportRevisionId;
      break;
    case 'artifact.read':
      valid =
        d.type === 'artifact' &&
        d.studyId === request.studyId &&
        same(d.artifactRef, request.artifactRef);
      break;
  }
  if (!valid) throw new StudyCodecError('REFERENCE_MISMATCH', 'response.selection');
}
export const operationMetadata = Object.freeze(
  Object.fromEntries(
    OPERATIONS.map((operation) => [
      operation,
      Object.freeze({
        operation,
        kind:
          operation.endsWith('.read') || operation.endsWith('.list')
            ? ('query' as const)
            : ('mutation' as const),
      }),
    ]),
  ),
);
