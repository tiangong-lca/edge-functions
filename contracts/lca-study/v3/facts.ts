import { z } from 'zod';
import schema from '../worker/analysis-facts.v1.schema.json' with { type: 'json' };
import type { AnalysisFacts } from '../worker/analysis-facts.v1.d.ts';
import { decimalSchema } from './report.ts';
export type { AnalysisFacts };

/** Generated owner schema is consumed unchanged. Parsing does not establish producer issuance. */
const factsSchema = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
export function parseAnalysisFacts(input: unknown): AnalysisFacts {
  const parsed = factsSchema.parse(input) as AnalysisFacts;
  if (
    new Set(parsed.facts.map((f) => f.factId)).size !== parsed.facts.length ||
    new Set(parsed.inputs.map((i) => i.runId)).size !== parsed.inputs.length ||
    parsed.facts.some(
      (f) =>
        f.runIds.some((id) => !parsed.config.runIds.includes(id)) ||
        (f.canonicalValue !== null &&
          (!decimalSchema.safeParse(f.canonicalValue).success ||
            !Number.isFinite(Number(f.canonicalValue)) ||
            (Number(f.canonicalValue) === 0 && f.canonicalValue !== '0'))),
    )
  )
    throw new Error('analysis_facts_binding');
  return parsed;
}
