import { z } from 'zod';
import {
  artifactRefSchema,
  hashSchema,
  idSchema,
  target,
  text,
  cursorSchema,
} from '../v1/common.ts';
import { reportRevisionSchema as previousReport } from '../v1/records.ts';
import { reportContentSchema as previousDraft } from '../v5/advanced.ts';
import { uuidSchema } from '../v5/advanced.ts';
import { decimalSchema } from '../v3/report.ts';
import { canonicalJson } from '../v3/canonical.ts';
import {
  methodConfigSchema,
  methodAssessmentSchema,
  methodEvidenceSchema,
  methodFactsRefSchema,
  METHOD_PROFILE,
} from './schemas.ts';
import { methodEvidenceRefSchema } from './evidence_contract.ts';
import { hasOnlyUnicodeScalars } from './owner_json.ts';

export const API_SCHEMA = 'lca.study-api.v6' as const;
export const CONTRACT_VERSION = '6.0.0' as const;
export const REPORT_TEMPLATE = 'lca.study-method-report.v1' as const;
export const contentRefSchema = artifactRefSchema.extend({
  type: z.literal('reportContent'),
  mediaType: z.literal('application/json'),
  schemaVersion: z.literal('lca.study-method-report-content.v1'),
  byteSize: z.number().int().min(1).max(4194304),
});
export const projectionRefSchema = artifactRefSchema.extend({
  type: z.literal('reportProjection'),
  mediaType: z.literal('application/json'),
  schemaVersion: z.literal('lca.study-report-view.v3'),
  byteSize: z.number().int().min(1).max(2000000),
});
export const manifestRefSchema = artifactRefSchema.extend({
  type: z.literal('renderResources'),
  mediaType: z.literal('application/json'),
  schemaVersion: z.literal('lca.study-export-manifest.v4'),
  byteSize: z.number().int().min(1).max(4194304),
});
export const bundleRefSchema = artifactRefSchema.extend({
  type: z.literal('reportExportBundle'),
  mediaType: z.literal('application/json'),
  schemaVersion: z.literal('lca.study-export-bundle.v4'),
  byteSize: z.number().int().min(1).max(4194304),
});
export const publicArtifactRefSchema = z.union([
  methodFactsRefSchema,
  methodEvidenceRefSchema,
  contentRefSchema,
  artifactRefSchema.extend({
    type: z.literal('modelInput'),
    mediaType: z.literal('application/json'),
    schemaVersion: z.literal('lca.study-prepared-input.v1'),
    byteSize: z.number().int().min(1).max(4194304),
  }),
  artifactRefSchema.extend({
    type: z.literal('runResult'),
    mediaType: z.literal('application/json'),
    schemaVersion: z.literal('lca.study-result.v1'),
    byteSize: z.number().int().min(1).max(4194304),
  }),
]);
export const methodReportArtifactRefSchema = z.union([
  publicArtifactRefSchema,
  projectionRefSchema,
  manifestRefSchema,
  bundleRefSchema,
]);
export const assessmentSchema = methodAssessmentSchema.superRefine((value, ctx) => {
  if ((value.execution.status === 'completed') !== (value.factsRef !== null))
    ctx.addIssue({ code: 'custom', message: 'exact completed method facts required' });
});
const plain = (max: number) =>
  text(max).refine(
    (v) => !/[<>]/u.test(v) && !/(?:https?|javascript|data|file|blob):/iu.test(v),
    'plain report text required',
  );
export const reportContentSchema = z
  .object({
    ...previousDraft.shape,
    schemaVersion: z.literal('lca.study-method-report-draft.v1'),
    claims: z
      .array(
        z
          .object({
            claimId: idSchema,
            bundleRef: methodFactsRefSchema,
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
  .superRefine((value, ctx) => {
    if (!hasOnlyUnicodeScalars(value)) {
      ctx.addIssue({ code: 'custom', message: 'Unicode scalar authored content required' });
      return;
    }
    const claims = new Set(value.claims.map((c) => c.claimId));
    if (claims.size !== value.claims.length)
      ctx.addIssue({ code: 'custom', message: 'unique method claims required' });
    for (const rows of [value.sections, value.tables, value.charts])
      for (const row of rows)
        if (
          new Set(row.claimIds).size !== row.claimIds.length ||
          row.claimIds.some((id) => !claims.has(id))
        )
          ctx.addIssue({ code: 'custom', message: 'exact method claim selections required' });
    for (const ids of [
      value.sections.map((v) => v.sectionId),
      value.tables.map((v) => v.tableId),
      value.charts.map((v) => v.chartId),
    ])
      if (new Set(ids).size !== ids.length)
        ctx.addIssue({ code: 'custom', message: 'unique method presentation IDs required' });
  });
export const reportRevisionSchema = previousReport
  .omit({ analysisIds: true })
  .extend({
    templateId: z.literal(REPORT_TEMPLATE),
    runIds: z.array(uuidSchema).length(1),
    methodAssessmentIds: z.array(uuidSchema).length(1),
    factsRefs: z.array(methodFactsRefSchema).length(1),
    contentRef: contentRefSchema,
  })
  .superRefine((value, ctx) => {
    if (value.contentRef.contentHash !== value.contentHash)
      ctx.addIssue({ code: 'custom', message: 'exact stored method content byte hash required' });
  });
export const envelope = { schemaVersion: z.literal(API_SCHEMA), requestId: idSchema };
export const write = { ...envelope, idempotencyKey: idSchema };
const resource = z.object({ type: z.literal('methodAssessment'), id: uuidSchema }).strict();
export const evidenceCreateSchema = z
  .object({
    ...write,
    operation: z.literal('method.evidence.create'),
    studyId: uuidSchema,
    content: methodEvidenceSchema,
  })
  .strict();
export const reportCreateSchema = z
  .object({
    ...write,
    operation: z.literal('report.create'),
    studyId: uuidSchema,
    parentReportRevisionId: uuidSchema.nullable(),
    runIds: z.array(uuidSchema).length(1),
    methodAssessmentIds: z.array(uuidSchema).length(1),
    templateId: z.literal(REPORT_TEMPLATE),
    content: reportContentSchema,
  })
  .strict();
export const reportSaveSchema = z
  .object({
    ...write,
    operation: z.literal('report.save'),
    target: target('reportRevision').extend({ id: uuidSchema }),
    content: reportContentSchema,
  })
  .strict();
export const reportFreezeSchema = z
  .object({
    ...write,
    operation: z.literal('report.freeze'),
    target: target('reportRevision').extend({ id: uuidSchema }),
    expectedContentHash: hashSchema,
  })
  .strict();
export const reportCommandSchema = z.discriminatedUnion('operation', [
  reportCreateSchema,
  reportSaveSchema,
  reportFreezeSchema,
]);
const variants = [
  z.object({ ...envelope, operation: z.literal('capability.read') }).strict(),
  z
    .object({
      ...write,
      operation: z.literal('method.assessment.request'),
      studyId: uuidSchema,
      profileId: z.literal(METHOD_PROFILE),
      config: methodConfigSchema,
      configHash: hashSchema,
    })
    .strict(),
  z
    .object({
      ...envelope,
      operation: z.literal('method.assessment.read'),
      assessmentId: uuidSchema,
    })
    .strict(),
  evidenceCreateSchema,
  z
    .object({ ...envelope, operation: z.literal('method.evidence.read'), evidenceId: uuidSchema })
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
      kind: z.enum(['methodAssessment', 'reportRevision']),
      limit: z.number().int().min(1).max(100),
      cursor: cursorSchema,
    })
    .strict(),
  z
    .object({
      ...envelope,
      operation: z.literal('artifact.read'),
      studyId: uuidSchema,
      artifactRef: publicArtifactRefSchema,
    })
    .strict(),
  z.object({ ...envelope, operation: z.literal('resource.actions'), resource }).strict(),
  reportCreateSchema,
  reportSaveSchema,
  reportFreezeSchema,
  z
    .object({ ...envelope, operation: z.literal('report.read'), reportRevisionId: uuidSchema })
    .strict(),
] as const;
export const requestSchema = z.discriminatedUnion('operation', variants);
export type MethodAuthoringRequest = z.infer<typeof requestSchema>;
export const AUTHORING_OPERATIONS = variants.map((v) => v.shape.operation.value);
export const HISTORICAL_OPERATIONS = [
  'capability.read',
  'method.assessment.read',
  'method.evidence.read',
  'task.read',
  'task.cancel',
  'study.resources.list',
  'artifact.read',
  'resource.actions',
  'report.read',
] as const;
export const limitsSchema = z
  .object({
    maxEvidenceRefs: z.number().int().min(0).max(128),
    maxSelectedFactorRecords: z.number().int().min(0).max(8192),
    maxFactsBytes: z.literal(4194304),
    maxProjectionBytes: z.literal(2000000),
  })
  .strict();
export const capabilitiesSchema = z
  .object({
    type: z.literal('capabilities'),
    contractVersion: z.literal(CONTRACT_VERSION),
    runtimeEnabled: z.boolean(),
    operations: z
      .array(
        z.enum(
          AUTHORING_OPERATIONS as [
            (typeof AUTHORING_OPERATIONS)[number],
            ...(typeof AUTHORING_OPERATIONS)[number][],
          ],
        ),
      )
      .min(1)
      .max(AUTHORING_OPERATIONS.length),
    methodProfiles: z.array(z.literal(METHOD_PROFILE)).max(1),
    reportTemplates: z.array(z.literal(REPORT_TEMPLATE)).max(1),
    limits: limitsSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      !value.operations.includes('capability.read') ||
      new Set(value.operations).size !== value.operations.length ||
      (!value.runtimeEnabled &&
        (value.operations.some(
          (op) => !(HISTORICAL_OPERATIONS as readonly string[]).includes(op),
        ) ||
          value.methodProfiles.length !== 0 ||
          value.reportTemplates.length !== 0)) ||
      (value.methodProfiles.length > 0 && value.limits.maxSelectedFactorRecords === 0)
    )
      ctx.addIssue({ code: 'custom', message: 'explicit qualified method admission required' });
  });
export type MethodAuthoringCapabilities = z.infer<typeof capabilitiesSchema>;
export const DISABLED_CAPABILITIES: MethodAuthoringCapabilities = {
  type: 'capabilities',
  contractVersion: CONTRACT_VERSION,
  runtimeEnabled: false,
  operations: ['capability.read'],
  methodProfiles: [],
  reportTemplates: [],
  limits: {
    maxEvidenceRefs: 0,
    maxSelectedFactorRecords: 0,
    maxFactsBytes: 4194304,
    maxProjectionBytes: 2000000,
  },
};
export const sameMethodJson = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
