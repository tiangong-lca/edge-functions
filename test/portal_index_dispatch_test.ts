import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert';
import { encodeBase64Url } from '../supabase/functions/_shared/portal_hmac.ts';
import {
  portalIndexLocales,
  portalIndexOrigin,
  type PortalIndexFetch,
  type PortalIndexTarget,
  portalIndexTargetUrl,
  submitPortalIndexTargets,
} from '../supabase/functions/_shared/portal_index_providers.ts';
import { createPortalIndexDispatchHandler } from '../supabase/functions/dispatch_portal_index_notifications/index.ts';

const indexNow = { name: 'indexnow', key: 'protocol-test-key' } as const;
const baidu = { name: 'baidu', token: 'SyntheticToken01', transport: 'https' } as const;
const upsert = {
  kind: 'process',
  id: '018f2041-d0e7-7f50-bcd5-d2baa12cc205',
  version: '01.02.003',
} as const;
const withdrawal = { ...upsert, version: '01.02.002' };
const lease = '07cedffe-5954-477f-89ad-2b34cc139a52';
const otherLease = '07cedffe-5954-477f-89ad-2b34cc139a53';
const projectSecret = 'sb_secret_synthetic-project-only';
const schedulerSecret = encodeBase64Url(new Uint8Array(32).fill(47));
const feedSecret = encodeBase64Url(new Uint8Array(32).fill(78));
const projectOrigin = 'https://fixture.supabase.co';
const basePath = 'https://fixture.supabase.co/functions/v1/dispatch_portal_index_notifications';
const feedPath = basePath + '/baidu-withdrawals.txt';

const upserts = portalIndexLocales.map((locale): PortalIndexTarget => ({
  ...upsert,
  locale,
  operation: 'upsert',
}));
const withdrawals = portalIndexLocales.map((locale): PortalIndexTarget => ({
  ...withdrawal,
  locale,
  operation: 'withdrawal',
}));

function response(status: number, headers?: HeadersInit) {
  return new Response(null, { status, headers });
}

function request(
  options: {
    method?: string;
    url?: string;
    secret?: string;
    feed?: boolean;
    headers?: HeadersInit;
  } = {},
) {
  const headers = new Headers(options.headers);
  headers.set(
    options.feed ? 'x-portal-index-feed-secret' : 'x-portal-index-dispatch-secret',
    options.secret ?? (options.feed ? feedSecret : schedulerSecret),
  );
  return new Request(options.url ?? (options.feed ? feedPath : basePath), {
    method: options.method ?? (options.feed ? 'GET' : 'POST'),
    headers,
  });
}

function environment(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    SUPABASE_URL: projectOrigin,
    SUPABASE_SECRET_KEYS: JSON.stringify({ index_dispatch: projectSecret }),
    PORTAL_INDEX_DB_SECRET_NAME: 'index_dispatch',
    PORTAL_INDEX_DISPATCH_ENABLED: 'true',
    PORTAL_INDEX_DISPATCH_SECRET: schedulerSecret,
    PORTAL_INDEX_FEED_SECRET: feedSecret,
    PORTAL_INDEX_ALLOWED_BRANDS: 'bafu,tiangong_lca',
    PORTAL_INDEX_INDEXNOW_ENABLED: 'true',
    PORTAL_INDEX_INDEXNOW_KEY: indexNow.key,
    ...overrides,
  };
  return { get: (key: string) => values[key] };
}

function work(overrides: Record<string, unknown> = {}) {
  return {
    eventId: '1',
    leaseToken: lease,
    attempt: 1,
    upserts: [upsert],
    withdrawals: [withdrawal],
    accepted: [],
    ...overrides,
  };
}

Deno.test(
  'IndexNow sends exact canonical URL changes and distinguishes pending verification',
  async () => {
    const targets = [upserts[0], withdrawals[2]];
    const abort = new AbortController();
    const receipt = await submitPortalIndexTargets(
      indexNow,
      targets,
      abort.signal,
      (input, init) => {
        assertEquals(input, 'https://api.indexnow.org/indexnow');
        assertEquals(init.method, 'POST');
        assertEquals(init.redirect, 'error');
        assertEquals(init.signal, abort.signal);
        assertEquals(JSON.parse(String(init.body)), {
          host: 'www.tiangong.earth',
          key: indexNow.key,
          keyLocation: `${portalIndexOrigin}/${indexNow.key}.txt`,
          urlList: [
            `${portalIndexOrigin}/zh-CN/process/${upsert.id}@01.02.003`,
            `${portalIndexOrigin}/de/process/${upsert.id}@01.02.002`,
          ],
        });
        return Promise.resolve(response(202));
      },
    );
    assertEquals(receipt, {
      outcome: 'accepted',
      reason: 'indexnow_validation_pending',
      accepted: targets,
    });
  },
);

Deno.test('IndexNow handles protocol rejection, overload, and aborted transport', async () => {
  const abort = new AbortController();
  for (const [status, outcome, reason] of [
    [200, 'accepted', 'indexnow_accepted'],
    [400, 'blocked', 'provider_invalid_request'],
    [403, 'blocked', 'provider_auth_failed'],
    [422, 'blocked', 'provider_invalid_request'],
    [429, 'retry', 'provider_rate_limited'],
    [503, 'retry', 'provider_temporary_failure'],
  ] as const) {
    const receipt = await submitPortalIndexTargets(indexNow, upserts, abort.signal, () =>
      Promise.resolve(response(status, status === 429 ? { 'retry-after': '120' } : undefined)),
    );
    assertEquals(receipt.outcome, outcome);
    assertEquals(receipt.reason, reason);
    if (status === 429)
      assertEquals('retryAfterSeconds' in receipt && receipt.retryAfterSeconds, 120);
  }
  abort.abort();
  const timeout = await submitPortalIndexTargets(indexNow, upserts, abort.signal, () => {
    throw new Error('aborted request reached provider');
  });
  assertEquals(timeout, { outcome: 'retry', reason: 'provider_timeout' });
});

Deno.test(
  'Baidu text submission excludes withdrawals and binds partial acceptance and quota to exact URLs',
  async () => {
    const targets = [...upserts, ...withdrawals];
    const signal = new AbortController().signal;
    const receipt = await submitPortalIndexTargets(baidu, targets, signal, (input, init) => {
      const endpoint = new URL(input);
      assertEquals(endpoint.origin + endpoint.pathname, 'https://data.zz.baidu.com/urls');
      assertEquals(endpoint.searchParams.get('site'), 'www.tiangong.earth');
      assertEquals(endpoint.searchParams.get('token'), baidu.token);
      assertEquals(init.redirect, 'error');
      assertEquals(new Headers(init.headers).get('content-type'), 'text/plain; charset=utf-8');
      assertEquals(init.body, upserts.map(portalIndexTargetUrl).join('\n'));
      return Promise.resolve(
        Response.json({
          success: 3,
          remain: 0,
          not_valid: [portalIndexTargetUrl(upserts[3])],
        }),
      );
    });
    assertEquals(receipt, {
      outcome: 'blocked',
      reason: 'provider_rejected_urls_quota_exhausted',
      accepted: upserts.slice(0, 3),
      retryAfterSeconds: 86_400,
    });
    const skip = await submitPortalIndexTargets(baidu, withdrawals, signal, () => {
      throw new Error('ordinary provider received a withdrawal');
    });
    assertEquals(skip, { outcome: 'skipped', reason: 'withdrawal_unsupported' });
  },
);

Deno.test(
  'Baidu distinguishes quota exhaustion, uncertain receipts, and confirmed success at zero quota',
  async () => {
    const signal = new AbortController().signal;
    for (const receiptBody of [
      { success: 5, remain: 4 },
      { success: -1, remain: 4 },
      { success: 1.5, remain: 4 },
      { error: 400, success: 0, remain: 4 },
      { success: 3, remain: 4, not_valid: ['https://other.invalid/'] },
      { success: 3, remain: -4, not_valid: [portalIndexTargetUrl(upserts[0])] },
      {
        success: 2,
        remain: 4,
        not_valid: [portalIndexTargetUrl(upserts[0])],
        not_same_site: [portalIndexTargetUrl(upserts[0])],
      },
    ]) {
      const receipt = await submitPortalIndexTargets(baidu, upserts, signal, () =>
        Promise.resolve(Response.json(receiptBody)),
      );
      assertEquals(receipt, { outcome: 'retry', reason: 'provider_response_unconfirmed' });
    }
    const exhausted = await submitPortalIndexTargets(baidu, upserts, signal, () =>
      Promise.resolve(Response.json({ error: 400, message: 'over quota' }, { status: 400 })),
    );
    assertEquals(exhausted, {
      outcome: 'retry',
      reason: 'provider_quota_exhausted',
      retryAfterSeconds: 86_400,
    });
    const accepted = await submitPortalIndexTargets(baidu, upserts, signal, () =>
      Promise.resolve(Response.json({ success: 4, remain: 0 })),
    );
    assertEquals(accepted, {
      outcome: 'accepted',
      reason: 'baidu_accepted_quota_exhausted',
      accepted: upserts,
      retryAfterSeconds: 86_400,
    });
  },
);

Deno.test(
  'Baidu blocks unattributed short counts without acknowledging individual URLs',
  async () => {
    const signal = new AbortController().signal;
    for (const [body, expected] of [
      [
        { success: 0, remain: 9 },
        { outcome: 'blocked', reason: 'baidu_success_unattributed' },
      ],
      [
        { success: 0, remain: 0 },
        {
          outcome: 'blocked',
          reason: 'baidu_success_unattributed_quota_exhausted',
          retryAfterSeconds: 86_400,
        },
      ],
      [
        { success: 2, remain: 9, not_valid: [portalIndexTargetUrl(upserts[3])] },
        { outcome: 'blocked', reason: 'baidu_success_unattributed' },
      ],
    ] as const) {
      const receipt = await submitPortalIndexTargets(baidu, upserts, signal, () =>
        Promise.resolve(Response.json(body)),
      );
      assertEquals(receipt, expected);
    }
  },
);

Deno.test(
  'Dispatcher settles Baidu quota from an unattributed count and stops that lane',
  async () => {
    const first = work({ withdrawals: [] });
    const second = work({ eventId: '2', leaseToken: otherLease, withdrawals: [] });
    const rechecks: unknown[] = [];
    const settlements: unknown[] = [];
    let submissions = 0;
    const handler = createPortalIndexDispatchHandler({
      env: environment({
        PORTAL_INDEX_INDEXNOW_ENABLED: 'false',
        PORTAL_INDEX_BAIDU_ENABLED: 'true',
        PORTAL_INDEX_BAIDU_TRANSPORT: 'https',
        PORTAL_INDEX_BAIDU_TOKEN: baidu.token,
      }),
      send: (input, init) => {
        if (new URL(input).hostname === 'data.zz.baidu.com') {
          submissions++;
          return Promise.resolve(
            Response.json({ success: 0, remain: 0 }, { headers: { 'retry-after': '300' } }),
          );
        }
        const body = JSON.parse(String(init.body));
        if (input.endsWith('claim_v1')) return Promise.resolve(Response.json([first, second]));
        if (input.endsWith('recheck_v1')) {
          rechecks.push(body.p_event_id);
          return Promise.resolve(Response.json(body.p_event_id === '1' ? first : second));
        }
        settlements.push(body);
        return Promise.resolve(Response.json(true));
      },
    });
    assertEquals((await handler(request())).status, 200);
    assertEquals(submissions, 1);
    assertEquals(rechecks, ['1']);
    assertEquals(settlements, [
      {
        p_provider: 'baidu',
        p_event_id: '1',
        p_lease_token: lease,
        p_outcome: 'blocked',
        p_reason: 'baidu_success_unattributed_quota_exhausted',
        p_retry_after_seconds: 300,
        p_accepted: [],
      },
    ]);
  },
);

Deno.test(
  'Dispatch rejects cross-use, absent credentials, methods, extra paths, and default-off activation before transport',
  async () => {
    const requests = [
      [request({ secret: feedSecret }), 401],
      [request({ feed: true, secret: schedulerSecret }), 401],
      [new Request(basePath, { method: 'POST' }), 401],
      [request({ headers: { Authorization: 'Bearer some-token' } }), 401],
      [request({ headers: { Cookie: 'anything=wrong' } }), 401],
      [
        request({ feed: true, headers: { 'x-portal-index-dispatch-secret': schedulerSecret } }),
        401,
      ],
      [request({ method: 'GET' }), 405],
      [request({ feed: true, method: 'POST' }), 405],
      [request({ url: basePath + '?provider=baidu' }), 404],
      [request({ feed: true, url: feedPath + '?' }), 404],
      [request({ feed: true, url: feedPath + '/extra' }), 404],
    ] as const;
    let sends = 0;
    const send: PortalIndexFetch = () => {
      sends++;
      return Promise.reject(new Error('unexpected transport'));
    };
    const handler = createPortalIndexDispatchHandler({
      env: environment({ PORTAL_INDEX_BAIDU_WITHDRAWALS_ENABLED: 'true' }),
      send,
    });
    for (const [input, status] of requests) assertEquals((await handler(input)).status, status);
    const defaultOff = createPortalIndexDispatchHandler({
      env: environment({ PORTAL_INDEX_DISPATCH_ENABLED: undefined }),
      send,
    });
    assertEquals((await defaultOff(request())).status, 503);
    const sharedCredentials = createPortalIndexDispatchHandler({
      env: environment({ PORTAL_INDEX_FEED_SECRET: schedulerSecret }),
      send,
    });
    assertEquals((await sharedCredentials(request())).status, 503);
    assertEquals(sends, 0);
  },
);

Deno.test(
  'Dispatcher rechecks its lease, excludes previously accepted URLs, and settles exact provider progress',
  async () => {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const handler = createPortalIndexDispatchHandler({
      env: environment(),
      send: (input, init) => {
        const url = new URL(input);
        const path = url.pathname.split('/').at(-1)!;
        const body = JSON.parse(String(init.body));
        calls.push({ path, body });
        if (path.startsWith('svc_')) {
          assertEquals(url.origin, projectOrigin);
          const headers = new Headers(init.headers);
          assertEquals(headers.get('apikey'), projectSecret);
          assertEquals(headers.get('Content-Profile'), 'api');
          assertEquals(headers.has('authorization'), false);
          assertEquals(init.redirect, 'error');
        }
        switch (path) {
          case 'svc_portal_index_claim_v1':
            return Promise.resolve(
              Response.json([work(), work({ eventId: '2', leaseToken: otherLease })]),
            );
          case 'svc_portal_index_recheck_v1':
            return Promise.resolve(
              Response.json(body.p_event_id === '1' ? work({ accepted: [upserts[0]] }) : null),
            );
          case 'svc_portal_index_settle_v1':
            return Promise.resolve(Response.json(true));
          case 'indexnow':
            assertEquals(new Headers(init.headers).has('apikey'), false);
            return Promise.resolve(response(202));
          default:
            throw new Error('unexpected call');
        }
      },
    });
    const result = await handler(request());
    assertEquals(result.status, 200);
    assertEquals(
      calls.map(({ path }) => path),
      [
        'svc_portal_index_claim_v1',
        'svc_portal_index_recheck_v1',
        'indexnow',
        'svc_portal_index_settle_v1',
        'svc_portal_index_recheck_v1',
      ],
    );
    assertEquals(calls[0].body, {
      p_provider: 'indexnow',
      p_origin: portalIndexOrigin,
      p_allowed_brands: ['bafu', 'tiangong_lca'],
      p_limit: 2,
    });
    const expected = [...upserts.slice(1), ...withdrawals];
    assertEquals(calls[2].body.urlList, expected.map(portalIndexTargetUrl));
    assertEquals(calls[3].body, {
      p_provider: 'indexnow',
      p_event_id: '1',
      p_lease_token: lease,
      p_outcome: 'accepted',
      p_reason: 'indexnow_validation_pending',
      p_retry_after_seconds: null,
      p_accepted: expected,
    });
    assertEquals((await result.json()).providers[0].stale, 1);
  },
);

Deno.test('Unapproved cleartext Baidu cannot claim or interfere with IndexNow', async () => {
  const providers: string[] = [];
  const handler = createPortalIndexDispatchHandler({
    env: environment({
      PORTAL_INDEX_BAIDU_ENABLED: 'true',
      PORTAL_INDEX_BAIDU_TRANSPORT: 'http',
      PORTAL_INDEX_BAIDU_TOKEN: baidu.token,
    }),
    send: (input, init) => {
      assertStringIncludes(input, 'svc_portal_index_claim_v1');
      providers.push(JSON.parse(String(init.body)).p_provider);
      return Promise.resolve(Response.json([]));
    },
  });
  const result = await handler(request());
  assertEquals(result.status, 503);
  assertEquals(providers, ['indexnow']);
  const body = await result.text();
  assertStringIncludes(body, 'configuration_invalid');
  assert(!body.includes(baidu.token));
  assert(!body.includes(projectSecret));
});

Deno.test(
  'Baidu withdrawal lane proves only strict canonical 404 and keeps partial progress',
  async () => {
    const seen: { url: string; method: string | undefined; body?: Record<string, unknown> }[] = [];
    const handler = createPortalIndexDispatchHandler({
      env: environment({
        PORTAL_INDEX_INDEXNOW_ENABLED: 'false',
        PORTAL_INDEX_BAIDU_WITHDRAWALS_ENABLED: 'true',
      }),
      send: (input, init) => {
        const url = input;
        if (url.startsWith(portalIndexOrigin)) {
          assertEquals(new Headers(init.headers).get('cache-control'), 'no-cache');
          assertEquals(new Headers(init.headers).has('apikey'), false);
          assertEquals(init.redirect, 'error');
          seen.push({ url, method: init.method });
          return Promise.resolve(response(url.includes('/fr/') ? 200 : 404));
        }
        const body = JSON.parse(String(init.body));
        seen.push({ url, method: init.method, body });
        if (url.endsWith('claim_v1'))
          return Promise.resolve(Response.json([work({ upserts: [] })]));
        if (url.endsWith('recheck_v1'))
          return Promise.resolve(Response.json(work({ upserts: [] })));
        return Promise.resolve(Response.json(true));
      },
    });
    assertEquals((await handler(request())).status, 200);
    assertEquals(seen[0].body?.p_provider, 'baidu_withdrawal');
    assertEquals(
      seen.slice(2, 6),
      withdrawals.map((target) => ({ url: portalIndexTargetUrl(target), method: 'GET' })),
    );
    assertEquals(seen[6].body, {
      p_provider: 'baidu_withdrawal',
      p_event_id: '1',
      p_lease_token: lease,
      p_outcome: 'retry',
      p_reason: 'withdrawal_http_unconfirmed',
      p_retry_after_seconds: 300,
      p_accepted: withdrawals.slice(0, 3),
    });
  },
);

Deno.test(
  'Private feed returns only exact bounded plain text from its single service RPC',
  async () => {
    let duplicate = false;
    const handler = createPortalIndexDispatchHandler({
      env: environment({ PORTAL_INDEX_BAIDU_WITHDRAWALS_ENABLED: 'true' }),
      send: (input, init) => {
        assertEquals(input, `${projectOrigin}/rest/v1/rpc/svc_portal_index_withdrawal_feed_v1`);
        assertEquals(JSON.parse(String(init.body)), {
          p_origin: portalIndexOrigin,
          p_allowed_brands: ['bafu', 'tiangong_lca'],
        });
        const feedKey = { ...withdrawal, locale: 'en' };
        return Promise.resolve(Response.json(duplicate ? [feedKey, feedKey] : [feedKey]));
      },
    });
    const feed = await handler(request({ feed: true }));
    assertEquals(feed.status, 200);
    assertEquals(feed.headers.get('cache-control'), 'no-store');
    assertEquals(feed.headers.get('content-type'), 'text/plain; charset=utf-8');
    assertEquals(feed.headers.get('x-robots-tag'), 'noindex');
    assertEquals(feed.headers.get('x-portal-index-feed-version'), '1');
    assertEquals(feed.headers.get('x-portal-index-origin'), portalIndexOrigin);
    assertEquals(feed.headers.get('x-portal-index-brands'), 'bafu,tiangong_lca');
    assertEquals(await feed.text(), portalIndexTargetUrl(withdrawals[1]) + '\n');
    duplicate = true;
    assertEquals((await handler(request({ feed: true }))).status, 503);
  },
);

Deno.test(
  'Dispatcher exercises native HTTP transport against an owned loopback fixture',
  async () => {
    const seen: string[] = [];
    const server = Deno.serve(
      { hostname: '127.0.0.1', port: 0, onListen: () => {} },
      async (incoming) => {
        const path = new URL(incoming.url).pathname.split('/').at(-1)!;
        seen.push(path);
        const body = await incoming.json();
        if (path === 'indexnow') {
          assertEquals(body.urlList, upserts.map(portalIndexTargetUrl));
          return response(200);
        }
        assertEquals(incoming.headers.get('apikey'), projectSecret);
        if (path.endsWith('claim_v1')) return Response.json([work({ withdrawals: [] })]);
        if (path.endsWith('recheck_v1')) return Response.json(work({ withdrawals: [] }));
        assertEquals(body.p_accepted, upserts);
        assertEquals(body.p_reason, 'indexnow_accepted');
        return Response.json(true);
      },
    );
    try {
      const origin = `http://127.0.0.1:${server.addr.port}`;
      const handler = createPortalIndexDispatchHandler({
        env: environment({ SUPABASE_URL: origin }),
        send: (input, init) =>
          fetch(input === 'https://api.indexnow.org/indexnow' ? `${origin}/indexnow` : input, init),
      });
      const result = await handler(request());
      assertEquals(result.status, 200);
      assertEquals(seen, [
        'svc_portal_index_claim_v1',
        'svc_portal_index_recheck_v1',
        'indexnow',
        'svc_portal_index_settle_v1',
      ]);
    } finally {
      await server.shutdown();
    }
  },
);

Deno.test(
  'Dispatcher supplies mandatory retry delay and stops on a provider-wide rate hold',
  async () => {
    const workItem = work({ attempt: 4, withdrawals: [] });
    const settlements: Record<string, unknown>[] = [];
    const rechecks: string[] = [];
    let providerStatus = 503;
    const handler = createPortalIndexDispatchHandler({
      env: environment(),
      send: (input, init) => {
        if (input.endsWith('/indexnow')) return Promise.resolve(response(providerStatus));
        const body = JSON.parse(String(init.body));
        if (input.endsWith('claim_v1')) {
          return Promise.resolve(
            Response.json([
              workItem,
              work({ eventId: '2', leaseToken: otherLease, withdrawals: [] }),
            ]),
          );
        }
        if (input.endsWith('recheck_v1')) {
          rechecks.push(body.p_event_id);
          return Promise.resolve(Response.json(body.p_event_id === '1' ? workItem : null));
        }
        settlements.push(body);
        return Promise.resolve(Response.json(true));
      },
    });
    assertEquals((await handler(request())).status, 200);
    assertEquals(settlements[0].p_retry_after_seconds, 480);
    assertEquals(rechecks, ['1', '2']);
    providerStatus = 429;
    rechecks.length = 0;
    assertEquals((await handler(request())).status, 200);
    assertEquals(settlements[1].p_retry_after_seconds, 60);
    assertEquals(rechecks, ['1']);
  },
);

Deno.test(
  'Baidu withdrawal completion records manifest readiness without provider acceptance',
  async () => {
    const urls: string[] = [];
    const verifiedWork = work({ upserts: [], accepted: withdrawals.slice(0, 3) });
    let settlement: Record<string, unknown> | undefined;
    const handler = createPortalIndexDispatchHandler({
      env: environment({
        PORTAL_INDEX_INDEXNOW_ENABLED: 'false',
        PORTAL_INDEX_BAIDU_WITHDRAWALS_ENABLED: 'true',
      }),
      send: (input, init) => {
        if (input.endsWith('claim_v1')) return Promise.resolve(Response.json([verifiedWork]));
        if (input.endsWith('recheck_v1')) return Promise.resolve(Response.json(verifiedWork));
        if (input.endsWith('settle_v1')) {
          settlement = JSON.parse(String(init.body));
          return Promise.resolve(Response.json(true));
        }
        assertEquals(init.method, 'GET');
        urls.push(input);
        return Promise.resolve(response(404));
      },
    });
    assertEquals((await handler(request())).status, 200);
    assertEquals(urls, [portalIndexTargetUrl(withdrawals[3])]);
    assertEquals(settlement, {
      p_provider: 'baidu_withdrawal',
      p_event_id: '1',
      p_lease_token: lease,
      p_outcome: 'manifest_ready',
      p_reason: 'manual_registration_pending',
      p_retry_after_seconds: null,
      p_accepted: withdrawals.slice(3),
    });
  },
);
