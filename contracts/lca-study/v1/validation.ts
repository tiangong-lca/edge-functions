import { API_SCHEMA, type ContractIssue } from './common.ts';
import { graphSchema, type FixtureGraph } from './records.ts';
import { requestSchema, type StudyApiRequest } from './requests.ts';
import { responseSchema, type StudyApiResponse } from './responses.ts';

export type ValidationResult<T> =
  { ok: true; value: T; issues: [] } | { ok: false; issues: ContractIssue[] };

function pointer(path: PropertyKey[]): string {
  return (
    '/' + path.map((part) => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')
  );
}

function duplicates(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

/** Structural/local request checks. Never authenticates or authorizes an actor. */
export function validateRequest(input: unknown): ValidationResult<StudyApiRequest> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) {
    const unsupported =
      input !== null &&
      typeof input === 'object' &&
      'schemaVersion' in input &&
      input.schemaVersion !== API_SCHEMA;
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, 64).map((issue) => ({
        code: unsupported ? 'UNSUPPORTED_SCHEMA' : 'INVALID_REQUEST',
        path: pointer(issue.path),
        ruleId: unsupported ? 'schema.version' : 'request.structure',
      })),
    };
  }
  const value = parsed.data;
  const issues: ContractIssue[] = [];
  if ('overrides' in value && duplicates(value.overrides.map((item) => item.path))) {
    issues.push({
      code: 'INVALID_REQUEST',
      path: '/overrides',
      ruleId: 'scenario.unique_override',
    });
  }
  for (const key of ['runIds', 'analysisIds', 'capabilities'] as const) {
    if (key in value && duplicates((value as Record<string, unknown>)[key] as string[])) {
      issues.push({
        code: 'INVALID_REQUEST',
        path: '/' + key,
        ruleId: 'request.unique_references',
      });
    }
  }
  if ('contentRef' in value && value.contentRef.type !== 'reportContent') {
    issues.push({
      code: 'REFERENCE_MISMATCH',
      path: '/contentRef/type',
      ruleId: 'report.content_kind',
    });
  }
  return issues.length ? { ok: false, issues } : { ok: true, value, issues: [] };
}

/** Correlation/selection checks only; opaque cursors and actor access require runtime verification. */
export function validateResponseForRequest(
  request: StudyApiRequest,
  input: unknown,
): ValidationResult<StudyApiResponse> {
  const parsed = responseSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      issues: [{ code: 'REFERENCE_MISMATCH', path: '/data', ruleId: 'response.structure' }],
    };
  const value = parsed.data;
  if (value.requestId !== request.requestId)
    return {
      ok: false,
      issues: [
        { code: 'REFERENCE_MISMATCH', path: '/requestId', ruleId: 'response.request_binding' },
      ],
    };
  if (!value.ok) return { ok: true, value, issues: [] };
  const data = value.data;
  let expectedType: string;
  if (request.operation === 'study.list') expectedType = 'studyPage';
  else if (request.operation === 'study.resources.list') expectedType = 'resourcePage';
  else if (request.operation === 'capability.read') expectedType = 'capabilities';
  else if (request.operation === 'model.source.resolve') expectedType = 'modelSourceSnapshot';
  else if (request.operation.startsWith('model.')) expectedType = 'modelPreparation';
  else if (request.operation.startsWith('revision.')) expectedType = 'studyRevision';
  else if (request.operation.startsWith('scenario.')) expectedType = 'scenarioRevision';
  else if (request.operation.startsWith('report.')) expectedType = 'reportRevision';
  else expectedType = request.operation.split('.')[0];
  if (data.type !== expectedType)
    return {
      ok: false,
      issues: [
        { code: 'REFERENCE_MISMATCH', path: '/data/type', ruleId: 'response.operation_kind' },
      ],
    };
  if (
    request.operation === 'study.resources.list' &&
    data.type === 'resourcePage' &&
    (data.studyId !== request.studyId ||
      data.kind !== request.kind ||
      data.items.length > request.limit)
  )
    return {
      ok: false,
      issues: [{ code: 'REFERENCE_MISMATCH', path: '/data', ruleId: 'page.request_selection' }],
    };
  if (
    request.operation === 'study.list' &&
    data.type === 'studyPage' &&
    data.items.length > request.limit
  )
    return {
      ok: false,
      issues: [{ code: 'REFERENCE_MISMATCH', path: '/data/items', ruleId: 'page.request_limit' }],
    };
  if ('value' in data) {
    const record = data.value as Record<string, unknown>;
    const selectionKeys = [
      'studyId',
      'revisionId',
      'scenarioRevisionId',
      'preparationId',
      'runId',
      'analysisId',
      'reportRevisionId',
      'exportId',
      'shareId',
    ] as const;
    if (
      request.operation.endsWith('.read') &&
      selectionKeys.some(
        (key) => key in request && record[key] !== (request as Record<string, unknown>)[key],
      )
    )
      return {
        ok: false,
        issues: [
          { code: 'REFERENCE_MISMATCH', path: '/data/value', ruleId: 'response.resource_binding' },
        ],
      };
    if ('studyId' in request && record.studyId !== request.studyId)
      return {
        ok: false,
        issues: [
          {
            code: 'REFERENCE_MISMATCH',
            path: '/data/value/studyId',
            ruleId: 'response.study_binding',
          },
        ],
      };
  }
  if (
    request.operation === 'model.source.resolve' &&
    data.type === 'modelSourceSnapshot' &&
    JSON.stringify(request.originRef) !== JSON.stringify(data.value.originRef)
  )
    return {
      ok: false,
      issues: [
        {
          code: 'REFERENCE_MISMATCH',
          path: '/data/value/originRef',
          ruleId: 'response.model_origin',
        },
      ],
    };
  if (
    request.operation === 'model.prepare' &&
    data.type === 'modelPreparation' &&
    (JSON.stringify(request.source) !== JSON.stringify(data.value.source) ||
      request.profileId !== data.value.profileId ||
      JSON.stringify(request.calculationContractRef) !==
        JSON.stringify(data.value.calculationContractRef))
  )
    return {
      ok: false,
      issues: [
        { code: 'REFERENCE_MISMATCH', path: '/data/value', ruleId: 'response.preparation_source' },
      ],
    };
  if (
    request.operation === 'run.submit' &&
    data.type === 'run' &&
    (request.studyRevisionId !== data.value.studyRevisionId ||
      request.scenarioRevisionId !== data.value.scenarioRevisionId ||
      request.expectedInputHash !== data.value.inputHash ||
      request.profileId !== data.value.profileId ||
      JSON.stringify(request.calculationContractRef) !==
        JSON.stringify(data.value.calculationContractRef))
  )
    return {
      ok: false,
      issues: [{ code: 'REFERENCE_MISMATCH', path: '/data/value', ruleId: 'response.run_intent' }],
    };
  return { ok: true, value, issues: [] };
}

/** A supplied fixture snapshot is NOT a fresh database authorization/concurrency check. */
export function validateFixturePrecondition(
  request: StudyApiRequest,
  graph: FixtureGraph,
): ContractIssue[] {
  if (!('target' in request)) return [];
  const { target } = request;
  const candidates =
    target.type === 'study'
      ? graph.studies.map((value) => ({ id: value.studyId, value }))
      : target.type === 'studyRevision'
        ? graph.studyRevisions.map((value) => ({ id: value.revisionId, value }))
        : target.type === 'scenarioRevision'
          ? graph.scenarioRevisions.map((value) => ({ id: value.scenarioRevisionId, value }))
          : graph.reports.map((value) => ({ id: value.reportRevisionId, value }));
  const record = candidates.find((item) => item.id === target.id)?.value;
  if (!record)
    return [{ code: 'NOT_FOUND', path: '/target/id', ruleId: 'precondition.target_exists' }];
  if (record.revision !== target.expectedRevision)
    return [
      {
        code: 'REVISION_CONFLICT',
        path: '/target/expectedRevision',
        ruleId: 'precondition.target_generation',
      },
    ];
  if (
    ['revision.save', 'scenario.save', 'report.save'].includes(request.operation) &&
    record.status === 'frozen'
  ) {
    return [{ code: 'FROZEN_REVISION', path: '/target', ruleId: 'precondition.frozen_content' }];
  }
  if (
    'expectedContentHash' in request &&
    'contentHash' in record &&
    request.expectedContentHash !== record.contentHash
  ) {
    return [
      {
        code: 'REVISION_CONFLICT',
        path: '/expectedContentHash',
        ruleId: 'precondition.content_hash',
      },
    ];
  }
  if (request.operation === 'scenario.freeze') {
    const preparation = graph.modelPreparations.find(
      (value) => value.preparationId === request.modelPreparationId,
    );
    const scenario = graph.scenarioRevisions.find(
      (value) => value.scenarioRevisionId === request.target.id,
    );
    if (
      !scenario ||
      !preparation ||
      preparation.studyId !== scenario.studyId ||
      preparation.execution.status !== 'completed' ||
      !preparation.modelRef ||
      !preparation.inputArtifactRef ||
      preparation.inputHash === null ||
      preparation.source.type !== 'scenarioRevision' ||
      preparation.source.scenarioRevisionId !== scenario.scenarioRevisionId ||
      preparation.source.contentHash !== scenario.contentHash ||
      preparation.source.expectedRevision !== scenario.revision
    )
      return [
        {
          code: 'REFERENCE_MISMATCH',
          path: '/modelPreparationId',
          ruleId: 'precondition.prepared_model',
        },
      ];
  }
  return [];
}

/**
 * Offline fixture relationships only. Supplied actor/time/state are not authority.
 * No RPC, state transition, hash calculation, signature verification or license decision.
 */
export function validateFixtureGraph(
  input: unknown,
  observedAt: string,
): ValidationResult<FixtureGraph> {
  const parsed = graphSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, 64).map((issue) => ({
        code: 'INVALID_REQUEST',
        path: pointer(issue.path),
        ruleId: 'graph.structure',
      })),
    };
  }
  if (!Number.isFinite(Date.parse(observedAt))) {
    return {
      ok: false,
      issues: [{ code: 'INVALID_REQUEST', path: '/observedAt', ruleId: 'graph.observation_time' }],
    };
  }
  const graph = parsed.data;
  const issues: ContractIssue[] = [];
  function reject(
    path: string,
    ruleId: string,
    code: ContractIssue['code'] = 'REFERENCE_MISMATCH',
  ) {
    if (issues.length < 64) issues.push({ code, path, ruleId });
  }
  function index<T>(items: T[], key: (item: T) => string, path: string): Map<string, T> {
    const result = new Map<string, T>();
    items.forEach((item, i) => {
      const id = key(item);
      if (result.has(id)) reject(`${path}/${i}`, 'graph.unique_identity');
      else result.set(id, item);
    });
    return result;
  }
  const studies = index(graph.studies, (item) => item.studyId, '/studies');
  const snapshots = index(
    graph.modelSourceSnapshots,
    (item) => item.snapshotId,
    '/modelSourceSnapshots',
  );
  const preparations = index(
    graph.modelPreparations,
    (item) => item.preparationId,
    '/modelPreparations',
  );
  index(graph.modelPreparations, (item) => item.execution.jobId, '/modelPreparations');
  const revisions = index(graph.studyRevisions, (item) => item.revisionId, '/studyRevisions');
  const scenarios = index(
    graph.scenarioRevisions,
    (item) => item.scenarioRevisionId,
    '/scenarioRevisions',
  );
  const runs = index(graph.runs, (item) => item.runId, '/runs');
  index(graph.runs, (item) => item.execution.jobId, '/runs');
  const analyses = index(graph.analyses, (item) => item.analysisId, '/analyses');
  const reports = index(graph.reports, (item) => item.reportRevisionId, '/reports');
  const reviews = index(graph.reviews, (item) => item.reviewId, '/reviews');
  const exports = index(graph.exports, (item) => item.exportId, '/exports');
  index(graph.shares, (item) => item.shareId, '/shares');
  function acyclic<T>(
    items: T[],
    id: (item: T) => string,
    parent: (item: T) => string | null,
    path: string,
    ruleId = 'graph.acyclic_lineage',
  ) {
    const parents = new Map(items.map((item) => [id(item), parent(item)]));
    const complete = new Set<string>();
    for (const item of items) {
      const seen = new Set<string>();
      let cursor: string | null | undefined = id(item);
      while (cursor != null && !complete.has(cursor)) {
        if (seen.has(cursor)) {
          reject(path, ruleId);
          break;
        }
        seen.add(cursor);
        cursor = parents.get(cursor);
      }
      for (const visited of seen) complete.add(visited);
    }
  }
  acyclic(
    graph.studyRevisions,
    (item) => item.revisionId,
    (item) => item.parentRevisionId,
    '/studyRevisions',
  );
  acyclic(
    graph.scenarioRevisions,
    (item) => item.scenarioRevisionId,
    (item) => item.parentScenarioRevisionId,
    '/scenarioRevisions',
  );
  acyclic(
    graph.reports,
    (item) => item.reportRevisionId,
    (item) => item.parentReportRevisionId,
    '/reports',
  );
  acyclic(
    graph.reviews,
    (item) => item.reviewId,
    (item) => item.supersedesReviewId,
    '/reviews',
  );
  const modelProvenance = [
    ...graph.modelSourceSnapshots.map((item) => ({
      id: 'snapshot:' + item.snapshotId,
      parent: null as string | null,
    })),
    ...graph.modelPreparations.map((item) => ({
      id: 'preparation:' + item.preparationId,
      parent:
        item.source.type === 'modelSourceSnapshot'
          ? 'snapshot:' + item.source.snapshotId
          : 'scenario:' + item.source.scenarioRevisionId,
    })),
    ...graph.studyRevisions.map((item) => ({
      id: 'revision:' + item.revisionId,
      parent: 'preparation:' + item.modelPreparationId,
    })),
    ...graph.scenarioRevisions.map((item) => ({
      id: 'scenario:' + item.scenarioRevisionId,
      parent: 'revision:' + item.studyRevisionId,
    })),
  ];
  acyclic(
    modelProvenance,
    (item) => item.id,
    (item) => item.parent,
    '/modelPreparations',
    'model.acyclic_provenance',
  );

  const artifacts = new Map<string, string>();
  const models = new Map<string, string>();
  const bind = (map: Map<string, string>, key: string, binding: string, path: string) => {
    if (map.has(key) && map.get(key) !== binding) reject(path, 'graph.immutable_reference');
    else map.set(key, binding);
  };
  graph.studyRevisions.forEach((item, i) =>
    bind(
      models,
      item.modelRef.modelRevisionId,
      item.modelRef.contentHash,
      `/studyRevisions/${i}/modelRef`,
    ),
  );
  graph.scenarioRevisions.forEach((item, i) => {
    if (item.effectiveModelRef)
      bind(
        models,
        item.effectiveModelRef.modelRevisionId,
        item.effectiveModelRef.contentHash,
        `/scenarioRevisions/${i}/effectiveModelRef`,
      );
  });
  graph.modelPreparations.forEach((item, i) => {
    if (item.modelRef)
      bind(
        models,
        item.modelRef.modelRevisionId,
        item.modelRef.contentHash,
        `/modelPreparations/${i}/modelRef`,
      );
  });
  graph.runs.forEach((item, i) =>
    bind(
      models,
      item.effectiveModelRef.modelRevisionId,
      item.effectiveModelRef.contentHash,
      `/runs/${i}/effectiveModelRef`,
    ),
  );
  const artifactGroups = [
    ...graph.modelSourceSnapshots.map((item) => item.sourceArtifactRef),
    ...graph.modelPreparations.flatMap((item) =>
      item.inputArtifactRef ? [item.inputArtifactRef] : [],
    ),
    ...graph.runs.flatMap((item) => (item.resultRef ? [item.resultRef] : [])),
    ...graph.analyses.flatMap((item) => (item.factsRef ? [item.factsRef] : [])),
    ...graph.reports.flatMap((item) => [...item.factsRefs, item.contentRef]),
    ...graph.exports.flatMap((item) => [...item.factsRefs, item.projectionRef, item.resourcesRef]),
  ];
  artifactGroups.forEach((ref, i) =>
    bind(artifacts, ref.id, JSON.stringify(ref), `/artifactReferences/${i}`),
  );

  graph.studies.forEach((item, i) => {
    if (
      item.currentRevisionId !== null &&
      revisions.get(item.currentRevisionId)?.studyId !== item.studyId
    ) {
      reject(`/studies/${i}/currentRevisionId`, 'study.head_binding');
    }
  });
  graph.modelSourceSnapshots.forEach((item, i) => {
    const p = `/modelSourceSnapshots/${i}`;
    if (!studies.has(item.studyId)) reject(p + '/studyId', 'model_source.study_binding');
    if (item.sourceArtifactRef.type !== 'modelSource')
      reject(p + '/sourceArtifactRef', 'model_source.artifact_kind');
  });
  graph.modelPreparations.forEach((item, i) => {
    const p = `/modelPreparations/${i}`;
    if (!studies.has(item.studyId)) reject(p + '/studyId', 'model_preparation.study_binding');
    if (
      (item.execution.status === 'completed') !==
        (item.modelRef !== null && item.inputArtifactRef !== null) ||
      (item.execution.status !== 'completed' &&
        (item.modelRef !== null || item.inputArtifactRef !== null || item.inputHash !== null))
    )
      reject(p, 'model_preparation.result_state');
    if (
      item.execution.status === 'completed' &&
      item.source.type === 'scenarioRevision' &&
      item.inputHash === null
    )
      reject(p + '/inputHash', 'model_preparation.run_input_identity');
    if (item.inputArtifactRef && item.inputArtifactRef.type !== 'modelInput')
      reject(p + '/inputArtifactRef', 'model_preparation.input_kind');
    if (item.source.type === 'modelSourceSnapshot') {
      const snapshot = snapshots.get(item.source.snapshotId);
      if (
        !snapshot ||
        snapshot.studyId !== item.studyId ||
        snapshot.sourceArtifactRef.contentHash !== item.source.contentHash
      )
        reject(p + '/source', 'model_preparation.source_snapshot');
    } else {
      const scenario = scenarios.get(item.source.scenarioRevisionId);
      if (
        !scenario ||
        scenario.studyId !== item.studyId ||
        item.source.expectedRevision > scenario.revision - (scenario.status === 'frozen' ? 1 : 0) ||
        (item.source.expectedRevision ===
          scenario.revision - (scenario.status === 'frozen' ? 1 : 0) &&
          scenario.contentHash !== item.source.contentHash)
      )
        reject(p + '/source', 'model_preparation.scenario_snapshot');
    }
  });
  graph.studyRevisions.forEach((item, i) => {
    const p = `/studyRevisions/${i}`;
    if (!studies.has(item.studyId)) reject(p + '/studyId', 'revision.study_binding');
    const prepared = preparations.get(item.modelPreparationId);
    if (
      !prepared ||
      prepared.studyId !== item.studyId ||
      prepared.execution.status !== 'completed' ||
      prepared.modelRef?.modelRevisionId !== item.modelRef.modelRevisionId ||
      prepared.modelRef?.contentHash !== item.modelRef.contentHash
    )
      reject(p + '/modelRef', 'revision.prepared_model');
    if (item.status === 'frozen' && item.validation !== 'passed')
      reject(p + '/validation', 'revision.freeze_validation');
    if (item.parentRevisionId !== null) {
      const parent = revisions.get(item.parentRevisionId);
      if (
        !parent ||
        parent.studyId !== item.studyId ||
        parent.status !== 'frozen' ||
        parent.revisionId === item.revisionId
      ) {
        reject(p + '/parentRevisionId', 'revision.parent_binding');
      }
    }
  });
  graph.scenarioRevisions.forEach((item, i) => {
    const p = `/scenarioRevisions/${i}`;
    const revision = revisions.get(item.studyRevisionId);
    if (!revision || revision.studyId !== item.studyId || revision.status !== 'frozen')
      reject(p + '/studyRevisionId', 'scenario.base_binding');
    if (duplicates(item.overrides.map((entry) => entry.path)))
      reject(p + '/overrides', 'scenario.unique_override');
    if (item.status === 'frozen') {
      const preparation = item.modelPreparationId
        ? preparations.get(item.modelPreparationId)
        : undefined;
      if (
        !preparation ||
        preparation.studyId !== item.studyId ||
        preparation.execution.status !== 'completed' ||
        preparation.source.type !== 'scenarioRevision' ||
        preparation.source.scenarioRevisionId !== item.scenarioRevisionId ||
        preparation.source.contentHash !== item.contentHash ||
        preparation.source.expectedRevision + 1 !== item.revision ||
        !item.effectiveModelRef ||
        JSON.stringify(preparation.modelRef) !== JSON.stringify(item.effectiveModelRef)
      )
        reject(p + '/modelPreparationId', 'scenario.prepared_model');
    } else if (item.modelPreparationId !== null || item.effectiveModelRef !== null)
      reject(p + '/effectiveModelRef', 'scenario.draft_unfrozen_model');
    if (item.parentScenarioRevisionId !== null) {
      const parent = scenarios.get(item.parentScenarioRevisionId);
      if (
        !parent ||
        parent.studyId !== item.studyId ||
        parent.status !== 'frozen' ||
        parent.scenarioRevisionId === item.scenarioRevisionId
      )
        reject(p + '/parentScenarioRevisionId', 'scenario.parent_binding');
    }
  });
  graph.runs.forEach((item, i) => {
    const p = `/runs/${i}`;
    const base = revisions.get(item.studyRevisionId);
    const scenario = scenarios.get(item.scenarioRevisionId);
    if (!base || base.studyId !== item.studyId || base.status !== 'frozen')
      reject(p + '/studyRevisionId', 'run.frozen_base');
    if (
      !scenario ||
      scenario.studyId !== item.studyId ||
      scenario.studyRevisionId !== item.studyRevisionId ||
      scenario.status !== 'frozen'
    )
      reject(p + '/scenarioRevisionId', 'run.frozen_scenario');
    if (
      scenario &&
      (!scenario.effectiveModelRef ||
        scenario.effectiveModelRef.modelRevisionId !== item.effectiveModelRef.modelRevisionId ||
        scenario.effectiveModelRef.contentHash !== item.effectiveModelRef.contentHash)
    )
      reject(p + '/effectiveModelRef', 'run.effective_model_binding');
    const preparation = preparations.get(item.modelPreparationId);
    if (
      !preparation ||
      preparation.studyId !== item.studyId ||
      preparation.execution.status !== 'completed' ||
      item.modelPreparationId !== scenario?.modelPreparationId ||
      JSON.stringify(preparation.modelRef) !== JSON.stringify(item.effectiveModelRef) ||
      preparation.profileId !== item.profileId ||
      preparation.inputHash !== item.inputHash ||
      JSON.stringify(preparation.calculationContractRef) !==
        JSON.stringify(item.calculationContractRef)
    )
      reject(p + '/modelPreparationId', 'run.prepared_model_binding');
    if ((item.execution.status === 'completed') !== (item.resultRef !== null))
      reject(p + '/resultRef', 'run.result_state');
    if (item.resultRef !== null && item.resultRef.type !== 'runResult')
      reject(p + '/resultRef/type', 'run.result_kind');
  });
  graph.analyses.forEach((item, i) => {
    const p = `/analyses/${i}`;
    if (duplicates(item.runIds)) reject(p + '/runIds', 'analysis.unique_runs');
    item.runIds.forEach((id, j) => {
      const run = runs.get(id);
      if (
        !run ||
        run.studyId !== item.studyId ||
        (item.status === 'ready' && run.execution.status !== 'completed')
      )
        reject(`${p}/runIds/${j}`, 'analysis.run_binding');
    });
    if ((item.status === 'ready') !== (item.factsRef !== null))
      reject(p + '/factsRef', 'analysis.facts_state');
    if (item.factsRef && item.factsRef.type !== 'analysisFacts')
      reject(p + '/factsRef/type', 'analysis.facts_kind');
    if (
      item.runIds.length > 1 &&
      item.status === 'ready' &&
      item.comparability.status !== 'comparable'
    )
      reject(p + '/comparability', 'analysis.comparison_gate');
  });
  graph.reviews.forEach((item, i) => {
    const p = `/reviews/${i}`;
    const report = reports.get(item.target.revisionId);
    if (
      !report ||
      report.studyId !== item.studyId ||
      report.contentHash !== item.target.contentHash ||
      report.status !== 'frozen'
    )
      reject(p + '/target', 'review.exact_target');
    if (report && item.reviewClass === 'independent' && item.actorId === report.authorId)
      reject(p + '/actorId', 'review.independent_actor', 'FORBIDDEN');
    if (report && item.reviewClass === 'self' && item.actorId !== report.authorId)
      reject(p + '/actorId', 'review.self_actor', 'FORBIDDEN');
    if (item.supersedesReviewId !== null) {
      const previous = reviews.get(item.supersedesReviewId);
      if (
        !previous ||
        previous.target.revisionId !== item.target.revisionId ||
        previous.target.contentHash !== item.target.contentHash ||
        previous.actorId !== item.actorId ||
        previous.reviewId === item.reviewId ||
        Date.parse(previous.decidedAt) > Date.parse(item.decidedAt)
      )
        reject(p + '/supersedesReviewId', 'review.append_binding');
    }
  });
  const priorReviewIds = graph.reviews.flatMap((item) =>
    item.supersedesReviewId ? [item.supersedesReviewId] : [],
  );
  if (duplicates(priorReviewIds)) reject('/reviews', 'review.unique_supersession');
  graph.reports.forEach((item, i) => {
    const p = `/reports/${i}`;
    if (!studies.has(item.studyId)) reject(p + '/studyId', 'report.study_binding');
    if (duplicates(item.runIds) || duplicates(item.analysisIds))
      reject(p, 'report.unique_references');
    const allowedFacts = new Set<string>();
    item.runIds.forEach((id, j) => {
      const run = runs.get(id);
      if (
        !run ||
        run.studyId !== item.studyId ||
        run.execution.status !== 'completed' ||
        !run.resultRef
      )
        reject(`${p}/runIds/${j}`, 'report.run_binding');
      else allowedFacts.add(JSON.stringify(run.resultRef));
    });
    item.analysisIds.forEach((id, j) => {
      const analysis = analyses.get(id);
      if (
        !analysis ||
        analysis.studyId !== item.studyId ||
        analysis.status !== 'ready' ||
        !analysis.factsRef ||
        analysis.runIds.some((runId) => !item.runIds.includes(runId))
      )
        reject(`${p}/analysisIds/${j}`, 'report.analysis_binding');
      else allowedFacts.add(JSON.stringify(analysis.factsRef));
    });
    item.factsRefs.forEach((ref, j) => {
      if (!allowedFacts.has(JSON.stringify(ref)))
        reject(`${p}/factsRefs/${j}`, 'report.facts_binding');
    });
    if (item.contentRef.type !== 'reportContent')
      reject(p + '/contentRef/type', 'report.content_kind');
    if (item.parentReportRevisionId !== null) {
      const parent = reports.get(item.parentReportRevisionId);
      if (
        !parent ||
        parent.studyId !== item.studyId ||
        parent.status !== 'frozen' ||
        parent.reportRevisionId === item.reportRevisionId
      )
        reject(p + '/parentReportRevisionId', 'report.parent_binding');
    }
    if (item.finalization.status === 'finalized') {
      if (item.status !== 'frozen') reject(p + '/status', 'report.finalize_frozen');
      if (item.finalization.finalizedAt === null)
        reject(p + '/finalization/finalizedAt', 'report.finalize_time');
      const requirement = item.finalization.reviewRequirement;
      const cutoff = Date.parse(item.finalization.finalizedAt ?? '');
      const superseded = new Set(
        graph.reviews
          .filter((review) => Date.parse(review.decidedAt) <= cutoff)
          .map((review) => review.supersedesReviewId),
      );
      if (
        requirement !== 'none' &&
        !graph.reviews.some(
          (review) =>
            item.finalization.reviewIds.includes(review.reviewId) &&
            Date.parse(review.decidedAt) <= cutoff &&
            review.target.revisionId === item.reportRevisionId &&
            review.target.contentHash === item.contentHash &&
            review.decision === 'approve' &&
            !superseded.has(review.reviewId) &&
            review.reviewClass === requirement,
        )
      )
        reject(p + '/finalization', 'report.required_review', 'REVIEW_REQUIRED');
    } else if (item.finalization.finalizedAt !== null || item.finalization.reviewIds.length !== 0) {
      reject(p + '/finalization', 'report.unfinalized_snapshot');
    }
    if (duplicates(item.finalization.reviewIds))
      reject(p + '/finalization/reviewIds', 'report.unique_finalization_reviews');
    item.finalization.reviewIds.forEach((id, j) => {
      const review = reviews.get(id);
      if (
        !review ||
        review.target.revisionId !== item.reportRevisionId ||
        review.target.contentHash !== item.contentHash ||
        Date.parse(review.decidedAt) > Date.parse(item.finalization.finalizedAt ?? '')
      )
        reject(`${p}/finalization/reviewIds/${j}`, 'report.finalization_review_binding');
    });
  });
  graph.exports.forEach((item, i) => {
    const p = `/exports/${i}`;
    const report = reports.get(item.reportRevisionId);
    if (
      !report ||
      report.studyId !== item.studyId ||
      report.contentHash !== item.reportContentHash ||
      report.status !== 'frozen'
    )
      reject(p + '/reportRevisionId', 'export.exact_report');
    if (
      item.projectionRef.type !== 'reportProjection' ||
      item.resourcesRef.type !== 'renderResources'
    )
      reject(p, 'export.artifact_kinds');
    if (item.status === 'ready' && (item.disclosureDecision !== 'allowed' || !item.receipt))
      reject(p + '/status', 'export.ready_disclosure_receipt', 'DISCLOSURE_DENIED');
    if (report && JSON.stringify(item.factsRefs) !== JSON.stringify(report.factsRefs))
      reject(p + '/factsRefs', 'export.facts_binding');
    if (duplicates(item.reviewIds)) reject(p + '/reviewIds', 'export.unique_reviews');
    item.reviewIds.forEach((id, j) => {
      const review = reviews.get(id);
      if (
        !review ||
        review.target.revisionId !== item.reportRevisionId ||
        review.target.contentHash !== item.reportContentHash ||
        Date.parse(review.decidedAt) > Date.parse(item.generatedAt)
      )
        reject(`${p}/reviewIds/${j}`, 'export.review_snapshot');
    });
  });
  graph.shares.forEach((item, i) => {
    const p = `/shares/${i}`;
    const exported = exports.get(item.exportId);
    if (
      !exported ||
      exported.studyId !== item.studyId ||
      exported.reportRevisionId !== item.reportRevisionId ||
      exported.projectionRef.contentHash !== item.projectionHash ||
      exported.grantEpoch !== item.grantEpoch
    )
      reject(p + '/exportId', 'share.exact_export', 'FORBIDDEN');
    if (
      item.status === 'active' &&
      exported &&
      (exported.status !== 'ready' || exported.disclosureDecision !== 'allowed')
    )
      reject(p + '/exportId', 'share.active_export', 'FORBIDDEN');
    if (item.status === 'active' && Date.parse(item.expiresAt) <= Date.parse(observedAt))
      reject(p + '/expiresAt', 'share.not_expired', 'FORBIDDEN');
    if (item.status === 'expired' && Date.parse(item.expiresAt) > Date.parse(observedAt))
      reject(p + '/status', 'share.expiry_state', 'FORBIDDEN');
    if (duplicates(item.capabilities)) reject(p + '/capabilities', 'share.unique_capabilities');
  });
  return issues.length ? { ok: false, issues } : { ok: true, value: graph, issues: [] };
}
