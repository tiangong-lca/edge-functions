import { assert, assertEquals, assertRejects } from 'jsr:@std/assert';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { createMethodRepository } from '../supabase/functions/_shared/study/method_repository.ts';
import { parseRequest } from '../contracts/lca-study/v6/codec.ts';
import { sha256 } from '../contracts/lca-study/v3/canonical.ts';
import contexts from './fixtures/lca-study-v6/database-report-contexts.json' with { type: 'json' };
import signatures from './fixtures/lca-study-v6/database-rpc-signatures.json' with { type: 'json' };
Deno.test(
  'V6 real Supabase SDK uses fixed actor/service API RPCs and immutable bounded Storage without authority fallback',
  async () => {
    const calls: Array<{
        name: string;
        bearer: string | null;
        profile: string | null;
        body: unknown;
      }> = [],
      storageCalls: Array<{ method: string; bearer: string | null; upsert: string | null }> = [];
    let stored = new Uint8Array();
    const transport: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (request.url.includes('/storage/v1/object/')) {
        storageCalls.push({
          method: request.method,
          bearer: request.headers.get('authorization'),
          upsert: request.headers.get('x-upsert'),
        });
        if (request.method === 'POST') {
          stored = new Uint8Array(await request.arrayBuffer());
          return Response.json({ Key: 'fixture' });
        }
        return new Response(stored);
      }
      calls.push({
        name: new URL(request.url).pathname.split('/').at(-1)!,
        bearer: request.headers.get('authorization'),
        profile: request.headers.get('content-profile'),
        body: await request.json(),
      });
      return Response.json({ ok: true, data: {} });
    };
    const client = (key: string, bearer?: string) =>
      createClient('https://method-sdk.invalid', key, {
        db: { schema: 'api' },
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
          fetch: transport,
          ...(bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {}),
        },
      }) as unknown as SupabaseClient;
    const repo = createMethodRepository(client('synthetic-publishable', 'exact-actor-bearer'), () =>
      client('synthetic-service'),
    );
    const signal = new AbortController().signal;
    await repo.dispatch(
      parseRequest({
        schemaVersion: 'lca.study-api.v6',
        requestId: 'a',
        operation: 'capability.read',
      }),
      signal,
      'authoring',
    );
    await repo.dispatch(parseRequest(contexts.methodRequest), signal, 'authoring');
    await repo.dispatch(parseRequest(contexts.previewContext.data.request), signal, 'review');
    await repo.dispatch(
      parseRequest({
        schemaVersion: 'lca.study-api.v6',
        requestId: 'comment',
        idempotencyKey: 'comment-original',
        operation: 'comment.append',
        reportRevisionId: '10000000-0000-4000-8000-000000000300',
        expectedContentHash: 'a'.repeat(64),
        text: 'Declared synthetic comment',
      }),
      signal,
      'review',
    );
    for (const kind of ['evidence', 'report', 'review'] as const) {
      await repo.resolveIntent(kind, 'original-intent', signal);
      await repo.consumeIntent(kind, 'original-intent', { unchanged: 'completion' }, signal);
      await repo.reconcileIntent(
        kind,
        'original-intent',
        'original-artifact',
        'b'.repeat(64),
        signal,
      );
    }
    await repo.resolveArtifact('read-intent', signal);
    assertEquals(
      calls.slice(0, 4).map((c) => c.name),
      [
        'qry_study_method_v1',
        'cmd_study_method_v1',
        'qry_study_method_review_v1',
        'cmd_study_method_review_v1',
      ],
    );
    for (const call of calls) {
      assertEquals(call.profile, 'api');
      assertEquals(
        call.bearer,
        call.name.startsWith('svc_') ? 'Bearer synthetic-service' : 'Bearer exact-actor-bearer',
      );
      if (call.name !== 'svc_study_artifact_read_resolve_v1')
        assert(signatures.some((s) => s.name === call.name));
    }
    for (const call of calls.slice(4, 13)) {
      assertEquals((call.body as Record<string, unknown>).p_intent_id, 'original-intent');
      if (call.name.includes('_consume_'))
        assertEquals(call.body, {
          p_intent_id: 'original-intent',
          p_completion: { unchanged: 'completion' },
        });
      if (call.name.includes('_reconcile_'))
        assertEquals(call.body, {
          p_intent_id: 'original-intent',
          p_artifact_id: 'original-artifact',
          p_content_hash: 'b'.repeat(64),
        });
    }
    const bytes = new TextEncoder().encode('{}'),
      artifact = {
        studyId: '10000000-0000-4000-8000-000000000001',
        artifactRef: {
          type: 'methodEvidence' as const,
          id: '10000000-0000-4000-8000-000000000700',
          contentHash: await sha256(bytes),
          digestScope: 'artifact_bytes_sha256' as const,
          byteSize: bytes.length,
          mediaType: 'application/json' as const,
          schemaVersion: 'lca.study-method-evidence.v1' as const,
        },
        storageBucket: 'study-artifacts',
        storageObjectPath:
          'study/10000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000700/evidence.json',
      };
    await repo.upload(artifact, bytes, signal);
    assertEquals(stored, bytes);
    assertEquals(
      storageCalls.map((c) => c.method),
      ['POST', 'GET'],
    );
    assertEquals(storageCalls[0].upsert, 'false');
    for (const call of storageCalls) assertEquals(call.bearer, 'Bearer synthetic-service');
    await assertRejects(() => repo.upload(artifact, new TextEncoder().encode('changed'), signal));
    assertEquals(storageCalls.length, 2);
    const controller = new AbortController();
    controller.abort();
    await assertRejects(() =>
      repo.dispatch(parseRequest(contexts.methodRequest), controller.signal, 'authoring'),
    );
    assertEquals(calls.length, 14);
  },
);
