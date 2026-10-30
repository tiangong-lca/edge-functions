import { assertEquals, assertRejects } from 'jsr:@std/assert';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { createLcaReleaseResultsHandler } from '../supabase/functions/lca_release_results/index.ts';
import {
  readResultQueryBytes,
  signResultQuery,
} from '../supabase/functions/_shared/result_query.ts';

const id = '87700000-0000-4000-8000-000000000901';
const publicationId = '87700000-0000-4000-8000-000000001201';
const artifactId = '87700000-0000-4000-8000-000000000701';
const secret = '0123456789abcdef0123456789abcdef';
const process = { id, version: '01.00.000' };
const descriptor = {
  publicationId,
  releaseRunId: '87700000-0000-4000-8000-000000001001',
  releaseVersion: '01.00.000',
  publishedAt: '2026-10-30T00:00:00Z',
  artifact: {
    schemaVersion: 'tiangong.query-artifact.v1',
    artifactId,
    manifestSha256: 'a'.repeat(64),
    manifestByteSize: 1000,
  },
  process,
  lciAvailable: true,
  lciaAvailable: true,
};
const queryProcess = {
  ...process,
  ordinal: 5,
  quantitativeReference: { meanAmount: 1, referenceUnit: 'kg' },
};
function wire(data: unknown) {
  return {
    schemaVersion: 'result.query.response.v1',
    publicationId,
    artifactId,
    source: process,
    data,
  };
}
function reply(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function request(query: unknown = { kind: 'overview' }, extra: Record<string, unknown> = {}) {
  return new Request('http://localhost/lca_release_results', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-actor', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'query',
      processId: id,
      processVersion: '01.00.000',
      query,
      ...extra,
    }),
  });
}
function setup(upstream?: typeof fetch, timeoutMs = 8000) {
  const observed = {
    actor: 0,
    source: 0,
    descriptor: 0,
    upstream: 0,
    visible: true,
    published: true,
  };
  const actor = createClient('http://127.0.0.1:61221', 'synthetic-anon', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        observed.source++;
        const url = new URL(String(input));
        assertEquals(url.pathname, '/rest/v1/processes');
        assertEquals(url.searchParams.get('id'), `eq.${id}`);
        assertEquals(url.searchParams.get('version'), 'eq.01.00.000');
        assertEquals(url.searchParams.get('state_code'), 'neq.120');
        assertEquals(
          new Headers((init as { headers?: HeadersInit })?.headers).get('Accept-Profile'),
          'public',
        );
        return reply(observed.visible ? [process] : []);
      },
    },
  });
  const service = createClient('http://127.0.0.1:61221', 'synthetic-service', {
    db: { schema: 'api' },
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        observed.descriptor++;
        assertEquals(new URL(String(input)).pathname, '/rest/v1/rpc/svc_result_query_resolve');
        const body = JSON.parse(String((init as { body?: unknown })?.body));
        assertEquals(body.p_process_id, id);
        assertEquals(body.p_process_version, process.version);
        return reply(
          observed.published
            ? { ok: true, data: descriptor }
            : { ok: false, status: 404, code: 'published_result_not_available' },
        );
      },
    },
  });
  const handler = createLcaReleaseResultsHandler({
    serviceSupabase: service as unknown as SupabaseClient,
    resolveActor: () => {
      observed.actor++;
      return Promise.resolve({
        ok: true,
        value: { userId: id, accessToken: 'test-actor', supabase: actor },
      });
    },
    resultQuery: {
      serviceUrl: 'https://query.example.invalid',
      secret,
      timeoutMs,
      fetch: async (input, init) => {
        observed.upstream++;
        assertEquals(String(input), 'https://query.example.invalid/internal/results/query');
        assertEquals((init as { redirect?: string })?.redirect, 'error');
        const headers = new Headers((init as { headers?: HeadersInit })?.headers);
        assertEquals(
          headers.get('x-query-signature'),
          await signResultQuery(
            secret,
            headers.get('x-query-timestamp')!,
            String((init as { body?: unknown })?.body),
          ),
        );
        const body = JSON.parse(String((init as { body?: unknown })?.body));
        assertEquals(body.artifact, descriptor.artifact);
        assertEquals(body.process, process);
        assertEquals(body.publicationId, publicationId);
        return upstream
          ? await upstream(input, init)
          : reply(wire({ process: queryProcess, lciAvailable: true, lciaAvailable: true }));
      },
    },
  });
  return { handler, observed };
}
Deno.test(
  'HDF5 query repeats actor RLS and publication authorization after warm reads and revocation',
  async () => {
    const { handler, observed } = setup();
    const first = await handler(request());
    assertEquals(first.status, 200);
    assertEquals(first.headers.get('Cache-Control'), 'no-store');
    const value = await first.json();
    assertEquals(value.data.data.process, {
      ...process,
      quantitativeReference: queryProcess.quantitativeReference,
    });
    assertEquals(value.data.artifact, undefined);
    const second = await handler(request());
    await second.body?.cancel();
    observed.published = false;
    const revoked = await handler(request());
    assertEquals(revoked.status, 404);
    await revoked.body?.cancel();
    assertEquals(
      [observed.actor, observed.source, observed.descriptor, observed.upstream],
      [3, 3, 3, 2],
    );
  },
);
Deno.test('invisible source and denied user never reach the internal result service', async () => {
  const { handler, observed } = setup();
  observed.visible = false;
  const result = await handler(request());
  assertEquals(result.status, 404);
  await result.body?.cancel();
  assertEquals(observed.descriptor, 0);
  assertEquals(observed.upstream, 0);
  const denied = createLcaReleaseResultsHandler({
    resolveActor: () =>
      Promise.resolve({ ok: false, response: new Response('unauthorized', { status: 401 }) }),
  });
  const response = await denied(request());
  assertEquals(response.status, 401);
  await response.body?.cancel();
});
Deno.test(
  'caller artifact overrides, page limits, long filters and oversized bodies are rejected',
  async () => {
    const { handler, observed } = setup();
    for (const input of [
      request({ kind: 'lci', limit: 1001 }),
      request({ kind: 'lci', limit: 20, filter: '结'.repeat(100) }),
      request({ kind: 'overview' }, { artifactId }),
      new Request('http://localhost/lca_release_results', {
        method: 'POST',
        body: 'x'.repeat(65537),
      }),
    ]) {
      const response = await handler(input);
      assertEquals(response.status, 400);
      await response.body?.cancel();
    }
    assertEquals(observed.actor, 0);
  },
);
Deno.test('cold preparation returns only bound result identity and retry guidance', async () => {
  const { handler } = setup(() =>
    Promise.resolve(
      reply(
        {
          schemaVersion: 'result.query.response.v1',
          status: 'preparing',
          artifactId,
          publicationId,
        },
        202,
      ),
    ),
  );
  const response = await handler(request());
  assertEquals(response.status, 202);
  assertEquals(response.headers.get('retry-after'), '2');
  assertEquals(await response.json(), {
    ok: true,
    mode: 'query',
    data: {
      schemaVersion: 'result.query.response.v1',
      status: 'preparing',
      artifactId,
      publicationId,
      source: process,
    },
  });
});
Deno.test(
  'LCIA and LCI preserve frozen units, signs and tiny values without leaking ordinals',
  async () => {
    const impact = {
      ordinal: 1,
      id,
      version: '01.00.000',
      key: 'climate',
      name: 'Frozen climate',
      unit: 'kg CO2 eq',
    };
    const lcia = setup(() =>
      Promise.resolve(reply(wire({ process: queryProcess, impacts: [[impact, -1e-20]] }))),
    );
    const a = await lcia.handler(request({ kind: 'lcia' }));
    assertEquals(a.status, 200);
    const av = await a.json();
    assertEquals(av.data.data.impacts[0].amount, -1e-20);
    assertEquals(av.data.data.impacts[0].method.unit, 'kg CO2 eq');
    assertEquals(av.data.data.impacts[0].method.ordinal, undefined);
    const item = {
      ordinal: 9,
      key: { flowId: id, flowVersion: '01.00.000', direction: 'Input', unit: 'kg', location: 'CN' },
      name: { baseName: 'Frozen flow' },
      classification: null,
    };
    const lci = setup(() =>
      Promise.resolve(
        reply(
          wire({
            process: queryProcess,
            items: [{ item, amount: -2 }],
            nextCursor: 'opaque',
            nonzeroCount: 2,
          }),
        ),
      ),
    );
    const b = await lci.handler(
      request({ kind: 'lci', limit: 1, cursor: 'prior', filter: 'flow' }),
    );
    assertEquals(b.status, 200);
    const bv = await b.json();
    assertEquals(bv.data.data.items[0], {
      key: item.key,
      name: item.name,
      classification: null,
      amount: -2,
    });
    assertEquals(bv.data.data.nextCursor, 'opaque');
  },
);
Deno.test(
  'wrong result identity, malformed numeric payload and upstream details fail closed',
  async () => {
    for (const response of [
      reply({
        ...wire({ process: queryProcess, lciAvailable: true, lciaAvailable: true }),
        artifactId: id,
      }),
      reply(
        wire({
          process: { ...queryProcess, version: '02.00.000' },
          lciAvailable: true,
          lciaAvailable: true,
        }),
      ),
      reply({ privateStorageUrl: 'secret' }, 500),
    ]) {
      const { handler } = setup(() => Promise.resolve(response));
      const value = await handler(request());
      assertEquals(value.status, 503);
      assertEquals((await value.text()).includes('secret'), false);
    }
  },
);
Deno.test('bounded response reading cancels excessive streams', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(65));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assertRejects(() => readResultQueryBytes(stream, 64));
  assertEquals(cancelled, true);
});
Deno.test('internal query timeout cancels transport and releases request capacity', async () => {
  const { handler } = setup(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = (init as { signal: AbortSignal }).signal;
        const fail = () => reject(new DOMException('aborted', 'AbortError'));
        if (signal.aborted) fail();
        else signal.addEventListener('abort', fail, { once: true });
      }),
    5,
  );
  const response = await handler(request());
  assertEquals(response.status, 503);
  await response.body?.cancel();
  const fresh = setup();
  const ready = await fresh.handler(request());
  assertEquals(ready.status, 200);
  await ready.body?.cancel();
});

Deno.test('HMAC matches the independent UTF-8 reference vector', async () => {
  assertEquals(
    await signResultQuery(secret, '1700000000', '{"hello":"结果"}'),
    '32c3605959249831d3d39350baf7adc1e70fd3cc3bd69bb9f34a39a3919155cf',
  );
});
