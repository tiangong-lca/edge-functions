import { z } from 'zod';
import { reportViewSchema as previousView } from '../v5/view.ts';
import { hashSchema, idSchema } from '../v1/common.ts';
import { canonicalJson } from '../v3/canonical.ts';
import { methodSummarySchema, METHOD_PROJECTION_MAX_BYTES } from './summary.ts';
import { hasOnlyUnicodeScalars } from './owner_json.ts';

const oldFact = previousView.shape.facts.element;
const provenance = z.discriminatedUnion('type', [
  z.object({ type: z.literal('runResult'), id: idSchema, contentHash: hashSchema }).strict(),
  z.object({ type: z.literal('analysisFacts'), id: idSchema, contentHash: hashSchema }).strict(),
  z
    .object({
      type: z.literal('methodAssessmentFacts'),
      id: idSchema,
      contentHash: hashSchema,
      sourceFactId: idSchema,
    })
    .strict(),
]);
/** New view3 structural contract; Platform adds its independently owned display validator. */
export const methodViewSchema = z
  .object({
    ...previousView.shape,
    schemaVersion: z.literal('lca.study-report-view.v3'),
    rendererVersion: z.literal('3.0.0'),
    facts: z.array(oldFact.extend({ provenance })).min(1).max(256),
    methodAssessment: methodSummarySchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      !hasOnlyUnicodeScalars(value) ||
      new TextEncoder().encode(JSON.stringify(value)).length > METHOD_PROJECTION_MAX_BYTES
    )
      ctx.addIssue({ code: 'custom', message: 'bounded Unicode method projection required' });
    const summary = value.methodAssessment;
    const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
    if (
      value.report.studyId !== summary.studyId ||
      value.runs.length !== 1 ||
      value.runs[0].runId !== summary.baseline.runId ||
      value.runs[0].scenarioRevisionId !== summary.baseline.scenarioRevisionId ||
      value.runs[0].inputHash !== summary.baseline.inputHash ||
      !same(value.runs[0].calculationContractRef, summary.baseline.calculationContractRef) ||
      !same(value.definition.functionalUnit, summary.frozenEvidence.functionalUnit) ||
      value.definition.boundary !== summary.frozenEvidence.declaredSystemBoundary
    )
      ctx.addIssue({ code: 'custom', message: 'exact method summary Study/baseline required' });
    for (const fact of value.facts) {
      const provenance = fact.provenance;
      if (provenance.type !== 'methodAssessmentFacts') continue;
      const selected = summary.factCatalog.find((f) => f.factId === provenance.sourceFactId);
      if (
        !selected ||
        fact.provenance.id !== summary.factsRef.id ||
        fact.provenance.contentHash !== summary.factsRef.contentHash ||
        !same(fact.runIds, [summary.baseline.runId]) ||
        !same(fact.methodRef, selected.methodRef) ||
        fact.canonicalValue !== selected.canonicalValue ||
        fact.unit !== selected.unit ||
        fact.coverage !== selected.coverage ||
        !same(fact.reasonCodes, selected.reasonCodes)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'exact method catalog provenance and values required',
        });
    }
  });
export type MethodReportView = z.infer<typeof methodViewSchema>;
export function parseMethodView(input: unknown): MethodReportView {
  try {
    const parsed = methodViewSchema.safeParse(input);
    if (parsed.success) return parsed.data;
  } catch {
    /* Fixed boundary never emits producer/user values or framework diagnostics. */
  }
  throw new Error('method_view_invalid');
}
