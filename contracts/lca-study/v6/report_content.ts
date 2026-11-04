import { z } from 'zod';
import { hashSchema, idSchema } from '../v1/common.ts';
import { REPORT_TEMPLATE, reportContentSchema, sameMethodJson } from './authoring.ts';
import { methodCatalogFactSchema, methodFactsRefSchema } from './schemas.ts';
import { methodSummarySchema } from './summary.ts';

/** Exact stored artifact family; authored draft and mandatory evidence remain distinct. */
export const methodReportContentSchema = z
  .object({
    schemaVersion: z.literal('lca.study-method-report-content.v1'),
    reportRevisionId: idSchema,
    studyId: idSchema,
    templateId: z.literal(REPORT_TEMPLATE),
    runIds: z.array(idSchema).length(1),
    methodAssessmentIds: z.array(idSchema).length(1),
    factsRefs: z.array(methodFactsRefSchema).length(1),
    factsBindingHash: hashSchema,
    content: reportContentSchema,
    claims: z
      .array(
        reportContentSchema.shape.claims.element.extend({ fact: methodCatalogFactSchema }).strict(),
      )
      .min(1)
      .max(256),
    methodAssessment: methodSummarySchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const summary = value.methodAssessment;
    if (
      summary.studyId !== value.studyId ||
      summary.assessmentId !== value.methodAssessmentIds[0] ||
      summary.baseline.runId !== value.runIds[0] ||
      !sameMethodJson(summary.factsRef, value.factsRefs[0]) ||
      value.claims.length !== value.content.claims.length ||
      value.claims.some((stored, index) => {
        const { fact, ...claim } = stored;
        const original = value.content.claims[index],
          source = summary.factCatalog.find((f) => f.factId === claim.factId);
        return (
          !sameMethodJson(claim, original) ||
          !sameMethodJson(claim.bundleRef, value.factsRefs[0]) ||
          !source ||
          !sameMethodJson(fact, source) ||
          claim.canonicalValue !== source.canonicalValue ||
          claim.unit !== source.unit
        );
      })
    )
      ctx.addIssue({
        code: 'custom',
        message: 'exact stored draft, mandatory evidence and claim identities required',
      });
  });
export type MethodReportContent = z.infer<typeof methodReportContentSchema>;
