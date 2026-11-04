import { z } from 'zod';
import { requestSchema as authoring, AUTHORING_OPERATIONS as a } from './authoring.ts';
import { requestSchema as review, OPERATIONS as b } from './review.ts';
export { API_SCHEMA, CONTRACT_VERSION } from './authoring.ts';
export const requestSchema = z.union([authoring, review]);
export type MethodRequest = z.infer<typeof requestSchema>;
export const OPERATIONS = [...new Set([...a, ...b])];
export function isMethodReviewRequest(request: MethodRequest): boolean {
  return request.operation === 'resource.actions'
    ? request.resource.type !== 'methodAssessment'
    : request.operation !== 'capability.read' &&
        (b as readonly string[]).includes(request.operation);
}
