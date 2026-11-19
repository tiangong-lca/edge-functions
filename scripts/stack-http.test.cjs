'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { boundedBody, waitForFixture } = require('./stack-qualification/http.cjs');
const {
  workerVersionIdentity,
  serveExitIdentity,
  assertNativeStopped,
} = require('./stack-qualification/contracts.cjs');
const rejection = { ok: false, code: 'portal_hmac_method_invalid' };
test('readiness waits through real gateway errors for the exact fixture method rejection', async () => {
  const seen = [];
  const server = http.createServer((request, response) => {
    seen.push({ method: request.method, url: request.url });
    response.setHeader('content-type', 'application/json');
    response.statusCode = seen.length < 3 ? (seen.length === 1 ? 502 : 404) : 400;
    response.end(JSON.stringify(seen.length < 3 ? { message: 'not the worker' } : rejection));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const observations = [];
  try {
    const result = await waitForFixture(
      `http://127.0.0.1:${server.address().port}/functions/v1/portal`,
      {
        pause: async (ms) => assert.equal(ms, 200),
        record: (value) => observations.push(value),
      },
    );
    assert.equal(result.attempt, 3);
    assert.deepEqual(
      observations.map((x) => x.status),
      [502, 404, 400],
    );
    assert.deepEqual(
      observations.map((x) => x.ready),
      [false, false, true],
    );
    assert.ok(seen.every((x) => x.method === 'GET' && x.url === '/functions/v1/portal'));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
test('readiness rejects wrong status/body and stops at the unchanged attempt bound', async () => {
  const cases = [
    [200, rejection],
    [502, rejection],
    [400, { ok: false, code: 'wrong' }],
    [400, { ...rejection, extra: true }],
    [400, 'not-json'],
  ];
  for (const [status, body] of cases) {
    let calls = 0;
    let pauses = 0;
    await assert.rejects(
      () =>
        waitForFixture('http://127.0.0.1/fixture', {
          fetchImpl: async (_url, { signal }) => {
            assert.ok(signal instanceof AbortSignal);
            calls++;
            return typeof body === 'string'
              ? new Response(body, { status })
              : Response.json(body, { status });
          },
          pause: async (ms) => {
            assert.equal(ms, 200);
            pauses++;
          },
        }),
      /did not become ready/u,
    );
    assert.equal(calls, 150);
    assert.equal(pauses, 150);
  }
});
test('diagnostic response reads are bounded and cancel unread stream data', async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('0123456789'));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  assert.deepEqual(await boundedBody(response, 4), { body: '0123', bytes: 4, truncated: true });
  assert.equal(cancelled, true);
  assert.deepEqual(await boundedBody(new Response('done'), 4), {
    body: 'done',
    bytes: 4,
    truncated: false,
  });
  await assert.rejects(() => boundedBody(new Response('x'), 0));
});
test('worker reports use exact tagged metadata separately from actual compiler/binary identities', () => {
  for (const release of ['1.74.3', '1.77.4', '1.78.1']) {
    const fixture = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, `../test/fixtures/supabase-edge-runtime-v${release}-deno.json`),
      ),
    );
    const actual = {
      deno: `supabase-edge-runtime-${release} (compatible with Deno v2.1.4)`,
      v8: '11.6.189.12',
      typescript: '5.1.6',
    };
    assert.deepEqual(workerVersionIdentity(actual, fixture), actual);
    for (const changed of [
      { ...actual, deno: '2.1.4' },
      { ...actual, typescript: '5.6.2' },
      { ...actual, v8: 'wrong' },
      { ...actual, deno: actual.deno.replace(release, '0.1.0') },
      { ...actual, extra: true },
      null,
    ])
      assert.throws(() => workerVersionIdentity(changed, fixture));
    assert.equal(fixture.deno.bundledTypeScriptVersion, '5.6.2');
    assert.equal(fixture.edgeRuntime.binary.version, '0.1.0');
  }
});
test('normal native shutdown rejects crashes and leftover project resources', () => {
  for (const [code, signal] of [
    [0, null],
    [130, null],
    [null, 'SIGINT'],
  ])
    assert.deepEqual(serveExitIdentity(code, signal), { code, signal });
  for (const [code, signal] of [
    [1, null],
    [137, null],
    [null, 'SIGKILL'],
    [null, 'SIGTERM'],
    [null, null],
    [0, 'SIGINT'],
  ])
    assert.throws(() => serveExitIdentity(code, signal));
  assertNativeStopped({ containers: [], volumes: [] });
  assert.throws(() => assertNativeStopped({ containers: ['owned'], volumes: [] }));
  assert.throws(() => assertNativeStopped({ containers: [], volumes: ['owned'] }));
});
