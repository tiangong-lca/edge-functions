import { z } from 'zod';
import { resolveOwnerSchema, hasOnlyUnicodeScalars, type JsonSchema } from './owner_json.ts';
import {
  assertMethodFactRelations,
  methodFactsRefSchema,
  parseMethodFacts,
  METHOD_FACTS_SCHEMA,
  METHOD_SELECTED_FACTOR_MAX_RECORDS,
  type MethodFacts,
  type MethodFactsRef,
} from './schemas.ts';
import { canonicalBytes, canonicalJson } from '../v3/canonical.ts';

export const METHOD_SUMMARY_SCHEMA = 'lca.study-method-report-summary.v1' as const;
export const METHOD_PROJECTION_MAX_BYTES = 2_000_000;
export const SELECTED_FACTORS_DISPOSITION =
  'complete_selected_factor_records_in_exact_method_facts_artifact' as const;
export type MethodReportSummary = Omit<
  MethodFacts,
  'schemaVersion' | 'methodSourceEvidence' | 'identityKind'
> & {
  schemaVersion: typeof METHOD_SUMMARY_SCHEMA;
  identityKind: 'private_job_metadata_not_an_authorization_receipt';
  sourceFactsSchemaVersion: typeof METHOD_FACTS_SCHEMA;
  factsRef: MethodFactsRef;
  methodSourceEvidence: Omit<MethodFacts['methodSourceEvidence'], 'selectedFactors'> & {
    selectedFactorEvidence: {
      factsRef: MethodFactsRef;
      selectedFactorRecordCount: number;
      embedded: false;
      disposition: typeof SELECTED_FACTORS_DISPOSITION;
    };
  };
};

/** A new Edge-owned schema derives all retained fields from exact owner schemas. */
export function methodSummaryJsonSchema(): JsonSchema {
  const schema = resolveOwnerSchema('study-method-assessment-facts.v1.schema.json');
  const properties = schema.properties as Record<string, JsonSchema>;
  schema.$id = METHOD_SUMMARY_SCHEMA;
  schema.$comment =
    'Derived method report summary, not unchanged Worker facts. Complete selected factors remain in the exact facts artifact; no qualification or authorization is inferred.';
  properties.schemaVersion = { const: METHOD_SUMMARY_SCHEMA };
  properties.sourceFactsSchemaVersion = { const: METHOD_FACTS_SCHEMA };
  properties.factsRef = resolveOwnerSchema(
    'study-method-assessment-facts.v1.schema.json',
    '/$defs/methodFactsRef',
  );
  properties.identityKind = { const: 'private_job_metadata_not_an_authorization_receipt' };
  schema.required = [...(schema.required as string[]), 'sourceFactsSchemaVersion', 'factsRef'];
  const source = properties.methodSourceEvidence;
  const sourceProperties = source.properties as Record<string, JsonSchema>;
  delete sourceProperties.selectedFactors;
  sourceProperties.selectedFactorEvidence = {
    type: 'object',
    additionalProperties: false,
    required: ['factsRef', 'selectedFactorRecordCount', 'embedded', 'disposition'],
    properties: {
      factsRef: properties.factsRef,
      selectedFactorRecordCount: {
        type: 'integer',
        minimum: 0,
        maximum: METHOD_SELECTED_FACTOR_MAX_RECORDS,
      },
      embedded: { const: false },
      disposition: { const: SELECTED_FACTORS_DISPOSITION },
    },
  };
  source.required = (source.required as string[]).map((key) =>
    key === 'selectedFactors' ? 'selectedFactorEvidence' : key,
  );
  return schema;
}
export const methodSummarySchema = z
  .fromJSONSchema(methodSummaryJsonSchema() as Parameters<typeof z.fromJSONSchema>[0])
  .superRefine((raw, ctx) => {
    try {
      const value = raw as MethodReportSummary;
      if (!hasOnlyUnicodeScalars(value)) throw new Error('unicode');
      assertMethodFactRelations(value);
      if (
        canonicalJson(value.factsRef) !==
        canonicalJson(value.methodSourceEvidence.selectedFactorEvidence.factsRef)
      )
        throw new Error('facts_ref');
      if (canonicalBytes(value).length > METHOD_PROJECTION_MAX_BYTES)
        throw new Error('projection_bound');
    } catch {
      ctx.addIssue({ code: 'custom', message: 'exact bounded method summary required' });
    }
  }) as z.ZodType<MethodReportSummary>;

export function parseMethodSummary(input: unknown): MethodReportSummary {
  const parsed = methodSummarySchema.safeParse(input);
  if (!parsed.success) throw new Error('method_summary_invalid');
  return parsed.data;
}

/** Producer projection only. Actual byte/source/current authority is checked by its caller. */
export function makeMethodSummary(
  factsInput: unknown,
  factsRefInput: unknown,
): MethodReportSummary {
  const facts = parseMethodFacts(factsInput);
  const factsRef = methodFactsRefSchema.parse(factsRefInput);
  const { schemaVersion, methodSourceEvidence, ...retained } = facts;
  const { selectedFactors, ...sourceEvidence } = methodSourceEvidence;
  return parseMethodSummary({
    ...retained,
    schemaVersion: METHOD_SUMMARY_SCHEMA,
    sourceFactsSchemaVersion: schemaVersion,
    factsRef,
    methodSourceEvidence: {
      ...sourceEvidence,
      selectedFactorEvidence: {
        factsRef,
        selectedFactorRecordCount: selectedFactors.length,
        embedded: false,
        disposition: SELECTED_FACTORS_DISPOSITION,
      },
    },
  });
}
