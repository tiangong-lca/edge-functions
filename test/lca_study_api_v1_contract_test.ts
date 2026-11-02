import { assert, assertEquals } from 'jsr:@std/assert';
import { z } from 'zod';
import {
  API_SCHEMA,
  CONTRACT_CAPABILITIES,
  ERROR_CODES,
  graphSchema,
  OPERATIONS,
  responseSchema,
  validateFixtureGraph,
  validateFixturePrecondition,
  validateRequest,
  type FixtureGraph,
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
