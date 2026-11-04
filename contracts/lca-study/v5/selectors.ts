import type { AdvancedFacts } from '../worker/analysis-facts.v2.d.ts';
import { canonicalJson } from '../v3/canonical.ts';
type Fact = AdvancedFacts['factCatalog'][number];
type Context = Fact['context'];
type Identity = Fact['unitIdentity'];
/** Copy exact producer fields into selectors; no scientific arithmetic or string regeneration. */
export function assertFactSelectors(a: AdvancedFacts): void {
  const expected: Fact[] = [];
  const direction = (v: string): 'Input' | 'Output' => {
    if (v !== 'Input' && v !== 'Output') throw new Error('advanced_selector_direction');
    return v;
  };
  const scalar = (
    factId: string,
    context: Context,
    methodRef: Fact['methodRef'],
    canonicalValue: string | null,
    unit: string,
    unitIdentity: Identity,
    coverage: Fact['coverage'],
    relative = false,
  ) =>
    expected.push({
      factId,
      baselineRunId: a.baseline.runId,
      context,
      methodRef,
      canonicalValue,
      unit,
      unitIdentity,
      coverage,
      reasonCodes:
        canonicalValue === null
          ? [
              relative && coverage !== 'unknown'
                ? 'zero_baseline_relative_undefined'
                : 'no_characterized_terms',
            ]
          : [],
    });
  const methodUnit = (methodRef: NonNullable<Fact['methodRef']>, unit: string): Identity => ({
    kind: 'methodQuantity',
    methodRef,
    unit,
  });
  for (const [i, p] of a.config.parameters.entries()) {
    const r = a.resolvedParameters[i],
      identity: Identity = {
        kind: 'exchangeAmount',
        parameterIndex: i,
        flow: r.flow,
        direction: direction(r.direction),
        unit: r.unit,
        support: r.support,
      };
    for (const role of ['baseline', 'low', 'high'] as const)
      scalar(
        `parameter:${i}:${role}`,
        { kind: 'parameterAmount', parameterIndex: i, role },
        null,
        role === 'baseline' ? p.baselineAmount : p[role],
        r.unit,
        identity,
        'complete',
      );
  }
  for (const [i, b] of a.baselineEvaluation.outputs.entries())
    scalar(
      `baseline:method:${i}`,
      { kind: 'baselineOutput', methodIndex: i },
      b.methodRef,
      b.canonicalValue,
      b.unit,
      methodUnit(b.methodRef, b.unit),
      b.coverage,
    );
  if (a.config.kind === 'sensitivityOat') {
    if (
      a.evaluations.length !== 2 * a.config.parameters.length ||
      a.oatEffects.length !== a.config.parameters.length * a.baselineEvaluation.outputs.length ||
      a.statistics.length !== 0
    )
      throw new Error('advanced_selector_shape');
    for (const [pi, p] of a.resolvedParameters.entries())
      for (const [mi, b] of a.baselineEvaluation.outputs.entries()) {
        const e = a.oatEffects[pi * a.baselineEvaluation.outputs.length + mi];
        if (
          e.parameterIndex !== pi ||
          canonicalJson(e.methodRef) !== canonicalJson(b.methodRef) ||
          e.outputUnit !== b.unit ||
          e.inputUnit !== p.unit ||
          e.coverage !== b.coverage ||
          e.lowEvaluationId !== a.evaluations[2 * pi].evaluationId ||
          e.highEvaluationId !== a.evaluations[2 * pi + 1].evaluationId
        )
          throw new Error('advanced_selector_effect');
        for (const [offset, endpoint] of ['low', 'high'].entries()) {
          const ev = a.evaluations[2 * pi + offset],
            ctx = {
              parameterIndex: pi,
              methodIndex: mi,
              endpoint: endpoint as 'low' | 'high',
              evaluationId: ev.evaluationId,
            };
          if (
            ev.outputs.length !== a.baselineEvaluation.outputs.length ||
            ev.parameterIndex !== pi ||
            ev.kind !== endpoint ||
            canonicalJson(ev.outputs[mi].methodRef) !== canonicalJson(b.methodRef) ||
            ev.outputs[mi].unit !== b.unit
          )
            throw new Error('advanced_selector_evaluation');
          const assignments = a.config.parameters.map((p, i) =>
            i === pi ? p[endpoint as 'low' | 'high'] : p.baselineAmount,
          );
          if (
            canonicalJson(ev.amounts) !== canonicalJson(assignments) ||
            ev.empiricalRowIndex !== null
          )
            throw new Error('advanced_selector_assignments');
          scalar(
            `oat:parameter:${pi}:${endpoint}:output:method:${mi}`,
            { kind: 'oatOutput', ...ctx },
            b.methodRef,
            ev.outputs[mi].canonicalValue,
            b.unit,
            methodUnit(b.methodRef, b.unit),
            b.coverage,
          );
          scalar(
            `oat:parameter:${pi}:${endpoint}:absoluteDelta:method:${mi}`,
            { kind: 'oatAbsoluteDelta', ...ctx },
            b.methodRef,
            endpoint === 'low' ? e.lowAbsoluteDelta : e.highAbsoluteDelta,
            b.unit,
            methodUnit(b.methodRef, b.unit),
            b.coverage,
          );
          scalar(
            `oat:parameter:${pi}:${endpoint}:relativeDelta:method:${mi}`,
            { kind: 'oatRelativeDelta', ...ctx },
            b.methodRef,
            endpoint === 'low' ? e.lowRelativeDelta : e.highRelativeDelta,
            '1',
            { kind: 'dimensionless', unit: '1' },
            b.coverage,
            true,
          );
        }
        scalar(
          `oat:parameter:${pi}:secant:method:${mi}`,
          {
            kind: 'oatSecant',
            parameterIndex: pi,
            methodIndex: mi,
            lowEvaluationId: e.lowEvaluationId,
            highEvaluationId: e.highEvaluationId,
          },
          b.methodRef,
          e.secant,
          `(${b.unit})/(${p.unit})`,
          {
            kind: 'secant',
            numerator: { methodRef: b.methodRef, unit: b.unit },
            denominator: {
              parameterIndex: pi,
              flow: p.flow,
              direction: direction(p.direction),
              unit: p.unit,
              support: p.support,
            },
          },
          b.coverage,
        );
      }
  } else {
    if (
      a.statistics.length !== a.baselineEvaluation.outputs.length ||
      a.oatEffects.length !== 0 ||
      a.evaluations.length !== a.config.sampleCount
    )
      throw new Error('advanced_selector_shape');
    for (const [i, ev] of a.evaluations.entries()) {
      if (
        ev.evaluationId !== `evaluation-${i}` ||
        ev.kind !== 'sample' ||
        ev.parameterIndex !== null ||
        ev.amounts.length !== a.config.parameters.length ||
        ev.amounts.some(
          (v, j) =>
            !Number.isFinite(Number(v)) ||
            Number(v) < Number(a.config.parameters[j].low) ||
            Number(v) > Number(a.config.parameters[j].high),
        )
      )
        throw new Error('advanced_selector_sample');
      if (a.config.design.kind === 'jointEmpirical') {
        if (
          ev.empiricalRowIndex === null ||
          !a.config.design.rows[ev.empiricalRowIndex] ||
          canonicalJson(ev.amounts) !== canonicalJson(a.config.design.rows[ev.empiricalRowIndex])
        )
          throw new Error('advanced_selector_empirical');
      } else if (ev.empiricalRowIndex !== null) throw new Error('advanced_selector_uniform');
    }
    for (const [i, s] of a.statistics.entries()) {
      const b = a.baselineEvaluation.outputs[i];
      if (
        canonicalJson(s.methodRef) !== canonicalJson(b.methodRef) ||
        s.unit !== b.unit ||
        s.coverage !== b.coverage
      )
        throw new Error('advanced_selector_statistic');
      for (const statistic of [
        'mean',
        'sampleStandardDeviation',
        'meanMcse',
        'minimum',
        'maximum',
      ] as const)
        scalar(
          `uncertainty:${statistic}:method:${i}`,
          { kind: 'uncertaintyStatistic', methodIndex: i, statistic },
          s.methodRef,
          s[statistic],
          s.unit,
          methodUnit(s.methodRef, s.unit),
          s.coverage,
        );
      if (
        canonicalJson(s.quantiles.map((q) => q.probability)) !==
        canonicalJson(['0.025', '0.5', '0.975'])
      )
        throw new Error('advanced_selector_quantiles');
      for (const q of s.quantiles)
        scalar(
          `uncertainty:quantile:${q.probability}:method:${i}`,
          {
            kind: 'uncertaintyQuantile',
            methodIndex: i,
            probability: q.probability as '0.025' | '0.5' | '0.975',
          },
          s.methodRef,
          q.value,
          s.unit,
          methodUnit(s.methodRef, s.unit),
          s.coverage,
        );
    }
  }
  if (canonicalJson(a.factCatalog) !== canonicalJson(expected))
    throw new Error('advanced_selector_catalog');
  const b = a.baseline,
    e = a.baselineEvaluation;
  if (
    e.evaluationId !== 'baseline' ||
    e.kind !== 'baseline' ||
    e.inputHash !== b.inputHash ||
    e.modelHash !== (b.effectiveModelRef as { contentHash: string }).contentHash ||
    e.preparedSha256 !== b.preparedArtifactRef.contentHash ||
    e.resultSha256 !== b.resultRef.contentHash ||
    canonicalJson(e.amounts) !== canonicalJson(a.config.parameters.map((p) => p.baselineAmount)) ||
    new Set(a.evaluations.map((e) => e.evaluationId)).size !== a.evaluations.length ||
    a.counts.requested !== a.evaluations.length ||
    a.counts.attempted !== a.counts.requested ||
    a.counts.valid !== a.counts.requested ||
    a.counts.invalid !== 0 ||
    a.counts.stopReason !== 'fixed_budget_complete'
  )
    throw new Error('advanced_selector_baseline_counts');
}
