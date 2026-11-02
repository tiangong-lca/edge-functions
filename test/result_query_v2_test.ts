import { assertEquals, assertMatch, assertRejects } from 'jsr:@std/assert';
import './fixtures/final-result-gateway.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { createLcaReleaseResultsHandler } from '../supabase/functions/lca_release_results/index.ts';
import { signResultQuery } from '../supabase/functions/_shared/result_query.ts';
import {
  finalDownloadTarget,
  type FinalDownloadConfig,
} from '../supabase/functions/_shared/result_download_v2.ts';

// SDK test roots merge several fetch overloads; inspect the browser transport fields explicitly.
function fetchInit(
  value: unknown,
): { headers?: HeadersInit; body?: unknown; redirect?: string; signal?: AbortSignal } | undefined {
  return value as
    { headers?: HeadersInit; body?: unknown; redirect?: string; signal?: AbortSignal } | undefined;
}
const id = (n: number) => `87700000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const result = { uuid: id(1), version: '01.00.000' };
const publicationId = id(2);
const runtimeRevision = id(3);
const secret = '0123456789abcdef0123456789abcdef';
const descriptor = {
  publicationId,
  releaseVersion: '2026.11.1',
  scope: { kind: 'publication', publicationId },
  artifact: {
    schemaVersion: 'tiangong.query-artifact.v2',
    artifactId: id(4),
    manifestSha256: 'a'.repeat(64),
    manifestByteSize: 1000,
  },
  result,
  relationKind: 'derived',
  lciAvailable: true,
  lciaAvailable: true,
  runtimeRevision,
  readerSha256: 'b'.repeat(64),
};
const inventory = {
  flowId: id(5),
  flowVersion: '01.00.000',
  flowName: 'Carbon dioxide',
  flowClassification: ['air'],
  direction: 'Output',
  location: 'CN',
  functionType: 'General reminder flow',
  unit: {
    flowPropertyId: id(6),
    flowPropertyVersion: '01.00.000',
    unitGroupId: id(7),
    unitGroupVersion: '02.00.000',
    internalId: '0',
    name: 'kg',
  },
};
const row = {
  ...result,
  quantitativeReference: { ...inventory, value: -2, amountField: 'resultingAmount' },
  relationKind: 'derived',
};
const overview = { result: row, lciAvailable: true, lciaAvailable: true };
const config = {
  databaseTargetHash: 'd'.repeat(64),
  bucket: 'synthetic-results',
  region: 'us-east-1',
  endpoint: 'https://storage.example.invalid/',
  prefix: 'test-owned',
  accessKeyId: 'synthetic-access',
  secretAccessKey: 'synthetic-secret',
};
function reply(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function wire(data: unknown = overview) {
  return {
    schemaVersion: 'result.query.response.v2',
    reader: {
      schemaVersion: 'tiangong.final-result-reader.v1',
      executableSha256: descriptor.readerSha256,
    },
    scope: descriptor.scope,
    artifactId: descriptor.artifact.artifactId,
    result,
    data,
  };
}
function request(extra: Record<string, unknown> = {}) {
  return new Request('http://localhost/lca_release_results', {
    method: 'POST',
    headers: { Authorization: 'Bearer synthetic-actor', 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'final_query',
      resultId: result.uuid,
      resultVersion: result.version,
      query: { kind: 'overview' },
      ...extra,
    }),
  });
}
function setup(
  options: {
    database?: (name: string, args: Record<string, unknown>, count: number) => unknown;
    reader?: typeof fetch;
    timeoutMs?: number;
    serviceUrl?: string;
    downloadConfig?: FinalDownloadConfig;
    downloadFetch?: typeof fetch;
    downloadServiceCredentials?: () => { url: string; key: string };
  } = {},
) {
  const counts = { actor: 0, database: 0, reader: 0 };
  const actor = createClient('http://127.0.0.1:61431', 'synthetic-anon', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { Authorization: 'Bearer synthetic-actor' },
      fetch: async (input, init) => {
        counts.database++;
        const url = new URL(String(input));
        assertEquals(url.pathname.startsWith('/rest/v1/rpc/'), true);
        const headers = new Headers(fetchInit(init)?.headers);
        assertEquals(headers.get('Content-Profile'), 'api');
        assertEquals(headers.get('Authorization'), 'Bearer synthetic-actor');
        assertEquals(fetchInit(init)?.signal instanceof AbortSignal, true);
        const name = url.pathname.split('/').pop()!;
        const args = JSON.parse(String(fetchInit(init)?.body));
        if (options.database) return reply(options.database(name, args, counts.database));
        assertEquals(name, 'qry_final_result_query_v2');
        assertEquals(args.p_result_id, result.uuid);
        assertEquals(args.p_result_version, result.version);
        return reply({ ok: true, data: descriptor });
      },
    },
  });
  const handler = createLcaReleaseResultsHandler({
    resolveActor: () => {
      counts.actor++;
      return Promise.resolve({
        ok: true,
        value: { userId: id(9), accessToken: 'synthetic-actor', supabase: actor },
      });
    },
    get serviceSupabase(): never {
      throw new Error('v2 must never construct a service client');
    },
    finalDownload: {
      config: options.downloadConfig ?? config,
      fetch: options.downloadFetch,
      serviceCredentials: options.downloadServiceCredentials ?? (() => serviceCredentials),
      timeoutMs: options.timeoutMs,
    },
    resultQuery: {
      serviceUrl: options.serviceUrl ?? 'https://query.example.invalid',
      secret,
      timeoutMs: options.timeoutMs,
      fetch: async (input, init) => {
        counts.reader++;
        assertEquals(String(input), 'https://query.example.invalid/internal/results/query-v2');
        assertEquals(fetchInit(init)?.redirect, 'error');
        const headers = new Headers(fetchInit(init)?.headers);
        assertEquals(
          headers.get('x-query-signature'),
          await signResultQuery(
            secret,
            headers.get('x-query-timestamp')!,
            String(fetchInit(init)?.body),
          ),
        );
        const body = JSON.parse(String(fetchInit(init)?.body));
        assertEquals(body.schemaVersion, 'result.query.request.v2');
        assertEquals(body.scope, descriptor.scope);
        assertEquals(body.artifact, descriptor.artifact);
        assertEquals(body.result, result);
        return options.reader ? options.reader(input, init) : reply(wire());
      },
    },
  });
  return { handler, counts };
}
Deno.test(
  'v2 derived Result uses actor exact identity without loading hidden source processes, and rechecks every read',
  async () => {
    const { handler, counts } = setup();
    for (let n = 0; n < 2; n++) {
      const response = await handler(request());
      const value = await response.json();
      assertEquals(response.status, 200);
      assertEquals(response.headers.get('Cache-Control'), 'no-store');
      assertEquals(value.data, {
        schemaVersion: 'result.query.response.v2',
        publicationId,
        releaseVersion: '2026.11.1',
        runtimeRevision,
        result,
        data: overview,
      });
    }
    assertEquals(counts, { actor: 2, database: 4, reader: 2 });
  },
);
Deno.test(
  'v2 LCI preserves signed values and full composite units; LCIA preserves zero and frozen method version',
  async () => {
    const lci = {
      result: row,
      items: [{ item: { ordinal: 31, ...inventory }, amount: -3.5 }],
      nextCursor: 'opaque',
      nonzeroCount: 2,
    };
    const impact = {
      ordinal: 8,
      id: id(8),
      version: '03.02.001',
      key: 'method-key',
      name: 'Climate change',
      unit: 'kg CO2 eq',
    };
    const { handler } = setup({
      reader: async (_input, init) =>
        reply(
          wire(
            JSON.parse(String(fetchInit(init)?.body)).query.kind === 'lci'
              ? lci
              : { result: row, impacts: [[impact, 0]] },
          ),
        ),
    });
    const first = await handler(request({ query: { kind: 'lci', limit: 1 } }));
    const body = await first.json();
    assertEquals(first.status, 200);
    assertEquals(body.data.data.items[0], {
      key: {
        flowId: inventory.flowId,
        flowVersion: inventory.flowVersion,
        direction: inventory.direction,
        location: inventory.location,
        functionType: inventory.functionType,
        unit: inventory.unit,
      },
      name: inventory.flowName,
      classification: inventory.flowClassification,
      amount: -3.5,
    });
    const second = await handler(request({ query: { kind: 'lcia' } }));
    const value = await second.json();
    assertEquals(second.status, 200);
    assertEquals(value.data.data.impacts, [
      {
        method: {
          id: impact.id,
          version: impact.version,
          key: impact.key,
          name: impact.name,
          unit: impact.unit,
        },
        amount: 0,
      },
    ]);
  },
);
Deno.test(
  'v2 continuation requires explicit publication and runtime; UTF-8 bounds precede auth',
  async () => {
    const { handler, counts } = setup();
    const cases = [
      { query: { kind: 'lci', limit: 1, cursor: 'opaque' } },
      { publicationId, query: { kind: 'lci', limit: 1, cursor: 'opaque' } },
      {
        publicationId,
        runtimeRevision,
        query: { kind: 'lci', limit: 1, cursor: '界'.repeat(1366) },
      },
      { query: { kind: 'lci', limit: 1, filter: '界'.repeat(86) } },
      { query: { kind: 'lci', limit: 1001 } },
      { resultVersion: 'latest' },
      { artifactId: id(4) },
    ];
    for (const item of cases) {
      const response = await handler(request(item));
      assertEquals(response.status, 400);
      await response.body?.cancel();
    }
    assertEquals(counts, { actor: 0, database: 0, reader: 0 });
  },
);
for (const [code, status] of [
  ['published_result_not_available', 404],
  ['result_query_runtime_unavailable', 503],
  ['auth_required', 401],
] as const) {
  Deno.test(`v2 ${code} denies before private reader access`, async () => {
    const { handler, counts } = setup({
      database: () => ({ ok: false, code, status, message: 'private error detail' }),
    });
    const response = await handler(request());
    assertEquals(response.status, status);
    assertEquals((await response.text()).includes('private error detail'), false);
    assertEquals(counts.reader, 0);
  });
}
Deno.test(
  'v2 catches withdrawal and runtime rotation while reader request is in flight',
  async () => {
    for (const runtime of [false, true]) {
      const { handler, counts } = setup({
        database: (_name, _args, count) =>
          count === 1
            ? { ok: true, data: descriptor }
            : runtime
              ? { ok: true, data: { ...descriptor, runtimeRevision: id(11) } }
              : { ok: false, code: 'published_result_not_available', status: 404 },
      });
      const response = await handler(request());
      const value = await response.json();
      assertEquals(response.status, runtime ? 409 : 404);
      assertEquals(value.data, undefined);
      assertEquals(counts.reader, 1);
      assertEquals(counts.database, 2);
    }
  },
);
Deno.test(
  'v2 cold cache is bound and reauthorized without claiming reader qualification',
  async () => {
    const { handler, counts } = setup({
      reader: async () =>
        reply(
          {
            schemaVersion: 'result.query.response.v2',
            status: 'preparing',
            artifactId: id(4),
            scope: descriptor.scope,
          },
          202,
        ),
    });
    const response = await handler(request());
    const body = await response.json();
    assertEquals(response.status, 202);
    assertEquals(response.headers.get('Retry-After'), '2');
    assertEquals(body.data.data, { status: 'preparing' });
    assertEquals(body.data.runtimeRevision, runtimeRevision);
    assertEquals(counts.database, 2);
  },
);
Deno.test(
  'v2 rejects wrong reader build, scope, result, capabilities and metadata shape',
  async () => {
    const wrong = [
      {
        ...wire(),
        reader: {
          schemaVersion: 'tiangong.final-result-reader.v1',
          executableSha256: 'f'.repeat(64),
        },
      },
      { ...wire(), scope: { kind: 'publication', publicationId: id(99) } },
      { ...wire(), result: { ...result, version: '02.00.000' } },
      wire({ ...overview, result: { ...row, ancestorKeys: ['private-source'] } }),
      wire({ ...overview, lciaAvailable: false }),
      wire({ ...overview, result: { ...row, relationKind: 'direct' } }),
    ];
    for (const value of wrong) {
      const { handler } = setup({ reader: async () => reply(value) });
      const response = await handler(request());
      assertEquals(response.status, 503);
      assertEquals((await response.json()).data, undefined);
    }
  },
);
Deno.test(
  'v2 checks pinned runtime before private I/O, rejects unsafe origin and bounded body overflow',
  async () => {
    const pinned = setup();
    const response = await pinned.handler(request({ runtimeRevision: id(99) }));
    assertEquals(response.status, 409);
    await response.body?.cancel();
    assertEquals(pinned.counts.reader, 0);
    for (const serviceUrl of [
      'http://query.example.invalid',
      'https://query.example.invalid/path',
      'https://user:password@query.example.invalid',
    ]) {
      const { handler, counts } = setup({ serviceUrl });
      const result = await handler(request());
      assertEquals(result.status, 503);
      await result.body?.cancel();
      assertEquals(counts.reader, 0);
    }
    const large = setup({ reader: async () => new Response(' '.repeat(2 * 1024 * 1024 + 1)) });
    const oversized = await large.handler(request());
    assertEquals(oversized.status, 503);
    await oversized.body?.cancel();
  },
);
Deno.test('v2 reader timeout cancels I/O and permits subsequent requests', async () => {
  const { handler } = setup({
    timeoutMs: 10,
    reader: (_url, init) =>
      new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (fetchInit(init)?.signal?.aborted) abort();
        else fetchInit(init)?.signal?.addEventListener('abort', abort, { once: true });
      }),
  });
  const response = await handler(request());
  assertEquals(response.status, 503);
  await response.body?.cancel();
  const next = await setup().handler(request());
  assertEquals(next.status, 200);
  await next.body?.cancel();
});
Deno.test('v2 no LCIA is an explicit absence, not a zero vector', async () => {
  const { handler, counts } = setup({
    database: () => ({ ok: true, data: { ...descriptor, lciaAvailable: false } }),
  });
  const response = await handler(request({ query: { kind: 'lcia' } }));
  assertEquals(response.status, 404);
  assertEquals((await response.json()).code, 'RESULT_LCIA_NOT_AVAILABLE');
  assertEquals(counts.reader, 0);
});
function sourceRequest(extra: Record<string, unknown> = {}) {
  return new Request('http://localhost/lca_release_results', {
    method: 'POST',
    body: JSON.stringify({
      mode: 'source_results',
      sourceId: id(12),
      sourceVersion: '01.00.000',
      ...extra,
    }),
  });
}
Deno.test(
  'source selection uses exact actor RPC, direct relations, and publication-bound pagination',
  async () => {
    const key = `${result.uuid}@${result.version}`;
    const data = {
      publication: { publicationId, releaseVersion: '2026.11.1', format: 'final-result-pair.v2' },
      results: [{ ...result, relationKind: 'direct', lciAvailable: true, lciaAvailable: false }],
      nextResultKey: key,
    };
    const { handler } = setup({
      database: (name, args) => {
        assertEquals(name, 'qry_source_final_results_v2');
        assertEquals(args, {
          p_source_id: id(12),
          p_source_version: '01.00.000',
          p_after_key: null,
          p_limit: 1,
          p_publication_id: null,
        });
        return { ok: true, data };
      },
    });
    const response = await handler(sourceRequest({ limit: 1 }));
    assertEquals(response.status, 200);
    assertEquals((await response.json()).data, data);
    const invalid = await handler(sourceRequest({ afterKey: key }));
    assertEquals(invalid.status, 400);
    await invalid.body?.cancel();
    const changed = setup({
      database: () => ({ ok: false, code: 'publication_changed', status: 409 }),
    });
    const next = await changed.handler(sourceRequest({ publicationId, afterKey: key }));
    assertEquals(next.status, 409);
    await next.body?.cancel();
  },
);
Deno.test(
  'source selection represents absent or explicitly legacy publications without v2 fallback',
  async () => {
    for (const publication of [
      null,
      { publicationId, releaseVersion: '2026.11.1', format: 'legacy-four-zip.v1' },
    ]) {
      const data = { publication, results: [], nextResultKey: null };
      const { handler } = setup({ database: () => ({ ok: true, data }) });
      const response = await handler(sourceRequest());
      assertEquals(response.status, 200);
      assertEquals((await response.json()).data, data);
    }
  },
);
Deno.test(
  'source selection rejects ancestor-like derived mappings and non-monotone cursors',
  async () => {
    for (const patch of [{ relationKind: 'derived' }, { relationKind: 'direct' }]) {
      const { handler } = setup({
        database: () => ({
          ok: true,
          data: {
            publication: {
              publicationId,
              releaseVersion: '2026.11.1',
              format: 'final-result-pair.v2',
            },
            results: [{ ...result, ...patch, lciAvailable: true, lciaAvailable: true }],
            nextResultKey: `${id(99)}@01.00.000`,
          },
        }),
      });
      const response = await handler(sourceRequest());
      assertEquals(response.status, 503);
      await response.body?.cancel();
    }
  },
);
function downloadRequest(format = 'tidas') {
  return new Request('http://localhost/lca_release_results', {
    method: 'POST',
    body: JSON.stringify({ mode: 'final_download', publicationId, format }),
  });
}
Deno.test('Supabase S3 base path agrees with Release and survives real ZIP signing', async () => {
  const endpoint = 'https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/s3';
  const downloadConfig = { ...config, endpoint, bucket: 'lca_results' };
  const { target, targetHash } = await finalDownloadTarget({ ...config, endpoint });
  const supabaseTargetHash = (await finalDownloadTarget(downloadConfig)).targetHash;
  assertEquals(
    supabaseTargetHash,
    'f76a8f2ce1f462bba6f446b7a02a1871c182bbbdc03cabd67ac1961f62487c35',
  );
  await assertRejects(() => finalDownloadTarget({ ...config, bucket: 'lca_results' }));
  for (const bucket of ['../bucket', 'bucket/child', 'bucket?key', 'bucket%2Fkey', 'a'.repeat(64)])
    await assertRejects(() => finalDownloadTarget({ ...downloadConfig, bucket }));
  assertEquals(target.endpoint, endpoint);
  // Independent Python SHA-256 over sorted compact JSON; shared with Release.
  assertEquals(targetHash, '5a28a7316cbdf68e3169f93f35527b0da247b40949954fa2d3c303ef02b3da23');
  for (const bad of [
    endpoint + '/',
    endpoint + '?key=value',
    endpoint + '#fragment',
    endpoint.replace('https:', 'http:'),
    endpoint.replace('.supabase.co', '.supabase.co.evil.invalid'),
    endpoint.replace('/storage/v1/s3', '/storage/v1/other'),
    endpoint.replace('https://', 'https://user:password@'),
  ])
    await assertRejects(() => finalDownloadTarget({ ...config, endpoint: bad }));
  for (const format of ['tidas', 'ilcd']) {
    const file = { name: `result.${format}.zip`, sha256: 'e'.repeat(64), byteSize: 1000 };
    const { handler, counts } = setup({
      downloadConfig,
      database: () => ({
        ok: true,
        data: {
          publicationId,
          candidateHash: 'c'.repeat(64),
          targetHash: supabaseTargetHash,
          file,
        },
      }),
    });
    const response = await handler(downloadRequest(format));
    assertEquals(response.status, 200);
    const url = new URL((await response.json()).data.url);
    assertEquals(url.origin, new URL(endpoint).origin);
    assertEquals(
      url.pathname,
      `/storage/v1/s3/lca_results/test-owned/release-candidates/${'c'.repeat(64)}/${file.name}`,
    );
    assertEquals(url.searchParams.get('X-Amz-Expires'), '60');
    assertMatch(url.searchParams.get('X-Amz-Signature')!, /^[0-9a-f]{64}$/);
    assertEquals(counts, { actor: 1, database: 2, reader: 0 });
  }
});
Deno.test(
  'ZIP signing uses the immutable target and file name, short TTL and independent actor recheck',
  async () => {
    const { targetHash } = await finalDownloadTarget(config);
    for (const format of ['tidas', 'ilcd']) {
      const file = { name: `result.${format}.zip`, sha256: 'e'.repeat(64), byteSize: 1000 };
      const { handler, counts } = setup({
        database: (name, args) => {
          assertEquals(name, 'qry_final_result_download_v2');
          assertEquals(args, { p_publication_id: publicationId, p_format: format });
          return {
            ok: true,
            data: { publicationId, candidateHash: 'c'.repeat(64), targetHash, file },
          };
        },
      });
      const response = await handler(downloadRequest(format));
      const value = await response.json();
      assertEquals(response.status, 200);
      assertEquals(value.data.file, file);
      const url = new URL(value.data.url);
      assertEquals(url.origin, 'https://storage.example.invalid');
      assertEquals(
        url.pathname,
        `/synthetic-results/test-owned/release-candidates/${'c'.repeat(64)}/${file.name}`,
      );
      assertEquals(url.searchParams.get('X-Amz-Expires'), '60');
      assertEquals(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
      assertMatch(url.searchParams.get('X-Amz-Signature')!, /^[0-9a-f]{64}$/);
      assertEquals(
        url.searchParams.get('response-content-disposition'),
        `attachment; filename="${file.name}"`,
      );
      assertEquals(value.data.targetHash, undefined);
      assertEquals(value.data.candidateHash, undefined);
      assertEquals(counts, { actor: 1, database: 2, reader: 0 });
    }
  },
);
Deno.test(
  'ZIP denies partial/private selections, target mismatch and withdrawal during signing',
  async () => {
    const { targetHash } = await finalDownloadTarget(config);
    for (const mode of ['partial', 'target', 'withdrawal']) {
      const { handler } = setup({
        database: (_name, _args, count) =>
          mode === 'partial' || (mode === 'withdrawal' && count === 2)
            ? { ok: false, code: 'result_package_not_available', status: 404 }
            : {
                ok: true,
                data: {
                  publicationId,
                  candidateHash: 'c'.repeat(64),
                  targetHash: mode === 'target' ? 'f'.repeat(64) : targetHash,
                  file: { name: 'result.tidas.zip', sha256: 'e'.repeat(64), byteSize: 1000 },
                },
              },
      });
      const response = await handler(downloadRequest());
      assertEquals(response.status, mode === 'target' ? 503 : 404);
      assertEquals((await response.json()).data, undefined);
    }
  },
);
Deno.test(
  'storage target normalization agrees on origin and rejects ambiguous prefixes or non-loopback HTTP',
  async () => {
    // Independently produced by Release finalResultStorageTarget, not Edge's implementation.
    assertEquals(
      (await finalDownloadTarget(config)).targetHash,
      'de1df92faaa979b2e608e579ee2733b451cfc4396e98574c7179a73f9d1b9e41',
    );
    assertEquals(
      (await finalDownloadTarget(config)).targetHash,
      (await finalDownloadTarget({ ...config, endpoint: 'https://storage.example.invalid' }))
        .targetHash,
    );
    for (const patch of [
      { prefix: '../escape' },
      { prefix: '/root' },
      { endpoint: 'http://storage.example.invalid' },
      { endpoint: 'https://storage.example.invalid/path' },
    ])
      await assertRejects(() => finalDownloadTarget({ ...config, ...patch }));
  },
);

const serviceCredentials = {
  url: 'https://abcdefghijklmnopqrst.supabase.co',
  key: 'sb_secret_synthetic_fixture_only',
};
const nativeConfig: FinalDownloadConfig = {
  ...config,
  signer: 'supabase-storage',
  endpoint: 'https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/s3',
  bucket: 'lca_results',
  prefix: 'lca_results',
  accessKeyId: '',
  secretAccessKey: '',
};
const zipPath = (format: string) =>
  `/object/sign/lca_results/lca_results/release-candidates/${'c'.repeat(64)}/result.${format}.zip`;
const zipDescriptor = async (format = 'tidas') => ({
  publicationId,
  candidateHash: 'c'.repeat(64),
  targetHash: (await finalDownloadTarget(nativeConfig)).targetHash,
  file: { name: `result.${format}.zip`, sha256: 'e'.repeat(64), byteSize: 1000 },
});
Deno.test(
  'Storage ZIP signing uses existing server credentials and returns one object capability',
  async () => {
    for (const format of ['tidas', 'ilcd']) {
      const d = await zipDescriptor(format);
      let signs = 0;
      const { handler, counts } = setup({
        downloadConfig: nativeConfig,
        database: () => ({ ok: true, data: d }),
        downloadFetch: async (input, init) => {
          signs++;
          assertEquals(
            String(input),
            `https://abcdefghijklmnopqrst.supabase.co/storage/v1${zipPath(format)}`,
          );
          const h = new Headers(fetchInit(init)?.headers);
          assertEquals(h.get('apikey'), serviceCredentials.key);
          assertEquals(h.get('Authorization'), null);
          assertEquals(fetchInit(init)?.redirect, 'error');
          assertEquals(fetchInit(init)?.signal instanceof AbortSignal, true);
          assertEquals(JSON.parse(String(fetchInit(init)?.body)), { expiresIn: 60 });
          return reply({ signedURL: `${zipPath(format)}?token=header.object.signature` });
        },
      });
      const r = await handler(downloadRequest(format));
      assertEquals(r.status, 200);
      const body = await r.json();
      const url = new URL(body.data.url);
      assertEquals(url.origin, 'https://abcdefghijklmnopqrst.supabase.co');
      assertEquals(url.pathname, '/storage/v1' + zipPath(format));
      assertEquals(url.searchParams.get('download'), `result.${format}.zip`);
      assertEquals([...url.searchParams.keys()].sort(), ['download', 'token']);
      assertEquals(JSON.stringify(body).includes(serviceCredentials.key), false);
      assertEquals(counts.database, 2);
      assertEquals(signs, 1);
    }
  },
);
Deno.test(
  'Storage signer refuses foreign/substituted/malformed provider capabilities',
  async () => {
    const d = await zipDescriptor();
    for (const signedURL of [
      `https://evil.invalid${zipPath('tidas')}?token=a.b.c`,
      `${zipPath('ilcd')}?token=a.b.c`,
      `${zipPath('tidas')}?token=a.b.c&token=d.e.f`,
      `${zipPath('tidas')}?token=a.b.c&extra=1`,
      `${zipPath('tidas')}?token=a.b.c#fragment`,
      `${zipPath('tidas')}?token=${serviceCredentials.key}`,
      `${zipPath('tidas')}?token=${'x'.repeat(9000)}`,
    ]) {
      const { handler } = setup({
        downloadConfig: nativeConfig,
        database: () => ({ ok: true, data: d }),
        downloadFetch: async () => reply({ signedURL }),
      });
      const r = await handler(downloadRequest());
      assertEquals(r.status, 503);
      assertEquals((await r.text()).includes(serviceCredentials.key), false);
    }
  },
);
Deno.test('Storage signer denies before I/O and rechecks withdrawal after signing', async () => {
  const d = await zipDescriptor();
  for (const deniedAt of [1, 2]) {
    let signs = 0;
    const { handler } = setup({
      downloadConfig: nativeConfig,
      database: (_n, _a, count) =>
        count === deniedAt
          ? { ok: false, code: 'result_package_not_available', status: 404 }
          : { ok: true, data: d },
      downloadFetch: async () => {
        signs++;
        return reply({ signedURL: `${zipPath('tidas')}?token=a.b.c` });
      },
    });
    const r = await handler(downloadRequest());
    assertEquals(r.status, 404);
    assertEquals((await r.text()).includes('token='), false);
    assertEquals(signs, deniedAt - 1);
  }
});
Deno.test(
  'Storage signer fails closed on network/auth failure and cancelled requests',
  async () => {
    const d = await zipDescriptor();
    for (const status of [302, 400, 401, 403, 500]) {
      const { handler } = setup({
        downloadConfig: nativeConfig,
        database: () => ({ ok: true, data: d }),
        downloadFetch: async () => reply({ message: serviceCredentials.key }, status),
      });
      const r = await handler(downloadRequest());
      assertEquals(r.status, 503);
      assertEquals((await r.text()).includes(serviceCredentials.key), false);
    }
    let aborted = false;
    const { handler } = setup({
      downloadConfig: nativeConfig,
      timeoutMs: 5,
      database: () => ({ ok: true, data: d }),
      downloadFetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = fetchInit(init)!.signal!;
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('aborted'));
            },
            { once: true },
          );
        }),
    });
    const r = await handler(downloadRequest());
    assertEquals(r.status, 503);
    await r.body?.cancel();
    assertEquals(aborted, true);
  },
);
Deno.test(
  'Supabase JWT session credentials and mixed signer configurations cannot leak into browser URLs',
  async () => {
    const awaitedDescriptor = await zipDescriptor();
    for (const bad of [
      {
        ...nativeConfig,
        signer: 's3' as const,
        accessKeyId: 'project',
        secretAccessKey: 'anon',
        sessionToken: 'auth.jwt.token',
      },
      { ...nativeConfig, accessKeyId: 'mixed-key' },
      { ...nativeConfig, sessionToken: 'auth.jwt.token' },
    ]) {
      const { handler } = setup({
        downloadConfig: bad,
        database: () => ({
          ok: true,
          data: awaitedDescriptor,
        }),
        downloadFetch: () => {
          throw new Error('must reject before signing');
        },
      });
      const r = await handler(downloadRequest());
      assertEquals(r.status, 503);
      await r.body?.cancel();
    }
  },
);

Deno.test('Storage signer rejects missing or foreign service credentials before I/O', async () => {
  const descriptor = await zipDescriptor();
  for (const credentials of [
    { ...serviceCredentials, key: '' },
    { ...serviceCredentials, url: 'https://foreign.supabase.co' },
    { ...serviceCredentials, url: serviceCredentials.url + '/path' },
  ]) {
    let signs = 0;
    const { handler } = setup({
      downloadConfig: nativeConfig,
      downloadServiceCredentials: () => credentials,
      database: () => ({ ok: true, data: descriptor }),
      downloadFetch: () => {
        signs++;
        throw new Error('Must reject before I/O');
      },
    });
    const response = await handler(downloadRequest());
    assertEquals(response.status, 503);
    assertEquals(signs, 0);
    await response.body?.cancel();
  }
});
Deno.test('Storage signer also accepts existing legacy service-role credentials', async () => {
  const descriptor = await zipDescriptor();
  const key = 'synthetic.service_role.signature';
  const { handler } = setup({
    downloadConfig: nativeConfig,
    downloadServiceCredentials: () => ({ ...serviceCredentials, key }),
    database: () => ({ ok: true, data: descriptor }),
    downloadFetch: async (_input, init) => {
      const headers = new Headers(fetchInit(init)?.headers);
      assertEquals(headers.get('apikey'), key);
      assertEquals(headers.get('Authorization'), `Bearer ${key}`);
      return reply({ signedURL: `${zipPath('tidas')}?token=a.b.c` });
    },
  });
  const response = await handler(downloadRequest());
  assertEquals(response.status, 200);
  assertEquals((await response.text()).includes(key), false);
});
