import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js@2';

import type { ActorContext } from '../supabase/functions/_shared/command_runtime/actor_context.ts';
import {
  executeNationalCarbonGraphCacheObjectsCommand,
  parseNationalCarbonGraphCacheObjectsCommand,
} from '../supabase/functions/_shared/commands/national_carbon_graph_cache_objects.ts';

const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';

type StoredObject = {
  body?: unknown;
  error?: { message: string; code?: string };
};

class FakeBlob {
  constructor(private readonly body: unknown) {}

  text() {
    return Promise.resolve(typeof this.body === 'string' ? this.body : JSON.stringify(this.body));
  }
}

class FakeGraphCacheStorageBucket {
  downloads: string[] = [];
  signedUrls: Array<{ objectPath: string; expiresIn: number }> = [];
  signedErrors = new Map<string, { message: string; code?: string }>();

  constructor(private readonly objects: Map<string, StoredObject>) {}

  async download(objectPath: string) {
    this.downloads.push(objectPath);
    const object = this.objects.get(objectPath);
    if (!object || object.error) {
      return {
        data: null,
        error: object?.error ?? { message: 'Object not found', code: '404' },
      };
    }

    return {
      data: new FakeBlob(object.body),
      error: null,
    };
  }

  async createSignedUrl(objectPath: string, expiresIn: number) {
    this.signedUrls.push({ objectPath, expiresIn });
    const error = this.signedErrors.get(objectPath);
    if (error) {
      return { data: null, error };
    }

    return {
      data: {
        signedUrl: `https://signed.example/${encodeURIComponent(objectPath)}?expires=${expiresIn}`,
      },
      error: null,
    };
  }
}

class FakeGraphCacheSupabase {
  buckets: string[] = [];

  constructor(readonly bucket: FakeGraphCacheStorageBucket) {}

  storage = {
    from: (bucket: string) => {
      this.buckets.push(bucket);
      return this.bucket;
    },
  };
}

function actor(): ActorContext {
  return {
    userId: TEST_USER_ID,
    accessToken: 'access-token',
    supabase: {} as SupabaseClient,
  };
}

function makeObjects(overrides: Record<string, StoredObject> = {}): Map<string, StoredObject> {
  const activeManifestPath = 'national-carbon/process-flow-graph/v1/manifest.json';
  const buildManifestPath =
    'national-carbon/process-flow-graph/v1/builds/process-flow-graph-test/manifest.json';

  return new Map<string, StoredObject>([
    [
      activeManifestPath,
      {
        body: {
          schemaVersion: 'process_flow_graph_manifest_v1',
          activeBuildId: 'process-flow-graph-test',
          buildManifestPath: 'builds/process-flow-graph-test/manifest.json',
          generatedAt: '2026-06-12T00:00:00Z',
        },
      },
    ],
    [
      buildManifestPath,
      {
        body: {
          schemaVersion: 'process_flow_graph_v2',
          buildId: 'process-flow-graph-test',
          files: {
            nodes: {
              path: 'graph/nodes.json.gz',
              byteSize: 12,
              sha256: 'abc',
              contentType: 'application/gzip',
            },
            geoMapWorldView: {
              path: 'geo-map/world/view.json.gz',
              byteSize: 34,
              sha256: 'def',
              contentType: 'application/gzip',
            },
          },
        },
      },
    ],
    ...Object.entries(overrides),
  ]);
}

function env(values: Record<string, string | undefined>) {
  return (name: string) => values[name];
}

Deno.test('parseNationalCarbonGraphCacheObjectsCommand accepts read manifest bundle action', () => {
  const result = parseNationalCarbonGraphCacheObjectsCommand({
    action: 'read_manifest_bundle',
  });

  assertEquals(result.ok, true);
});

Deno.test('parseNationalCarbonGraphCacheObjectsCommand rejects unknown actions', () => {
  const result = parseNationalCarbonGraphCacheObjectsCommand({
    action: 'read_anything',
  });

  assertEquals(result.ok, false);
});

Deno.test(
  'executeNationalCarbonGraphCacheObjectsCommand returns manifest bundle with signed URLs',
  async () => {
    const bucket = new FakeGraphCacheStorageBucket(makeObjects());
    const supabase = new FakeGraphCacheSupabase(bucket);

    const result = await executeNationalCarbonGraphCacheObjectsCommand(
      { action: 'read_manifest_bundle' },
      actor(),
      supabase as unknown as SupabaseClient,
      env({
        NATIONAL_CARBON_GRAPH_CACHE_BUCKET: 'lca_results',
        NATIONAL_CARBON_GRAPH_CACHE_PREFIX: 'national-carbon/process-flow-graph/v1',
        NATIONAL_CARBON_GRAPH_CACHE_SIGNED_URL_EXPIRES_IN: '120',
      }),
    );

    assertEquals(result.ok, true);
    if (result.ok) {
      const body = result.body as {
        data: {
          bucket: string;
          prefix: string;
          expiresIn: number;
          activeManifest: { activeBuildId: string };
          buildManifest: { files: Record<string, { signedUrl?: string }> };
        };
      };
      assertEquals(body.data.bucket, 'lca_results');
      assertEquals(body.data.prefix, 'national-carbon/process-flow-graph/v1');
      assertEquals(body.data.expiresIn, 120);
      assertEquals(body.data.activeManifest.activeBuildId, 'process-flow-graph-test');
      assertEquals(
        body.data.buildManifest.files.nodes.signedUrl,
        'https://signed.example/national-carbon%2Fprocess-flow-graph%2Fv1%2Fbuilds%2Fprocess-flow-graph-test%2Fgraph%2Fnodes.json.gz?expires=120',
      );
    }

    assertEquals(supabase.buckets, ['lca_results']);
    assertEquals(bucket.downloads, [
      'national-carbon/process-flow-graph/v1/manifest.json',
      'national-carbon/process-flow-graph/v1/builds/process-flow-graph-test/manifest.json',
    ]);
    assertEquals(bucket.signedUrls, [
      {
        objectPath:
          'national-carbon/process-flow-graph/v1/builds/process-flow-graph-test/graph/nodes.json.gz',
        expiresIn: 120,
      },
      {
        objectPath:
          'national-carbon/process-flow-graph/v1/builds/process-flow-graph-test/geo-map/world/view.json.gz',
        expiresIn: 120,
      },
    ]);
  },
);

Deno.test(
  'executeNationalCarbonGraphCacheObjectsCommand rejects unsafe build manifest paths',
  async () => {
    const bucket = new FakeGraphCacheStorageBucket(
      makeObjects({
        'national-carbon/process-flow-graph/v1/manifest.json': {
          body: {
            schemaVersion: 'process_flow_graph_manifest_v1',
            activeBuildId: 'process-flow-graph-test',
            buildManifestPath: '../private/manifest.json',
          },
        },
      }),
    );
    const supabase = new FakeGraphCacheSupabase(bucket);

    const result = await executeNationalCarbonGraphCacheObjectsCommand(
      { action: 'read_manifest_bundle' },
      actor(),
      supabase as unknown as SupabaseClient,
      env({}),
    );

    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.code, 'NATIONAL_CARBON_GRAPH_CACHE_ACTIVE_MANIFEST_INVALID');
    }
  },
);

Deno.test(
  'executeNationalCarbonGraphCacheObjectsCommand reports missing active manifest',
  async () => {
    const bucket = new FakeGraphCacheStorageBucket(new Map());
    const supabase = new FakeGraphCacheSupabase(bucket);

    const result = await executeNationalCarbonGraphCacheObjectsCommand(
      { action: 'read_manifest_bundle' },
      actor(),
      supabase as unknown as SupabaseClient,
      env({}),
    );

    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.status, 404);
      assertEquals(result.code, 'NATIONAL_CARBON_GRAPH_CACHE_OBJECT_NOT_FOUND');
    }
  },
);

Deno.test('executeNationalCarbonGraphCacheObjectsCommand reports signed URL failures', async () => {
  const bucket = new FakeGraphCacheStorageBucket(makeObjects());
  bucket.signedErrors.set(
    'national-carbon/process-flow-graph/v1/builds/process-flow-graph-test/graph/nodes.json.gz',
    { message: 'sign failed', code: 'SIGN_FAILED' },
  );
  const supabase = new FakeGraphCacheSupabase(bucket);

  const result = await executeNationalCarbonGraphCacheObjectsCommand(
    { action: 'read_manifest_bundle' },
    actor(),
    supabase as unknown as SupabaseClient,
    env({}),
  );

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.code, 'NATIONAL_CARBON_GRAPH_CACHE_SIGNED_URL_FAILED');
    assertEquals(result.status, 502);
  }
});
