import { assert, assertEquals } from 'jsr:@std/assert';
import { z } from 'zod';
import {
  API_SCHEMA,
  CONTRACT_CAPABILITIES,
  ERROR_CODES,
  graphSchema,
  OPERATIONS,
  responseSchema,
  resourcePageSchema,
  studyPageSchema,
  validateFixtureGraph,
  validateFixturePrecondition,
  validateRequest,
  validateResponseForRequest,
  type FixtureGraph,
  type StudyApiRequest,
} from '../contracts/lca-study/v1/index.ts';

const ROOT = new URL('./fixtures/lca-study-api/v1/', import.meta.url);
const OBSERVED_AT = '2026-11-02T00:00:00Z';
async function readFixture(name: string): Promise<unknown> {
  return JSON.parse(await Deno.readTextFile(new URL(name, ROOT)));
}

const validGraph = graphSchema.parse(await readFixture('valid-graph.json'));
const validRequests = z.array(z.unknown()).parse(await readFixture('valid-requests.json'));
const invalidRequests = z
  .array(
    z
      .object({
        name: z.string(),
        input: z.unknown(),
        expectedCode: z.enum(ERROR_CODES),
        expectedRule: z.string(),
      })
      .strict(),
  )
  .parse(await readFixture('invalid-requests.json'));
const invalidGraphs = z
  .object({
    schemaVersion: z.literal('lca.study-api-negative-cases.v1'),
    observedAt: z.string().datetime(),
    cases: z.array(
      z
        .object({
          name: z.string(),
          patches: z.array(z.object({ path: z.string(), value: z.unknown() }).strict()),
          expectedCode: z.enum(ERROR_CODES),
          expectedRule: z.string(),
        })
        .strict(),
    ),
  })
  .strict()
  .parse(await readFixture('invalid-graphs.json'));

function applyPatch(graph: FixtureGraph, path: string, value: unknown): void {
  const parts = path.split('/').slice(1);
  assert(
    parts.length > 0 &&
      parts.every((part) => part !== '__proto__' && part !== 'constructor' && part !== 'prototype'),
  );
  let current: unknown = graph;
  for (const part of parts.slice(0, -1)) {
    assert(current !== null && typeof current === 'object');
    current = (current as Record<string, unknown>)[part];
  }
  assert(current !== null && typeof current === 'object');
  (current as Record<string, unknown>)[parts.at(-1)!] = structuredClone(value);
}

Deno.test('Study contract fixtures cover every declared operation without enabling runtime', () => {
  const operations: string[] = [];
  for (const request of validRequests) {
    const result = validateRequest(request);
    assert(result.ok, JSON.stringify(result));
    operations.push(result.value.operation);
  }
  assertEquals([...operations].sort(), [...OPERATIONS].sort());
  assertEquals(new Set(OPERATIONS).size, OPERATIONS.length);
  assertEquals(CONTRACT_CAPABILITIES.runtimeEnabled, false);
  assertEquals(CONTRACT_CAPABILITIES.schemaVersion, API_SCHEMA);
});

for (const fixture of invalidRequests) {
  Deno.test(`Study request rejects ${fixture.name} with a stable redacted rule`, () => {
    const result = validateRequest(fixture.input);
    assert(!result.ok);
    assert(
      result.issues.some(
        (issue) => issue.code === fixture.expectedCode && issue.ruleId === fixture.expectedRule,
      ),
      JSON.stringify(result),
    );
    assert(result.issues.every((issue) => issue.path.startsWith('/')));
    const serialized = JSON.stringify(result);
    assert(!serialized.includes('SYNTHETIC-NOT-A-REAL-TOKEN'));
    assert(!serialized.includes('private/key'));
  });
}

Deno.test(
  'Study fixture binds a frozen study, two scenarios, jobs, facts, review and disclosure',
  () => {
    const result = validateFixtureGraph(validGraph, OBSERVED_AT);
    assert(result.ok, JSON.stringify(result));
    assertEquals(result.value.scenarioRevisions.length, 2);
    assertEquals(
      result.value.runs.map((run) => run.calculationContractRef.schema),
      ['lca.calculation-contract.v1', 'lca.calculation-contract.v1'],
    );
  },
);

for (const fixture of invalidGraphs.cases) {
  Deno.test(`Study graph rejects ${fixture.name} at the expected relationship boundary`, () => {
    const graph = structuredClone(validGraph);
    for (const patch of fixture.patches) applyPatch(graph, patch.path, patch.value);
    const result = validateFixtureGraph(graph, invalidGraphs.observedAt);
    assert(!result.ok);
    assert(
      result.issues.some(
        (issue) => issue.code === fixture.expectedCode && issue.ruleId === fixture.expectedRule,
      ),
      JSON.stringify(result),
    );
  });
}

Deno.test('Study responses validate every public resource and all stable error codes', () => {
  const records = [
    ['modelSourceSnapshot', validGraph.modelSourceSnapshots[0]],
    ['modelPreparation', validGraph.modelPreparations[0]],
    ['study', validGraph.studies[0]],
    ['studyRevision', validGraph.studyRevisions[0]],
    ['scenarioRevision', validGraph.scenarioRevisions[0]],
    ['run', validGraph.runs[0]],
    ['analysis', validGraph.analyses[0]],
    ['reportRevision', validGraph.reports[0]],
    ['review', validGraph.reviews[0]],
    ['export', validGraph.exports[0]],
    ['share', validGraph.shares[0]],
  ];
  for (const [type, value] of records) {
    assert(
      responseSchema.safeParse({
        schemaVersion: API_SCHEMA,
        requestId: 'fixture-request',
        ok: true,
        data: { type, value },
      }).success,
    );
  }
  assert(
    responseSchema.safeParse({
      schemaVersion: API_SCHEMA,
      requestId: 'fixture-request',
      ok: true,
      data: {
        type: 'capabilities',
        contractVersion: CONTRACT_CAPABILITIES.contractVersion,
        runtimeEnabled: false,
        operations: OPERATIONS,
      },
    }).success,
  );
  for (const code of ERROR_CODES) {
    assert(
      responseSchema.safeParse({
        schemaVersion: API_SCHEMA,
        requestId: 'fixture-request',
        ok: false,
        code,
        message: 'Sanitized contract fixture.',
        retryable: false,
        issues: [],
      }).success,
    );
  }
  const secretResponse = {
    schemaVersion: API_SCHEMA,
    requestId: 'fixture-request',
    ok: true,
    data: {
      type: 'run',
      value: { ...validGraph.runs[0], accessToken: 'SYNTHETIC-NOT-A-REAL-TOKEN' },
    },
  };
  assertEquals(responseSchema.safeParse(secretResponse).success, false);
});

Deno.test(
  'Fixture preconditions distinguish resource generation, frozen content and content hash',
  () => {
    const save = validateRequest(
      validRequests.find((value) => (value as { operation: string }).operation === 'revision.save'),
    );
    assert(save.ok);
    assertEquals(validateFixturePrecondition(save.value, validGraph)[0]?.code, 'FROZEN_REVISION');
    const stale = structuredClone(save.value);
    assert('target' in stale);
    stale.target.expectedRevision = 1;
    assertEquals(
      validateFixturePrecondition(stale, validGraph)[0]?.ruleId,
      'precondition.target_generation',
    );
    stale.target.id = 'missing';
    assertEquals(validateFixturePrecondition(stale, validGraph)[0]?.code, 'NOT_FOUND');
    const freeze = validateRequest(
      validRequests.find(
        (value) => (value as { operation: string }).operation === 'revision.freeze',
      ),
    );
    assert(freeze.ok && 'expectedContentHash' in freeze.value);
    freeze.value.expectedContentHash = 'e'.repeat(64);
    assertEquals(
      validateFixturePrecondition(freeze.value, validGraph)[0]?.ruleId,
      'precondition.content_hash',
    );
  },
);

Deno.test(
  'CAS target types retain each operation literal and reject a foreign target at runtime',
  () => {
    type FreezeTarget = Extract<
      StudyApiRequest,
      { operation: 'revision.freeze' }
    >['target']['type'];
    const studyRevision: FreezeTarget = 'studyRevision';
    // @ts-expect-error A different resource must not become assignable through type widening.
    const reportRevision: FreezeTarget = 'reportRevision';
    assertEquals(studyRevision, 'studyRevision');
    const freeze = validRequests.find(
      (value) => (value as { operation: string }).operation === 'revision.freeze',
    ) as Record<string, unknown>;
    assertEquals(
      validateRequest({
        ...freeze,
        target: { type: reportRevision, id: 'report-rev-1', expectedRevision: 2 },
      }).ok,
      false,
    );
  },
);

Deno.test(
  'Expired exports retain expired and revoked share audit references without allowing active access',
  () => {
    for (const status of ['expired', 'revoked'] as const) {
      const graph = structuredClone(validGraph);
      graph.exports[0].status = 'expired';
      graph.shares[0].status = status;
      graph.shares[0].expiresAt = '2026-11-01T00:00:00Z';
      assert(validateFixtureGraph(graph, OBSERVED_AT).ok, status);
      graph.shares[0].projectionHash = 'e'.repeat(64);
      const changedBinding = validateFixtureGraph(graph, OBSERVED_AT);
      assert(!changedBinding.ok);
      assert(changedBinding.issues.some((issue) => issue.ruleId === 'share.exact_export'));
    }
  },
);

Deno.test('Structurally valid intent does not establish state, permission or authority', () => {
  const request = validRequests.find(
    (value) => (value as { operation: string }).operation === 'revision.save',
  );
  assert(validateRequest(request).ok);
  const parsed = validateRequest(request);
  assert(parsed.ok);
  assertEquals(validateFixturePrecondition(parsed.value, validGraph)[0]?.code, 'FROZEN_REVISION');
  assertEquals(validateFixtureGraph(validGraph, 'not-a-time').ok, false);
  // A syntactically valid, explicitly synthetic receipt is NOT a verified signature.
  assert(validGraph.exports[0].receipt?.signature.startsWith('SYNTHETIC_'));
});

Deno.test('Frozen unreviewed report can finalize only under an explicit no-review profile', () => {
  const graph = structuredClone(validGraph);
  graph.reports[0].finalization.reviewRequirement = 'none';
  graph.reports[0].finalization.reviewIds = [];
  graph.reports[0].finalization.profileId = 'fixture-unreviewed.v1';
  graph.reviews = [];
  graph.exports[0].reviewIds = [];
  assert(validateFixtureGraph(graph, OBSERVED_AT).ok);
});

Deno.test(
  'Later review withdrawal preserves history and cannot replace an earlier required approval',
  () => {
    const graph = structuredClone(validGraph);
    graph.reviews.push({
      ...graph.reviews[0],
      reviewId: 'review-withdrawal',
      decision: 'withdraw',
      decidedAt: '2026-11-03T00:00:00Z',
      supersedesReviewId: 'review-1',
    });
    assert(validateFixtureGraph(graph, '2026-11-04T00:00:00Z').ok);
    graph.reviews[1].decidedAt = '2026-11-01T23:00:00Z';
    // Make the append chain itself chronological; the withdrawal now precedes finalization.
    graph.reviews[0].decidedAt = '2026-11-01T22:00:00Z';
    const result = validateFixtureGraph(graph, OBSERVED_AT);
    assert(!result.ok);
    assert(result.issues.some((issue) => issue.ruleId === 'report.required_review'));
  },
);

Deno.test(
  'Every worker status is retained; result availability remains distinct from validity',
  () => {
    for (const status of [
      'queued',
      'running',
      'waiting',
      'blocked',
      'stale',
      'failed',
      'cancelled',
    ] as const) {
      const graph = structuredClone(validGraph);
      graph.runs[0].execution.status = status;
      graph.runs[0].resultRef = null;
      graph.analyses = [];
      graph.reports = [];
      graph.reviews = [];
      graph.exports = [];
      graph.shares = [];
      assert(validateFixtureGraph(graph, OBSERVED_AT).ok, status);
    }
    const graph = structuredClone(validGraph);
    graph.runs[0].validity.status = 'withdrawn';
    assert(validateFixtureGraph(graph, OBSERVED_AT).ok);
    assertEquals(graph.runs[0].execution.status, 'completed');
  },
);

Deno.test(
  'Request boundaries reject nonfinite quantities and preserve explicit numerical zero',
  () => {
    const source = validRequests.find(
      (value) => (value as { operation: string }).operation === 'scenario.save',
    ) as Record<string, unknown>;
    for (const value of [NaN, Infinity, -Infinity])
      assertEquals(
        validateRequest({ ...source, overrides: [{ path: '/parameters/energy/value', value }] }).ok,
        false,
      );
    assert(
      validateRequest({ ...source, overrides: [{ path: '/parameters/energy/value', value: 0 }] })
        .ok,
    );
  },
);

Deno.test('Method selection preserves two exact single-impact categories', () => {
  const request = validRequests.find(
    (value) => (value as { operation: string }).operation === 'revision.create',
  );
  const parsed = validateRequest(request);
  assert(parsed.ok && parsed.value.operation === 'revision.create');
  assertEquals(
    parsed.value.definition.methodRefs.map((ref) => ref.id),
    ['method-fixture', 'method-acid-fixture'],
  );
  assertEquals(
    parsed.value.definition.methodRefs.map((ref) => ref.version),
    ['01.00.000', '01.04.000'],
  );
});

Deno.test(
  'Model preparation issues no references before completion and binds Scenario CAS at freeze',
  () => {
    const pending = structuredClone(validGraph);
    pending.studies[0].currentRevisionId = null;
    pending.studyRevisions = [];
    pending.scenarioRevisions = [];
    pending.runs = [];
    pending.analyses = [];
    pending.reports = [];
    pending.reviews = [];
    pending.exports = [];
    pending.shares = [];
    pending.modelPreparations = [pending.modelPreparations[0]];
    pending.modelPreparations[0].execution.status = 'queued';
    pending.modelPreparations[0].modelRef = null;
    pending.modelPreparations[0].inputArtifactRef = null;
    assert(validateFixtureGraph(pending, OBSERVED_AT).ok);
    const draft = structuredClone(validGraph);
    draft.scenarioRevisions = [draft.scenarioRevisions[0]];
    draft.modelPreparations = draft.modelPreparations.slice(0, 2);
    draft.runs = [];
    draft.analyses = [];
    draft.reports = [];
    draft.reviews = [];
    draft.exports = [];
    draft.shares = [];
    const scenario = draft.scenarioRevisions[0];
    scenario.status = 'draft';
    scenario.revision = 1;
    scenario.modelPreparationId = null;
    scenario.effectiveModelRef = null;
    assert(validateFixtureGraph(draft, OBSERVED_AT).ok);
    const freeze = validateRequest({
      schemaVersion: API_SCHEMA,
      requestId: 'freeze-prepared',
      idempotencyKey: 'freeze-key',
      operation: 'scenario.freeze',
      target: { type: 'scenarioRevision', id: scenario.scenarioRevisionId, expectedRevision: 1 },
      expectedContentHash: scenario.contentHash,
      modelPreparationId: 'preparation-scenario-base',
    });
    assert(freeze.ok && freeze.value.operation === 'scenario.freeze');
    assertEquals(validateFixturePrecondition(freeze.value, draft), []);
    freeze.value.modelPreparationId = 'preparation-base';
    assertEquals(
      validateFixturePrecondition(freeze.value, draft)[0]?.ruleId,
      'precondition.prepared_model',
    );
  },
);

Deno.test(
  'Bounded resource pages constrain kind, Study, uniqueness and originating request',
  () => {
    const value = validGraph.studyRevisions[0];
    const page = {
      type: 'resourcePage',
      studyId: value.studyId,
      kind: 'studyRevision',
      items: [{ type: 'studyRevision', value }],
      nextCursor: null,
    };
    assert(resourcePageSchema.safeParse(page).success);
    assertEquals(resourcePageSchema.safeParse({ ...page, kind: 'run' }).success, false);
    assertEquals(
      resourcePageSchema.safeParse({ ...page, studyId: 'foreign-study' }).success,
      false,
    );
    assertEquals(
      resourcePageSchema.safeParse({ ...page, items: [page.items[0], page.items[0]] }).success,
      false,
    );
    assertEquals(
      resourcePageSchema.safeParse({ ...page, nextCursor: '?raw=scope' }).success,
      false,
    );
    const selected = validateRequest({
      schemaVersion: API_SCHEMA,
      requestId: 'page-request',
      operation: 'study.resources.list',
      studyId: value.studyId,
      kind: 'studyRevision',
      cursor: null,
      limit: 1,
    });
    assert(selected.ok);
    const response = { schemaVersion: API_SCHEMA, requestId: 'page-request', ok: true, data: page };
    assert(validateResponseForRequest(selected.value, response).ok);
    const another = {
      ...page,
      studyId: 'foreign-study',
      items: [{ type: 'studyRevision', value: { ...value, studyId: 'foreign-study' } }],
    };
    const wrongStudy = validateResponseForRequest(selected.value, { ...response, data: another });
    assert(!wrongStudy.ok && wrongStudy.issues[0].ruleId === 'page.request_selection');
    const oversized = {
      ...page,
      items: [
        ...page.items,
        { type: 'studyRevision', value: { ...value, revisionId: 'revision-2' } },
      ],
    };
    assert(resourcePageSchema.safeParse(oversized).success);
    assertEquals(
      validateResponseForRequest(selected.value, { ...response, data: oversized }).ok,
      false,
    );
    assertEquals(
      validateResponseForRequest(selected.value, { ...response, requestId: 'unrelated-request' })
        .ok,
      false,
    );
    const studies = { type: 'studyPage', items: [validGraph.studies[0]], nextCursor: null };
    assert(studyPageSchema.safeParse(studies).success);
    assertEquals(
      studyPageSchema.safeParse({ ...studies, items: [...studies.items, ...studies.items] })
        .success,
      false,
    );
  },
);

Deno.test(
  'Session recovery reads bind the requested revision, scenario and preparation identities',
  () => {
    const selections = [
      {
        operation: 'revision.read',
        field: 'revisionId',
        type: 'studyRevision',
        record: validGraph.studyRevisions[0],
      },
      {
        operation: 'scenario.read',
        field: 'scenarioRevisionId',
        type: 'scenarioRevision',
        record: validGraph.scenarioRevisions[0],
      },
      {
        operation: 'model.read',
        field: 'preparationId',
        type: 'modelPreparation',
        record: validGraph.modelPreparations[0],
      },
    ];
    for (const { operation, field, type, record } of selections) {
      const id = (record as Record<string, unknown>)[field];
      const request = validateRequest({
        schemaVersion: API_SCHEMA,
        requestId: 'resume',
        operation,
        [field]: id,
      });
      assert(request.ok);
      const response = {
        schemaVersion: API_SCHEMA,
        requestId: 'resume',
        ok: true,
        data: { type, value: record },
      };
      assert(validateResponseForRequest(request.value, response).ok);
      assertEquals(
        validateResponseForRequest(request.value, {
          ...response,
          data: { type, value: { ...record, [field]: 'another-record' } },
        }).ok,
        false,
      );
    }
  },
);

Deno.test('Producer responses bind exact selected source and frozen Run intent', () => {
  const origin = validGraph.modelSourceSnapshots[0];
  const sourceRequest = validateRequest({
    schemaVersion: API_SCHEMA,
    requestId: 'source-select',
    idempotencyKey: 'source-key',
    operation: 'model.source.resolve',
    studyId: origin.studyId,
    originRef: origin.originRef,
  });
  assert(sourceRequest.ok);
  const sourceResponse = {
    schemaVersion: API_SCHEMA,
    requestId: 'source-select',
    ok: true,
    data: { type: 'modelSourceSnapshot', value: origin },
  };
  assert(validateResponseForRequest(sourceRequest.value, sourceResponse).ok);
  assertEquals(
    validateResponseForRequest(sourceRequest.value, {
      ...sourceResponse,
      data: {
        type: 'modelSourceSnapshot',
        value: { ...origin, originRef: { ...origin.originRef, id: 'different-origin' } },
      },
    }).ok,
    false,
  );
  const run = validGraph.runs[0];
  const request = validateRequest({
    schemaVersion: API_SCHEMA,
    requestId: 'run-select',
    idempotencyKey: 'run-key',
    operation: 'run.submit',
    studyRevisionId: run.studyRevisionId,
    scenarioRevisionId: run.scenarioRevisionId,
    expectedInputHash: validGraph.modelPreparations[1].inputHash,
    calculationContractRef: run.calculationContractRef,
    profileId: run.profileId,
  });
  assert(request.ok);
  const response = {
    schemaVersion: API_SCHEMA,
    requestId: 'run-select',
    ok: true,
    data: { type: 'run', value: run },
  };
  assert(validateResponseForRequest(request.value, response).ok);
  assertEquals(
    validateResponseForRequest(request.value, {
      ...response,
      data: { type: 'run', value: { ...run, inputHash: 'e'.repeat(64) } },
    }).ok,
    false,
  );
});

Deno.test('Saved Scenario drafts retain old completed and failed preparation audit history', () => {
  const graph = structuredClone(validGraph);
  graph.scenarioRevisions = [graph.scenarioRevisions[0]];
  graph.modelPreparations = graph.modelPreparations.slice(0, 2);
  graph.runs = [];
  graph.analyses = [];
  graph.reports = [];
  graph.reviews = [];
  graph.exports = [];
  graph.shares = [];
  const scenario = graph.scenarioRevisions[0];
  scenario.status = 'draft';
  scenario.revision = 2;
  scenario.contentHash = 'a'.repeat(64);
  scenario.overrides = [{ path: '/parameters/energy/value', value: 0 }];
  scenario.modelPreparationId = null;
  scenario.effectiveModelRef = null;
  assert(validateFixtureGraph(graph, OBSERVED_AT).ok);
  const freeze = validateRequest({
    schemaVersion: API_SCHEMA,
    requestId: 'stale-preparation',
    operation: 'scenario.freeze',
    idempotencyKey: 'freeze-old-key',
    target: { type: 'scenarioRevision', id: scenario.scenarioRevisionId, expectedRevision: 2 },
    expectedContentHash: scenario.contentHash,
    modelPreparationId: graph.modelPreparations[1].preparationId,
  });
  assert(freeze.ok);
  assertEquals(
    validateFixturePrecondition(freeze.value, graph)[0]?.ruleId,
    'precondition.prepared_model',
  );
  graph.modelPreparations[1].execution.status = 'failed';
  graph.modelPreparations[1].modelRef = null;
  graph.modelPreparations[1].inputArtifactRef = null;
  graph.modelPreparations[1].inputHash = null;
  assert(validateFixtureGraph(graph, OBSERVED_AT).ok);
});

Deno.test('Model references cannot bootstrap through their own Scenario producer', () => {
  const graph = structuredClone(validGraph);
  graph.studyRevisions[0].modelPreparationId = graph.scenarioRevisions[0].modelPreparationId!;
  graph.modelPreparations.shift();
  graph.modelSourceSnapshots = [];
  const result = validateFixtureGraph(graph, OBSERVED_AT);
  assert(!result.ok);
  assert(result.issues.some((issue) => issue.ruleId === 'model.acyclic_provenance'));
});

Deno.test(
  'A later StudyRevision may adopt a qualified older Scenario preparation without a cycle',
  () => {
    const graph = structuredClone(validGraph);
    graph.studyRevisions.push({
      ...graph.studyRevisions[0],
      revisionId: 'study-rev-2',
      parentRevisionId: graph.studyRevisions[0].revisionId,
      modelPreparationId: graph.modelPreparations[1].preparationId,
      modelRef: graph.modelPreparations[1].modelRef!,
    });
    assert(validateFixtureGraph(graph, OBSERVED_AT).ok);
  },
);
