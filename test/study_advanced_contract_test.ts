import { assertEquals, assertRejects, assertThrows } from 'jsr:@std/assert';
import {
  analysisConfigHash,
  API_SCHEMA,
  parseRequest,
  parseResponse,
  validateResponseForRequest,
} from '../contracts/lca-study/v5/codec.ts';
import {
  parseRequest as parseLegacyRequest,
  parseResponse as parseLegacyResponse,
} from '../contracts/lca-study/v3/codec.ts';
import { type AdvancedConfig } from '../contracts/lca-study/v5/advanced.ts';
import {
  capabilitiesSchema,
  DISABLED_CAPABILITIES,
} from '../contracts/lca-study/v5/capabilities.ts';
const fixtures = new URL('./fixtures/lca-study-v5/', import.meta.url);
const read = async (name: string) => JSON.parse(await Deno.readTextFile(new URL(name, fixtures)));
const request = (analysis: {
  studyId: string;
  profileId: string;
  config: unknown;
  configHash: string;
}) => ({
  schemaVersion: API_SCHEMA,
  requestId: 'advanced-request',
  idempotencyKey: 'advanced-request-key',
  operation: 'analysis.request',
  studyId: analysis.studyId,
  profileId: analysis.profileId,
  config: analysis.config,
  configHash: analysis.configHash,
});

Deno.test(
  'V5 exact Worker OAT, uniform and empirical fixtures preserve configuration and hash domains',
  async () => {
    for (const file of ['input-oat.json', 'input-uniform.json', 'input-uncertainty.json']) {
      const { analysis } = await read(file);
      const wire = request(analysis);
      assertEquals<unknown>(parseRequest(wire), wire);
      assertEquals(await analysisConfigHash(analysis.config), analysis.configHash);
      const changed = structuredClone(analysis.config) as AdvancedConfig;
      changed.parameters[0].low = '0';
      assertEquals((await analysisConfigHash(changed)) === analysis.configHash, false);
      assertThrows(() => parseLegacyRequest({ ...wire, schemaVersion: 'lca.study-api.v3' }));
    }
  },
);

Deno.test(
  'V5 rejects profile confusion, extra authority and malformed or unbounded scientific settings',
  async () => {
    const { analysis } = await read('input-oat.json');
    const wire = request(analysis);
    for (const invalid of [
      { ...wire, profileId: 'lca.study-uncertainty-bounded.v1' },
      { ...wire, authorized: true },
      { ...wire, config: { ...(wire.config as object), kind: 'contribution' } },
      { ...wire, config: { ...(wire.config as object), methodRefs: [] } },
      {
        ...wire,
        config: {
          ...(wire.config as object),
          baselineRunId: 'ABCDEFAB-0000-4000-8000-000000000010',
        },
      },
    ])
      assertThrows(() => parseRequest(invalid));
    for (const [key, value] of [
      ['low', '1e309'],
      ['low', '-0'],
      ['high', '9'],
      ['baselineAmount', '12'],
      ['baselineAmount', '10.0'],
    ]) {
      const changed = structuredClone(wire);
      (changed.config as AdvancedConfig).parameters[0][key as 'low' | 'high' | 'baselineAmount'] =
        value;
      assertThrows(() => parseRequest(changed));
    }
    const duplicate = structuredClone(wire);
    (duplicate.config as AdvancedConfig).parameters.push(
      (duplicate.config as AdvancedConfig).parameters[0],
    );
    assertThrows(() => parseRequest(duplicate));
    await assertRejects(() => analysisConfigHash({ ...analysis.config, parameters: [] }));
  },
);

Deno.test(
  'V5 empirical width and supports and explicit independence are part of the closed contract',
  async () => {
    const { analysis } = await read('input-uncertainty.json');
    const wire = request(analysis);
    const config = wire.config as Extract<AdvancedConfig, { kind: 'uncertainty' }>;
    assertEquals(config.design.kind, 'jointEmpirical');
    for (const rows of [[], [['9', '10']], [['8']], [['12']], [['10.0']]]) {
      assertThrows(() =>
        parseRequest({ ...wire, config: { ...config, design: { kind: 'jointEmpirical', rows } } }),
      );
    }
    assertThrows(() =>
      parseRequest({
        ...wire,
        config: { ...config, design: { kind: 'independentUniform', independenceDeclared: false } },
      }),
    );
    assertThrows(() =>
      parseRequest({
        ...wire,
        config: {
          ...config,
          design: { kind: 'independentUniform', independenceDeclared: true, correlation: [] },
        },
      }),
    );
    assertThrows(() => parseRequest({ ...wire, config: { ...config, generator: 'random' } }));
    assertThrows(() => parseRequest({ ...wire, config: { ...config, sampleCount: 1 } }));
  },
);

Deno.test(
  'V5 binds Worker public records and resource pages without admitting them to strict V3 consumers',
  async () => {
    const record = await read('public-analysis-oat.json');
    const wire = parseRequest(request(record));
    const response = parseResponse({
      schemaVersion: API_SCHEMA,
      requestId: wire.requestId,
      ok: true,
      data: { type: 'analysis', value: record },
    });
    validateResponseForRequest(wire, response);
    assertThrows(() => parseLegacyResponse({ ...response, schemaVersion: 'lca.study-api.v3' }));
    assertThrows(() =>
      validateResponseForRequest(wire, { ...response, requestId: 'foreign-request' }),
    );
    const changed = structuredClone(record);
    changed.config.parameters[0].low = '8';
    assertThrows(() =>
      validateResponseForRequest(
        wire,
        parseResponse({ ...response, data: { type: 'analysis', value: changed } }),
      ),
    );
    assertThrows(() =>
      parseResponse({
        ...response,
        data: {
          type: 'resourcePage',
          studyId: record.studyId,
          kind: 'analysis',
          items: [
            { type: 'analysis', value: record },
            { type: 'analysis', value: record },
          ],
          nextCursor: null,
        },
      }),
    );
    assertThrows(() =>
      parseResponse({
        ...response,
        data: {
          type: 'resourcePage',
          studyId: '10000000-0000-4000-8000-000000000999',
          kind: 'analysis',
          items: [{ type: 'analysis', value: record }],
          nextCursor: null,
        },
      }),
    );
  },
);

Deno.test('V5 starts disabled and requires finalization and renderer 2.0.0 for new exports', () => {
  assertEquals(capabilitiesSchema.parse(DISABLED_CAPABILITIES), DISABLED_CAPABILITIES);
  assertThrows(() =>
    capabilitiesSchema.parse({
      ...DISABLED_CAPABILITIES,
      analysisProfiles: ['lca.study-sensitivity-oat.v1'],
    }),
  );
  assertThrows(() =>
    parseRequest({
      schemaVersion: API_SCHEMA,
      requestId: 'export',
      idempotencyKey: 'export-key',
      operation: 'export.request',
      reportRevisionId: '10000000-0000-4000-8000-000000000001',
      expectedContentHash: 'a'.repeat(64),
      rendererVersion: '1.0.0',
      viewModelVersion: 'lca.study-report-view.v2',
    }),
  );
  const exportRequest = {
    schemaVersion: API_SCHEMA,
    requestId: 'advanced-final-export',
    idempotencyKey: 'advanced-final-export-key',
    operation: 'export.request',
    reportRevisionId: '10000000-0000-4000-8000-000000000001',
    expectedContentHash: 'a'.repeat(64),
    finalizationId: '10000000-0000-4000-8000-000000000002',
    expectedReviewStateHash: 'b'.repeat(64),
    rendererVersion: '2.0.0',
    viewModelVersion: 'lca.study-report-view.v2',
  };
  assertEquals<unknown>(parseRequest(exportRequest), exportRequest);
  assertThrows(() => parseRequest({ ...exportRequest, rendererVersion: '1.0.0' }));
  assertThrows(() => parseLegacyRequest({ ...exportRequest, schemaVersion: 'lca.study-api.v3' }));
});
