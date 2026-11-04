import type { ReportView as ReportViewModel } from '../../../../contracts/lca-study/v5/view.ts';
import type { AdvancedRenderer as ReportingRenderer } from './advanced_renderer.ts';
import type { AdvancedContent, AdvancedReportInput } from './advanced_producer.ts';
import { canonicalJson } from '../../../../contracts/lca-study/v3/canonical.ts';
import type { AdvancedFacts } from '../../../../contracts/lca-study/v5/facts.ts';
import { StudyFailure } from './protocol.ts';

/** A minimal field allowlist; raw source packets, locators and credentials never enter this view. */
export function makeAdvancedView(
  envelope: AdvancedContent,
  input: AdvancedReportInput,
  renderer: ReportingRenderer,
): ReportViewModel {
  const { context, prepared, analyses } = input,
    definition = context.runs[0].revision.definition,
    first = prepared.get(context.runs[0].run.runId)!;
  if (!context.report) throw new StudyFailure('REFERENCE_MISMATCH', 409, 'report.view_context');
  const methods = definition.methodRefs.map((m) => {
    const axis = first.numeric.methodAxes.find((a) => a.id === m.id && a.version === m.version);
    if (!axis) throw new StudyFailure('REFERENCE_MISMATCH', 409, 'report.method_axis');
    return { id: m.id, version: m.version, name: m.id, unit: axis.unit };
  });
  const citations: ReportViewModel['citations'] = [],
    seenSources = new Set<string>(),
    cutoffs: string[] = [],
    limitations: string[] = [
      'Only structured numerical claims are checked against frozen producer facts. Narrative interpretation is unreviewed.',
      'This profile does not establish scientific ranking, business suitability, certification or publication.',
    ];
  for (const row of context.runs) {
    const p = prepared.get(row.run.runId)!;
    for (const source of p.model.sourceDocuments) {
      const key = `${source.kind}:${source.identity.id}:${source.identity.version}:${source.sha256}`;
      if (seenSources.has(key)) continue;
      seenSources.add(key);
      citations.push({
        citationId: `source-${citations.length + 1}`,
        label: `${source.kind} ${source.identity.id}`,
        sourceType: 'datasetRevision',
        identity: `${source.kind}:${source.identity.id}`,
        version: source.identity.version,
        contentHash: source.sha256,
      });
    }
    const key = `method-source:${p.methodSourceHash}`;
    if (!seenSources.has(key)) {
      seenSources.add(key);
      citations.push({
        citationId: `source-${citations.length + 1}`,
        label: 'Frozen characterization source',
        sourceType: 'document',
        identity: p.methodSourceHash,
        version: p.profileId,
        contentHash: p.methodSourceHash,
      });
    }
    for (const cutoff of p.model.cutoffs)
      cutoffs.push(`${cutoff.port.instanceId}/${cutoff.port.exchangeId}: ${cutoff.reason}`);
    for (const finding of p.model.qualityFindings)
      limitations.push(`Run ${row.run.runId}: ${finding}`);
  }
  const evidence: ReportViewModel['sections'] = [];
  for (const a of analyses.values()) {
    limitations.push(...a.limitations.map((x) => `Analysis ${a.analysisId}: ${x}`));
    limitations.push(
      `Analysis ${a.analysisId}: derived evaluations are analysis evidence bound to baseline Run ${a.baseline.runId}. Characterization coverage does not establish sampling convergence or scientific validity.`,
    );
    const metadata = {
      analysisId: a.analysisId,
      profileId: a.profileId,
      producerVersion: a.producerVersion,
      configHash: a.configHash,
      config: a.config,
      executionLimits: a.executionLimits,
      baseline: a.baseline,
      sourceSnapshotRef: a.sourceSnapshotRef,
      resolvedParameters: a.resolvedParameters,
      counts: a.counts,
      qualityFindings: a.qualityFindings,
      coverageGaps: a.coverageGaps,
      limitations: a.limitations,
    };
    const text = canonicalJson(metadata),
      paragraphs: string[] = [
        'The values below are frozen analysis evidence. Evaluations have local identities and are not additional Runs. Coverage describes characterization completeness; it does not assess scientific validity or sampling precision.',
        a.config.kind === 'sensitivityOat'
          ? 'One-at-a-time design evaluates low then high for each ordered parameter while other effective amounts retain the baseline. Absolute delta is endpoint minus baseline; relative delta divides by the absolute baseline and is undefined for a zero or unknown baseline. The secant divides high-minus-low output by high-minus-low parameter amount; it is range dependent and does not measure a local derivative, interactions or global sensitivity.'
          : 'A fixed sample budget is not convergence, a confidence interval or a claim of tail precision. Statistics exclude baseline replay. Mean and M2 use sequential Welford updates in sample order; sample standard deviation uses N-1 and mean MCSE is SD/sqrt(N). Min/max are sample extrema. Quantiles at 0.025, 0.5 and 0.975 use Hyndman-Fan type 7 interpolation without fuzz correction.',
        a.config.kind === 'uncertainty'
          ? 'Independent-uniform design requires the declared independence assumption. Joint-empirical design samples whole supplied equal-weight rows with replacement, preserving their declared dependence. The configured HMAC_DRBG SHA-256 version and seed specify reproducibility, not a security or entropy guarantee. Invalid evaluations abort the entire analysis; no successful conditional subset, redraw or silent discard is issued.'
          : 'Declared ranges are caller assumptions rather than acquired source uncertainty. Invalid endpoints abort the entire analysis. The profile does not establish scientific ranking or recommend materials or processes.',
      ];
    for (let i = 0; i < text.length; i += 2000) paragraphs.push(text.slice(i, i + 2000));
    evidence.push({
      sectionId: `advanced-${a.analysisId}`,
      title: `Analysis settings and frozen provenance: ${a.profileId}`,
      paragraphs,
      factIds: [],
      citationIds: [],
    });
  }
  const tables = envelope.content.tables.map((t) => ({
    tableId: t.tableId,
    title: t.title,
    factIds: t.claimIds,
  }));
  const view = {
    schemaVersion: 'lca.study-report-view.v2',
    rendererVersion: '2.0.0',
    report: {
      studyId: context.studyId,
      reportRevisionId: context.reportRevisionId,
      contentHash: context.report.contentHash,
      title: envelope.content.title,
      generatedAt: context.generatedAt,
    },
    definition: {
      goal: definition.goal,
      functionalUnit: definition.functionalUnit,
      boundary: definition.systemBoundary,
      methodRefs: methods,
    },
    runs: context.runs.map((r, i) => ({
      runId: r.run.runId,
      scenarioRevisionId: r.run.scenarioRevisionId,
      label: `Run ${i + 1}`,
      inputHash: r.run.inputHash,
      profileId: r.run.profileId,
      calculationContractRef: r.run.calculationContractRef,
    })),
    facts: envelope.claims.map((c) => ({
      factId: c.claimId,
      label: factLabel(c.fact, analyses),
      runIds: [c.fact.baselineRunId],
      methodRef: c.fact.methodRef,
      canonicalValue: c.fact.canonicalValue,
      unit: c.fact.unit,
      coverage: c.fact.coverage,
      reasonCodes: c.fact.reasonCodes,
      provenance: {
        type: 'analysisFacts',
        id: c.bundleRef.id,
        contentHash: c.bundleRef.contentHash,
      },
    })),
    sections: [
      ...evidence,
      ...envelope.content.sections.map((s) => ({
        sectionId: s.sectionId,
        title: s.title,
        paragraphs: s.paragraphs,
        factIds: s.claimIds,
        citationIds: [],
      })),
    ],
    tables,
    charts: envelope.content.charts.map((c) => ({
      chartId: c.chartId,
      title: c.title,
      factIds: c.claimIds,
    })),
    citations,
    assumptions: definition.assumptions.map((a) => `${a.statement} (evidence ${a.evidenceRef})`),
    cutoffs: [...new Set(cutoffs)],
    limitations: [...new Set([...limitations, ...envelope.content.additionalLimitations])],
    snapshot: {
      validity: context.report.validitySnapshot.status,
      checkedAt: context.report.validitySnapshot.checkedAt,
      review: 'unreviewed',
      reviewIds: [],
      finalization: 'not_finalized',
    },
  };
  return renderer.validate(view);
}

function factLabel(
  fact: AdvancedFacts['factCatalog'][number],
  analyses: Map<string, AdvancedFacts>,
): string {
  const source = [...analyses.values()].find((a) => a.factCatalog.includes(fact));
  if (!source) throw new StudyFailure('REFERENCE_MISMATCH', 409, 'advanced.fact_label');
  const c = fact.context,
    parameter = 'parameterIndex' in c ? source.resolvedParameters[c.parameterIndex] : null;
  return `${fact.factId}${parameter ? ` · ${parameter.path}` : ''} · ${canonicalJson(c)}${fact.reasonCodes.length ? ` · ${fact.reasonCodes.join(', ')}` : ''}`;
}
