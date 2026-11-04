import { z } from 'zod';
// Exact Platform-owned portable validator artifact; no server, I/O or sibling source dependency.
import { validateReportView } from '../../../supabase/functions/_shared/study/vendor/renderer-v2/viewModel.js';
import {
  calculationContractRefSchema,
  datasetVersionSchema,
  hashSchema,
  idSchema,
  text,
  timestampSchema,
} from '../v1/common.ts';
import { decimalSchema } from '../v3/report.ts';
const method = z.object({ id: idSchema, version: datasetVersionSchema }).strict();
const strings = z.array(text(4096)).max(256);
/** Exact Platform view.v2 allowlist. No storage locators or raw producer artifacts. */
export const reportViewSchema = z
  .object({
    schemaVersion: z.literal('lca.study-report-view.v2'),
    rendererVersion: z.literal('2.0.0'),
    report: z
      .object({
        studyId: idSchema,
        reportRevisionId: idSchema,
        contentHash: hashSchema,
        title: text(256),
        generatedAt: timestampSchema,
      })
      .strict(),
    definition: z
      .object({
        goal: text(4096),
        functionalUnit: z
          .object({
            amount: z
              .string()
              .max(64)
              .regex(/^(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)$/u),
            unit: text(128),
            referenceFlowId: idSchema,
          })
          .strict(),
        boundary: text(4096),
        methodRefs: z.array(method.extend({ name: text(256), unit: text(128) })).max(64),
      })
      .strict(),
    runs: z
      .array(
        z
          .object({
            runId: idSchema,
            scenarioRevisionId: idSchema,
            label: text(256),
            inputHash: hashSchema,
            profileId: idSchema,
            calculationContractRef: calculationContractRefSchema,
          })
          .strict(),
      )
      .min(1)
      .max(2),
    facts: z
      .array(
        z
          .object({
            factId: idSchema,
            label: text(512),
            runIds: z.array(idSchema).min(1).max(2),
            methodRef: method.nullable(),
            canonicalValue: decimalSchema.nullable(),
            unit: text(128),
            coverage: z.enum(['complete', 'partial', 'unknown']),
            reasonCodes: z.array(text(128)).max(32),
            provenance: z
              .object({
                type: z.enum(['runResult', 'analysisFacts']),
                id: idSchema,
                contentHash: hashSchema,
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(256),
    sections: z
      .array(
        z
          .object({
            sectionId: idSchema,
            title: text(256),
            paragraphs: z.array(text(2048)).max(32),
            factIds: z.array(idSchema).max(256),
            citationIds: z.array(idSchema).max(256),
          })
          .strict(),
      )
      .max(32),
    tables: z
      .array(
        z
          .object({
            tableId: idSchema,
            title: text(256),
            factIds: z.array(idSchema).min(1).max(256),
          })
          .strict(),
      )
      .max(32),
    charts: z
      .array(
        z
          .object({
            chartId: idSchema,
            title: text(256),
            factIds: z.array(idSchema).min(1).max(64),
          })
          .strict(),
      )
      .max(32),
    citations: z
      .array(
        z
          .object({
            citationId: idSchema,
            label: text(512),
            sourceType: z.enum(['datasetRevision', 'releaseFinalResult', 'document']),
            identity: text(512),
            version: text(128),
            contentHash: hashSchema.nullable(),
          })
          .strict(),
      )
      .max(256),
    assumptions: strings,
    cutoffs: strings,
    limitations: strings,
    snapshot: z
      .object({
        validity: z.enum(['current', 'superseded', 'withdrawn', 'unknown']),
        checkedAt: timestampSchema,
        review: z.enum(['unreviewed', 'reviewed']),
        reviewIds: z.array(idSchema).max(100),
        finalization: z.enum(['not_finalized', 'finalized']),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      validateReportView(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'exact Platform view.v2 required' });
    }
  });
export type ReportView = z.infer<typeof reportViewSchema>;
