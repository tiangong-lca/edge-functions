import { z } from 'zod';
import { reportContextSchema, type MethodReportContext } from './method_context.ts';
import { preparedInputSchema } from './validator.ts';
import { sameJson } from './reporting_producer.ts';
import { StudyFailure } from './protocol.ts';
import {
  reportContentSchema,
  REPORT_TEMPLATE,
} from '../../../../contracts/lca-study/v6/authoring.ts';
import {
  parseMethodFacts,
  methodConfigHash,
  type MethodFacts,
  type MethodCatalogFact,
  type MethodFactsRef,
} from '../../../../contracts/lca-study/v6/schemas.ts';
import {
  makeMethodSummary,
  type MethodReportSummary,
} from '../../../../contracts/lca-study/v6/summary.ts';
import {
  canonicalBytes,
  domainBytes,
  sha256,
} from '../../../../contracts/lca-study/v3/canonical.ts';

export type MethodReportInput = {
  context: MethodReportContext;
  prepared: z.infer<typeof preparedInputSchema>;
  facts: MethodFacts;
};
export type MethodStoredContent = {
  schemaVersion: 'lca.study-method-report-content.v1';
  reportRevisionId: string;
  studyId: string;
  templateId: typeof REPORT_TEMPLATE;
  runIds: string[];
  methodAssessmentIds: string[];
  factsRefs: MethodFactsRef[];
  factsBindingHash: string;
  content: z.infer<typeof reportContentSchema>;
  claims: Array<
    z.infer<typeof reportContentSchema>['claims'][number] & { fact: MethodCatalogFact }
  >;
  methodAssessment: MethodReportSummary;
};
function fail(rule: string): never {
  throw new StudyFailure('REFERENCE_MISMATCH', 409, rule);
}
const semantic = (raw: unknown) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const { requestId: _transport, ...rest } = raw as Record<string, unknown>;
  return rest;
};
export function assertMethodReportContext(c: MethodReportContext, request: unknown): void {
  if (c.operation !== c.request.operation || !sameJson(semantic(c.request), semantic(request)))
    fail('method.intent_request');
  const q = c.request,
    create = q.operation === 'report.create',
    run = c.runs[0],
    method = c.methodAssessments[0];
  const runIds = create ? q.runIds : c.report?.runIds,
    methodIds = create ? q.methodAssessmentIds : c.report?.methodAssessmentIds;
  if (
    !runIds ||
    !methodIds ||
    !sameJson(runIds, [run.run.runId]) ||
    !sameJson(methodIds, [method.assessment.assessmentId])
  )
    fail('method.intent_inputs');
  if (create) {
    if (
      c.report !== null ||
      c.contentArtifact !== null ||
      !c.contentArtifactId ||
      q.studyId !== c.studyId
    )
      fail('method.create_context');
  } else {
    const r = c.report;
    if (
      !r ||
      r.studyId !== c.studyId ||
      r.reportRevisionId !== c.reportRevisionId ||
      !c.contentArtifact ||
      !sameJson(c.contentArtifact.artifactRef, r.contentRef)
    )
      fail('method.current_content');
    if (q.operation === 'report.save' || q.operation === 'report.freeze') {
      if (
        r.status !== 'draft' ||
        r.revision !== q.target.expectedRevision ||
        r.reportRevisionId !== q.target.id
      )
        fail('method.report_target');
      if (
        q.operation === 'report.freeze' &&
        (r.contentHash !== q.expectedContentHash || c.contentArtifactId !== null)
      )
        fail('method.freeze_context');
      if (q.operation === 'report.save' && !c.contentArtifactId) fail('method.save_artifact');
    } else if (q.operation === 'report.view' || q.operation === 'export.request') {
      if (
        r.status !== 'frozen' ||
        r.reportRevisionId !== q.reportRevisionId ||
        r.contentHash !== q.expectedContentHash ||
        c.contentArtifactId !== null
      )
        fail('method.frozen_projection_context');
      if (q.operation === 'report.view') {
        if (
          [c.exportId, c.projectionArtifactId, c.resourcesArtifactId, c.bundleArtifactId].some(
            (v) => v !== null,
          )
        )
          fail('method.preview_no_export_allocation');
      } else if (
        !c.exportId ||
        !c.projectionArtifactId ||
        !c.resourcesArtifactId ||
        !c.bundleArtifactId ||
        !c.exportProfile ||
        !c.disclosureContextHash
      )
        fail('method.export_allocations');
    }
  }
  const {
    run: r,
    revision: v,
    scenario: s,
    preparation: p,
    preparedArtifact: a,
    resultArtifact: b,
  } = run;
  if (
    [
      r.studyId,
      v.studyId,
      s.studyId,
      p.studyId,
      a.studyId,
      b.studyId,
      method.assessment.studyId,
      method.factsArtifact.studyId,
    ].some((id) => id !== c.studyId) ||
    r.execution.status !== 'completed' ||
    r.validity.status !== 'current' ||
    v.status !== 'frozen' ||
    s.status !== 'frozen' ||
    p.execution.status !== 'completed' ||
    r.studyRevisionId !== v.revisionId ||
    r.scenarioRevisionId !== s.scenarioRevisionId ||
    s.studyRevisionId !== v.revisionId ||
    r.modelPreparationId !== p.preparationId ||
    s.modelPreparationId !== p.preparationId ||
    r.inputHash !== p.inputHash ||
    !sameJson(r.effectiveModelRef, p.modelRef) ||
    !sameJson(r.effectiveModelRef, s.effectiveModelRef) ||
    !sameJson(a.artifactRef, p.inputArtifactRef) ||
    !sameJson(b.artifactRef, r.resultRef) ||
    !sameJson(r.calculationContractRef, p.calculationContractRef) ||
    method.assessment.execution.status !== 'completed' ||
    !sameJson(method.assessment.factsRef, method.factsArtifact.artifactRef) ||
    method.assessment.config.baselineRunId !== r.runId
  )
    fail('method.baseline_context');
  if (
    p.source.type === 'modelSourceSnapshot' &&
    p.source.contentHash !== method.sourceSnapshotRef.contentHash
  )
    fail('method.source_snapshot_binding');
  const refs = [
    a.artifactRef,
    b.artifactRef,
    method.factsArtifact.artifactRef,
    ...(c.contentArtifact ? [c.contentArtifact.artifactRef] : []),
  ];
  if (new Set(refs.map((ref) => ref.id)).size !== refs.length) fail('method.unique_artifact_roles');
}
export function methodFactsBindingPayload(c: MethodReportContext) {
  const row = c.runs[0],
    r = row.run,
    a = c.methodAssessments[0];
  return {
    studyId: c.studyId,
    runIds: [r.runId],
    methodAssessmentIds: [a.assessment.assessmentId],
    factsRefs: [a.factsArtifact.artifactRef],
    baseline: {
      runId: r.runId,
      studyId: r.studyId,
      studyRevisionId: r.studyRevisionId,
      scenarioRevisionId: r.scenarioRevisionId,
      effectiveModelRef: r.effectiveModelRef,
      inputHash: r.inputHash,
      profileId: r.profileId,
      engineId: r.engineId,
      calculationContractRef: r.calculationContractRef,
      resultRef: r.resultRef,
      preparedArtifactRef: row.preparedArtifact.artifactRef,
      sourceSnapshotRef: a.sourceSnapshotRef,
    },
    assessment: {
      assessmentId: a.assessment.assessmentId,
      profileId: a.assessment.profileId,
      configHash: a.assessment.configHash,
      moduleRef: a.assessment.config.moduleRef,
    },
  };
}
export async function validateMethodReportInputs(
  rawContext: unknown,
  bytes: Map<string, Uint8Array>,
): Promise<MethodReportInput> {
  const c = reportContextSchema.parse(rawContext);
  assertMethodReportContext(c, c.request);
  const read = async (ref: { id: string; byteSize: number; contentHash: string }) => {
    const b = bytes.get(ref.id);
    if (
      !b ||
      b.length !== ref.byteSize ||
      b.length > 4194304 ||
      (await sha256(b)) !== ref.contentHash
    )
      fail('method.artifact_bytes');
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b));
    } catch {
      return fail('method.artifact_json');
    }
  };
  if (
    (await sha256(
      domainBytes('lca.study-method-report-facts-binding.v1', methodFactsBindingPayload(c)),
    )) !== c.factsBindingHash
  )
    fail('method.facts_binding_hash');
  const row = c.runs[0],
    r = row.run,
    a = c.methodAssessments[0];
  const prepared = preparedInputSchema.parse(await read(row.preparedArtifact.artifactRef));
  if (
    prepared.modelHash !== r.effectiveModelRef.contentHash ||
    prepared.inputHash !== r.inputHash ||
    prepared.profileId !== r.profileId ||
    !sameJson(prepared.calculationContractRef, r.calculationContractRef) ||
    !prepared.studyBinding ||
    prepared.studyBinding.studyRevisionId !== row.revision.revisionId ||
    prepared.studyBinding.studyRevisionContentHash !== row.revision.contentHash ||
    !sameJson(prepared.studyBinding.definition, row.revision.definition)
  )
    fail('method.prepared_binding');
  const result = (await read(row.resultArtifact.artifactRef)) as Record<string, unknown>;
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    result.schemaVersion !== 'lca.study-result.v1' ||
    result.compilerVersion !== prepared.compilerVersion ||
    result.profileId !== prepared.profileId ||
    result.modelHash !== prepared.modelHash ||
    result.inputHash !== prepared.inputHash ||
    result.preparedArtifactSha256 !== row.preparedArtifact.artifactRef.contentHash ||
    !sameJson(result.calculationContractRef, prepared.calculationContractRef) ||
    !sameJson(result.coverage, prepared.coverage) ||
    !sameJson(result.qualityFindings, prepared.model.qualityFindings) ||
    result.businessPilotQualified !== false ||
    result.completeLciaScores !== (prepared.coverage.length === 0) ||
    !Array.isArray(result.h) ||
    result.h.length !== prepared.numeric.methodAxes.length ||
    result.h.some((v) => typeof v !== 'number' || !Number.isFinite(v))
  )
    fail('method.result_binding');
  const facts = parseMethodFacts(await read(a.factsArtifact.artifactRef)),
    b = facts.baseline;
  if (
    facts.identityKind !== 'private_job_metadata_not_an_authorization_receipt' ||
    facts.studyId !== c.studyId ||
    facts.assessmentId !== a.assessment.assessmentId ||
    facts.profileId !== a.assessment.profileId ||
    facts.configHash !== a.assessment.configHash ||
    (await methodConfigHash(facts.config)) !== facts.configHash ||
    !sameJson(facts.config, a.assessment.config) ||
    !sameJson(facts.moduleRef, a.assessment.config.moduleRef) ||
    b.runId !== r.runId ||
    b.studyRevisionId !== r.studyRevisionId ||
    b.scenarioRevisionId !== r.scenarioRevisionId ||
    b.modelPreparationId !== r.modelPreparationId ||
    b.inputHash !== r.inputHash ||
    b.methodSourceHash !== prepared.methodSourceHash ||
    !sameJson(b.effectiveModelRef, r.effectiveModelRef) ||
    !sameJson(b.preparedArtifactRef, row.preparedArtifact.artifactRef) ||
    !sameJson(b.resultRef, row.resultArtifact.artifactRef) ||
    !sameJson(b.sourceSnapshotRef, a.sourceSnapshotRef) ||
    !sameJson(b.calculationContractRef, r.calculationContractRef) ||
    !sameJson(b.sourceOrigin, prepared.model.origin)
  )
    fail('method.assessment_baseline_binding');
  const f = facts.frozenEvidence;
  if (
    !sameJson(f.functionalUnit, row.revision.definition.functionalUnit) ||
    f.declaredSystemBoundary !== row.revision.definition.systemBoundary ||
    f.processInstances !== prepared.model.instances.length ||
    f.sourceDocumentCount !== prepared.model.sourceDocuments.length ||
    !sameJson(f.methodAxes, prepared.numeric.methodAxes) ||
    f.exchanges !== prepared.model.instances.reduce((sum, i) => sum + i.exchanges.length, 0) ||
    f.inventoryAxes !== prepared.numeric.inventoryAxes.length ||
    f.declaredCutoffs !== prepared.model.cutoffs.length ||
    !sameJson(f.coverageGaps, prepared.coverage) ||
    !sameJson(f.qualityFindings, prepared.model.qualityFindings)
  )
    fail('method.frozen_evidence_binding');
  for (const category of facts.categories) {
    const index = prepared.numeric.methodAxes.findIndex(
      (m) => m.id === category.methodRef.id && m.version === category.methodRef.version,
    );
    if (
      index >= 0 &&
      category.canonicalCharacterisedValue !== null &&
      Number(category.canonicalCharacterisedValue) !== result.h[index]
    )
      fail('method.characterised_result_identity');
    const gaps = prepared.coverage
      .filter(
        (gap) =>
          gap.method.id === category.methodRef.id &&
          gap.method.version === category.methodRef.version,
      )
      .map((gap) => gap.inventoryIndex);
    if (!sameJson(category.missingInventoryIndices, gaps)) fail('method.coverage_indices');
  }
  return { context: c, prepared, facts };
}
export function makeMethodContent(input: MethodReportInput, raw: unknown): MethodStoredContent {
  const content = reportContentSchema.parse(raw),
    c = input.context,
    record = c.methodAssessments[0],
    ref = record.factsArtifact.artifactRef;
  const claims = content.claims.map((claim) => {
    const fact = input.facts.factCatalog.find((fact) => fact.factId === claim.factId);
    if (
      !sameJson(claim.bundleRef, ref) ||
      !fact ||
      claim.canonicalValue !== fact.canonicalValue ||
      claim.unit !== fact.unit
    )
      fail('method.claim_binding');
    return { ...claim, bundleRef: ref, fact };
  });
  let summary: MethodReportSummary;
  try {
    summary = makeMethodSummary(input.facts, ref);
  } catch {
    // Input has already passed exact facts/reference validation. A complete
    // retained summary that cannot fit its reporting bound is not truncated.
    throw new StudyFailure('PAYLOAD_TOO_LARGE', 413, 'method.complete_summary_reportability');
  }
  return {
    schemaVersion: 'lca.study-method-report-content.v1',
    reportRevisionId: c.reportRevisionId,
    studyId: c.studyId,
    templateId: REPORT_TEMPLATE,
    runIds: [c.runs[0].run.runId],
    methodAssessmentIds: [record.assessment.assessmentId],
    factsRefs: [ref],
    factsBindingHash: c.factsBindingHash,
    content,
    claims,
    methodAssessment: summary,
  };
}
export async function methodContentValidation(
  input: MethodReportInput,
  content: MethodStoredContent,
) {
  const rebuilt = makeMethodContent(input, content.content);
  if (!sameJson(rebuilt, content)) fail('method.stored_content_immutable_evidence');
  return {
    schemaVersion: 'lca.study-method-report-validation.v1' as const,
    profileId: 'lca.study-method-report-claims.v1' as const,
    reportRevisionId: content.reportRevisionId,
    contentHash: await sha256(canonicalBytes(content)),
    claimCount: content.claims.length,
    factsBindingHash: content.factsBindingHash,
    methodAssessmentId: input.facts.assessmentId,
    configHash: input.facts.configHash,
    requirementCount: 20,
    categoryCount: 25,
    factCount: 58,
  };
}
