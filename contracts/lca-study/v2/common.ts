import { z } from 'zod';
import { ERROR_CODES as V1_CODES } from '../v1/common.ts';

export const API_SCHEMA = 'lca.study-api.v2' as const;
export const CONTRACT_VERSION = '2.0.0' as const;
export const ERROR_CODES = [
  ...V1_CODES,
  'AUTH_REQUIRED',
  'METHOD_NOT_ALLOWED',
  'PAYLOAD_TOO_LARGE',
  'DEADLINE_EXCEEDED',
] as const;
export const errorCodeSchema = z.enum(ERROR_CODES);
