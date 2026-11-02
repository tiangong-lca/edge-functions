import { z } from 'zod';

/** Published contract vocabulary only. No endpoint, actor resolver or persistence adapter. */
export const API_SCHEMA = 'lca.study-api.v1' as const;
export const CONTRACT_BUNDLE_SCHEMA = 'lca.study-api-contract-bundle.v1' as const;
export const QUALIFICATION_PROFILE = 'lca.study-deterministic-p0.v1' as const;

export function text(maximum = 512) {
  return z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim().length > 0, 'text must not be blank')
    .refine(
      (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value),
      'invalid control character',
    )
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= maximum * 4,
      'UTF-8 limit exceeded',
    );
}

export const idSchema = text(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const datasetVersionSchema = z.string().regex(/^\d{2}\.\d{2}\.\d{3}$/u);
export const cursorSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[A-Za-z0-9_-]+$/u)
  .nullable();
export const resourceKindSchema = z.enum([
  'studyRevision',
  'scenarioRevision',
  'modelSourceSnapshot',
  'modelPreparation',
  'run',
  'analysis',
  'reportRevision',
  'review',
  'export',
  'share',
]);
export const timestampSchema = z.string().datetime({ offset: true });
export const generationSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const contentStatusSchema = z.enum(['draft', 'frozen']);
export const workerJobStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'completed',
  'blocked',
  'stale',
  'failed',
  'cancelled',
]);
export const validitySchema = z
  .object({
    status: z.enum(['current', 'superseded', 'withdrawn', 'unknown']),
    checkedAt: timestampSchema,
    reasonCodes: z.array(idSchema).max(32),
  })
  .strict();

/** A Worker-issued fingerprint, NOT an artifact locator or a reserialized descriptor. */
export const calculationContractRefSchema = z
  .object({
    kind: z.literal('calculation_contract'),
    schema: z.literal('lca.calculation-contract.v1'),
    sha256: hashSchema,
  })
  .strict();

export const artifactRefSchema = z
  .object({
    type: z.enum([
      'modelInput',
      'modelSource',
      'runResult',
      'analysisFacts',
      'reportContent',
      'reportProjection',
      'renderResources',
    ]),
    id: idSchema,
    contentHash: hashSchema,
    digestScope: z.literal('artifact_bytes_sha256'),
    byteSize: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    mediaType: z.enum(['application/json', 'application/zip', 'text/html']),
    schemaVersion: idSchema,
  })
  .strict();

export const modelRefSchema = z
  .object({
    type: z.literal('modelRevision'),
    modelRevisionId: idSchema,
    contentHash: hashSchema,
    digestScope: z.literal('worker_prepared_model'),
  })
  .strict();

export const sourceRefSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('datasetRevision'),
      datasetType: z.enum(['process', 'flow', 'lciamethod', 'unitgroup', 'flowproperty', 'source']),
      id: idSchema,
      version: datasetVersionSchema,
      contentHash: hashSchema,
      licenseRef: idSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('releaseFinalResult'),
      releaseId: idSchema,
      resultId: idSchema,
      contentHash: hashSchema,
      licenseRef: idSchema,
    })
    .strict(),
]);

export const ERROR_CODES = [
  'INVALID_REQUEST',
  'UNSUPPORTED_SCHEMA',
  'REVISION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'REFERENCE_MISMATCH',
  'FROZEN_REVISION',
  'FORBIDDEN',
  'CAPABILITY_UNAVAILABLE',
  'REVIEW_REQUIRED',
  'DISCLOSURE_DENIED',
  'NOT_FOUND',
  'UPSTREAM_UNAVAILABLE',
] as const;

export const issueSchema = z
  .object({
    code: z.enum(ERROR_CODES),
    path: text(512),
    ruleId: idSchema,
  })
  .strict();

export function target<const TType extends string>(type: TType) {
  return z
    .object({ type: z.literal(type), id: idSchema, expectedRevision: generationSchema })
    .strict();
}

export type ContractIssue = z.infer<typeof issueSchema>;
export type CalculationContractRef = z.infer<typeof calculationContractRefSchema>;
