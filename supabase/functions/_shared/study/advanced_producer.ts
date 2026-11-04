import { z } from 'zod';
import {
  parseAdvancedFacts,
  type AdvancedFacts,
} from '../../../../contracts/lca-study/v5/facts.ts';
import { analysisConfigHash } from '../../../../contracts/lca-study/v5/codec.ts';
import {
  reportContentSchema,
  REPORT_TEMPLATE,
} from '../../../../contracts/lca-study/v5/advanced.ts';
import {
  canonicalBytes,
  domainBytes,
  sha256,
} from '../../../../contracts/lca-study/v3/canonical.ts';
import { preparedInputSchema } from './validator.ts';
import { sameJson } from './reporting_producer.ts';
import { reportContextSchema, type ReportContext } from './advanced_context.ts';
import { StudyFailure } from './protocol.ts';
export type AdvancedReportInput = {
  context: ReportContext;
  prepared: Map<string, z.infer<typeof preparedInputSchema>>;
  analyses: Map<string, AdvancedFacts>;
};
function fail(rule: string): never {
  throw new StudyFailure('REFERENCE_MISMATCH', 409, rule);
}
export function assertAdvancedContext(
  c: ReportContext,
  request: unknown,
  allowReadProjection = false,
) {
  const semantic = (v: unknown) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    const { requestId: _, ...rest } = v as Record<string, unknown>;
    return rest;
  };
  if (!sameJson(semantic(c.request), semantic(request)) || c.operation !== c.request.operation)
    fail('advanced.intent_request');
  const q = c.request;
  const create = q.operation === 'report.create';
  const runs = create ? q.runIds : c.report?.runIds,
    analyses = create ? q.analysisIds : c.report?.analysisIds;
  if (
    !runs ||
    !analyses ||
    !sameJson(
      runs,
      c.runs.map((r) => r.run.runId),
    ) ||
    !sameJson(
      analyses,
      c.analyses.map((a) => a.analysis.analysisId),
    )
  )
    fail('advanced.intent_inputs');
  if (create) {
    if (
      c.report !== null ||
      c.contentArtifact !== null ||
      q.studyId !== c.studyId ||
      !c.contentArtifactId
    )
      fail('advanced.create_context');
  } else {
    const r = c.report;
    if (
      !r ||
      r.studyId !== c.studyId ||
      r.reportRevisionId !== c.reportRevisionId ||
      !c.contentArtifact ||
      !sameJson(c.contentArtifact.artifactRef, r.contentRef)
    )
      fail('advanced.current_content');
    if (q.operation === 'report.save' || q.operation === 'report.freeze') {
      if (
        r.status !== 'draft' ||
        r.revision !== q.target.expectedRevision ||
        r.reportRevisionId !== q.target.id
      )
        fail('advanced.target');
    } else if (q.operation === 'export.request') {
      if (
        r.status !== 'frozen' ||
        r.reportRevisionId !== q.reportRevisionId ||
        r.contentHash !== q.expectedContentHash ||
        (!allowReadProjection &&
          (!c.exportProfile ||
            !c.disclosureContextHash ||
            !c.exportId ||
            !c.projectionArtifactId ||
            !c.resourcesArtifactId ||
            !c.bundleArtifactId))
      )
        fail('advanced.export_context');
    }
  }
  for (const row of c.runs) {
    const {
      run: r,
      revision: v,
      scenario: s,
      preparation: p,
      preparedArtifact: a,
      resultArtifact: b,
    } = row;
    if (
      [r.studyId, v.studyId, s.studyId, p.studyId, a.studyId, b.studyId].some(
        (id) => id !== c.studyId,
      ) ||
      r.execution.status !== 'completed' ||
      r.validity.status !== 'current' ||
      v.status !== 'frozen' ||
      s.status !== 'frozen' ||
      p.execution.status !== 'completed' ||
      r.studyRevisionId !== v.revisionId ||
      r.scenarioRevisionId !== s.scenarioRevisionId ||
      s.studyRevisionId !== v.revisionId ||
      r.modelPreparationId !== p.preparationId ||
      r.inputHash !== p.inputHash ||
      !sameJson(r.effectiveModelRef, p.modelRef) ||
      !sameJson(r.effectiveModelRef, s.effectiveModelRef) ||
      !sameJson(a.artifactRef, p.inputArtifactRef) ||
      !sameJson(b.artifactRef, r.resultRef) ||
      !sameJson(r.calculationContractRef, p.calculationContractRef)
    )
      fail('advanced.run_bindings');
  }
  for (const row of c.analyses) {
    if (
      row.analysis.studyId !== c.studyId ||
      row.factsArtifact.studyId !== c.studyId ||
      row.analysis.execution.status !== 'completed' ||
      !sameJson(row.analysis.factsRef, row.factsArtifact.artifactRef) ||
      row.analysis.config.baselineRunId !== runs[0]
    )
      fail('advanced.analysis_bindings');
  }
}
export async function validateAdvancedInputs(
  contextInput: unknown,
  bytes: Map<string, Uint8Array>,
  allowReadProjection = false,
): Promise<AdvancedReportInput> {
  const c = reportContextSchema.parse(contextInput);
  assertAdvancedContext(c, c.request, allowReadProjection);
  const prepared: AdvancedReportInput['prepared'] = new Map(),
    analyses: AdvancedReportInput['analyses'] = new Map();
  const read = (id: string) => {
    const b = bytes.get(id);
    if (!b) fail('advanced.missing_artifact');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b));
  };
  const refs = c.analyses.map((a) => a.factsArtifact.artifactRef);
  if ((await sha256(domainBytes('lca.study-report-facts-binding.v1', refs))) !== c.factsBindingHash)
    fail('advanced.facts_identity');
  for (const row of c.runs) {
    const p = preparedInputSchema.parse(read(row.preparedArtifact.artifactRef.id));
    if (
      p.modelHash !== row.run.effectiveModelRef.contentHash ||
      p.inputHash !== row.run.inputHash ||
      p.profileId !== row.run.profileId ||
      !sameJson(p.calculationContractRef, row.run.calculationContractRef) ||
      !p.studyBinding ||
      p.studyBinding.studyRevisionId !== row.revision.revisionId ||
      p.studyBinding.studyRevisionContentHash !== row.revision.contentHash ||
      !sameJson(p.studyBinding.definition, row.revision.definition)
    )
      fail('advanced.prepared_binding');
    prepared.set(row.run.runId, p);
  }
  for (const row of c.analyses) {
    const a = parseAdvancedFacts(read(row.factsArtifact.artifactRef.id)),
      b = a.baseline,
      r = c.runs[0],
      p = prepared.get(r.run.runId)!;
    if (
      !sameJson(a.sourceSnapshotRef, row.sourceSnapshotRef) ||
      a.studyId !== c.studyId ||
      a.analysisId !== row.analysis.analysisId ||
      a.profileId !== row.analysis.profileId ||
      a.configHash !== row.analysis.configHash ||
      (await analysisConfigHash(a.config)) !== a.configHash ||
      !sameJson(a.config, row.analysis.config) ||
      b.runId !== r.run.runId ||
      b.studyRevisionId !== r.revision.revisionId ||
      b.scenarioRevisionId !== r.scenario.scenarioRevisionId ||
      b.modelPreparationId !== r.preparation.preparationId ||
      b.inputHash !== r.run.inputHash ||
      b.methodSourceHash !== p.methodSourceHash ||
      !sameJson(b.effectiveModelRef, r.run.effectiveModelRef) ||
      !sameJson(b.preparedArtifactRef, r.preparedArtifact.artifactRef) ||
      !sameJson(b.resultRef, r.resultArtifact.artifactRef) ||
      !sameJson(b.calculationContractRef, r.run.calculationContractRef)
    )
      fail('advanced.producer_binding');
    if (
      a.baselineEvaluation.outputs.length !== p.numeric.methodAxes.length ||
      a.baselineEvaluation.outputs.some(
        (o, i) =>
          o.methodRef.id !== p.numeric.methodAxes[i].id ||
          o.methodRef.version !== p.numeric.methodAxes[i].version ||
          o.unit !== p.numeric.methodAxes[i].unit,
      ) ||
      !sameJson(a.coverageGaps, p.coverage)
    )
      fail('advanced.method_axis_binding');
    for (const x of a.resolvedParameters) {
      const parts = x.path.split('/'),
        i = p.model.instances.find((i) => i.id === parts[2]),
        e = i?.exchanges.find((e) => e.id === parts[4]);
      if (
        !i ||
        !e ||
        i.referenceExchangeId === e.id ||
        e.amount !== Number(x.baselineAmount) ||
        x.unit !== e.unit ||
        x.direction !== e.direction ||
        !sameJson(x.flow, e.flow) ||
        !sameJson(x.support, e.unitIdentity)
      )
        fail('advanced.parameter_source');
    }
    analyses.set(a.analysisId, a);
  }
  return { context: c, prepared, analyses };
}
export function makeAdvancedContent(input: AdvancedReportInput, raw: unknown) {
  const content = reportContentSchema.parse(raw),
    c = input.context;
  const claims = content.claims.map((claim) => {
    const source = c.analyses.find((a) => sameJson(a.factsArtifact.artifactRef, claim.bundleRef)),
      fact = source
        ? input.analyses
            .get(source.analysis.analysisId)
            ?.factCatalog.find((f) => f.factId === claim.factId)
        : undefined;
    if (
      !source ||
      !fact ||
      fact.canonicalValue !== claim.canonicalValue ||
      fact.unit !== claim.unit
    )
      fail('advanced.claim_binding');
    return { claimId: claim.claimId, bundleRef: claim.bundleRef, fact };
  });
  return {
    schemaVersion: 'lca.study-report-content.v2' as const,
    reportRevisionId: c.reportRevisionId,
    studyId: c.studyId,
    templateId: REPORT_TEMPLATE,
    runIds: c.runs.map((r) => r.run.runId),
    analysisIds: c.analyses.map((a) => a.analysis.analysisId),
    factsRefs: c.analyses.map((a) => a.factsArtifact.artifactRef),
    factsBindingHash: c.factsBindingHash,
    content,
    claims,
  };
}
export type AdvancedContent = ReturnType<typeof makeAdvancedContent>;
export async function advancedContentValidation(e: AdvancedContent) {
  const bytes = canonicalBytes(e),
    contentHash = await sha256(bytes);
  return {
    bytes,
    contentHash,
    validation: {
      schemaVersion: 'lca.study-report-validation.v2',
      profileId: 'lca.study-report-claims.v2',
      reportRevisionId: e.reportRevisionId,
      contentHash,
      claimCount: e.claims.length,
      factsBindingHash: e.factsBindingHash,
    },
  };
}
