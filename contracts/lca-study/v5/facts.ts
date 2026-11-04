import { assertFactSelectors } from './selectors.ts';
import { z } from 'zod';
import owner from '../worker/analysis-facts.v2.schema.json' with { type: 'json' };
import type { AdvancedFacts } from '../worker/analysis-facts.v2.d.ts';
import { parseAnalysisConfig, ANALYSIS_PROFILES } from './advanced.ts';
import { decimalSchema } from '../v3/report.ts';
const schema = z.fromJSONSchema(owner as unknown as Parameters<typeof z.fromJSONSchema>[0]);
export type { AdvancedFacts };
/** The exact issued Worker artifact owns numeric computation; this boundary checks structure and selectors. */
export function parseAdvancedFacts(input: unknown): AdvancedFacts {
  const v = schema.parse(input) as AdvancedFacts;
  const c = parseAnalysisConfig(v.config);
  if (
    v.profileId !== (c.kind === 'sensitivityOat' ? ANALYSIS_PROFILES[0] : ANALYSIS_PROFILES[1]) ||
    v.baseline.runId !== c.baselineRunId ||
    new Set(v.factCatalog.map((f) => f.factId)).size !== v.factCatalog.length ||
    v.resolvedParameters.length !== c.parameters.length ||
    v.resolvedParameters.some(
      (p, i) =>
        p.parameterIndex !== i ||
        p.path !== c.parameters[i].path ||
        p.baselineAmount !== c.parameters[i].baselineAmount ||
        p.unit !== c.parameters[i].unit,
    ) ||
    v.factCatalog.some(
      (f) =>
        f.baselineRunId !== c.baselineRunId ||
        (f.canonicalValue !== null &&
          (!decimalSchema.safeParse(f.canonicalValue).success ||
            !Number.isFinite(Number(f.canonicalValue)) ||
            (Number(f.canonicalValue) === 0 && f.canonicalValue !== '0'))),
    )
  )
    throw new Error('advanced_facts_binding');
  assertFactSelectors(v);
  return v;
}
