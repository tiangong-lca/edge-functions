import { assert, assertEquals } from 'jsr:@std/assert';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2.118.0';
import {
  API_SCHEMA,
  CONTRACT_VERSION,
  responseSchema,
  requestSchema,
  acquisitionSchema,
  type StudyApiRequest,
} from '../contracts/lca-study/v2/index.ts';
import {
  createStudyHandler,
  type HandlerOptions,
} from '../supabase/functions/_shared/study/handler.ts';
import {
  createStudyRepository,
  type StudyRepository,
} from '../supabase/functions/_shared/study/repository.ts';
import {
  DISABLED_CONFIG,
  P1_OPERATIONS,
  type RuntimeConfig,
} from '../supabase/functions/_shared/study/protocol.ts';
import type { ActorContext } from '../supabase/functions/_shared/command_runtime/actor_context.ts';
import {
  createPreparedInputValidator,
  sha256,
  preparedInputSchema,
} from '../supabase/functions/_shared/study/validator.ts';
const graph = JSON.parse(
  await Deno.readTextFile(new URL('./fixtures/lca-study-api/v1/valid-graph.json', import.meta.url)),
);
for (const p of graph.modelPreparations)
  p.methodRefs = graph.studyRevisions[0].definition.methodRefs;
const base = { schemaVersion: API_SCHEMA, requestId: 'request-1' };
const write = { ...base, idempotencyKey: 'key-1' };
const profile = {
  profileId: graph.runs[0].profileId,
  calculationContractRef: graph.runs[0].calculationContractRef,
};
const config: RuntimeConfig = {
  ...DISABLED_CONFIG,
  runtimeEnabled: true,
  operations: [...P1_OPERATIONS],
  profiles: [profile],
};
const actor: ActorContext = {
  userId: '11111111-1111-4111-8111-111111111111',
  accessToken: 'synthetic-jwt',
  supabase: {} as SupabaseClient,
};
const actorResult = async () => ({ ok: true as const, value: actor });
function fixture(overrides: Partial<StudyRepository> = {}, options: HandlerOptions = {}) {
  let calls = 0;
  const repository: StudyRepository = {
    dispatch: async () => {
      calls++;
      return { ok: true, data: { type: 'study', value: graph.studies[0] } };
    },
    consume: async () => {
      throw new Error('unexpected consume');
    },
    download: async () => {
      throw new Error('unexpected download');
    },
    ...overrides,
  };
  const handler = createStudyHandler({
    resolveActor: actorResult,
    repository: () => repository,
    config: () => config,
    validateRevision: null,
    ...options,
  });
  const send = (body: unknown, init: RequestInit = {}) =>
    handler(
      new Request('https://study.invalid', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...init,
      }),
    );
  return { handler, send, calls: () => calls };
}
async function code(response: Response) {
  const body = await response.json();
  assert(responseSchema.safeParse(body).success, JSON.stringify(body));
  return body.code;
}

Deno.test('Study runtime authenticates before parsing body or reaching repository', async () => {
  const f = fixture(
    {},
    {
      resolveActor: async () => ({
        ok: false,
        response: new Response('private upstream secret', { status: 401 }),
      }),
    },
  );
  assertEquals(await code(await f.send('malformed')), 'AUTH_REQUIRED');
  assertEquals(f.calls(), 0);
  const preflight = await f.handler(new Request('https://study.invalid', { method: 'OPTIONS' }));
  assertEquals(preflight.status, 200);
});
Deno.test(
  'Study runtime strict v2 schema and bounded transport redact submitted values',
  async () => {
    const f = fixture();
    for (const body of [
      { ...base, schemaVersion: 'lca.study-api.v1', operation: 'study.read', studyId: 'study-1' },
      { ...base, operation: 'study.read', studyId: 'study-1', secret: 'DO-NOT-ECHO' },
      {
        ...write,
        operation: 'revision.freeze',
        target: { type: 'studyRevision', id: 'x', expectedRevision: 1 },
        expectedContentHash: 'a'.repeat(64),
        validation: 'passed',
      },
      { ...base, operation: 'study.list', cursor: null, limit: 101 },
    ]) {
      const r = await f.send(body);
      assert(r.status >= 400);
      const text = await r.text();
      assert(!text.includes('DO-NOT-ECHO'));
      assert(responseSchema.safeParse(JSON.parse(text)).success);
    }
    assertEquals(await code(await f.send('x'.repeat(262144))), 'PAYLOAD_TOO_LARGE');
    assertEquals(await code(await f.send(base, { body: 'invalid-json' })), 'INVALID_REQUEST');
    assertEquals(
      await code(await f.send(base, { headers: { 'content-type': 'text/plain' } })),
      'INVALID_REQUEST',
    );
    assertEquals(
      await code(await f.handler(new Request('https://study.invalid', { method: 'GET' }))),
      'METHOD_NOT_ALLOWED',
    );
    assertEquals(f.calls(), 0);
  },
);
Deno.test('Study runtime operation/profile gates reject unavailable work before RPC', async () => {
  const f = fixture();
  assertEquals(
    await code(
      await f.send({ ...base, operation: 'analysis.read', analysisId: 'analysis-compare' }),
    ),
    'CAPABILITY_UNAVAILABLE',
  );
  assertEquals(
    await code(
      await f.send({
        ...write,
        operation: 'run.submit',
        studyRevisionId: 'study-rev-1',
        scenarioRevisionId: 'scenario-rev-base',
        expectedInputHash: 'a'.repeat(64),
        profileId: 'unknown',
        calculationContractRef: profile.calculationContractRef,
      }),
    ),
    'CAPABILITY_UNAVAILABLE',
  );
  assertEquals(f.calls(), 0);
});
Deno.test(
  'Study runtime base preparation requires exact method axes; Scenario derives them',
  async () => {
    const f = fixture();
    const source = graph.modelPreparations[0].source;
    const request = {
      ...write,
      operation: 'model.prepare',
      studyId: 'study-1',
      source,
      ...profile,
    };
    assertEquals(await code(await f.send(request)), 'INVALID_REQUEST');
    assertEquals(
      await code(
        await f.send({
          ...request,
          source: graph.modelPreparations[1].source,
          methodRefs: graph.studyRevisions[0].definition.methodRefs,
        }),
      ),
      'INVALID_REQUEST',
    );
    assertEquals(f.calls(), 0);
  },
);
Deno.test(
  'Study runtime exact response selection, CAS and idempotency errors stay distinct',
  async () => {
    const f = fixture();
    assertEquals(
      await code(await f.send({ ...base, operation: 'study.read', studyId: 'wrong-study' })),
      'REFERENCE_MISMATCH',
    );
    for (const c of ['REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'FORBIDDEN', 'NOT_FOUND']) {
      const r = await fixture({
        dispatch: async () => ({ ok: false, code: c, message: 'PRIVATE ERROR', details: 'secret' }),
      }).send({ ...base, operation: 'study.read', studyId: 'study-1' });
      assertEquals(await code(r), c);
    }
  },
);
Deno.test(
  'Study runtime deadline aborts actual in-flight dependency and returns no late success',
  async () => {
    let aborted = false;
    const f = fixture(
      {
        dispatch: (_r, signal) =>
          new Promise((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                resolve({ ok: true, data: { type: 'study', value: graph.studies[0] } });
              },
              { once: true },
            );
          }),
      },
      { timeoutMs: 5 },
    );
    assertEquals(
      await code(await f.send({ ...base, operation: 'study.read', studyId: 'study-1' })),
      'DEADLINE_EXCEEDED',
    );
    assert(aborted);
  },
);
Deno.test(
  'Study source acquisition recovers exact identity, never invents a snapshot while queued',
  async () => {
    const snapshot = graph.modelSourceSnapshots[0];
    const acquisition = {
      acquisitionId: 'acq-1',
      studyId: snapshot.studyId,
      originRef: snapshot.originRef,
      execution: { jobId: 'source-job', status: 'queued' },
      snapshot: null,
    };
    assert(acquisitionSchema.safeParse(acquisition).success);
    assert(!acquisitionSchema.safeParse({ ...acquisition, snapshot }).success);
    const f = fixture({
      dispatch: async () => ({
        ok: true,
        data: { type: 'modelSourceAcquisition', value: acquisition },
      }),
    });
    assertEquals(
      (
        await f.send({
          ...write,
          operation: 'model.source.resolve',
          studyId: snapshot.studyId,
          originRef: snapshot.originRef,
        })
      ).status,
      200,
    );
    assertEquals(
      (await f.send({ ...base, operation: 'model.source.read', acquisitionId: 'acq-1' })).status,
      200,
    );
    assertEquals(
      await code(await f.send({ ...base, operation: 'model.source.read', acquisitionId: 'wrong' })),
      'REFERENCE_MISMATCH',
    );
    const wrong = fixture({
      dispatch: async () => ({
        ok: true,
        data: {
          type: 'modelSourceAcquisition',
          value: { ...acquisition, originRef: { ...snapshot.originRef, version: '99.00.000' } },
        },
      }),
    });
    assertEquals(
      await code(
        await wrong.send({
          ...write,
          operation: 'model.source.resolve',
          studyId: snapshot.studyId,
          originRef: snapshot.originRef,
        }),
      ),
      'REFERENCE_MISMATCH',
    );
  },
);
Deno.test(
  'Study freeze uses server intent/validator and service consume, failures never synthesize passed',
  async () => {
    const revision = { ...graph.studyRevisions[0], status: 'draft', validation: 'not_checked' };
    const intent = {
      kind: 'revisionValidationIntent',
      intentId: 'intent-1',
      expiresAt: '2099-01-01T00:00:00Z',
      revision,
      preparation: graph.modelPreparations[0],
    };
    const request = {
      ...write,
      operation: 'revision.freeze',
      target: {
        type: 'studyRevision',
        id: revision.revisionId,
        expectedRevision: revision.revision,
      },
      expectedContentHash: revision.contentHash,
    };
    let consumed = 0;
    const repository = {
      dispatch: async () => ({ ok: true, data: intent }),
      consume: async (_id: string, decision: { outcome: string }) => {
        consumed++;
        return decision.outcome === 'passed'
          ? {
              ok: true,
              data: {
                type: 'studyRevision',
                value: {
                  ...revision,
                  status: 'frozen',
                  validation: 'passed',
                  revision: revision.revision + 1,
                },
              },
            }
          : { ok: false, code: 'REFERENCE_MISMATCH' };
      },
    };
    assertEquals(await code(await fixture(repository).send(request)), 'CAPABILITY_UNAVAILABLE');
    assertEquals(consumed, 0);
    const f = fixture(repository, { validateRevision: async () => ({ outcome: 'passed' }) });
    assertEquals((await f.send(request)).status, 200);
    assertEquals(consumed, 1);
    assertEquals(
      await code(
        await fixture(repository, {
          validateRevision: async () => ({ outcome: 'failed', code: 'REFERENCE_MISMATCH' }),
        }).send(request),
      ),
      'REFERENCE_MISMATCH',
    );
    const stale = fixture(
      {
        ...repository,
        dispatch: async () => ({
          ok: true,
          data: { ...intent, revision: { ...revision, revision: revision.revision + 1 } },
        }),
      },
      { validateRevision: async () => ({ outcome: 'passed' }) },
    );
    const before = consumed;
    assertEquals(await code(await stale.send(request)), 'REFERENCE_MISMATCH');
    assertEquals(consumed, before);
  },
);
Deno.test(
  'Study artifact verifies bytes, rejects wrong Study/locator and reauthorizes after I/O',
  async () => {
    const bytes = new TextEncoder().encode('{"value":0}');
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const artifactRef = { ...graph.runs[0].resultRef, byteSize: bytes.length, contentHash: hash };
    const cap = {
      kind: 'artifactCapability',
      studyId: 'study-1',
      artifactRef,
      storageBucket: 'private-study',
      storageObjectPath: 'study-1/result.json',
    };
    const request = { ...base, operation: 'artifact.read', studyId: 'study-1', artifactRef };
    const f = fixture({
      dispatch: async () => ({ ok: true, data: cap }),
      download: async () => bytes,
    });
    const r = await f.send(request);
    assertEquals(r.status, 200);
    const body = await r.json();
    assertEquals(atob(body.data.bytes), '{"value":0}');
    assert(!JSON.stringify(body).includes('private-study'));
    assertEquals(
      await code(
        await fixture({
          dispatch: async () => ({ ok: true, data: { ...cap, studyId: 'foreign' } }),
        }).send(request),
      ),
      'REFERENCE_MISMATCH',
    );
    assertEquals(
      await code(
        await fixture({
          dispatch: async () => ({ ok: true, data: { ...cap, storageObjectPath: '../secret' } }),
        }).send(request),
      ),
      'UPSTREAM_UNAVAILABLE',
    );
    assertEquals(
      await code(
        await fixture({
          dispatch: async () => ({ ok: true, data: cap }),
          download: async () => new Uint8Array([1]),
        }).send(request),
      ),
      'REFERENCE_MISMATCH',
    );
    let calls = 0;
    const withdrawn = fixture({
      dispatch: async () =>
        ++calls === 1 ? { ok: true, data: cap } : { ok: false, code: 'FORBIDDEN' },
      download: async () => bytes,
    });
    assertEquals(await code(await withdrawn.send(request)), 'FORBIDDEN');
    assertEquals(calls, 2);
  },
);
Deno.test(
  'Study actual SDK adapter forwards actor/api and service-only consume independently',
  async () => {
    const calls: Array<{
      url: string;
      authorization: string | null;
      profile: string | null;
      body: unknown;
    }> = [];
    const transport: typeof fetch = async (input, init) => {
      const r = new Request(input, init);
      calls.push({
        url: r.url,
        authorization: r.headers.get('authorization'),
        profile: r.headers.get('content-profile'),
        body: await r.json(),
      });
      return Response.json({ ok: true, data: { type: 'study', value: graph.studies[0] } });
    };
    function client(key: string, bearer?: string) {
      return createClient('https://sdk-study.invalid', key, {
        db: { schema: 'api' },
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
          fetch: transport,
          ...(bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {}),
        },
      }) as unknown as SupabaseClient;
    }
    const repository = createStudyRepository(client('publishable', 'actor-token'), () =>
      client('server-secret'),
    );
    for (const operation of ['study.read', 'study.create'] as const) {
      const value = requestSchema.parse(
        operation === 'study.read'
          ? { ...base, operation, studyId: 'study-1' }
          : { ...write, operation, scope: { kind: 'personal' }, title: 'study' },
      );
      await repository.dispatch(value, new AbortController().signal);
    }
    await repository.consume('intent-1', { outcome: 'passed' }, new AbortController().signal);
    assert(calls[0].url.endsWith('/rpc/qry_study_v1'));
    assert(calls[1].url.endsWith('/rpc/cmd_study_v1'));
    assert(calls[2].url.endsWith('/rpc/svc_study_revision_freeze_consume_v1'));
    assertEquals(
      calls.map((c) => c.profile),
      ['api', 'api', 'api'],
    );
    assertEquals(
      calls.map((c) => c.authorization),
      ['Bearer actor-token', 'Bearer actor-token', 'Bearer server-secret'],
    );
    assertEquals(calls[2].body, {
      p_intent_id: 'intent-1',
      p_outcome: 'passed',
      p_error_code: null,
    });
  },
);

Deno.test(
  'Study real default JWT boundary rejects malformed/foreign bearer without domain calls',
  async () => {
    const get = Deno.env.get;
    Deno.env.get = (name) =>
      ({
        SUPABASE_URL: 'https://jwt-study.invalid',
        SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic',
      })[name];
    let calls = 0;
    try {
      const handler = createStudyHandler({
        repository: () => {
          calls++;
          throw new Error('domain reached');
        },
        config: () => config,
      });
      for (const authorization of [
        undefined,
        'Bearer not-a-jwt',
        'Bearer e30.eyJpc3MiOiJodHRwczovL2ZvcmVpZ24uaW52YWxpZCJ9.bad',
      ]) {
        const r = await handler(
          new Request('https://study.invalid', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(authorization ? { authorization } : {}),
            },
            body: JSON.stringify({ ...base, operation: 'study.read', studyId: 'study-1' }),
          }),
        );
        assertEquals(await code(r), 'AUTH_REQUIRED');
      }
      assertEquals(calls, 0);
    } finally {
      Deno.env.get = get;
    }
  },
);

Deno.test(
  'Study actual Storage SDK consumes server-derived object and bounds hostile response bytes',
  async () => {
    const get = Deno.env.get,
      fetcher = globalThis.fetch;
    const bytes = new TextEncoder().encode('owner bytes');
    const artifactRef = {
      ...graph.runs[0].resultRef,
      contentHash: await sha256(bytes),
      byteSize: bytes.length,
    };
    const cap = {
      kind: 'artifactCapability',
      studyId: 'study-1',
      artifactRef,
      storageBucket: 'study-artifacts',
      storageObjectPath: 'study-1/run/result.json',
    };
    const calls: Request[] = [];
    let oversized = false;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      return new Response(oversized ? new Uint8Array(4 * 1024 * 1024 + 1) : bytes);
    };
    Deno.env.get = (name) =>
      ({
        SUPABASE_URL: 'https://storage-study.invalid',
        SUPABASE_SECRET_KEY: 'sb_secret_synthetic',
      })[name];
    try {
      const repository = createStudyRepository(actor.supabase);
      assertEquals(
        await repository.download(
          cap as Parameters<typeof repository.download>[0],
          new AbortController().signal,
        ),
        bytes,
      );
      assert(calls[0].url.endsWith('/storage/v1/object/study-artifacts/study-1/run/result.json'));
      assertEquals(calls[0].headers.get('authorization'), 'Bearer sb_secret_synthetic');
      oversized = true;
      let rejected = false;
      try {
        await repository.download(
          cap as Parameters<typeof repository.download>[0],
          new AbortController().signal,
        );
      } catch {
        rejected = true;
      }
      assert(rejected);
    } finally {
      Deno.env.get = get;
      globalThis.fetch = fetcher;
    }
  },
);

Deno.test(
  'Study qualified manifest validator checks actual bytes/producer bindings without semantic rehash',
  async () => {
    const definition = {
      ...graph.studyRevisions[0].definition,
      functionalUnit: { amount: '1', unit: 'kg', referenceFlowId: 'reference-flow' },
    };
    const flow = { id: 'reference-flow', version: '01.00.000' },
      port = { instanceId: 'one', exchangeId: 'reference' };
    // Synthetic shape fixture. Separate owner-produced qualification is required for runtime admission.
    const manifest = {
      schemaVersion: 'lca.study-prepared-input.v1',
      profileId: 'lca.study-explicit-v1',
      compilerVersion: 'study.compiler.v1',
      calculationContractRef: profile.calculationContractRef,
      sourceHash: 'a'.repeat(64),
      modelHash: 'b'.repeat(64),
      inputHash: null,
      methodSourceHash: 'c'.repeat(64),
      studyBinding: null,
      model: {
        schemaVersion: 'lca.study-normalized-model.v1',
        origin: { id: 'model', version: '01.00.000' },
        reference: port,
        overrides: [],
        instances: [],
        connections: [],
        cutoffs: [],
        sourceDocuments: [],
        qualityFindings: [],
      },
      numeric: {
        views: [],
        inventoryAxes: [],
        methodAxes: definition.methodRefs.map((r: { id: string; version: string }) => ({
          id: r.id,
          version: r.version,
          unit: 'kg',
        })),
        reference: { port, flow, unit: 'kg', pivot: 1 },
        a: [],
        b: [],
        c: [],
        y: [],
      },
      coverage: [],
      limits: {
        maxSourceBytes: 16777216,
        maxDocuments: 512,
        maxInstances: 64,
        maxViews: 128,
        maxExchanges: 4096,
        maxMethods: 25,
        maxNonzeros: 32768,
        maxDenseCells: 131072,
        maxArtifactBytes: 33554432,
        maxElapsedMillis: 30000,
        maxFunctionalUnitAmount: 1e12,
        maxOwnedBytes: 268435456,
      },
    };
    let bytes = new TextEncoder().encode(JSON.stringify(manifest));
    const artifactRef = {
      ...graph.modelPreparations[0].inputArtifactRef,
      schemaVersion: manifest.schemaVersion,
      byteSize: bytes.length,
      contentHash: await sha256(bytes),
    };
    const prep = {
      ...graph.modelPreparations[0],
      profileId: manifest.profileId,
      inputArtifactRef: artifactRef,
      modelRef: { ...graph.modelPreparations[0].modelRef, contentHash: manifest.modelHash },
    };
    const intent = {
      kind: 'revisionValidationIntent' as const,
      intentId: 'intent',
      expiresAt: '2099-01-01T00:00:00Z',
      revision: {
        ...graph.studyRevisions[0],
        status: 'draft',
        validation: 'not_checked',
        definition,
        modelRef: prep.modelRef,
      },
      preparation: prep,
    };
    const repository: StudyRepository = {
      dispatch: async () => ({
        ok: true,
        data: {
          kind: 'artifactCapability',
          studyId: 'study-1',
          artifactRef,
          storageBucket: 'private',
          storageObjectPath: 'prepared/input.json',
        },
      }),
      download: async () => bytes,
      consume: async () => {
        throw new Error('validator cannot mutate');
      },
    };
    const validate = createPreparedInputValidator(repository);
    assertEquals(await validate(intent, new AbortController().signal), { outcome: 'passed' });
    for (const patch of [
      {
        ...intent.revision.definition,
        functionalUnit: { ...definition.functionalUnit, amount: '1000000000001' },
      },
      { ...definition, methodRefs: [{ ...definition.methodRefs[0], version: '99.00.000' }] },
      { ...definition, functionalUnit: { ...definition.functionalUnit, unit: 'wrong' } },
    ]) {
      assertEquals(
        await validate(
          { ...intent, revision: { ...intent.revision, definition: patch } },
          new AbortController().signal,
        ),
        { outcome: 'failed', code: 'REFERENCE_MISMATCH' },
      );
    }
    bytes = new TextEncoder().encode('{"forged":true}');
    assertEquals(await validate(intent, new AbortController().signal), {
      outcome: 'failed',
      code: 'REFERENCE_MISMATCH',
    });
  },
);

Deno.test(
  'Study consumes unchanged actual Worker compiler cement manifest with diagnostic gaps',
  async () => {
    const bytes = await Deno.readFile(
      new URL('./fixtures/lca-study-api/v2/worker-cement-prepared.artifact', import.meta.url),
    );
    const hash = await sha256(bytes);
    assertEquals(hash, '2c2973070d318cf28c8a0cc099b0f938c055c039a25217854356d5ef59275adf');
    const manifest = preparedInputSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    assert(manifest.studyBinding);
    assertEquals(manifest.coverage.length, 5);
    assert(manifest.model.qualityFindings.some((f) => f.includes('TASK_AUTHORED_TEST_MODEL')));
    const artifactRef = {
      ...graph.modelPreparations[0].inputArtifactRef,
      id: 'actual-worker-input',
      schemaVersion: manifest.schemaVersion,
      byteSize: bytes.length,
      contentHash: hash,
    };
    const prep = {
      ...graph.modelPreparations[0],
      profileId: manifest.profileId,
      calculationContractRef: manifest.calculationContractRef,
      inputArtifactRef: artifactRef,
      inputHash: manifest.inputHash,
      methodRefs: manifest.studyBinding.definition.methodRefs,
      modelRef: { ...graph.modelPreparations[0].modelRef, contentHash: manifest.modelHash },
    };
    const revision = {
      ...graph.studyRevisions[0],
      revisionId: manifest.studyBinding.studyRevisionId,
      contentHash: manifest.studyBinding.studyRevisionContentHash,
      definition: manifest.studyBinding.definition,
      modelRef: prep.modelRef,
      status: 'draft',
      validation: 'not_checked',
    };
    const repository: StudyRepository = {
      dispatch: async () => ({
        ok: true,
        data: {
          kind: 'artifactCapability',
          studyId: revision.studyId,
          artifactRef,
          storageBucket: 'study-input',
          storageObjectPath: 'compiler/manifest.json',
        },
      }),
      download: async () => bytes,
      consume: async () => {
        throw new Error('must not write');
      },
    };
    assertEquals(
      await createPreparedInputValidator(repository)(
        {
          kind: 'revisionValidationIntent',
          intentId: 'owner-fixture-intent',
          expiresAt: '2099-01-01T00:00:00Z',
          revision,
          preparation: prep,
        },
        new AbortController().signal,
      ),
      { outcome: 'passed' },
    );
  },
);

Deno.test(
  'Study absolute deadline rejects synchronous late SDK replies before a success can escape',
  async () => {
    const f = fixture(
      {
        dispatch: () => {
          const end = performance.now() + 20;
          while (performance.now() < end) {
            /* bounded CPU fixture */
          }
          return Promise.resolve({ ok: true, data: { type: 'study', value: graph.studies[0] } });
        },
      },
      { timeoutMs: 5 },
    );
    assertEquals(
      await code(await f.send({ ...base, operation: 'study.read', studyId: 'study-1' })),
      'DEADLINE_EXCEEDED',
    );
  },
);

Deno.test(
  'Study maximum 4 MiB artifact succeeds; above-limit descriptors reject before download',
  async () => {
    const bytes = new Uint8Array(4 * 1024 * 1024).fill(97);
    const artifactRef = {
      ...graph.runs[0].resultRef,
      byteSize: bytes.length,
      contentHash: await sha256(bytes),
    };
    const cap = {
      kind: 'artifactCapability',
      studyId: 'study-1',
      artifactRef,
      storageBucket: 'study-artifacts',
      storageObjectPath: 'study-1/max.bin',
    };
    let downloads = 0;
    const f = fixture({
      dispatch: async () => ({ ok: true, data: cap }),
      download: async () => {
        downloads++;
        return bytes;
      },
    });
    const r = await f.send({
      ...base,
      operation: 'artifact.read',
      studyId: 'study-1',
      artifactRef,
    });
    assertEquals(r.status, 200);
    const body = await r.json();
    assert(responseSchema.safeParse(body).success);
    assertEquals(body.data.bytes.length, 5592408);
    assertEquals(atob(body.data.bytes).length, bytes.length);
    const large = { ...artifactRef, byteSize: bytes.length + 1 };
    const rejected = fixture({
      dispatch: async () => ({ ok: true, data: { ...cap, artifactRef: large } }),
      download: async () => {
        downloads++;
        return bytes;
      },
    });
    assertEquals(
      await code(
        await rejected.send({
          ...base,
          operation: 'artifact.read',
          studyId: 'study-1',
          artifactRef: large,
        }),
      ),
      'PAYLOAD_TOO_LARGE',
    );
    assertEquals(downloads, 1);
  },
);

Deno.test(
  'Study actual PostgREST permission/auth revocation stays nonretryable and sanitized',
  async () => {
    for (const [pgcode, status, expected] of [
      ['42501', 403, 'FORBIDDEN'],
      ['PGRST301', 401, 'AUTH_REQUIRED'],
      ['22023', 400, 'INVALID_REQUEST'],
      ['XX000', 502, 'UPSTREAM_UNAVAILABLE'],
    ] as const) {
      const client = createClient('https://rpc-errors.invalid', 'synthetic-key', {
        db: { schema: 'api' },
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
          fetch: async () =>
            Response.json(
              { code: pgcode, message: 'PRIVATE-DATABASE-DETAIL' },
              { status: pgcode === '42501' ? 403 : pgcode === 'PGRST301' ? 401 : 500 },
            ),
        },
      }) as unknown as SupabaseClient;
      const handler = createStudyHandler({
        resolveActor: async () => ({ ok: true, value: { ...actor, supabase: client } }),
        config: () => config,
      });
      const response = await handler(
        new Request('https://study.invalid', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...base, operation: 'study.read', studyId: 'study-1' }),
        }),
      );
      assertEquals(response.status, status);
      const serialized = await response.text();
      assert(!serialized.includes('PRIVATE-DATABASE-DETAIL'));
      const body = JSON.parse(serialized);
      assertEquals(body.code, expected);
      assertEquals(body.retryable, pgcode === 'XX000');
    }
  },
);

Deno.test(
  'Study preparation recovery retains exact method selection and rejects mismatched producer acknowledgment',
  async () => {
    const p = graph.modelPreparations[0];
    const f = fixture({
      dispatch: async () => ({ ok: true, data: { type: 'modelPreparation', value: p } }),
    });
    assertEquals(
      (await f.send({ ...base, operation: 'model.read', preparationId: p.preparationId })).status,
      200,
    );
    const request = {
      ...write,
      operation: 'model.prepare',
      studyId: p.studyId,
      source: p.source,
      profileId: p.profileId,
      calculationContractRef: p.calculationContractRef,
      methodRefs: p.methodRefs,
    };
    assertEquals((await f.send(request)).status, 200);
    assertEquals(
      await code(await f.send({ ...request, methodRefs: [p.methodRefs[1], p.methodRefs[0]] })),
      'REFERENCE_MISMATCH',
    );
  },
);

Deno.test(
  'Study capabilities intersect deployment and current Database client grants; default remains disabled',
  async () => {
    const database = {
      type: 'capabilities',
      contractVersion: CONTRACT_VERSION,
      runtimeEnabled: true,
      operations: ['capability.read', 'study.read'],
      profiles: [],
    };
    const f = fixture({ dispatch: async () => ({ ok: true, data: database }) });
    const body = await (await f.send({ ...base, operation: 'capability.read' })).json();
    assertEquals(body.data.operations, ['capability.read', 'study.read']);
    assertEquals(body.data.profiles, []);
    const disabled = fixture(
      { dispatch: async () => ({ ok: true, data: database }) },
      { config: () => DISABLED_CONFIG },
    );
    const value = await (await disabled.send({ ...base, operation: 'capability.read' })).json();
    assertEquals(value.data.runtimeEnabled, false);
    assertEquals(value.data.operations, ['capability.read']);
    assertEquals(
      await code(await disabled.send({ ...base, operation: 'study.read', studyId: 'study-1' })),
      'CAPABILITY_UNAVAILABLE',
    );
  },
);

Deno.test(
  'Study actual PostgreSQL owner DTOs survive handler and real SDK wire projection',
  async () => {
    const dtos = JSON.parse(
      await Deno.readTextFile(
        new URL('./fixtures/lca-study-api/v2/database-public-dtos.json', import.meta.url),
      ),
    );
    const selections: Record<string, object> = {
      capabilities: { operation: 'capability.read' },
      study: { operation: 'study.read', studyId: dtos.study.data.value.studyId },
      revision: { operation: 'revision.read', revisionId: dtos.revision.data.value.revisionId },
      scenario: {
        operation: 'scenario.read',
        scenarioRevisionId: dtos.scenario.data.value.scenarioRevisionId,
      },
      preparation: {
        operation: 'model.read',
        preparationId: dtos.preparation.data.value.preparationId,
      },
      acquisition: {
        operation: 'model.source.read',
        acquisitionId: dtos.acquisition.data.value.acquisitionId,
      },
      page: {
        operation: 'study.resources.list',
        studyId: dtos.page.data.studyId,
        kind: dtos.page.data.kind,
        cursor: null,
        limit: 100,
      },
    };
    let projection: unknown;
    const client = createClient('https://postgres-dto-study.invalid', 'synthetic-key', {
      db: { schema: 'api' },
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: { Authorization: 'Bearer synthetic-actor' },
        fetch: async (input, init) => {
          const request = new Request(input, init);
          assert(request.url.endsWith('/rpc/qry_study_v1'));
          assertEquals(request.headers.get('content-profile'), 'api');
          assertEquals(request.headers.get('authorization'), 'Bearer synthetic-actor');
          return Response.json(projection);
        },
      },
    }) as unknown as SupabaseClient;
    const handler = createStudyHandler({
      resolveActor: async () => ({ ok: true, value: { ...actor, supabase: client } }),
      config: () => config,
    });
    for (const [name, selection] of Object.entries(selections)) {
      projection = dtos[name];
      const response = await handler(
        new Request('https://study.invalid', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...base, ...selection }),
        }),
      );
      assertEquals(response.status, 200, name);
      assert(responseSchema.safeParse(await response.json()).success, name);
    }
  },
);

Deno.test(
  'Study actual PostgreSQL definition vectors match the authoritative v2 inherited schema',
  async () => {
    const { definitionSchema } = await import('../contracts/lca-study/v1/records.ts');
    const cases = JSON.parse(
      await Deno.readTextFile(
        new URL('./fixtures/lca-study-api/v2/database-definition-vectors.json', import.meta.url),
      ),
    );
    assertEquals(cases.length, 32);
    for (const c of cases) {
      assertEquals(c.dbAccepted, c.expected, c.name);
      assertEquals(definitionSchema.safeParse(c.definition).success, c.dbAccepted, c.name);
    }
  },
);

Deno.test(
  'Study live qualification refuses remote/alternate projects before any account operation',
  async () => {
    const { localConfigSchema } = await import('../scripts/qualify-study-core.ts');
    const config = {
      schemaVersion: 'lca.study-local-core-config.v1',
      projectId: 'study894',
      supabaseUrl: 'http://127.0.0.1:56421',
      publishableKey: 'synthetic',
      serviceKey: 'synthetic',
      fixturePath: '/tmp/synthetic.json',
    };
    assert(localConfigSchema.safeParse(config).success);
    for (const patch of [
      { supabaseUrl: 'https://production.invalid' },
      { supabaseUrl: 'http://localhost:56421' },
      { supabaseUrl: 'http://127.0.0.1:54321' },
      { projectId: 'other-project' },
    ])
      assertEquals(localConfigSchema.safeParse({ ...config, ...patch }).success, false);
  },
);

Deno.test(
  'Study Database expiry and revocation still reject unconsumed intents and stale receipt access',
  async () => {
    const dbNow = Date.now(),
      ttl = dbNow + 120000;
    const revision = { ...graph.studyRevisions[0], status: 'draft', validation: 'not_checked' };
    const intent = {
      kind: 'revisionValidationIntent',
      intentId: 'unconsumed-intent',
      expiresAt: new Date(ttl).toISOString(),
      revision,
      preparation: graph.modelPreparations[0],
    };
    const request = {
      ...write,
      operation: 'revision.freeze',
      target: {
        type: 'studyRevision',
        id: revision.revisionId,
        expectedRevision: revision.revision,
      },
      expectedContentHash: revision.contentHash,
    };
    let dbClock = ttl + 1,
      validateCalls = 0,
      consumeAttempts = 0,
      writes = 0;
    const transport: typeof fetch = async (input, init) => {
      const r = new Request(input, init);
      if (r.url.endsWith('/rpc/cmd_study_v1'))
        return Response.json(
          dbClock < ttl
            ? { ok: true, data: intent }
            : { ok: false, code: 'CAPABILITY_UNAVAILABLE' },
        );
      consumeAttempts++;
      if (dbClock >= ttl) return Response.json({ ok: false, code: 'CAPABILITY_UNAVAILABLE' });
      writes++;
      return Response.json({
        ok: true,
        data: {
          type: 'studyRevision',
          value: {
            ...revision,
            status: 'frozen',
            validation: 'passed',
            revision: revision.revision + 1,
          },
        },
      });
    };
    const client = (key: string) =>
      createClient('https://freeze-expired.invalid', key, {
        db: { schema: 'api' },
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: transport },
      }) as unknown as SupabaseClient;
    const f = fixture(
      createStudyRepository(client('actor'), () => client('service')),
      {
        validateRevision: async () => {
          validateCalls++;
          dbClock = ttl + 1;
          return { outcome: 'passed' };
        },
      },
    );
    assertEquals(await code(await f.send(request)), 'CAPABILITY_UNAVAILABLE');
    assertEquals(validateCalls, 0);
    assertEquals(consumeAttempts, 0);
    dbClock = dbNow;
    assertEquals(await code(await f.send(request)), 'CAPABILITY_UNAVAILABLE');
    assertEquals(validateCalls, 1);
    assertEquals(consumeAttempts, 1);
    assertEquals(writes, 0);
    const revoked = fixture(
      { dispatch: async () => ({ ok: false, code: 'FORBIDDEN' }) },
      {
        validateRevision: async () => {
          writes++;
          return { outcome: 'passed' };
        },
      },
    );
    assertEquals(await code(await revoked.send(request)), 'FORBIDDEN');
    assertEquals(writes, 0);
  },
);

Deno.test(
  'Study actual PostgreSQL freeze replies recover a lost success after TTL despite host clock skew',
  async () => {
    const source = JSON.parse(
      await Deno.readTextFile(
        new URL('./fixtures/lca-study-api/v2/database-freeze-recovery-dtos.json', import.meta.url),
      ),
    );
    const intent = source.originalIntentAtIssue.data,
      expires = Date.parse(intent.expiresAt);
    const request = source.committedAfterTtl.request;
    let committed = false,
      validations = 0,
      consumes = 0;
    const transport: typeof fetch = async (input, init) => {
      const r = new Request(input, init);
      if (r.url.endsWith('/rpc/cmd_study_v1'))
        return Response.json(
          committed ? source.committedAfterTtl.result : source.originalIntentAtIssue,
        );
      assert(r.url.endsWith('/rpc/svc_study_revision_freeze_consume_v1'));
      assertEquals((await r.json()).p_intent_id, intent.intentId);
      consumes++;
      committed = true;
      return Response.json(source.committedAfterTtl.result);
    };
    const client = (key: string) =>
      createClient('https://sql-freeze-recovery.invalid', key, {
        db: { schema: 'api' },
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: transport },
      }) as unknown as SupabaseClient;
    const f = fixture(
      createStudyRepository(client('actor'), () => client('service')),
      {
        config: () => ({
          ...config,
          profiles: [
            {
              profileId: intent.preparation.profileId,
              calculationContractRef: intent.preparation.calculationContractRef,
            },
          ],
        }),
        validateRevision: async () => {
          validations++;
          return { outcome: 'passed' };
        },
      },
    );
    const originalNow = Date.now;
    let hostNow = expires - 120000 + 332000;
    Date.now = () => hostNow;
    try {
      const lost = await f.send(request);
      assertEquals(lost.status, 200);
      await lost.body?.cancel();
      hostNow = expires + 86400000;
      const replay = await f.send({ ...request, requestId: 'sql-recovered-after-ttl' });
      assertEquals(replay.status, 200);
      const body = await replay.json();
      assertEquals(body.data, source.committedAfterTtl.result.data);
      assertEquals(validations, 1);
      assertEquals(consumes, 1);
    } finally {
      Date.now = originalNow;
    }
    const malformed = fixture(
      {
        dispatch: async () => ({
          ...source.originalIntentAtIssue,
          data: { ...intent, expiresAt: 'not-a-timestamp' },
        }),
      },
      {
        validateRevision: async () => {
          throw new Error('malformed intent must not validate');
        },
      },
    );
    assertEquals(await code(await malformed.send(request)), 'UPSTREAM_UNAVAILABLE');
  },
);

Deno.test(
  'Study actual PostgreSQL expired and revoked actor replays never validate or consume',
  async () => {
    const source = JSON.parse(
      await Deno.readTextFile(
        new URL('./fixtures/lca-study-api/v2/database-freeze-recovery-dtos.json', import.meta.url),
      ),
    );
    let validations = 0,
      consumes = 0;
    for (const [name, expected] of [
      ['expiredUnconsumed', 'CAPABILITY_UNAVAILABLE'],
      ['revokedCaller', 'FORBIDDEN'],
    ]) {
      const vector = source[name];
      const client = createClient('https://sql-freeze-negative.invalid', 'actor', {
        db: { schema: 'api' },
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: async () => Response.json(vector.result) },
      }) as unknown as SupabaseClient;
      const repository = createStudyRepository(client, () => {
        consumes++;
        throw new Error('actor rejection must not consume');
      });
      const f = fixture(repository, {
        validateRevision: async () => {
          validations++;
          return { outcome: 'passed' };
        },
      });
      assertEquals(await code(await f.send(vector.request)), expected, name);
    }
    assertEquals(validations, 0);
    assertEquals(consumes, 0);
  },
);
