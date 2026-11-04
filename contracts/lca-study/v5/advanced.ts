import { z } from 'zod';
import configOwner from '../worker/analysis-config.v2.schema.json' with { type: 'json' };
import recordOwner from '../worker/analysis-record.v2.schema.json' with { type: 'json' };
import type { AdvancedConfig } from '../worker/analysis-config.v2.d.ts';
import type { AdvancedRecord } from '../worker/analysis-record.v2.d.ts';
import { artifactRefSchema, hashSchema, idSchema, target, text } from '../v1/common.ts';
import { reportRevisionSchema as legacyReport } from '../v1/records.ts';
import { decimalSchema, reportContentSchema as oldContent } from '../v3/report.ts';
export const API_SCHEMA = 'lca.study-api.v5' as const;
export const CONTRACT_VERSION = '5.0.0' as const;
export const REPORT_TEMPLATE = 'lca.study-report.v2' as const;
export const ANALYSIS_PROFILES = [
  'lca.study-sensitivity-oat.v1',
  'lca.study-uncertainty-bounded.v1',
] as const;
export const uuidSchema = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u);
const owner = (s: unknown) => z.fromJSONSchema(s as Parameters<typeof z.fromJSONSchema>[0]);
export const analysisConfigSchema = owner(configOwner).superRefine((raw, c) => {
  const v = raw as AdvancedConfig;
  const number = (s: string) =>
    decimalSchema.safeParse(s).success &&
    Number.isFinite(Number(s)) &&
    (Number(s) !== 0 || s === '0');
  if (
    v.parameters.some(
      (p) =>
        new TextEncoder().encode(p.path).length > 256 ||
        new TextEncoder().encode(p.unit).length > 256,
    )
  )
    c.addIssue({ code: 'custom', message: 'bounded UTF-8 parameter metadata required' });
  if (
    new Set(v.parameters.map((p) => p.path)).size !== v.parameters.length ||
    v.parameters.some(
      (p) =>
        ![p.baselineAmount, p.low, p.high].every(number) ||
        !(
          Number(p.low) < Number(p.high) &&
          Number(p.low) <= Number(p.baselineAmount) &&
          Number(p.baselineAmount) <= Number(p.high) &&
          Number.isFinite(Number(p.high) - Number(p.low))
        ),
    )
  )
    c.addIssue({ code: 'custom', message: 'exact finite parameter bounds required' });
  if (
    v.kind === 'uncertainty' &&
    v.design.kind === 'jointEmpirical' &&
    v.design.rows.some(
      (row) =>
        row.length !== v.parameters.length ||
        row.some(
          (x, i) =>
            !number(x) ||
            Number(x) < Number(v.parameters[i].low) ||
            Number(x) > Number(v.parameters[i].high),
        ),
    )
  )
    c.addIssue({ code: 'custom', message: 'complete bounded empirical rows required' });
}) as z.ZodType<AdvancedConfig>;
export function parseAnalysisConfig(input: unknown): AdvancedConfig {
  return analysisConfigSchema.parse(input) as AdvancedConfig;
}
export const analysisSchema = owner(recordOwner).superRefine((raw, c) => {
  const v = raw as AdvancedRecord;
  if (
    !analysisConfigSchema.safeParse(v.config).success ||
    v.profileId !==
      (v.config.kind === 'sensitivityOat' ? ANALYSIS_PROFILES[0] : ANALYSIS_PROFILES[1])
  )
    c.addIssue({ code: 'custom', message: 'profile config binding required' });
}) as z.ZodType<AdvancedRecord>;
export function parseAnalysis(input: unknown): AdvancedRecord {
  return analysisSchema.parse(input) as AdvancedRecord;
}
export const reportingArtifactRefSchema = artifactRefSchema.extend({
  type: z.enum(['analysisFacts', 'reportContent']),
});
export const factsRefSchema = reportingArtifactRefSchema.extend({
  type: z.literal('analysisFacts'),
  schemaVersion: z.literal('lca.study-analysis-facts.v2'),
  mediaType: z.literal('application/json'),
});
const plain = (n: number) =>
  text(n).refine(
    (v) => !/[<>]/u.test(v) && !/(?:https?|javascript|data|file|blob):/iu.test(v),
    'plain report text required',
  );
export const reportContentSchema = z
  .object({
    ...oldContent.shape,
    schemaVersion: z.literal('lca.study-report-draft.v2'),
    claims: z
      .array(
        z
          .object({
            claimId: idSchema,
            bundleRef: factsRefSchema,
            factId: idSchema,
            canonicalValue: decimalSchema.nullable(),
            unit: plain(128),
            display: z.object({ style: z.literal('exact') }).strict(),
          })
          .strict(),
      )
      .min(1)
      .max(256),
  })
  .strict()
  .superRefine((v, c) => {
    const claims = new Set(v.claims.map((x) => x.claimId));
    if (claims.size !== v.claims.length)
      c.addIssue({ code: 'custom', message: 'unique claims required' });
    for (const rows of [v.sections, v.tables, v.charts])
      for (const row of rows)
        if (
          new Set(row.claimIds).size !== row.claimIds.length ||
          row.claimIds.some((id) => !claims.has(id))
        )
          c.addIssue({ code: 'custom', message: 'exact claim selections required' });
    for (const ids of [
      v.sections.map((x) => x.sectionId),
      v.tables.map((x) => x.tableId),
      v.charts.map((x) => x.chartId),
    ])
      if (new Set(ids).size !== ids.length)
        c.addIssue({ code: 'custom', message: 'unique presentation ids required' });
  });

export const reportRevisionSchema = legacyReport.refine(
  (v) =>
    v.templateId === REPORT_TEMPLATE &&
    v.runIds.length === 1 &&
    v.contentRef.schemaVersion === 'lca.study-report-content.v2',
  'advanced report family required',
);
const envelope = { schemaVersion: z.literal(API_SCHEMA), requestId: idSchema };
const write = { ...envelope, idempotencyKey: idSchema };
const resource = z.object({ type: z.literal('analysis'), id: uuidSchema }).strict();
const variants = [
  z.object({ ...envelope, operation: z.literal('capability.read') }).strict(),
  z
    .object({
      ...write,
      operation: z.literal('analysis.request'),
      studyId: uuidSchema,
      profileId: z.enum(ANALYSIS_PROFILES),
      config: analysisConfigSchema,
      configHash: hashSchema,
    })
    .strict()
    .superRefine((v, c) => {
      if (
        v.profileId !==
        ((v.config as AdvancedConfig).kind === 'sensitivityOat'
          ? ANALYSIS_PROFILES[0]
          : ANALYSIS_PROFILES[1])
      )
        c.addIssue({ code: 'custom', message: 'profile binding required' });
    }),
  z.object({ ...envelope, operation: z.literal('analysis.read'), analysisId: uuidSchema }).strict(),
  z
    .object({
      ...envelope,
      operation: z.literal('analysis.parameters.read'),
      studyId: uuidSchema,
      baselineRunId: uuidSchema,
    })
    .strict(),
  z
    .object({ ...envelope, operation: z.literal('task.read'), studyId: uuidSchema, resource })
    .strict(),
  z
    .object({
      ...write,
      operation: z.literal('task.cancel'),
      studyId: uuidSchema,
      resource,
      reason: text(512),
    })
    .strict(),
  z
    .object({
      ...envelope,
      operation: z.literal('study.resources.list'),
      studyId: uuidSchema,
      kind: z.enum(['analysis', 'reportRevision']),
      limit: z.number().int().min(1).max(100),
      cursor: text(2048).nullable(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      operation: z.literal('artifact.read'),
      studyId: uuidSchema,
      artifactRef: reportingArtifactRefSchema,
    })
    .strict(),
  z
    .object({
      ...write,
      operation: z.literal('report.create'),
      studyId: uuidSchema,
      parentReportRevisionId: uuidSchema.nullable(),
      runIds: z.array(uuidSchema).length(1),
      analysisIds: z.array(uuidSchema).min(1).max(2),
      content: reportContentSchema,
      templateId: z.literal(REPORT_TEMPLATE),
    })
    .strict(),
  z
    .object({
      ...write,
      operation: z.literal('report.save'),
      target: target('reportRevision').extend({ id: uuidSchema }),
      content: reportContentSchema,
    })
    .strict(),
  z
    .object({
      ...write,
      operation: z.literal('report.freeze'),
      target: target('reportRevision').extend({ id: uuidSchema }),
      expectedContentHash: hashSchema,
    })
    .strict(),
  z
    .object({ ...envelope, operation: z.literal('report.read'), reportRevisionId: uuidSchema })
    .strict(),
] as const;
export const requestSchema = z.union(variants).superRefine((v, c) => {
  if ('analysisIds' in v && new Set(v.analysisIds).size !== v.analysisIds.length)
    c.addIssue({ code: 'custom', message: 'unique references required' });
  if (
    v.operation === 'artifact.read' &&
    !(
      (v.artifactRef.type === 'analysisFacts' &&
        v.artifactRef.schemaVersion === 'lca.study-analysis-facts.v2') ||
      (v.artifactRef.type === 'reportContent' &&
        v.artifactRef.schemaVersion === 'lca.study-report-content.v2')
    )
  )
    c.addIssue({ code: 'custom', message: 'exact advanced artifact family required' });
});
export const OPERATIONS = variants.map((v) => v.shape.operation.value);
export type AdvancedRequest = z.infer<typeof requestSchema>;
export const capabilitiesSchema = z
  .object({
    type: z.literal('capabilities'),
    contractVersion: z.literal(CONTRACT_VERSION),
    runtimeEnabled: z.boolean(),
    operations: z.array(z.enum(OPERATIONS)).min(1).max(OPERATIONS.length),
    analysisProfiles: z.array(z.enum(ANALYSIS_PROFILES)).max(2),
    reportTemplates: z.array(z.literal(REPORT_TEMPLATE)).max(1),
  })
  .strict()
  .refine(
    (v) =>
      v.operations.includes('capability.read') &&
      new Set(v.operations).size === v.operations.length &&
      (v.runtimeEnabled ||
        (v.operations.length === 1 &&
          v.analysisProfiles.length === 0 &&
          v.reportTemplates.length === 0)),
    'explicit disabled admission required',
  );
export const DISABLED_CAPABILITIES: z.infer<typeof capabilitiesSchema> = {
  type: 'capabilities',
  contractVersion: CONTRACT_VERSION,
  runtimeEnabled: false,
  operations: ['capability.read'],
  analysisProfiles: [],
  reportTemplates: [],
};
export type { AdvancedConfig, AdvancedRecord };
