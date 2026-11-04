import { z } from 'zod';
import { requestSchema as authoring, OPERATIONS as a } from './advanced.ts';
import { requestSchema as review, OPERATIONS as b } from './review.ts';
export { API_SCHEMA, CONTRACT_VERSION } from './advanced.ts';
export const requestSchema = z.union([authoring, review]);
export const OPERATIONS = [...new Set([...a, ...b])];
export type AdvancedRequest = z.infer<typeof requestSchema>;
