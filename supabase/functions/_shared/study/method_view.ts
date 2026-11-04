import type { MethodStoredContent, MethodReportInput } from './method_producer.ts';
import type { MethodRenderer } from './method_renderer.ts';
import type { ReportView } from '../../../../contracts/lca-study/v6/view.ts';
import { canonicalBytes, sha256 } from '../../../../contracts/lca-study/v3/canonical.ts';
import { StudyFailure } from './protocol.ts';

/** Closed report projection, not raw source/Storage or a numerical calculation. */
export async function makeMethodView(
  content: MethodStoredContent,
  input: MethodReportInput,
  renderer: MethodRenderer,
): Promise<ReportView> {
  const c = input.context,
    row = c.runs[0],
    definition = row.revision.definition,
    source = input.prepared;
  const methods = definition.methodRefs.map((m) => {
    const axis = source.numeric.methodAxes.find(
      (axis) => axis.id === m.id && axis.version === m.version,
    );
    if (!axis) throw new StudyFailure('REFERENCE_MISMATCH', 409, 'method.view_method_axis');
    return {
      id: m.id,
      version: m.version,
      name:
        input.facts.categories.find(
          (category) => category.methodRef.id === m.id && category.methodRef.version === m.version,
        )?.name ?? m.id,
      unit: axis.unit,
    };
  });
  const citations: ReportView['citations'] = source.model.sourceDocuments.map((document, i) => ({
    citationId: `source-${i + 1}`,
    label: `${document.kind} ${document.identity.id}`,
    sourceType: 'datasetRevision',
    identity: `${document.kind}:${document.identity.id}`,
    version: document.identity.version,
    contentHash: document.sha256,
  }));
  citations.push({
    citationId: 'method-source',
    label: 'Frozen method source identity',
    sourceType: 'document',
    identity: source.methodSourceHash,
    version: source.profileId,
    contentHash: source.methodSourceHash,
  });
  const view = {
    schemaVersion: 'lca.study-report-view.v3',
    rendererVersion: '3.0.0',
    report: {
      studyId: c.studyId,
      reportRevisionId: c.reportRevisionId,
      contentHash: await sha256(canonicalBytes(content)),
      title: content.content.title,
      generatedAt: c.generatedAt,
    },
    definition: {
      goal: definition.goal,
      functionalUnit: definition.functionalUnit,
      boundary: definition.systemBoundary,
      methodRefs: methods,
    },
    runs: [
      {
        runId: row.run.runId,
        scenarioRevisionId: row.run.scenarioRevisionId,
        label: 'Frozen baseline Run',
        inputHash: row.run.inputHash,
        profileId: row.run.profileId,
        calculationContractRef: row.run.calculationContractRef,
      },
    ],
    facts: content.claims.map((claim) => ({
      factId: claim.claimId,
      label: `${claim.fact.context.kind}: ${claim.fact.methodRef?.id ?? 'candidate single score'}`,
      runIds: [claim.fact.baselineRunId],
      methodRef: claim.fact.methodRef,
      canonicalValue: claim.fact.canonicalValue,
      unit: claim.fact.unit,
      coverage: claim.fact.coverage,
      reasonCodes: claim.fact.reasonCodes,
      provenance: {
        type: 'methodAssessmentFacts',
        id: claim.bundleRef.id,
        contentHash: claim.bundleRef.contentHash,
        sourceFactId: claim.fact.factId,
      },
    })),
    sections: content.content.sections.map((section) => ({
      sectionId: section.sectionId,
      title: section.title,
      paragraphs: section.paragraphs,
      factIds: section.claimIds,
      citationIds: [],
    })),
    tables: content.content.tables.map((table) => ({
      tableId: table.tableId,
      title: table.title,
      factIds: table.claimIds,
    })),
    charts: content.content.charts.map((chart) => ({
      chartId: chart.chartId,
      title: chart.title,
      factIds: chart.claimIds,
    })),
    citations,
    assumptions: definition.assumptions.map((a) => `${a.statement} (evidence ${a.evidenceRef})`),
    cutoffs: source.model.cutoffs.map(
      (cutoff) => `${cutoff.port.instanceId}/${cutoff.port.exchangeId}: ${cutoff.reason}`,
    ),
    limitations: [
      'Method source identities and bounded machine checks are not professional approval, PEF conformity, scientific ranking or business suitability.',
      'Author narrative is unverified; all mandatory method evidence, states and the complete catalog are supplied independently of authored sections.',
      ...content.content.additionalLimitations,
    ],
    snapshot: {
      validity: c.report?.validitySnapshot.status ?? row.run.validity.status,
      checkedAt: c.report?.validitySnapshot.checkedAt ?? row.run.validity.checkedAt,
      review: 'unreviewed',
      reviewIds: [],
      finalization: 'not_finalized',
    },
    methodAssessment: content.methodAssessment,
  };
  return renderer.validate(view);
}
