import { assert, assertEquals, assertRejects, assertStringIncludes } from 'jsr:@std/assert';

import type { HybridSearchQuery } from '../supabase/functions/_shared/hybrid_query_utils.ts';
import {
  type PortalHybridModelCache,
  type PortalHybridSearchRequest,
  type PortalPublicHybridCandidatePage,
} from '../supabase/functions/_shared/portal_hybrid_contract.ts';
import {
  schedulePortalHybridSecurityEvent,
  type PortalHybridSecurityEvent,
} from '../supabase/functions/_shared/portal_hybrid_security_event.ts';
import {
  createPortalHybridRepository,
  PortalHybridRepositoryError,
  type PortalHybridRepository,
} from '../supabase/functions/_shared/portal_hybrid_repository.ts';
import {
  buildPortalHmacCanonical,
  computePortalBodyHash,
  encodeBase64Url,
  type PortalHmacKeyring,
} from '../supabase/functions/_shared/portal_hmac.ts';
import {
  PORTAL_HYBRID_ATOMIC_BEGIN_LUA,
  PORTAL_HYBRID_CIRCUIT_FAILURE_LUA,
  PORTAL_HYBRID_CIRCUIT_SUCCESS_LUA,
  PORTAL_HYBRID_TOTAL_TIMEOUT_MS,
} from '../supabase/functions/_shared/portal_redis_guard.ts';
import type { PortalRedisAdapter } from '../supabase/functions/_shared/redis_client.ts';
import {
  PortalHybridProviderError,
  readPortalHybridProviderConfig,
} from '../supabase/functions/_shared/portal_hybrid_provider.ts';
import type { PortalHybridKernelProviderConfig } from '../supabase/functions/_shared/portal_hybrid_kernel.ts';
import {
  createPortalHybridSearchHandler,
  isPortalHybridEnabled,
  PORTAL_HYBRID_FUNCTION_PATH,
  PORTAL_HYBRID_RUNTIME_PATH,
} from '../supabase/functions/portal_hybrid_search_v1/index.ts';

const NOW_SECONDS = 1_800_000_000;

function versionedDatabasePage(): Extract<
  PortalPublicHybridCandidatePage,
  {
    schemaVersion: 'portal.public-hybrid-candidate-page.v2';
  }
> {
  const legacy = databasePage();
  const item = {
    ...legacy.items[0],
    match: { ...legacy.items[0].match, algorithmVersion: 'portal-hybrid-rank-v2' as const },
  };
  return {
    schemaVersion: 'portal.public-hybrid-candidate-page.v2',
    kind: legacy.kind,
    queryFingerprint: legacy.queryFingerprint,
    items: [item],
    candidateCount: 2,
    datasetCount: 1,
    versionGroups: [
      {
        key: item.key,
        matches: [
          { key: item.key, match: item.match },
          {
            key: { ...item.key, version: '00.99.999' },
            match: {
              kind: 'hybrid',
              algorithmVersion: 'portal-hybrid-rank-v2',
              score: 0.1,
              reasonCodes: ['lexical_public_projection'],
              evidence: { lexicalRank: 2, semanticRank: null, semanticDistance: null },
            },
          },
        ],
      },
    ],
    nextCursor: null,
  };
}

Deno.test(
  'Portal V2 repository uses the additive API and refuses legacy or mixed contracts',
  async () => {
    let capturedUrl = '';
    let capturedBody: Record<string, unknown> = {};
    const request: PortalHybridSearchRequest = {
      ...REQUEST,
      schemaVersion: 'portal.hybrid-search-request.v2',
      cursor: 'opaque_page_2',
    };
    const repository = createPortalHybridRepository({
      supabaseUrl: 'https://example.supabase.co',
      publishableKey: TRUSTED_PUBLISHABLE_KEY,
      fetchImpl: (url, init) => {
        capturedUrl = String(url);
        const requestInit = init as RequestInit;
        capturedBody = JSON.parse(String(requestInit?.body));
        const headers = new Headers(requestInit?.headers);
        assertEquals(headers.get('authorization'), null);
        assertEquals(headers.get('apikey'), TRUSTED_PUBLISHABLE_KEY);
        return Promise.resolve(Response.json(versionedDatabasePage()));
      },
    });
    const page = await repository.query(request, ['steel'], VECTOR, new AbortController().signal);
    assertEquals(page, versionedDatabasePage());
    assertEquals(capturedUrl, 'https://example.supabase.co/rest/v1/rpc/portal_hybrid_search_v2');
    assertEquals(capturedBody.p_cursor, 'opaque_page_2');
    assertEquals(Object.keys(capturedBody).sort(), [
      'p_cursor',
      'p_filters',
      'p_kind',
      'p_limit',
      'p_query_embedding',
      'p_query_terms',
    ]);
    const oldRepository = createPortalHybridRepository({
      supabaseUrl: 'https://example.supabase.co',
      publishableKey: TRUSTED_PUBLISHABLE_KEY,
      fetchImpl: () => Promise.resolve(Response.json(databasePage())),
    });
    await assertRejects(
      () => oldRepository.query(request, ['steel'], VECTOR, new AbortController().signal),
      PortalHybridRepositoryError,
    );
    await assertRejects(
      () => repository.query(REQUEST, ['steel'], VECTOR, new AbortController().signal),
      PortalHybridRepositoryError,
    );
  },
);

Deno.test(
  'Portal V2 keeps English model work cached across continuation and filter changes',
  async () => {
    const redis = new FakePortalRedis();
    const cachedByKey = new Map<string, string>();
    redis.cacheGetOperation = (key) => Promise.resolve(cachedByKey.get(key) ?? null);
    let rewriteCalls = 0;
    let embeddingCalls = 0;
    const requests: PortalHybridSearchRequest[] = [];
    const handler = createPortalHybridSearchHandler(
      handlerOptions(
        redis,
        {
          query: (request) => {
            requests.push(request);
            return Promise.resolve(versionedDatabasePage());
          },
        },
        {
          rewriteQuery: async () => {
            rewriteCalls += 1;
            return REWRITE;
          },
          generateEmbedding: async (input: string) => {
            assertEquals(input, REWRITE.semantic_query_en);
            embeddingCalls += 1;
            return VECTOR;
          },
        },
      ),
    );
    const firstRequest = {
      ...REQUEST,
      schemaVersion: 'portal.hybrid-search-request.v2',
      cursor: null,
    };
    const first = await handler(await signedRequest({ payload: firstRequest }));
    assertEquals(first.status, 200);
    const firstPage = await first.json();
    assertEquals(firstPage.schemaVersion, 'portal.hybrid-search-page.v2');
    assertEquals(firstPage.versionGroups[0].matches.length, 2);
    assertEquals(redis.cacheWrites.length, 1);
    cachedByKey.set(redis.cacheWriteKeys[0], redis.cacheWrites[0]);

    const continued = await handler(
      await signedRequest({
        payload: { ...firstRequest, cursor: 'opaque_page_2' },
      }),
    );
    assertEquals(continued.status, 200);
    const filtered = await handler(
      await signedRequest({
        payload: { ...firstRequest, filters: { geography: 'fr' }, limit: 20 },
      }),
    );
    assertEquals(filtered.status, 200);
    assertEquals(rewriteCalls, 1);
    assertEquals(embeddingCalls, 1);
    assertEquals(requests.length, 3);
    assertEquals(new Set(redis.cacheReadKeys).size, 1);
    assertEquals(redis.cacheWriteKeys, [redis.cacheReadKeys[0]]);
    assertEquals(JSON.stringify(redis.cacheWrites).includes(REQUEST.query), false);

    const changed = await handler(
      await signedRequest({
        payload: { ...firstRequest, query: 'another private query', cursor: 'opaque_page_2' },
      }),
    );
    assertEquals(changed.status, 400);
    assertEquals(await responseCode(changed), 'invalid_request');
    assertEquals(rewriteCalls, 1);
    assertEquals(requests.length, 3);
    assertEquals(new Set(redis.cacheReadKeys).size, 2);
  },
);

Deno.test(
  'Portal V2 expired continuation makes zero provider/DB calls and does not trip the circuit',
  async () => {
    const redis = new FakePortalRedis();
    let calls = 0;
    const handler = createPortalHybridSearchHandler(
      handlerOptions(
        redis,
        {
          query: () => {
            calls += 1;
            return Promise.resolve(versionedDatabasePage());
          },
        },
        {
          rewriteQuery: async () => {
            calls += 1;
            return REWRITE;
          },
          generateEmbedding: async () => {
            calls += 1;
            return VECTOR;
          },
        },
      ),
    );
    const response = await handler(
      await signedRequest({
        payload: {
          ...REQUEST,
          schemaVersion: 'portal.hybrid-search-request.v2',
          cursor: 'expired_cursor',
        },
      }),
    );
    assertEquals(response.status, 400);
    assertEquals(await responseCode(response), 'invalid_request');
    assertEquals(calls, 0);
    assertEquals(redis.calls.includes('circuit_failure'), false);
    await flushPortalHybridSecurityEvent();
    assertEquals(redis.calls.includes('lease_release'), true);
  },
);

Deno.test(
  'Portal V2 still rejects guard failures and bad HMAC before cost or database work',
  async () => {
    for (const mode of ['hmac', 'budget', 'redis'] as const) {
      const redis = new FakePortalRedis();
      if (mode === 'budget') redis.guardStatus = 'budget_exhausted';
      if (mode === 'redis') redis.admissionOutage = true;
      let calls = 0;
      const handler = createPortalHybridSearchHandler(
        handlerOptions(
          redis,
          {
            query: () => {
              calls += 1;
              return Promise.resolve(versionedDatabasePage());
            },
          },
          {
            rewriteQuery: async () => {
              calls += 1;
              return REWRITE;
            },
            generateEmbedding: async () => {
              calls += 1;
              return VECTOR;
            },
          },
        ),
      );
      const response = await handler(
        await signedRequest({
          payload: { ...REQUEST, schemaVersion: 'portal.hybrid-search-request.v2', cursor: null },
          badSignature: mode === 'hmac',
        }),
      );
      assertEquals(response.status, mode === 'hmac' ? 401 : mode === 'budget' ? 429 : 503);
      assertEquals(calls, 0);
      assertEquals(redis.cacheReadKeys, []);
    }
  },
);
const SECRET = Uint8Array.from({ length: 32 }, (_value, index) => index + 17);
const KEYRING: PortalHmacKeyring = {
  current: { keyId: 'portal-hybrid-current', secret: SECRET },
};
const TRUSTED_PUBLISHABLE_KEY = 'sb_publishable_portal_hybrid';
const PROCESS_ID = '11111111-1111-4111-8111-111111111111';
const CORRELATION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const VECTOR = Array.from({ length: 1_024 }, () => 0.001);
const REQUEST: PortalHybridSearchRequest = {
  schemaVersion: 'portal.hybrid-search-request.v1',
  kind: 'process',
  query: 'private low-carbon steel query',
  filters: { accessLevel: 'open', geography: 'CN' },
  limit: 10,
};
const GUARD_LIMITS = {
  minuteBudget: 10,
  dailyBudget: 100,
  maxConcurrency: 2,
  leaseTtlSeconds: 20,
  cacheTtlSeconds: 60,
};
const CIRCUIT_LIMITS = {
  failureThreshold: 3,
  failureWindowSeconds: 60,
  openSeconds: 60,
};
const REWRITE: HybridSearchQuery = {
  semantic_query_en: 'low-carbon steel production',
  fulltext_query_en: ['steel production'],
  fulltext_query_zh: ['钢铁生产'],
};
const PROVIDER_CONFIG: Readonly<PortalHybridKernelProviderConfig> = {
  openAi: {
    apiKey: 'sk-portal-test-provider',
    model: 'portal-chat-model-v1',
    baseUrl: 'https://openai.example/v1',
  },
  sageMaker: {
    endpointName: 'portal-embedding-v1',
    region: 'us-east-1',
    accessKeyId: 'AKIAPORTALTEST1234',
    secretAccessKey: 'portal-secret-access-key-1234567890',
    sessionToken: 'portal-session-token-1234',
  },
};

const schedulePortalHybridSecurityEventForTest: typeof schedulePortalHybridSecurityEvent = (
  logger,
  event,
) => {
  queueMicrotask(() => {
    queueMicrotask(() => {
      void Promise.resolve()
        .then(() => logger(event))
        .catch(() => undefined);
    });
  });
};

function environment(values: Record<string, string | undefined>) {
  return { get: (name: string) => values[name] };
}

function databasePage(): PortalPublicHybridCandidatePage {
  return {
    schemaVersion: 'portal.public-hybrid-candidate-page.v1',
    kind: 'process',
    queryFingerprint: 'a'.repeat(64),
    items: [
      {
        key: { kind: 'process', id: PROCESS_ID, version: '01.00.000' },
        accessLevel: 'open',
        capabilities: {
          metadataVisible: true,
          exchangesVisible: true,
          lciaVisible: false,
          publicArtifactVisible: false,
          citationVisible: true,
          policyVersion: 'portal-public-policy-v1',
          reasonCodes: ['published_metadata'],
        },
        names: [{ language: 'en', value: 'Steel production' }],
        summary: [{ language: 'en', value: 'Public summary' }],
        geography: {
          code: 'CN',
          label: [{ language: 'en', value: 'China' }],
          precision: 'country',
        },
        referenceYear: 2025,
        context: {
          reference: {
            kind: 'reference_product',
            name: [{ language: 'en', value: 'Steel' }],
          },
          functionalUnit: {
            amount: '1',
            unit: 'kg',
            description: [{ language: 'en', value: '1 kg steel' }],
          },
          technology: [{ language: 'en', value: 'Electric arc furnace' }],
          source: {
            databaseId: 'tiangong-database',
            databaseVersion: '2026.1',
            sourceRecordId: null,
            providerName: [{ language: 'en', value: 'TianGong' }],
            licenseId: 'CC-BY-4.0',
            licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
          },
          quality: { reviewStatus: 'reviewed' },
        },
        modifiedAt: '2026-08-26T00:00:00Z',
        match: {
          kind: 'hybrid',
          algorithmVersion: 'portal-hybrid-rank-v1',
          score: 0.9,
          reasonCodes: ['lexical_public_projection', 'semantic_public_projection'],
          evidence: { lexicalRank: 1, semanticRank: 2, semanticDistance: '0.125' },
        },
      },
    ],
  };
}

class FakePortalRedis implements PortalRedisAdapter {
  readonly namespace = 'portal:test:v1';
  replay = false;
  admissionOutage = false;
  cacheReadFails = false;
  guardStatus: 'admitted' | 'budget_exhausted' | 'concurrency_exhausted' = 'admitted';
  circuitOpen = false;
  cached: string | null = null;
  cacheWriteFails = false;
  circuitSuccessOperation?: () => Promise<unknown>;
  cacheGetOperation?: (key: string) => Promise<string | null>;
  cacheSetOperation?: () => Promise<void>;
  hybridBeginOperation?: () => Promise<unknown>;
  leaseReleaseOperation?: () => Promise<unknown>;
  readonly calls: string[] = [];
  readonly cacheWrites: string[] = [];
  readonly cacheReadKeys: string[] = [];
  readonly cacheWriteKeys: string[] = [];
  readonly closed = Promise.withResolvers<void>();

  setNxEx(): Promise<boolean> {
    this.calls.push('nonce');
    if (this.admissionOutage) return Promise.reject(new Error('private redis provider details'));
    return Promise.resolve(!this.replay);
  }

  eval(script: string, _keys: string[], args: string[]): Promise<unknown> {
    if (script === PORTAL_HYBRID_ATOMIC_BEGIN_LUA) {
      this.calls.push('hybrid_begin');
      if (this.admissionOutage) {
        return Promise.reject(new Error('private redis provider details'));
      }
      if (this.hybridBeginOperation) return this.hybridBeginOperation();
      if (this.replay) return Promise.resolve([3, 0, 0, 0, 0, 0]);
      if (this.guardStatus === 'budget_exhausted') {
        return Promise.resolve([1, 0, 0, 1, 0, 0]);
      }
      if (this.guardStatus === 'concurrency_exhausted') {
        return Promise.resolve([2, 1, 1, 0, 0, 0]);
      }
      return Promise.resolve(
        this.circuitOpen ? [4, 9, 99, 1, 0, Number(args[0]) + 60_000] : [0, 9, 99, 1, 0, 0],
      );
    }
    if (script === PORTAL_HYBRID_CIRCUIT_FAILURE_LUA) {
      this.calls.push('circuit_failure');
      return Promise.resolve([0, 1, 0]);
    }
    if (script === PORTAL_HYBRID_CIRCUIT_SUCCESS_LUA) {
      this.calls.push('circuit_success');
      if (this.circuitSuccessOperation) return this.circuitSuccessOperation();
      return Promise.resolve(1);
    }
    this.calls.push('lease_release');
    if (this.leaseReleaseOperation) return this.leaseReleaseOperation();
    return Promise.resolve(1);
  }

  get(key: string): Promise<string | null> {
    this.calls.push('cache_get');
    this.cacheReadKeys.push(key);
    if (this.cacheGetOperation) return this.cacheGetOperation(key);
    if (this.cacheReadFails) return Promise.reject(new Error('private redis provider details'));
    return Promise.resolve(this.cached);
  }

  setEx(key: string, value: string): Promise<void> {
    this.calls.push('cache_set');
    this.cacheWriteKeys.push(key);
    if (this.cacheSetOperation) return this.cacheSetOperation();
    if (this.cacheWriteFails) return Promise.reject(new Error('private redis provider details'));
    this.cacheWrites.push(value);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.calls.push('close');
    this.closed.resolve();
    return Promise.resolve();
  }
}

function neverPromise<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

async function hmacSignature(secret: Uint8Array, canonical: string): Promise<string> {
  const copy = new Uint8Array(secret.byteLength);
  copy.set(secret);
  const key = await crypto.subtle.importKey(
    'raw',
    copy.buffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return encodeBase64Url(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical))),
  );
}

let nonceSeed = 0;
async function signedRequest(
  options: {
    payload?: unknown;
    rawBody?: string;
    signedBody?: string;
    actualPath?: string;
    signedPath?: string;
    method?: string;
    timestamp?: number;
    keyId?: string;
    secret?: Uint8Array;
    badSignature?: boolean;
    apiKey?: string | null;
    cookie?: string;
    authorization?: string;
    correlationId?: string;
  } = {},
): Promise<Request> {
  const rawBody =
    options.rawBody ?? JSON.stringify(options.payload === undefined ? REQUEST : options.payload);
  const signedBody = options.signedBody ?? rawBody;
  const keyId = options.keyId ?? KEYRING.current.keyId;
  const timestamp = options.timestamp ?? NOW_SECONDS;
  const nonceBytes = new Uint8Array(16);
  nonceBytes.fill((++nonceSeed % 251) + 1);
  const nonce = encodeBase64Url(nonceBytes);
  const bodyHash = encodeBase64Url(
    await computePortalBodyHash(new TextEncoder().encode(signedBody)),
  );
  const canonical = buildPortalHmacCanonical({
    keyId,
    timestamp: String(timestamp),
    nonce,
    method: 'POST',
    functionPath: options.signedPath ?? PORTAL_HYBRID_FUNCTION_PATH,
    bodyHash,
  });
  const signature = await hmacSignature(options.secret ?? SECRET, canonical);
  const headers = new Headers({
    'Content-Type': 'application/json',
    'x-portal-key-id': keyId,
    'x-portal-timestamp': String(timestamp),
    'x-portal-nonce': nonce,
    'x-portal-body-sha256': bodyHash,
    'x-portal-signature': options.badSignature ? `A${signature.slice(1)}` : signature,
  });
  if (options.apiKey !== null) headers.set('apikey', options.apiKey ?? TRUSTED_PUBLISHABLE_KEY);
  if (options.cookie) headers.set('cookie', options.cookie);
  if (options.authorization) headers.set('authorization', options.authorization);
  if (options.correlationId) headers.set('x-portal-correlation-id', options.correlationId);
  const method = options.method ?? 'POST';
  return new Request(`http://localhost${options.actualPath ?? PORTAL_HYBRID_FUNCTION_PATH}`, {
    method,
    headers,
    body: method === 'POST' ? rawBody : undefined,
  });
}

function handlerOptions(
  redis: FakePortalRedis,
  repository: PortalHybridRepository,
  overrides: Record<string, unknown> = {},
) {
  return {
    keyring: KEYRING,
    redis,
    guardLimits: GUARD_LIMITS,
    circuitLimits: CIRCUIT_LIMITS,
    repository,
    rewriteQuery: async () => REWRITE,
    generateEmbedding: async () => VECTOR,
    enabled: true,
    nowSeconds: () => NOW_SECONDS,
    nowMillis: () => NOW_SECONDS * 1_000,
    timeoutMs: 1_000,
    redisTimeoutMs: 100,
    trustedPublishableKey: TRUSTED_PUBLISHABLE_KEY,
    trustedLegacyAnonKey: null,
    providerConfig: PROVIDER_CONFIG,
    logger: () => undefined,
    scheduleSecurityEvent: schedulePortalHybridSecurityEventForTest,
    ...overrides,
  };
}

async function responseCode(response: Response): Promise<string | null> {
  const payload = (await response.json()) as { code?: string };
  return payload.code ?? null;
}

async function flushPortalHybridSecurityEvent(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function flushUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function raceWithTimeout<T, U>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutValue: U,
): Promise<T | U> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<U>((resolve) => {
    timeoutId = setTimeout(() => resolve(timeoutValue), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

Deno.test(
  'signed Portal Hybrid success is advisory, public-only, correlated, and no-CORS',
  async () => {
    const redis = new FakePortalRedis();
    const repositoryCalls: Array<{
      request: unknown;
      terms: string[];
      embedding: number[];
      signal: AbortSignal;
    }> = [];
    const events: PortalHybridSecurityEvent[] = [];
    const repository: PortalHybridRepository = {
      query(request, terms, embedding, signal) {
        repositoryCalls.push({ request, terms, embedding, signal });
        return Promise.resolve(databasePage());
      },
    };
    let rewriteSignal: AbortSignal | undefined;
    let embeddingSignal: AbortSignal | undefined;
    let embeddingInput: string | undefined;
    let rewriteProvider: Readonly<PortalHybridKernelProviderConfig> | undefined;
    let embeddingProvider: Readonly<PortalHybridKernelProviderConfig> | undefined;
    const handler = createPortalHybridSearchHandler(
      handlerOptions(redis, repository, {
        rewriteQuery: async (
          _config: unknown,
          _query: string,
          signal: AbortSignal,
          provider?: Readonly<PortalHybridKernelProviderConfig>,
        ) => {
          rewriteSignal = signal;
          rewriteProvider = provider;
          return REWRITE;
        },
        generateEmbedding: async (
          query: string,
          signal: AbortSignal,
          provider?: Readonly<PortalHybridKernelProviderConfig>,
        ) => {
          embeddingInput = query;
          embeddingSignal = signal;
          embeddingProvider = provider;
          return VECTOR;
        },
        logger: (event: PortalHybridSecurityEvent) => events.push(event),
      }),
    );
    const response = await handler(await signedRequest({ correlationId: CORRELATION_ID }));
    const text = await response.text();
    const payload = JSON.parse(text);

    assertEquals(response.status, 200);
    assertEquals(response.headers.get('x-portal-correlation-id'), CORRELATION_ID);
    assertEquals(response.headers.get('x-portal-cache'), 'miss');
    assertEquals(response.headers.get('access-control-allow-origin'), null);
    assertEquals(payload.schemaVersion, 'portal.hybrid-search-page.v1');
    assertEquals(payload.kind, 'process');
    assertEquals(payload.queryFingerprint, 'a'.repeat(64));
    assertEquals(payload.interpretation.source, 'model_generated');
    assertEquals(payload.interpretation.advisory, true);
    assertEquals(payload.items, databasePage().items);
    assertEquals(text.includes(REQUEST.query), false);
    assertEquals(Object.hasOwn(payload, 'fallbackReason'), false);
    assertEquals(Object.hasOwn(payload, 'lexicalResults'), false);
    assertEquals(repositoryCalls.length, 1);
    assertEquals((repositoryCalls[0].request as typeof REQUEST).filters.geography, 'cn');
    assert(repositoryCalls[0].terms.length <= 12);
    assertEquals(repositoryCalls[0].embedding.length, 1_024);
    assertEquals(repositoryCalls[0].signal, rewriteSignal);
    assertEquals(repositoryCalls[0].signal, embeddingSignal);
    assertEquals(embeddingInput, REWRITE.semantic_query_en);
    assertEquals(repositoryCalls[0].signal.aborted, false);
    assertEquals(rewriteProvider, PROVIDER_CONFIG);
    assertEquals(embeddingProvider, PROVIDER_CONFIG);
    await flushPortalHybridSecurityEvent();
    assertEquals(events.length, 1);
    assertEquals(events[0].correlationId, CORRELATION_ID);
    assertEquals(events[0].model, 'called');
    assertEquals(events[0].rewriteOutcome, 'succeeded');
    assertEquals(events[0].embeddingOutcome, 'succeeded');
    assertEquals(typeof events[0].rewriteLatencyMs, 'number');
    assertEquals(typeof events[0].embeddingLatencyMs, 'number');
    assertEquals(events[0].database, 'called');
    assertEquals(events[0].items, 1);
    assertEquals(events[0].status, response.status);
    assertEquals(events[0].errorCode, null);
    const serializedEvent = JSON.stringify(events[0]);
    assertEquals(serializedEvent.includes(REQUEST.query), false);
    assertEquals(serializedEvent.includes(PROCESS_ID), false);
    assertEquals(serializedEvent.includes(KEYRING.current.keyId), false);
    assertEquals(serializedEvent.includes(TRUSTED_PUBLISHABLE_KEY), false);
    assertEquals(redis.cacheWrites.length, 1);
    assertEquals(redis.cacheWrites[0].includes(PROCESS_ID), false);
    assertEquals(redis.cacheWrites[0].includes(REQUEST.query), false);
    assert(redis.calls.includes('lease_release'));
  },
);

Deno.test('Portal Hybrid waits for the rewritten English query before embedding', async () => {
  const redis = new FakePortalRedis();
  const rewrite = Promise.withResolvers<HybridSearchQuery>();
  let rewriteStarted = false;
  let embeddingCalls = 0;
  let embeddingInput = '';
  let rewriteSignal: AbortSignal | undefined;
  let embeddingSignal: AbortSignal | undefined;
  let databaseCalls = 0;
  const handler = createPortalHybridSearchHandler(
    handlerOptions(
      redis,
      {
        query() {
          databaseCalls += 1;
          return Promise.resolve(databasePage());
        },
      },
      {
        rewriteQuery: (_config: unknown, _query: string, signal: AbortSignal) => {
          rewriteStarted = true;
          rewriteSignal = signal;
          return rewrite.promise;
        },
        generateEmbedding: async (query: string, signal: AbortSignal) => {
          embeddingCalls += 1;
          embeddingInput = query;
          embeddingSignal = signal;
          return VECTOR;
        },
      },
    ),
  );
  const pending = handler(await signedRequest({ payload: { ...REQUEST, query: '钢铁生产' } }));
  await flushUntil(() => rewriteStarted, 'rewrite starts');
  const callsWhileRewritePending = { embedding: embeddingCalls, database: databaseCalls };
  rewrite.resolve(REWRITE);
  const response = await pending;
  assertEquals(callsWhileRewritePending, { embedding: 0, database: 0 });
  assertEquals(response.status, 200);
  assertEquals(embeddingCalls, 1);
  assertEquals(embeddingInput, REWRITE.semantic_query_en);
  assertEquals(embeddingSignal, rewriteSignal);
  assertEquals(databaseCalls, 1);
});

Deno.test('Portal Hybrid English pipeline cannot reuse the legacy raw-query cache', async () => {
  const redis = new FakePortalRedis();
  const request = await signedRequest();
  const legacyKey = `${redis.namespace}:cache:portal_hybrid_search_v1:${request.headers.get('x-portal-body-sha256')}`;
  const legacyCache = JSON.stringify({
    schemaVersion: 'portal.hybrid-model-cache.v1',
    interpretation: {
      source: 'model_generated',
      advisory: true,
      semanticQuery: REWRITE.semantic_query_en,
      terms: [{ language: 'en', value: 'steel production' }],
    },
    queryTerms: ['steel production'],
    queryEmbedding: VECTOR,
  });
  redis.cacheGetOperation = (key) => Promise.resolve(key === legacyKey ? legacyCache : null);
  let rewriteCalls = 0;
  const handler = createPortalHybridSearchHandler(
    handlerOptions(
      redis,
      { query: () => Promise.resolve(databasePage()) },
      {
        rewriteQuery: async () => {
          rewriteCalls += 1;
          return REWRITE;
        },
      },
    ),
  );
  const response = await handler(request);
  assertEquals(response.status, 200);
  assertEquals(rewriteCalls, 1);
  assertEquals(redis.cacheReadKeys.length, 1);
  assertEquals(redis.cacheReadKeys.includes(legacyKey), false);
  assertEquals(redis.cacheWriteKeys, redis.cacheReadKeys);
  assertEquals(JSON.parse(redis.cacheWrites[0]).schemaVersion, 'portal.hybrid-model-cache.v2');
});

Deno.test(
  'Portal Hybrid preserves original full-text queries beyond English and Chinese',
  async () => {
    for (const query of ['электроэнергия', 'الطاقة الكهربائية', '製鋼工程', 'STEEL PRODUCTION']) {
      const redis = new FakePortalRedis();
      let terms: string[] = [];
      let embeddingInput = '';
      const handler = createPortalHybridSearchHandler(
        handlerOptions(
          redis,
          {
            query(_request, queryTerms) {
              terms = queryTerms;
              return Promise.resolve(databasePage());
            },
          },
          {
            generateEmbedding: async (text: string) => {
              embeddingInput = text;
              return VECTOR;
            },
          },
        ),
      );
      const response = await handler(await signedRequest({ payload: { ...REQUEST, query } }));
      assertEquals(response.status, 200);
      assertEquals(terms[0], query);
      assert(terms.includes(REWRITE.semantic_query_en));
      assert(terms.length <= 12);
      assertEquals(new Set(terms.map((term) => term.toLowerCase())).size, terms.length);
      assertEquals(embeddingInput, REWRITE.semantic_query_en);
      assertEquals(
        redis.cacheWrites.some((value) => value.includes(query)),
        false,
      );
    }
  },
);

Deno.test(
  'Portal Hybrid repository calls only the exact api façade with a publishable key',
  async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const signal = new AbortController().signal;
    const repository = createPortalHybridRepository({
      supabaseUrl: 'https://example.supabase.co',
      publishableKey: TRUSTED_PUBLISHABLE_KEY,
      fetchImpl: (input, init) => {
        capturedUrl = String(input);
        capturedInit = init;
        return Promise.resolve(Response.json(databasePage()));
      },
    });
    const parsedRequest: PortalHybridSearchRequest = {
      ...REQUEST,
      filters: { accessLevel: 'open', geography: 'cn' },
    };
    const result = await repository.query(parsedRequest, ['steel', '钢铁'], VECTOR, signal);

    assertEquals(result, databasePage());
    assertEquals(capturedUrl, 'https://example.supabase.co/rest/v1/rpc/portal_hybrid_search_v1');
    assertEquals(capturedInit?.method, 'POST');
    const headers = new Headers(capturedInit?.headers);
    assertEquals(headers.get('apikey'), TRUSTED_PUBLISHABLE_KEY);
    assertEquals(headers.get('content-profile'), 'api');
    assertEquals(headers.get('authorization'), null);
    assertEquals(capturedInit?.signal, signal);
    assertEquals(JSON.parse(String(capturedInit?.body)), {
      p_kind: 'process',
      p_query_terms: ['steel', '钢铁'],
      p_query_embedding: `[${VECTOR.join(',')}]`,
      p_filters: { accessLevel: 'open', geography: 'cn' },
      p_limit: 10,
    });

    for (const credential of [
      'sb_secret_forbidden',
      `${btoa('{"alg":"none"}')}.${btoa('{"role":"service_role"}')}.AA`,
    ]) {
      await assertRejects(async () => {
        const invalid = createPortalHybridRepository({
          supabaseUrl: 'https://example.supabase.co',
          publishableKey: credential,
        });
        await invalid.query(parsedRequest, ['steel'], VECTOR, signal);
      });
    }
  },
);

Deno.test('Portal Hybrid repository rejects private or malformed database DTOs', async () => {
  const privatePage = structuredClone(databasePage()) as unknown as Record<string, unknown>;
  (privatePage.items as Array<Record<string, unknown>>)[0].team_id = 'private-team';
  const repository = createPortalHybridRepository({
    supabaseUrl: 'https://example.supabase.co',
    publishableKey: TRUSTED_PUBLISHABLE_KEY,
    fetchImpl: () => Promise.resolve(Response.json(privatePage)),
  });
  const error = await assertRejects(() =>
    repository.query(REQUEST, ['steel'], VECTOR, new AbortController().signal),
  );
  assertEquals((error as PortalHybridRepositoryError).code, 'contract_failure');

  const validRepository = createPortalHybridRepository({
    supabaseUrl: 'https://example.supabase.co',
    publishableKey: TRUSTED_PUBLISHABLE_KEY,
    fetchImpl: () => Promise.resolve(Response.json(databasePage())),
  });
  for (const [request, terms] of [
    [{ ...REQUEST, data_source: 'tg' }, ['steel']],
    [REQUEST, Array.from({ length: 13 }, (_value, index) => `term-${index}`)],
    [REQUEST, ['duplicate', 'duplicate']],
  ] as const) {
    const boundaryError = await assertRejects(() =>
      validRepository.query(
        request as PortalHybridSearchRequest,
        [...terms],
        VECTOR,
        new AbortController().signal,
      ),
    );
    assertEquals((boundaryError as PortalHybridRepositoryError).code, 'contract_failure');
  }
});

Deno.test(
  'Portal Hybrid rejects HMAC failures before Redis, JSON, model, or database',
  async () => {
    for (const request of [
      await signedRequest({ badSignature: true, rawBody: '{bad json' }),
      await signedRequest({
        signedBody: JSON.stringify(REQUEST),
        rawBody: JSON.stringify({ ...REQUEST, limit: 9 }),
      }),
      await signedRequest({ timestamp: NOW_SECONDS - 61 }),
      await signedRequest({ keyId: 'unknown-key' }),
      await signedRequest({ signedPath: '/functions/v1/portal_data_product_results_v1' }),
    ]) {
      const redis = new FakePortalRedis();
      let modelCalls = 0;
      let databaseCalls = 0;
      const handler = createPortalHybridSearchHandler(
        handlerOptions(
          redis,
          {
            query() {
              databaseCalls += 1;
              return Promise.resolve(databasePage());
            },
          },
          {
            rewriteQuery: async () => {
              modelCalls += 1;
              return REWRITE;
            },
          },
        ),
      );
      const response = await handler(request);
      assertEquals(response.status, 401);
      assertEquals(await responseCode(response), 'portal_auth_failed');
      assertEquals(redis.calls, []);
      assertEquals(modelCalls, 0);
      assertEquals(databaseCalls, 0);
    }
  },
);

Deno.test(
  'Portal Hybrid method, size, transport, and guard configuration statuses are fixed',
  async () => {
    const repository: PortalHybridRepository = { query: () => Promise.resolve(databasePage()) };
    const methodRedis = new FakePortalRedis();
    const methodResponse = await createPortalHybridSearchHandler(
      handlerOptions(methodRedis, repository),
    )(await signedRequest({ method: 'GET' }));
    assertEquals(methodResponse.status, 405);
    assertEquals(await responseCode(methodResponse), 'method_not_allowed');
    assertEquals(methodRedis.calls, []);

    const sizeRedis = new FakePortalRedis();
    const oversized = await signedRequest();
    oversized.headers.set('content-length', String(32 * 1024 + 1));
    const sizeResponse = await createPortalHybridSearchHandler(
      handlerOptions(sizeRedis, repository),
    )(oversized);
    assertEquals(sizeResponse.status, 413);
    assertEquals(await responseCode(sizeResponse), 'request_too_large');
    assertEquals(sizeRedis.calls, []);

    const transportRedis = new FakePortalRedis();
    const transportResponse = await createPortalHybridSearchHandler(
      handlerOptions(transportRedis, repository),
    )(await signedRequest({ apiKey: null }));
    assertEquals(transportResponse.status, 401);
    assertEquals(await responseCode(transportResponse), 'portal_auth_failed');
    assertEquals(transportRedis.calls, []);

    const configRedis = new FakePortalRedis();
    const configResponse = await createPortalHybridSearchHandler(
      handlerOptions(configRedis, repository, {
        timeoutMs: PORTAL_HYBRID_TOTAL_TIMEOUT_MS + 1,
      }),
    )(await signedRequest());
    assertEquals(configResponse.status, 503);
    assertEquals(await responseCode(configResponse), 'guard_unavailable');
    assertEquals(configRedis.calls, []);
  },
);

Deno.test('Portal Hybrid accepts only exact public and CLI-stripped runtime paths', async () => {
  for (const actualPath of [PORTAL_HYBRID_FUNCTION_PATH, PORTAL_HYBRID_RUNTIME_PATH]) {
    const redis = new FakePortalRedis();
    const handler = createPortalHybridSearchHandler(
      handlerOptions(redis, { query: () => Promise.resolve(databasePage()) }),
    );
    const response = await handler(await signedRequest({ actualPath }));
    assertEquals(response.status, 200);
  }
  const redis = new FakePortalRedis();
  const handler = createPortalHybridSearchHandler(
    handlerOptions(redis, { query: () => Promise.resolve(databasePage()) }),
  );
  const response = await handler(
    await signedRequest({ actualPath: `${PORTAL_HYBRID_FUNCTION_PATH}/suffix` }),
  );
  assertEquals(response.status, 401);
  assertEquals(redis.calls, []);
});

Deno.test(
  'Portal Hybrid exact-false kill switch rejects before Redis, model, or database',
  async () => {
    assertEquals(isPortalHybridEnabled({ get: () => undefined }), false);
    assertEquals(isPortalHybridEnabled({ get: () => 'TRUE' }), false);
    assertEquals(isPortalHybridEnabled({ get: () => ' true ' }), false);
    assertEquals(isPortalHybridEnabled({ get: () => 'true' }), true);

    const redis = new FakePortalRedis();
    let modelCalls = 0;
    let databaseCalls = 0;
    let providerConfigReads = 0;
    const handler = createPortalHybridSearchHandler(
      handlerOptions(
        redis,
        {
          query() {
            databaseCalls += 1;
            return Promise.resolve(databasePage());
          },
        },
        {
          enabled: false,
          providerConfig: undefined,
          providerConfigFactory: () => {
            providerConfigReads += 1;
            throw new Error('must not read provider configuration');
          },
          rewriteQuery: async () => {
            modelCalls += 1;
            return REWRITE;
          },
        },
      ),
    );
    const response = await handler(await signedRequest());
    assertEquals(response.status, 503);
    assertEquals(await responseCode(response), 'hybrid_disabled');
    assertEquals(redis.calls, []);
    assertEquals(providerConfigReads, 0);
    assertEquals(modelCalls, 0);
    assertEquals(databaseCalls, 0);
  },
);

Deno.test('Portal Hybrid provider configuration is strict and has no generic fallback', () => {
  const portalValues = {
    PORTAL_OPENAI_API_KEY: 'sk-portal-test-provider',
    PORTAL_OPENAI_CHAT_MODEL: 'portal-chat-model-v1',
    PORTAL_OPENAI_BASE_URL: 'https://openai.example/v1',
    PORTAL_SAGEMAKER_ENDPOINT_NAME: 'portal-embedding-v1',
    PORTAL_AWS_ACCESS_KEY_ID: 'AKIAPORTALTEST1234',
    PORTAL_AWS_SECRET_ACCESS_KEY: 'portal-secret-access-key-1234567890',
    PORTAL_AWS_SESSION_TOKEN: 'portal-session-token-1234',
    OPENAI_API_KEY: 'sk-generic-must-not-win',
    OPENAI_CHAT_MODEL: 'generic-model',
    OPENAI_BASE_URL: 'https://generic.example/v1',
    SAGEMAKER_ENDPOINT_NAME: 'generic-endpoint',
    AWS_ACCESS_KEY_ID: 'AKIAGENERICTEST123',
    AWS_SECRET_ACCESS_KEY: 'generic-secret-access-key-123456789',
    AWS_SESSION_TOKEN: 'generic-session-token-1234',
  };
  assertEquals(readPortalHybridProviderConfig(environment(portalValues)), PROVIDER_CONFIG);

  const requiredPortalNames = [
    'PORTAL_OPENAI_API_KEY',
    'PORTAL_OPENAI_CHAT_MODEL',
    'PORTAL_SAGEMAKER_ENDPOINT_NAME',
    'PORTAL_AWS_ACCESS_KEY_ID',
    'PORTAL_AWS_SECRET_ACCESS_KEY',
  ];
  for (const missing of requiredPortalNames) {
    assertRejects(
      () =>
        Promise.resolve().then(() =>
          readPortalHybridProviderConfig(environment({ ...portalValues, [missing]: undefined })),
        ),
      PortalHybridProviderError,
      'portal_hybrid_provider_config_invalid',
    );
  }
  for (const invalid of [
    { ...portalValues, PORTAL_OPENAI_API_KEY: 'sb_secret_not_openai' },
    { ...portalValues, PORTAL_OPENAI_CHAT_MODEL: ' bad-model' },
    { ...portalValues, PORTAL_OPENAI_BASE_URL: 'http://provider.example/v1' },
    { ...portalValues, PORTAL_SAGEMAKER_ENDPOINT_NAME: '-invalid-endpoint' },
    { ...portalValues, PORTAL_AWS_ACCESS_KEY_ID: 'short' },
    { ...portalValues, PORTAL_AWS_SECRET_ACCESS_KEY: 'contains whitespace secret' },
    { ...portalValues, PORTAL_AWS_SESSION_TOKEN: 'short' },
  ]) {
    assertRejects(
      () => Promise.resolve().then(() => readPortalHybridProviderConfig(environment(invalid))),
      PortalHybridProviderError,
      'portal_hybrid_provider_config_invalid',
    );
  }

  assertRejects(
    () =>
      Promise.resolve().then(() =>
        readPortalHybridProviderConfig(
          environment({
            OPENAI_API_KEY: portalValues.PORTAL_OPENAI_API_KEY,
            OPENAI_CHAT_MODEL: portalValues.PORTAL_OPENAI_CHAT_MODEL,
            SAGEMAKER_ENDPOINT_NAME: portalValues.PORTAL_SAGEMAKER_ENDPOINT_NAME,
            AWS_ACCESS_KEY_ID: portalValues.PORTAL_AWS_ACCESS_KEY_ID,
            AWS_SECRET_ACCESS_KEY: portalValues.PORTAL_AWS_SECRET_ACCESS_KEY,
          }),
        ),
      ),
    PortalHybridProviderError,
    'portal_hybrid_provider_config_invalid',
  );
});

Deno.test(
  'Portal Hybrid default provider resolver rejects generic-only environment wiring',
  async () => {
    const redis = new FakePortalRedis();
    let modelCalls = 0;
    let databaseCalls = 0;
    const genericOnlyEnvironment = environment({
      OPENAI_API_KEY: 'sk-generic-must-not-win',
      OPENAI_CHAT_MODEL: 'generic-model',
      SAGEMAKER_ENDPOINT_NAME: 'generic-endpoint',
      AWS_ACCESS_KEY_ID: 'AKIAGENERICTEST123',
      AWS_SECRET_ACCESS_KEY: 'generic-secret-access-key-123456789',
    });
    const handler = createPortalHybridSearchHandler(
      handlerOptions(
        redis,
        {
          query() {
            databaseCalls += 1;
            return Promise.resolve(databasePage());
          },
        },
        {
          providerConfig: undefined,
          providerConfigFactory: () => readPortalHybridProviderConfig(genericOnlyEnvironment),
          rewriteQuery: async () => {
            modelCalls += 1;
            return REWRITE;
          },
        },
      ),
    );

    const response = await handler(await signedRequest());
    assertEquals(response.status, 503);
    assertEquals(await responseCode(response), 'hybrid_upstream_unavailable');
    assertEquals(redis.calls, []);
    assertEquals(modelCalls, 0);
    assertEquals(databaseCalls, 0);
  },
);

Deno.test(
  'Portal Hybrid invalid provider or database config fails before Redis or cost',
  async () => {
    const redis = new FakePortalRedis();
    let modelCalls = 0;
    let databaseCalls = 0;
    const handler = createPortalHybridSearchHandler(
      handlerOptions(
        redis,
        {
          query() {
            databaseCalls += 1;
            return Promise.resolve(databasePage());
          },
        },
        {
          providerConfig: undefined,
          providerConfigFactory: () => {
            throw new PortalHybridProviderError();
          },
          rewriteQuery: async () => {
            modelCalls += 1;
            return REWRITE;
          },
        },
      ),
    );
    const response = await handler(await signedRequest());
    assertEquals(response.status, 503);
    assertEquals(await responseCode(response), 'hybrid_upstream_unavailable');
    assertEquals(redis.calls, []);
    assertEquals(modelCalls, 0);
    assertEquals(databaseCalls, 0);

    const repositoryConfigRedis = new FakePortalRedis();
    const repositoryConfigResponse = await createPortalHybridSearchHandler(
      handlerOptions(
        repositoryConfigRedis,
        { query: () => Promise.resolve(databasePage()) },
        {
          repository: undefined,
          repositoryFactory: () => {
            throw new Error('cross-project database configuration');
          },
          rewriteQuery: async () => {
            modelCalls += 1;
            return REWRITE;
          },
        },
      ),
    )(await signedRequest());
    assertEquals(repositoryConfigResponse.status, 503);
    assertEquals(await responseCode(repositoryConfigResponse), 'hybrid_upstream_unavailable');
    assertEquals(repositoryConfigRedis.calls, []);
    assertEquals(modelCalls, 0);
    assertEquals(databaseCalls, 0);
  },
);

Deno.test('Portal Hybrid public transport rejects Cookie before Redis or cost', async () => {
  const redis = new FakePortalRedis();
  let modelCalls = 0;
  let databaseCalls = 0;
  const handler = createPortalHybridSearchHandler(
    handlerOptions(
      redis,
      {
        query() {
          databaseCalls += 1;
          return Promise.resolve(databasePage());
        },
      },
      {
        rewriteQuery: async () => {
          modelCalls += 1;
          return REWRITE;
        },
      },
    ),
  );
  const response = await handler(await signedRequest({ cookie: 'session=private' }));
  assertEquals(response.status, 401);
  assertEquals(await responseCode(response), 'portal_auth_failed');
  assertEquals(redis.calls, []);
  assertEquals(modelCalls, 0);
  assertEquals(databaseCalls, 0);
});

Deno.test(
  'Portal Hybrid replay, nonce/admission Redis, budget, concurrency, and open-circuit rejections make zero cost calls',
  async () => {
    const cases: Array<{
      configure: (redis: FakePortalRedis) => void;
      status: number;
      code: string;
    }> = [
      { configure: (redis) => (redis.replay = true), status: 403, code: 'replay_rejected' },
      {
        configure: (redis) => (redis.admissionOutage = true),
        status: 503,
        code: 'guard_unavailable',
      },
      {
        configure: (redis) => (redis.guardStatus = 'budget_exhausted'),
        status: 429,
        code: 'budget_exhausted',
      },
      {
        configure: (redis) => (redis.guardStatus = 'concurrency_exhausted'),
        status: 429,
        code: 'concurrency_exhausted',
      },
      { configure: (redis) => (redis.circuitOpen = true), status: 503, code: 'circuit_open' },
    ];
    for (const testCase of cases) {
      const redis = new FakePortalRedis();
      testCase.configure(redis);
      let modelCalls = 0;
      let databaseCalls = 0;
      const handler = createPortalHybridSearchHandler(
        handlerOptions(
          redis,
          {
            query() {
              databaseCalls += 1;
              return Promise.resolve(databasePage());
            },
          },
          {
            rewriteQuery: async () => {
              modelCalls += 1;
              return REWRITE;
            },
          },
        ),
      );
      const response = await handler(await signedRequest());
      assertEquals(response.status, testCase.status);
      assertEquals(await responseCode(response), testCase.code);
      assertEquals(modelCalls, 0);
      assertEquals(databaseCalls, 0);
    }
  },
);

Deno.test(
  'Portal Hybrid atomic begin or cache deadline stops before every model and database call',
  async () => {
    for (const stage of ['begin', 'cache'] as const) {
      const redis = new FakePortalRedis();
      if (stage === 'begin') redis.hybridBeginOperation = () => neverPromise();
      if (stage === 'cache') redis.cacheGetOperation = () => neverPromise();
      let modelCalls = 0;
      let databaseCalls = 0;
      const handler = createPortalHybridSearchHandler(
        handlerOptions(
          redis,
          {
            query() {
              databaseCalls += 1;
              return Promise.resolve(databasePage());
            },
          },
          {
            timeoutMs: 100,
            rewriteQuery: async () => {
              modelCalls += 1;
              return REWRITE;
            },
          },
        ),
      );
      const response = await handler(await signedRequest());
      assertEquals(response.status, 503);
      assertEquals(await responseCode(response), 'hybrid_timeout');
      assertEquals(modelCalls, 0, stage);
      assertEquals(databaseCalls, 0, stage);
      assert(redis.calls.includes(stage === 'begin' ? 'hybrid_begin' : 'cache_get'));
    }
  },
);

Deno.test(
  'Portal Hybrid atomic begin preserves circuit-open and invalid-request precedence',
  async () => {
    let databaseCalls = 0;
    const openRedis = new FakePortalRedis();
    openRedis.circuitOpen = true;
    openRedis.cacheReadFails = true;
    const openResponse = await createPortalHybridSearchHandler(
      handlerOptions(openRedis, {
        query() {
          databaseCalls += 1;
          return Promise.resolve(databasePage());
        },
      }),
    )(await signedRequest());
    assertEquals(openResponse.status, 503);
    assertEquals(await responseCode(openResponse), 'circuit_open');
    assertEquals(openRedis.calls.includes('cache_get'), false);
    assertEquals(databaseCalls, 0);

    const invalidRedis = new FakePortalRedis();
    invalidRedis.cacheReadFails = true;
    const invalidResponse = await createPortalHybridSearchHandler(
      handlerOptions(invalidRedis, {
        query() {
          databaseCalls += 1;
          return Promise.resolve(databasePage());
        },
      }),
    )(await signedRequest({ rawBody: '{bad json' }));
    assertEquals(invalidResponse.status, 400);
    assertEquals(await responseCode(invalidResponse), 'invalid_request');
    assertEquals(invalidRedis.calls, ['hybrid_begin', 'lease_release']);
    assertEquals(databaseCalls, 0);
  },
);

Deno.test('Portal Hybrid overlaps model-cache write with the public Database query', async () => {
  const redis = new FakePortalRedis();
  let resolveCacheWrite: (() => void) | undefined;
  redis.cacheSetOperation = () =>
    new Promise((resolve) => {
      resolveCacheWrite = resolve;
    });
  let resolveDatabase: ((value: PortalPublicHybridCandidatePage) => void) | undefined;
  let databaseCalls = 0;
  const handler = createPortalHybridSearchHandler(
    handlerOptions(redis, {
      query() {
        databaseCalls += 1;
        return new Promise((resolve) => {
          resolveDatabase = resolve;
        });
      },
    }),
  );

  const responsePromise = handler(await signedRequest());
  await flushUntil(
    () => resolveCacheWrite !== undefined && resolveDatabase !== undefined,
    'parallel cache write and Database query',
  );
  assertEquals(databaseCalls, 1);
  assert(redis.calls.includes('cache_set'));

  resolveDatabase?.(databasePage());
  assertEquals(await raceWithTimeout(responsePromise, 10, 'pending'), 'pending');
  resolveCacheWrite?.();

  const response = await responsePromise;
  assertEquals(response.status, 200);
  assertEquals(response.headers.get('x-portal-cache'), 'miss');
});

Deno.test(
  'Portal Hybrid captures cache-write failure before sanitizing a Database rejection event',
  async () => {
    const redis = new FakePortalRedis();
    let rejectCacheWrite: ((reason?: unknown) => void) | undefined;
    redis.cacheSetOperation = () =>
      new Promise((_resolve, reject) => {
        rejectCacheWrite = reject;
      });
    const events: PortalHybridSecurityEvent[] = [];
    const handler = createPortalHybridSearchHandler(
      handlerOptions(
        redis,
        {
          query() {
            return Promise.reject(new Error('private Database details'));
          },
        },
        { logger: (event: PortalHybridSecurityEvent) => events.push(event) },
      ),
    );

    const responsePromise = handler(await signedRequest());
    await flushUntil(() => rejectCacheWrite !== undefined, 'pending model-cache write');
    assertEquals(await raceWithTimeout(responsePromise, 10, 'pending'), 'pending');
    rejectCacheWrite?.(new Error('private Redis cache details'));

    const response = await responsePromise;
    assertEquals(response.status, 503);
    assertEquals(await responseCode(response), 'hybrid_upstream_unavailable');
    await flushPortalHybridSecurityEvent();
    assertEquals(events.length, 1);
    assertEquals(events[0].cache, 'write_failed');
    assertEquals(events[0].database, 'failed');
  },
);

Deno.test(
  'Portal Hybrid cache-write and circuit-reset errors remain bounded best effort',
  async () => {
    const redis = new FakePortalRedis();
    redis.cacheWriteFails = true;
    redis.circuitSuccessOperation = () => Promise.reject(new Error('private redis reset details'));
    const events: PortalHybridSecurityEvent[] = [];
    const handler = createPortalHybridSearchHandler(
      handlerOptions(
        redis,
        { query: () => Promise.resolve(databasePage()) },
        { logger: (event: PortalHybridSecurityEvent) => events.push(event) },
      ),
    );
    const response = await handler(await signedRequest());
    assertEquals(response.status, 200);
    await flushPortalHybridSecurityEvent();
    assertEquals(events.length, 1);
    assertEquals(events[0].cache, 'write_failed');
    assertEquals(events[0].circuit, 'reset_failed');
  },
);

Deno.test(
  'Portal Hybrid parses JSON only after admission and rejects every extra field before model',
  async () => {
    for (const rawBody of [
      '{bad json',
      JSON.stringify({ ...REQUEST, data_source: 'tg' }),
      JSON.stringify({ ...REQUEST, cursor: 'forbidden' }),
      JSON.stringify({ ...REQUEST, kind: 'flow', filters: { processSubtype: 'unit' } }),
    ]) {
      const redis = new FakePortalRedis();
      redis.cacheReadFails = true;
      let modelCalls = 0;
      let databaseCalls = 0;
      const handler = createPortalHybridSearchHandler(
        handlerOptions(
          redis,
          {
            query() {
              databaseCalls += 1;
              return Promise.resolve(databasePage());
            },
          },
          {
            rewriteQuery: async () => {
              modelCalls += 1;
              return REWRITE;
            },
          },
        ),
      );
      const response = await handler(await signedRequest({ rawBody }));
      assertEquals(response.status, 400);
      assertEquals(await responseCode(response), 'invalid_request');
      assert(redis.calls.includes('hybrid_begin'));
      assertEquals(redis.calls.includes('cache_get'), false);
      assertEquals(modelCalls, 0);
      assertEquals(databaseCalls, 0);
    }
  },
);

Deno.test(
  'Portal Hybrid model cache skips models but never skips the public database façade',
  async () => {
    const redis = new FakePortalRedis();
    const cache: PortalHybridModelCache = {
      schemaVersion: 'portal.hybrid-model-cache.v2',
      interpretation: {
        source: 'model_generated',
        advisory: true,
        semanticQuery: 'steel production',
        terms: [{ language: 'en', value: 'steel' }],
      },
      queryTerms: ['steel'],
      queryEmbedding: VECTOR,
    };
    redis.cached = JSON.stringify(cache);
    let databaseCalls = 0;
    const events: PortalHybridSecurityEvent[] = [];
    const handler = createPortalHybridSearchHandler(
      handlerOptions(
        redis,
        {
          query() {
            databaseCalls += 1;
            return Promise.resolve(databasePage());
          },
        },
        {
          rewriteQuery: () => Promise.reject(new Error('must not call rewrite')),
          generateEmbedding: () => Promise.reject(new Error('must not call embedding')),
          logger: (event: PortalHybridSecurityEvent) => events.push(event),
        },
      ),
    );
    const response = await handler(await signedRequest());
    assertEquals(response.status, 200);
    assertEquals(response.headers.get('x-portal-cache'), 'hit');
    assertEquals(databaseCalls, 1);
    await flushPortalHybridSecurityEvent();
    assertEquals(events[0].model, 'cache_hit');
    assertEquals(events[0].rewriteOutcome, 'cache_hit');
    assertEquals(events[0].embeddingOutcome, 'cache_hit');
    assertEquals(events[0].rewriteLatencyMs, null);
    assertEquals(events[0].embeddingLatencyMs, null);
  },
);

Deno.test(
  'Portal Hybrid malformed cache fails contract without model or database fallback',
  async () => {
    const redis = new FakePortalRedis();
    redis.cached = '{"schemaVersion":"portal.hybrid-model-cache.v1","query":"private"}';
    let modelCalls = 0;
    let databaseCalls = 0;
    const handler = createPortalHybridSearchHandler(
      handlerOptions(
        redis,
        {
          query() {
            databaseCalls += 1;
            return Promise.resolve(databasePage());
          },
        },
        {
          rewriteQuery: async () => {
            modelCalls += 1;
            return REWRITE;
          },
        },
      ),
    );
    const response = await handler(await signedRequest());
    assertEquals(response.status, 503);
    assertEquals(await responseCode(response), 'contract_failure');
    assertEquals(modelCalls, 0);
    assertEquals(databaseCalls, 0);
    assert(redis.calls.includes('circuit_failure'));
  },
);

Deno.test(
  'Portal Hybrid model failure and invalid embedding are fixed circuit failures',
  async () => {
    for (const testCase of [
      {
        rewriteQuery: () => Promise.reject(new Error('private provider details')),
        generateEmbedding: async () => VECTOR,
        code: 'hybrid_upstream_unavailable',
      },
      {
        rewriteQuery: async () => REWRITE,
        generateEmbedding: async () => [0.1, 0.2],
        code: 'contract_failure',
      },
      {
        rewriteQuery: async () => null as unknown as HybridSearchQuery,
        generateEmbedding: async () => VECTOR,
        code: 'contract_failure',
      },
      {
        rewriteQuery: async () => ({ ...REWRITE, semantic_query_en: ' ' }),
        generateEmbedding: () => {
          throw new Error('embedding must not run for an empty rewrite');
        },
        code: 'contract_failure',
      },
      {
        rewriteQuery: async () => ({ ...REWRITE, semantic_query_en: 'a'.repeat(513) }),
        generateEmbedding: () => {
          throw new Error('embedding must not run for an invalid rewrite');
        },
        code: 'contract_failure',
      },
      {
        rewriteQuery: async () =>
          ({
            semantic_query_en: 'steel',
            fulltext_query_en: ['steel', 42],
            fulltext_query_zh: [],
          }) as unknown as HybridSearchQuery,
        generateEmbedding: async () => VECTOR,
        code: 'contract_failure',
      },
      {
        rewriteQuery: async () =>
          ({ ...REWRITE, private_provider_field: 'must not pass' }) as HybridSearchQuery,
        generateEmbedding: async () => VECTOR,
        code: 'contract_failure',
      },
    ]) {
      const redis = new FakePortalRedis();
      let databaseCalls = 0;
      const handler = createPortalHybridSearchHandler(
        handlerOptions(
          redis,
          {
            query() {
              databaseCalls += 1;
              return Promise.resolve(databasePage());
            },
          },
          testCase,
        ),
      );
      const response = await handler(await signedRequest());
      assertEquals(response.status, 503);
      assertEquals(await responseCode(response), testCase.code);
      assertEquals(databaseCalls, 0);
      assert(redis.calls.includes('circuit_failure'));
    }
  },
);

Deno.test('Portal Hybrid rewrite failure stops embedding before releasing the lease', async () => {
  const redis = new FakePortalRedis();
  let embeddingSignal: AbortSignal | undefined;
  let embeddingAbortObserved = false;
  let databaseCalls = 0;
  const events: PortalHybridSecurityEvent[] = [];
  const handler = createPortalHybridSearchHandler(
    handlerOptions(
      redis,
      {
        query() {
          databaseCalls += 1;
          return Promise.resolve(databasePage());
        },
      },
      {
        rewriteQuery: () => Promise.reject(new Error('private provider details')),
        generateEmbedding: (_query: string, signal: AbortSignal) => {
          embeddingSignal = signal;
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                embeddingAbortObserved = true;
                reject(new DOMException('aborted', 'AbortError'));
              },
              { once: true },
            );
          });
        },
        logger: (event: PortalHybridSecurityEvent) => events.push(event),
      },
    ),
  );

  const response = await handler(await signedRequest());
  assertEquals(response.status, 503);
  assertEquals(await responseCode(response), 'hybrid_upstream_unavailable');
  assertEquals(embeddingSignal, undefined);
  assertEquals(embeddingAbortObserved, false);
  assertEquals(databaseCalls, 0);
  assert(redis.calls.includes('circuit_failure'));
  assert(redis.calls.includes('lease_release'));
  await flushPortalHybridSecurityEvent();
  assertEquals(events[0].rewriteOutcome, 'failed');
  assertEquals(events[0].embeddingOutcome, 'not_called');
  assertEquals(typeof events[0].rewriteLatencyMs, 'number');
  assertEquals(events[0].embeddingLatencyMs, null);
});

Deno.test(
  'Portal Hybrid rewrite deadline aborts rewrite without starting embedding or database',
  async () => {
    const redis = new FakePortalRedis();
    let rewriteSignal: AbortSignal | undefined;
    let embeddingSignal: AbortSignal | undefined;
    let embeddingCalls = 0;
    let databaseCalls = 0;
    const handler = createPortalHybridSearchHandler(
      handlerOptions(
        redis,
        {
          query() {
            databaseCalls += 1;
            return Promise.resolve(databasePage());
          },
        },
        {
          timeoutMs: 100,
          rewriteQuery: (_config: unknown, _query: string, signal: AbortSignal) => {
            rewriteSignal = signal;
            return neverPromise();
          },
          generateEmbedding: (_query: string, signal: AbortSignal) => {
            embeddingCalls += 1;
            embeddingSignal = signal;
            return neverPromise();
          },
        },
      ),
    );
    const response = await handler(await signedRequest());
    assertEquals(response.status, 503);
    assertEquals(await responseCode(response), 'hybrid_timeout');
    assertEquals(rewriteSignal?.aborted, true);
    assertEquals(embeddingCalls, 0);
    assertEquals(embeddingSignal, undefined);
    assertEquals(databaseCalls, 0);
  },
);

Deno.test(
  'Portal Hybrid absolute deadline shares the same signal with SageMaker and stops database',
  async () => {
    const redis = new FakePortalRedis();
    let embeddingSignal: AbortSignal | undefined;
    let databaseCalls = 0;
    const events: PortalHybridSecurityEvent[] = [];
    const handler = createPortalHybridSearchHandler(
      handlerOptions(
        redis,
        {
          query() {
            databaseCalls += 1;
            return Promise.resolve(databasePage());
          },
        },
        {
          timeoutMs: 100,
          generateEmbedding: (_query: string, signal: AbortSignal) => {
            embeddingSignal = signal;
            return new Promise((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => reject(new DOMException('aborted', 'AbortError')),
                {
                  once: true,
                },
              );
            });
          },
          logger: (event: PortalHybridSecurityEvent) => events.push(event),
        },
      ),
    );
    const response = await handler(await signedRequest());
    assertEquals(response.status, 503);
    assertEquals(await responseCode(response), 'hybrid_timeout');
    assertEquals(embeddingSignal?.aborted, true);
    assertEquals(databaseCalls, 0);
    await flushPortalHybridSecurityEvent();
    assertEquals(events[0].model, 'aborted');
    assertEquals(events[0].rewriteOutcome, 'succeeded');
    assertEquals(events[0].embeddingOutcome, 'aborted');
    assertEquals(typeof events[0].rewriteLatencyMs, 'number');
    assertEquals(typeof events[0].embeddingLatencyMs, 'number');
    assertEquals(events[0].status, response.status);
    assertEquals(events[0].errorCode, 'hybrid_timeout');
  },
);

Deno.test(
  'Portal Hybrid absolute deadline aborts PostgREST and prevents circuit reset',
  async () => {
    const redis = new FakePortalRedis();
    let rewriteSignal: AbortSignal | undefined;
    let embeddingSignal: AbortSignal | undefined;
    let databaseSignal: AbortSignal | undefined;
    const handler = createPortalHybridSearchHandler(
      handlerOptions(
        redis,
        {
          query(_request, _terms, _embedding, signal) {
            databaseSignal = signal;
            return neverPromise();
          },
        },
        {
          timeoutMs: 100,
          redis: undefined,
          redisFactory: async () => redis,
          rewriteQuery: async (_config: unknown, _query: string, signal: AbortSignal) => {
            rewriteSignal = signal;
            return REWRITE;
          },
          generateEmbedding: async (_query: string, signal: AbortSignal) => {
            embeddingSignal = signal;
            return VECTOR;
          },
        },
      ),
    );
    const response = await handler(await signedRequest());
    assertEquals(response.status, 503);
    assertEquals(await responseCode(response), 'hybrid_timeout');
    assertEquals(rewriteSignal, embeddingSignal);
    assertEquals(embeddingSignal, databaseSignal);
    assertEquals(databaseSignal?.aborted, true);
    assertEquals(redis.calls.includes('circuit_success'), false);
    assertEquals(
      await raceWithTimeout(
        redis.closed.promise.then(() => true),
        500,
        false,
      ),
      true,
    );
  },
);

Deno.test(
  'Portal Hybrid DB success cannot become 200 after circuit reset crosses deadline',
  async () => {
    const redis = new FakePortalRedis();
    redis.circuitSuccessOperation = () => neverPromise();
    let databaseCalls = 0;
    const handler = createPortalHybridSearchHandler(
      handlerOptions(
        redis,
        {
          query() {
            databaseCalls += 1;
            return Promise.resolve(databasePage());
          },
        },
        { timeoutMs: 100, redis: undefined, redisFactory: async () => redis },
      ),
    );
    const response = await handler(await signedRequest());
    assertEquals(response.status, 503);
    assertEquals(await responseCode(response), 'hybrid_timeout');
    assertEquals(databaseCalls, 1);
    assert(redis.calls.includes('circuit_success'));
    assertEquals(
      await raceWithTimeout(
        redis.closed.promise.then(() => true),
        500,
        false,
      ),
      true,
    );
  },
);

Deno.test(
  'Portal Hybrid never waits for lease release and relies on lease TTL recovery',
  async () => {
    const redis = new FakePortalRedis();
    redis.leaseReleaseOperation = () => neverPromise();
    const handler = createPortalHybridSearchHandler(
      handlerOptions(
        redis,
        { query: () => Promise.resolve(databasePage()) },
        {
          timeoutMs: 100,
          redis: undefined,
          redisFactory: async () => redis,
        },
      ),
    );
    const result = await raceWithTimeout(
      handler(await signedRequest()).then((response) => response.status),
      50,
      599,
    );
    assertEquals(result, 200);
    assert(redis.calls.includes('lease_release'));
    await new Promise((resolve) => setTimeout(resolve, 125));
    assert(redis.calls.includes('close'));
  },
);

Deno.test(
  'Portal Hybrid context and private-field drift never leaks or falls back to raw Hybrid RPC',
  async () => {
    const privateField = structuredClone(databasePage()) as unknown as Record<string, unknown>;
    (privateField.items as Array<Record<string, unknown>>)[0].owner_id = 'private-owner';
    const missingContext = structuredClone(databasePage()) as unknown as Record<string, unknown>;
    delete (missingContext.items as Array<Record<string, unknown>>)[0].context;
    const privateContext = structuredClone(databasePage()) as unknown as Record<string, unknown>;
    const context = (privateContext.items as Array<Record<string, unknown>>)[0].context as Record<
      string,
      unknown
    >;
    (context.source as Record<string, unknown>).storagePath = 'private/bucket/object';

    for (const invalid of [privateField, missingContext, privateContext]) {
      const redis = new FakePortalRedis();
      const handler = createPortalHybridSearchHandler(
        handlerOptions(redis, {
          query: () => Promise.resolve(invalid as unknown as PortalPublicHybridCandidatePage),
        }),
      );
      const response = await handler(await signedRequest());
      const body = await response.text();
      assertEquals(response.status, 503);
      assertStringIncludes(body, 'contract_failure');
      assertEquals(body.includes('private-owner'), false);
      assertEquals(body.includes('private/bucket/object'), false);
      assert(redis.calls.includes('circuit_failure'));
    }
  },
);

Deno.test(
  'Portal Hybrid bounds a never-resolving logger through EdgeRuntime waitUntil',
  async () => {
    const redis = new FakePortalRedis();
    let loggerCalls = 0;
    let backgroundDelivery: Promise<unknown> | undefined;
    Object.defineProperty(globalThis, 'EdgeRuntime', {
      configurable: true,
      value: {
        waitUntil(promise: Promise<unknown>) {
          backgroundDelivery = promise;
        },
      },
    });
    try {
      const handler = createPortalHybridSearchHandler(
        handlerOptions(
          redis,
          { query: () => Promise.resolve(databasePage()) },
          {
            logger: () => {
              loggerCalls += 1;
              return new Promise<void>(() => undefined);
            },
            scheduleSecurityEvent: schedulePortalHybridSecurityEvent,
          },
        ),
      );
      const response = await handler(await signedRequest());
      assertEquals(response.status, 200);
      assertEquals(loggerCalls, 0);
      assert(backgroundDelivery);
      const completed = await raceWithTimeout(
        backgroundDelivery.then(() => true),
        250,
        false,
      );
      assertEquals(completed, true);
      assertEquals(loggerCalls, 1);
    } finally {
      Reflect.deleteProperty(globalThis, 'EdgeRuntime');
    }
  },
);

Deno.test(
  'Portal Hybrid sync-busy logger runs after handler resolution and cannot return a late 200',
  async () => {
    const redis = new FakePortalRedis();
    let loggerCalls = 0;
    const handler = createPortalHybridSearchHandler(
      handlerOptions(
        redis,
        { query: () => Promise.resolve(databasePage()) },
        {
          timeoutMs: 250,
          logger: () => {
            loggerCalls += 1;
            const loggerStartedAt = performance.now();
            while (performance.now() - loggerStartedAt < 400) {
              // Simulate a synchronous observability sink that blocks its own background task.
            }
          },
          scheduleSecurityEvent: schedulePortalHybridSecurityEvent,
        },
      ),
    );
    const request = await signedRequest();
    const startedAt = performance.now();
    const response = await handler(request);
    const handlerLatencyMs = performance.now() - startedAt;

    assertEquals(response.status, 200);
    assert(handlerLatencyMs < 250);
    assertEquals(loggerCalls, 0);
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    assertEquals(loggerCalls, 0);
    await new Promise((resolve) => setTimeout(resolve, 450));
    assertEquals(loggerCalls, 1);
  },
);

Deno.test('Portal Hybrid absorbs detached logger throws and rejections', async () => {
  let loggerCalls = 0;
  const loggers = [
    () => {
      loggerCalls += 1;
      throw new Error('private synchronous logger details');
    },
    () => {
      loggerCalls += 1;
      return Promise.reject(new Error('private asynchronous logger details'));
    },
  ];

  for (const logger of loggers) {
    const handler = createPortalHybridSearchHandler(
      handlerOptions(
        new FakePortalRedis(),
        { query: () => Promise.resolve(databasePage()) },
        { logger },
      ),
    );
    const response = await handler(await signedRequest());
    assertEquals(response.status, 200);
  }
  await flushPortalHybridSecurityEvent();
  assertEquals(loggerCalls, 2);
});
