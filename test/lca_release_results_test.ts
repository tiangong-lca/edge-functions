import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js@2';

import {
  createLcaReleaseResultsHandler,
  lcaReleaseResultsRequestSchema,
} from '../supabase/functions/lca_release_results/index.ts';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const RELEASE_RUN_ID = '22222222-2222-4222-8222-222222222222';
const ARTIFACT_ID = '33333333-3333-4333-8333-333333333333';
const PROCESS_ID = '44444444-4444-4444-8444-444444444444';
const PUBLISHABLE_KEY = 'sb_publishable_local_test';
const LEGACY_ANON_KEY = 'legacy-anon-jwt-fixture';

function repository(label: string, privateFailure = false) {
  return {
    getCurrent: () =>
      Promise.resolve({
        ok: true as const,
        data: { label, status: 'current' },
      }),
    getRun: (releaseRunId: string) =>
      privateFailure
        ? Promise.resolve({
            ok: false as const,
            code: 'not_data_product_manager',
            status: 403,
            message: 'Data product manager role is required for private release runs',
          })
        : Promise.resolve({ ok: true as const, data: { label, releaseRunId } }),
    getCurrentProcess: (processId: string, processVersion: string) =>
      Promise.resolve({
        ok: true as const,
        data: { label, processId, processVersion, datasets: [] },
      }),
    createArtifactDownload: (artifactId: string) =>
      Promise.resolve({
        ok: true as const,
        data: {
          label,
          artifactId,
          signedDownloadUrl: 'https://download.example/artifact.zip',
        },
      }),
  };
}

Deno.test('LCA release results schema defaults an empty GET query to current', () => {
  const parsed = lcaReleaseResultsRequestSchema.safeParse({});
  assertEquals(parsed.success, true);
  if (parsed.success) assertEquals(parsed.data, { mode: 'current' });
});

Deno.test('anonymous current release lookup uses the public repository', async () => {
  const handler = createLcaReleaseResultsHandler({
    publicRepository: repository('public'),
  });
  const response = await handler(
    new Request('http://localhost/functions/v1/lca_release_results', {
      method: 'GET',
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    ok: true,
    mode: 'current',
    data: { label: 'public', status: 'current' },
  });
});

Deno.test('publishable-key current lookup uses the public repository', async () => {
  const handler = createLcaReleaseResultsHandler({
    publicRepository: repository('public'),
    publishableApiKey: PUBLISHABLE_KEY,
    resolveActor: () => Promise.reject(new Error('publishable key must not resolve a user actor')),
  });
  const response = await handler(
    new Request('http://localhost/functions/v1/lca_release_results', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PUBLISHABLE_KEY}`,
        apikey: PUBLISHABLE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mode: 'current' }),
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    ok: true,
    mode: 'current',
    data: { label: 'public', status: 'current' },
  });
});

Deno.test('configured legacy anon key current lookup uses the public repository', async () => {
  const handler = createLcaReleaseResultsHandler({
    publicRepository: repository('public'),
    publishableApiKey: LEGACY_ANON_KEY,
    resolveActor: () => Promise.reject(new Error('legacy anon key must not resolve a user actor')),
  });
  const response = await handler(
    new Request('http://localhost/functions/v1/lca_release_results', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${LEGACY_ANON_KEY}`,
        apikey: LEGACY_ANON_KEY,
      },
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    ok: true,
    mode: 'current',
    data: { label: 'public', status: 'current' },
  });
});

Deno.test('anonymous process lookup returns the current release identity projection', async () => {
  const handler = createLcaReleaseResultsHandler({
    publicRepository: repository('public'),
  });
  const response = await handler(
    new Request(
      `http://localhost/functions/v1/lca_release_results?mode=process&processId=${PROCESS_ID}&processVersion=01.00.000`,
      { method: 'GET' },
    ),
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    ok: true,
    mode: 'process',
    data: {
      label: 'public',
      processId: PROCESS_ID,
      processVersion: '01.00.000',
      datasets: [],
    },
  });
});

Deno.test('process lookup rejects a non-canonical process version', async () => {
  const handler = createLcaReleaseResultsHandler({
    publicRepository: repository('public'),
  });
  const response = await handler(
    new Request(
      `http://localhost/functions/v1/lca_release_results?mode=process&processId=${PROCESS_ID}&processVersion=1.0`,
      { method: 'GET' },
    ),
  );
  assertEquals(response.status, 400);
  assertEquals((await response.json()).code, 'INVALID_PAYLOAD');
});

Deno.test('anonymous private release lookup preserves DB authorization failure', async () => {
  const handler = createLcaReleaseResultsHandler({
    publicRepository: repository('public', true),
  });
  const response = await handler(
    new Request(
      `http://localhost/functions/v1/lca_release_results?mode=release&releaseRunId=${RELEASE_RUN_ID}`,
      { method: 'GET' },
    ),
  );
  assertEquals(response.status, 403);
  assertEquals(await response.json(), {
    ok: false,
    code: 'not_data_product_manager',
    message: 'Data product manager role is required for private release runs',
  });
});

Deno.test('authenticated release lookup uses the actor-bound repository', async () => {
  const handler = createLcaReleaseResultsHandler({
    publicRepository: repository('public'),
    repositoryForActor: () => repository('actor'),
    resolveActor: async () => ({
      ok: true as const,
      value: {
        userId: USER_ID,
        accessToken: 'access-token',
        supabase: {} as SupabaseClient,
      },
    }),
  });
  const response = await handler(
    new Request('http://localhost/functions/v1/lca_release_results', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mode: 'release', releaseRunId: RELEASE_RUN_ID }),
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    ok: true,
    mode: 'release',
    data: { label: 'actor', releaseRunId: RELEASE_RUN_ID },
  });
});

Deno.test(
  'an invalid supplied Authorization header fails instead of falling back to public',
  async () => {
    const handler = createLcaReleaseResultsHandler({
      publicRepository: repository('public'),
      resolveActor: async () => ({
        ok: false as const,
        response: new Response(
          JSON.stringify({
            ok: false,
            code: 'AUTH_REQUIRED',
            message: 'Authentication required',
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      }),
    });
    const response = await handler(
      new Request('http://localhost/functions/v1/lca_release_results', {
        method: 'GET',
        headers: { Authorization: 'Malformed credential' },
      }),
    );
    assertEquals(response.status, 401);
    assertEquals(await response.json(), {
      ok: false,
      code: 'AUTH_REQUIRED',
      message: 'Authentication required',
    });
  },
);

Deno.test(
  'public artifact downloads are signed only after the DB projection succeeds',
  async () => {
    const handler = createLcaReleaseResultsHandler({
      publicRepository: repository('public'),
    });
    const response = await handler(
      new Request(
        `http://localhost/functions/v1/lca_release_results?mode=artifact_download&artifactId=${ARTIFACT_ID}`,
        { method: 'GET' },
      ),
    );
    assertEquals(response.status, 200);
    assertEquals(await response.json(), {
      ok: true,
      mode: 'artifact_download',
      data: {
        label: 'public',
        artifactId: ARTIFACT_ID,
        signedDownloadUrl: 'https://download.example/artifact.zip',
      },
    });
  },
);
