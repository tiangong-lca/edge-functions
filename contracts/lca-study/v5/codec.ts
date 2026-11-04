import {
  API_SCHEMA,
  CONTRACT_VERSION,
  OPERATIONS,
  requestSchema,
  type AdvancedRequest,
} from './requests.ts';
import { responseSchema, type AdvancedResponse } from './responses.ts';
import { OPERATIONS as authoringOps } from './advanced.ts';
import { capabilitiesSchema } from './capabilities.ts';
import {
  parseResponse as parseAuthoringResponse,
  validateResponseForRequest as validateAuthoring,
  type StudyApiRequest as AuthoringRequest,
} from './authoring_codec.ts';
import {
  parseResponse as parseReviewResponse,
  validateResponseForRequest as validateReview,
  type StudyApiRequest as ReviewRequest,
} from './review_codec.ts';
import { StudyCodecError } from '../v2/codec.ts';
export { API_SCHEMA, CONTRACT_VERSION, OPERATIONS, StudyCodecError };
export { analysisConfigHash } from './authoring_codec.ts';
export * from './export.ts';
export type { AdvancedRequest as StudyApiRequest, AdvancedResponse as StudyApiResponse };
export function parseRequest(input: unknown): AdvancedRequest {
  if (
    input &&
    typeof input === 'object' &&
    'schemaVersion' in input &&
    input.schemaVersion !== API_SCHEMA
  )
    throw new StudyCodecError('UNSUPPORTED_SCHEMA', 'schema.version');
  const p = requestSchema.safeParse(input);
  if (!p.success) throw new StudyCodecError('INVALID_REQUEST', 'request.structure');
  return p.data;
}
export function parseResponse(input: unknown): AdvancedResponse {
  const p = responseSchema.safeParse(input);
  if (!p.success) throw new StudyCodecError('REFERENCE_MISMATCH', 'response.structure');
  return p.data;
}
export function validateResponseForRequest(r: AdvancedRequest, s: AdvancedResponse): void {
  if (r.operation === 'capability.read') {
    if (
      s.schemaVersion !== API_SCHEMA ||
      s.requestId !== r.requestId ||
      (s.ok && !capabilitiesSchema.safeParse(s.data).success)
    )
      throw new StudyCodecError('REFERENCE_MISMATCH', 'response.capabilities');
    return;
  }
  if ((authoringOps as readonly string[]).includes(r.operation))
    validateAuthoring(r as AuthoringRequest, parseAuthoringResponse(s));
  else validateReview(r as ReviewRequest, parseReviewResponse(s));
}
export const operationMetadata = Object.freeze(
  Object.fromEntries(
    OPERATIONS.map((operation) => [
      operation,
      Object.freeze({
        operation,
        kind:
          operation.endsWith('.read') ||
          operation.endsWith('.list') ||
          [
            'report.current',
            'report.view',
            'share.view',
            'share.download',
            'export.download',
            'resource.actions',
          ].includes(operation)
            ? ('query' as const)
            : ('mutation' as const),
      }),
    ]),
  ),
);
