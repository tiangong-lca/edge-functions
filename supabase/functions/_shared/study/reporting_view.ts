import { renderReport, validateReportView } from './vendor/renderer/index.js';
import type { ReportViewModel, RenderContext } from './vendor/renderer/viewModel.d.ts';
import consumption from './vendor/renderer/consumption.json' with { type: 'json' };
import type { ReportContentEnvelope, ReportProducerInput } from './reporting_producer.ts';
import { StudyFailure } from './protocol.ts';

export interface ReportingRenderer {
  artifactHash: string;
  qualifiedSource: boolean;
  validate(value: unknown): ReportViewModel;
  render(value: unknown, context: RenderContext): Promise<string>;
}
export const bundledReportingRenderer: ReportingRenderer = {
  artifactHash: consumption.archiveSha256,
  qualifiedSource: !consumption.sourceDirty,
  validate: validateReportView,
  render: renderReport,
};
export type { ReportViewModel, RenderContext };

/** A minimal field allowlist; raw source packets, locators and credentials never enter this view. */
export function makeReportView(
  envelope: ReportContentEnvelope,
  input: ReportProducerInput,
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
  for (const a of analyses.values()) {
    limitations.push(
      `Analysis ${a.analysisId}: comparability ${a.comparability.status}; scope ${a.comparability.scope}; scientific ranking is not qualified.`,
    );
    for (const reason of a.comparability.reasonCodes)
      limitations.push(`Analysis ${a.analysisId}: ${reason}`);
    for (const coverage of a.coverage) {
      const p = prepared.get(coverage.runId);
      if (!p) throw new StudyFailure('REFERENCE_MISMATCH', 409, 'report.coverage_run');
      for (const gap of coverage.gaps) {
        const axis = p.numeric.inventoryAxes[gap.inventoryIndex];
        if (!axis) throw new StudyFailure('REFERENCE_MISMATCH', 409, 'report.coverage_axis');
        limitations.push(
          `Run ${coverage.runId}: no factor for ${axis.flow.id}@${axis.flow.version} (${axis.direction}), method ${gap.method.id}@${gap.method.version}. This term is unknown, not zero.`,
        );
      }
    }
  }
  const tables = envelope.content.tables.map((t) => ({
    tableId: t.tableId,
    title: t.title,
    factIds: t.claimIds,
  }));
  const view = {
    schemaVersion: 'lca.study-report-view.v1',
    rendererVersion: '1.0.0',
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
      label: c.fact.label,
      runIds: c.fact.runIds,
      methodRef: c.fact.methodRef,
      canonicalValue: c.fact.canonicalValue,
      unit: c.fact.unit,
      coverage: c.fact.coverage,
      provenance: {
        type: 'analysisFacts',
        id: c.bundleRef.id,
        contentHash: c.bundleRef.contentHash,
      },
    })),
    sections: envelope.content.sections.map((s) => ({
      sectionId: s.sectionId,
      title: s.title,
      paragraphs: s.paragraphs,
      factIds: s.claimIds,
      citationIds: [],
    })),
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
