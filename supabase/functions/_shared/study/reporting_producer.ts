import { z } from 'zod';
import { artifactRefSchema } from '../../../../contracts/lca-study/v1/common.ts';
import {
  reportContentSchema,
  REPORT_TEMPLATE,
  type ReportContent,
} from '../../../../contracts/lca-study/v3/report.ts';
import {
  parseAnalysisFacts,
  type AnalysisFacts,
} from '../../../../contracts/lca-study/v3/facts.ts';
import {
  canonicalBytes,
  domainBytes,
  sha256,
} from '../../../../contracts/lca-study/v3/canonical.ts';
import { preparedInputSchema } from './validator.ts';
import { StudyFailure } from './protocol.ts';
import { reportContextSchema, type ReportContext } from './reporting_context.ts';

type Prepared = z.infer<typeof preparedInputSchema>;
type ArtifactRef = z.infer<typeof artifactRefSchema>;
type Fact = AnalysisFacts['facts'][number];
export type SelectedClaim = { claimId: string; bundleRef: ArtifactRef; fact: Fact };
export type ReportContentEnvelope = {
  schemaVersion: 'lca.study-report-content.v1';
  reportRevisionId: string;
  studyId: string;
  templateId: typeof REPORT_TEMPLATE;
  runIds: string[];
  analysisIds: string[];
  factsRefs: ArtifactRef[];
  factsBindingHash: string;
  content: ReportContent;
  claims: SelectedClaim[];
};
export type ReportProducerInput = {
  context: ReportContext;
  prepared: Map<string, Prepared>;
  analyses: Map<string, AnalysisFacts>;
};
function fail(rule: string): never {
  throw new StudyFailure('REFERENCE_MISMATCH', 409, rule);
}
/** Equality only, not a P1 semantic identity implementation; P1 can contain finite JSON numbers. */
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, ordered(v)]),
    );
  return value;
}
export const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));

export function assertReportContext(context: ReportContext, request: unknown): void {
  const semanticRequest = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const { requestId: _transport, ...identity } = value as Record<string, unknown>;
    return identity;
  };
  if (
    !sameJson(semanticRequest(context.request), semanticRequest(request)) ||
    context.operation !== context.request.operation
  )
    fail('report.intent_request');
  const requestValue = context.request;
  const create = requestValue.operation === 'report.create';
  const runs = create ? requestValue.runIds : context.report?.runIds;
  const analyses = create ? requestValue.analysisIds : context.report?.analysisIds;
  if (
    !runs ||
    !analyses ||
    !sameJson(
      runs,
      context.runs.map((r) => r.run.runId),
    ) ||
    !sameJson(
      analyses,
      context.analyses.map((a) => a.analysis.analysisId),
    )
  )
    fail('report.intent_inputs');
  if (create) {
    if (
      context.report !== null ||
      context.contentArtifact !== null ||
      requestValue.studyId !== context.studyId ||
      !context.contentArtifactId
    )
      fail('report.create_context');
  } else {
    const r = context.report;
    if (
      !r ||
      r.reportRevisionId !== context.reportRevisionId ||
      r.studyId !== context.studyId ||
      !context.contentArtifact ||
      !sameJson(context.contentArtifact.artifactRef, r.contentRef)
    )
      fail('report.current_content');
    if (
      context.request.operation === 'report.save' ||
      context.request.operation === 'report.freeze'
    ) {
      if (
        r.status !== 'draft' ||
        r.revision !== context.request.target.expectedRevision ||
        r.reportRevisionId !== context.request.target.id
      )
        fail('report.target');
    } else if (context.request.operation === 'export.request') {
      if (
        r.status !== 'frozen' ||
        r.reportRevisionId !== context.request.reportRevisionId ||
        r.contentHash !== context.request.expectedContentHash ||
        !context.exportProfile ||
        !context.disclosureContextHash ||
        !context.exportId ||
        !context.projectionArtifactId ||
        !context.resourcesArtifactId ||
        !context.bundleArtifactId
      )
        fail('report.export_context');
    }
  }
  const definition = context.runs[0].revision.definition;
  for (const row of context.runs) {
    const { run, revision, scenario, preparation, preparedArtifact, resultArtifact } = row;
    if (
      [
        run.studyId,
        revision.studyId,
        scenario.studyId,
        preparation.studyId,
        preparedArtifact.studyId,
        resultArtifact.studyId,
      ].some((s) => s !== context.studyId) ||
      run.execution.status !== 'completed' ||
      run.validity.status !== 'current' ||
      revision.status !== 'frozen' ||
      scenario.status !== 'frozen' ||
      preparation.execution.status !== 'completed' ||
      run.studyRevisionId !== revision.revisionId ||
      run.scenarioRevisionId !== scenario.scenarioRevisionId ||
      scenario.studyRevisionId !== revision.revisionId ||
      run.modelPreparationId !== preparation.preparationId ||
      run.inputHash !== preparation.inputHash ||
      !sameJson(run.effectiveModelRef, preparation.modelRef) ||
      !sameJson(run.effectiveModelRef, scenario.effectiveModelRef) ||
      !sameJson(preparedArtifact.artifactRef, preparation.inputArtifactRef) ||
      !sameJson(resultArtifact.artifactRef, run.resultRef) ||
      !sameJson(run.calculationContractRef, preparation.calculationContractRef)
    )
      fail('report.run_bindings');
    if (!sameJson(definition, revision.definition))
      throw new StudyFailure('INVALID_REQUEST', 400, 'report.single_scope_template');
  }
  for (const row of context.analyses) {
    if (
      row.analysis.studyId !== context.studyId ||
      row.factsArtifact.studyId !== context.studyId ||
      row.analysis.execution.status !== 'completed' ||
      !sameJson(row.analysis.factsRef, row.factsArtifact.artifactRef) ||
      row.analysis.config.runIds.some((id) => !runs.includes(id))
    )
      fail('report.analysis_bindings');
  }
}

/** All bytes must first be fetched through the context-bound current-rights adapter. */
export async function validateReportInputs(
  contextInput: unknown,
  bytes: Map<string, Uint8Array>,
): Promise<ReportProducerInput> {
  const context = reportContextSchema.parse(contextInput);
  assertReportContext(context, context.request);
  const prepared = new Map<string, Prepared>(),
    analyses = new Map<string, AnalysisFacts>();
  const read = (ref: { id: string }) => {
    const b = bytes.get(ref.id);
    if (!b) fail('report.missing_artifact');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b));
  };
  const factsRefs = context.analyses.map((a) => a.factsArtifact.artifactRef);
  if (
    (await sha256(domainBytes('lca.study-report-facts-binding.v1', factsRefs))) !==
    context.factsBindingHash
  )
    fail('report.facts_identity');
  for (const row of context.runs) {
    const p = preparedInputSchema.parse(read(row.preparedArtifact.artifactRef));
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
      fail('report.prepared_binding');
    prepared.set(row.run.runId, p);
  }
  for (const row of context.analyses) {
    const a = parseAnalysisFacts(read(row.factsArtifact.artifactRef));
    if (
      a.studyId !== context.studyId ||
      a.analysisId !== row.analysis.analysisId ||
      a.profileId !== row.analysis.profileId ||
      a.configHash !== row.analysis.configHash ||
      !sameJson(a.config, row.analysis.config) ||
      !sameJson(
        a.inputs.map((i) => i.runId),
        a.config.runIds,
      ) ||
      !sameJson(
        { status: a.comparability.status, reasonCodes: a.comparability.reasonCodes },
        row.analysis.comparability,
      )
    )
      fail('report.producer_binding');
    for (const input of a.inputs) {
      const r = context.runs.find((r) => r.run.runId === input.runId),
        p = prepared.get(input.runId);
      if (
        !r ||
        !p ||
        input.studyRevisionId !== r.revision.revisionId ||
        input.scenarioRevisionId !== r.scenario.scenarioRevisionId ||
        input.modelPreparationId !== r.preparation.preparationId ||
        input.inputHash !== r.run.inputHash ||
        input.methodSourceHash !== p.methodSourceHash ||
        !sameJson(input.effectiveModelRef, r.run.effectiveModelRef) ||
        !sameJson(input.preparedArtifactRef, r.preparedArtifact.artifactRef) ||
        !sameJson(input.resultRef, r.resultArtifact.artifactRef) ||
        !sameJson(input.calculationContractRef, r.run.calculationContractRef)
      )
        fail('report.fact_run_binding');
    }
    analyses.set(a.analysisId, a);
  }
  return { context, prepared, analyses };
}

export function makeReportContent(
  input: ReportProducerInput,
  contentInput: unknown,
): ReportContentEnvelope {
  const content = reportContentSchema.parse(contentInput),
    { context, analyses } = input;
  const claims = content.claims.map((claim) => {
    const source = context.analyses.find((a) =>
      sameJson(a.factsArtifact.artifactRef, claim.bundleRef),
    );
    const fact = source
      ? analyses.get(source.analysis.analysisId)?.facts.find((f) => f.factId === claim.factId)
      : undefined;
    if (
      !source ||
      !fact ||
      fact.canonicalValue !== claim.canonicalValue ||
      fact.unit !== claim.unit
    )
      fail('report.claim_binding');
    return { claimId: claim.claimId, bundleRef: claim.bundleRef, fact };
  });
  return {
    schemaVersion: 'lca.study-report-content.v1',
    reportRevisionId: context.reportRevisionId,
    studyId: context.studyId,
    templateId: REPORT_TEMPLATE,
    runIds: context.runs.map((r) => r.run.runId),
    analysisIds: context.analyses.map((a) => a.analysis.analysisId),
    factsRefs: context.analyses.map((a) => a.factsArtifact.artifactRef) as ArtifactRef[],
    factsBindingHash: context.factsBindingHash,
    content,
    claims,
  };
}

export async function contentValidation(envelope: ReportContentEnvelope) {
  const bytes = canonicalBytes(envelope),
    contentHash = await sha256(bytes);
  return {
    bytes,
    contentHash,
    validation: {
      schemaVersion: 'lca.study-report-validation.v1',
      profileId: 'lca.study-report-claims.v1',
      reportRevisionId: envelope.reportRevisionId,
      contentHash,
      claimCount: envelope.claims.length,
      factsBindingHash: envelope.factsBindingHash,
    },
  };
}
