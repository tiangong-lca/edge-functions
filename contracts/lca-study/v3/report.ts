import { z } from 'zod';
import {
  artifactRefSchema,
  hashSchema,
  idSchema,
  target,
  text,
  validitySchema,
  workerJobStatusSchema,
} from '../v1/common.ts';
import {
  reportRevisionSchema as legacyReport,
  exportSchema as legacyExport,
} from '../v1/records.ts';
import { exportReceiptSchema } from './export.ts';

export const API_SCHEMA = 'lca.study-api.v3' as const;
export const CONTRACT_VERSION = '3.0.0' as const;
export const ANALYSIS_PROFILE = 'lca.study-analysis-explicit-v1' as const;
export const REPORT_TEMPLATE = 'lca.study-report.v1' as const;
export const reportingArtifactRefSchema = artifactRefSchema.extend({
  type: z.enum([
    'analysisFacts',
    'reportContent',
    'reportProjection',
    'renderResources',
    'reportExportBundle',
  ]),
});
const factsRef = reportingArtifactRefSchema.extend({
  type: z.literal('analysisFacts'),
  schemaVersion: z.literal('lca.study-analysis-facts.v1'),
  mediaType: z.literal('application/json'),
});
export const analysisConfigSchema = z
  .object({
    schemaVersion: z.literal('lca.study-analysis-config.v1'),
    kind: z.enum(['contribution', 'comparison']),
    runIds: z
      .array(z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u))
      .min(1)
      .max(2),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      new Set(v.runIds).size !== v.runIds.length ||
      v.runIds.length !== (v.kind === 'comparison' ? 2 : 1)
    )
      c.addIssue({ code: 'custom', message: 'ordered unique analysis runs required' });
  });
export const analysisSchema = z
  .object({
    analysisId: idSchema,
    studyId: idSchema,
    profileId: z.literal(ANALYSIS_PROFILE),
    config: analysisConfigSchema,
    configHash: hashSchema,
    execution: z.object({ jobId: idSchema, status: workerJobStatusSchema }).strict(),
    comparability: z
      .object({
        status: z.enum(['not_assessed', 'comparable', 'not_comparable']),
        reasonCodes: z.array(idSchema).max(32),
      })
      .strict(),
    factsRef: factsRef.nullable(),
  })
  .strict()
  .refine(
    (v) => (v.execution.status === 'completed') === (v.factsRef !== null),
    'facts only on completed analysis',
  );
// Worker owns the exact numerical spelling. This is its bounded consumer grammar;
// claim validation additionally compares the producer string byte-for-byte.
export const decimalSchema = z
  .string()
  .max(64)
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?(?:e-?[1-9]\d{0,2})?$/u)
  .refine(
    (v) =>
      (!/^-?0(?:e.*)?$/u.test(v) || v === '0') && Math.abs(Number(v.split('e')[1] ?? 0)) <= 324,
    'canonical Worker number required',
  );
const plain = (max: number) =>
  text(max).refine(
    (v) => !/[<>]/u.test(v) && !/(?:https?|javascript|data|file|blob):/iu.test(v),
    'plain report text required',
  );
const claimSchema = z
  .object({
    claimId: idSchema,
    bundleRef: factsRef,
    factId: idSchema,
    canonicalValue: decimalSchema.nullable(),
    unit: plain(128),
    display: z.object({ style: z.literal('exact') }).strict(),
  })
  .strict();
export const reportContentSchema = z
  .object({
    schemaVersion: z.literal('lca.study-report-draft.v1'),
    title: plain(256),
    claims: z.array(claimSchema).min(1).max(256),
    sections: z
      .array(
        z
          .object({
            sectionId: idSchema,
            title: plain(256),
            paragraphs: z.array(plain(2048)).max(32),
            claimIds: z.array(idSchema).max(256),
          })
          .strict(),
      )
      .max(32),
    tables: z
      .array(
        z
          .object({
            tableId: idSchema,
            title: plain(256),
            claimIds: z.array(idSchema).min(1).max(256),
          })
          .strict(),
      )
      .max(32),
    charts: z
      .array(
        z
          .object({
            chartId: idSchema,
            title: plain(256),
            claimIds: z.array(idSchema).min(1).max(64),
          })
          .strict(),
      )
      .max(32),
    additionalLimitations: z.array(plain(2048)).max(32),
  })
  .strict()
  .superRefine((v, c) => {
    const claims = new Set(v.claims.map((x) => x.claimId));
    if (claims.size !== v.claims.length)
      c.addIssue({ code: 'custom', message: 'unique claims required' });
    for (const [kind, rows] of [
      ['sections', v.sections],
      ['tables', v.tables],
      ['charts', v.charts],
    ] as const) {
      const key = kind === 'sections' ? 'sectionId' : kind === 'tables' ? 'tableId' : 'chartId';
      const ids = rows.map((row) => (row as unknown as Record<string, unknown>)[key]);
      if (new Set(ids).size !== ids.length)
        c.addIssue({ code: 'custom', message: 'unique presentation ids required' });
      for (const row of rows)
        if (
          new Set(row.claimIds).size !== row.claimIds.length ||
          row.claimIds.some((id) => !claims.has(id))
        )
          c.addIssue({ code: 'custom', message: 'exact supplied claim references required' });
    }
  });
export type ReportContent = z.infer<typeof reportContentSchema>;
export const reportRevisionSchema = legacyReport.refine(
  (v) =>
    v.templateId === REPORT_TEMPLATE &&
    v.finalization.status === 'not_finalized' &&
    v.finalization.reviewIds.length === 0,
  'P2 is unreviewed and not finalized',
);
export const exportSchema = legacyExport
  .omit({ receipt: true })
  .extend({
    receipt: exportReceiptSchema,
    bundleRef: reportingArtifactRefSchema.refine(
      (v) =>
        v.type === 'reportExportBundle' &&
        v.mediaType === 'application/json' &&
        v.schemaVersion === 'lca.study-export-bundle.v1',
    ),
  })
  .refine(
    (v) => v.status === 'ready' && v.disclosureDecision === 'allowed' && v.reviewIds.length === 0,
    'ready P2 authorized export required',
  );
const envelope = { schemaVersion: z.literal(API_SCHEMA), requestId: idSchema };
const write = { ...envelope, idempotencyKey: idSchema };
const resource = z.object({ type: z.literal('analysis'), id: idSchema }).strict();
const variants = [
  z.object({ ...envelope, operation: z.literal('capability.read') }).strict(),
  z
    .object({
      ...write,
      operation: z.literal('analysis.request'),
      studyId: idSchema,
      profileId: z.literal(ANALYSIS_PROFILE),
      config: analysisConfigSchema,
      configHash: hashSchema,
    })
    .strict(),
  z.object({ ...envelope, operation: z.literal('analysis.read'), analysisId: idSchema }).strict(),
  z
    .object({ ...envelope, operation: z.literal('task.read'), studyId: idSchema, resource })
    .strict(),
  z
    .object({
      ...write,
      operation: z.literal('task.cancel'),
      studyId: idSchema,
      resource,
      reason: text(512),
    })
    .strict(),
  z
    .object({
      ...envelope,
      operation: z.literal('study.resources.list'),
      studyId: idSchema,
      kind: z.enum(['analysis', 'reportRevision', 'export']),
      limit: z.number().int().min(1).max(100),
      cursor: text(2048).nullable(),
    })
    .strict(),
  z
    .object({
      ...write,
      operation: z.literal('report.create'),
      studyId: idSchema,
      parentReportRevisionId: idSchema.nullable(),
      runIds: z.array(idSchema).min(1).max(2),
      analysisIds: z.array(idSchema).min(1).max(2),
      content: reportContentSchema,
      templateId: z.literal(REPORT_TEMPLATE),
    })
    .strict(),
  z
    .object({
      ...write,
      operation: z.literal('report.save'),
      target: target('reportRevision'),
      content: reportContentSchema,
    })
    .strict(),
  z
    .object({
      ...write,
      operation: z.literal('report.freeze'),
      target: target('reportRevision'),
      expectedContentHash: hashSchema,
    })
    .strict(),
  z
    .object({ ...envelope, operation: z.literal('report.read'), reportRevisionId: idSchema })
    .strict(),
  z
    .object({
      ...write,
      operation: z.literal('export.request'),
      reportRevisionId: idSchema,
      expectedContentHash: hashSchema,
      rendererVersion: z.literal('1.0.0'),
      viewModelVersion: z.literal('lca.study-report-view.v1'),
    })
    .strict(),
  z.object({ ...envelope, operation: z.literal('export.read'), exportId: idSchema }).strict(),
  z
    .object({
      ...envelope,
      operation: z.literal('artifact.read'),
      studyId: idSchema,
      artifactRef: reportingArtifactRefSchema,
    })
    .strict(),
] as const;
export const requestSchema = z.union(variants).superRefine((v, c) => {
  for (const key of ['runIds', 'analysisIds'] as const)
    if (key in v) {
      const ids = (v as Record<string, unknown>)[key] as string[];
      if (new Set(ids).size !== ids.length)
        c.addIssue({ code: 'custom', message: 'unique references required' });
    }
});
export const OPERATIONS = variants.map((v) => v.shape.operation.value);
export type ReportingRequest = z.infer<typeof requestSchema>;
export const capabilitiesSchema = z
  .object({
    type: z.literal('capabilities'),
    contractVersion: z.literal(CONTRACT_VERSION),
    runtimeEnabled: z.boolean(),
    operations: z.array(z.enum(OPERATIONS as [string, ...string[]])).max(32),
    analysisProfiles: z.array(z.literal(ANALYSIS_PROFILE)).max(1),
    reportTemplates: z.array(z.literal(REPORT_TEMPLATE)).max(1),
  })
  .strict();
export const DISABLED_CAPABILITIES = {
  type: 'capabilities' as const,
  contractVersion: CONTRACT_VERSION,
  runtimeEnabled: false,
  operations: ['capability.read'],
  analysisProfiles: [],
  reportTemplates: [],
};
export { validitySchema };
