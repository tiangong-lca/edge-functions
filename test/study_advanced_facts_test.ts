import { assertEquals, assertThrows } from 'jsr:@std/assert';
import { parseAdvancedFacts } from '../contracts/lca-study/v5/facts.ts';
const root = new URL('./fixtures/lca-study-v5/', import.meta.url);
const load = async (name: string) => JSON.parse(await Deno.readTextFile(new URL(name, root)));
Deno.test(
  'V5 consumes exact native OAT/uniform/empirical catalog selectors and frozen identities',
  async () => {
    for (const name of ['facts-oat.json', 'facts-uniform.json', 'facts-uncertainty.json']) {
      const raw = await load(name),
        facts = parseAdvancedFacts(raw);
      assertEquals(facts, raw);
      assertEquals(
        facts.factCatalog.every((f) => f.baselineRunId === facts.baseline.runId),
        true,
      );
      assertEquals(facts.counts.invalid, 0);
    }
  },
);
Deno.test(
  'V5 rejects transplanted scalar contexts, units, values and baseline evidence',
  async () => {
    const native = await load('facts-oat.json');
    for (const change of [
      'value',
      'unit',
      'unitIdentity',
      'context',
      'duplicate',
      'baseline',
      'count',
      'reference',
    ]) {
      const f = structuredClone(native),
        fact = f.factCatalog.find(
          (x: { context: { kind: string } }) => x.context.kind === 'oatRelativeDelta',
        );
      if (change === 'value') fact.canonicalValue = '100';
      if (change === 'unit') fact.unit = 'impact';
      if (change === 'unitIdentity')
        fact.unitIdentity = { kind: 'methodQuantity', methodRef: fact.methodRef, unit: 'impact' };
      if (change === 'context') fact.context.evaluationId = 'different-evaluation';
      if (change === 'duplicate') f.factCatalog.push(f.factCatalog[0]);
      if (change === 'baseline') f.baselineEvaluation.inputHash = 'a'.repeat(64);
      if (change === 'count') f.counts.valid--;
      if (change === 'reference') f.resolvedParameters[0].path = '/instances/b/exchanges/e/amount';
      assertThrows(() => parseAdvancedFacts(f), Error, undefined, change);
    }
  },
);
Deno.test(
  'V5 statistics selectors cannot claim another quantile, method, or empirical sample count',
  async () => {
    const native = await load('facts-uncertainty.json');
    for (const change of ['quantile', 'method', 'sampleCount', 'notation']) {
      const f = structuredClone(native);
      if (change === 'quantile') f.statistics[0].quantiles[0].probability = '0.05';
      if (change === 'method') f.statistics[0].methodRef.id = 'other';
      if (change === 'sampleCount') f.config.sampleCount++;
      if (change === 'notation') f.factCatalog[0].canonicalValue = '10.0';
      assertThrows(() => parseAdvancedFacts(f), Error, undefined, change);
    }
  },
);
