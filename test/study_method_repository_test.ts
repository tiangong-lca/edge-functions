import { assert, assertEquals, assertRejects } from 'jsr:@std/assert';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { createMethodRepository } from '../supabase/functions/_shared/study/method_repository.ts';
import { parseRequest } from '../contracts/lca-study/v6/codec.ts';
import { sha256 } from '../contracts/lca-study/v3/canonical.ts';
import contexts from './fixtures/lca-study-v6/database-report-contexts.json' with { type: 'json' };
import signatures from './fixtures/lca-study-v6/database-rpc-signatures.json' with { type: 'json' };
import { createStudyHandler } from '../supabase/functions/_shared/study/handler.ts';
import { capabilitiesSchema } from '../contracts/lca-study/v6/authoring.ts';
import type { ActorContext } from '../supabase/functions/_shared/command_runtime/actor_context.ts';
import publicDtos from './fixtures/lca-study-v6/database-public-dtos.json' with { type: 'json' };

Deno.test(
  'V6 evidence handler sends the exact Database golden three-key completion through real SDK transport',
  async () => {
    const context = contexts.evidenceContext.data;
    let stored = new Uint8Array(),
      completion: unknown;
    const calls: Array<{ name: string; bearer: string | null }> = [];
    const transport: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url.includes('/storage/v1/object/')) {
        assertEquals(request.headers.get('authorization'), 'Bearer synthetic-evidence-service');
        if (request.method === 'POST') {
          stored = new Uint8Array(await request.arrayBuffer());
          return Response.json({ Key: 'fixture' });
        }
        return new Response(stored);
      }
      const name = new URL(request.url).pathname.split('/').at(-1)!;
      calls.push({ name, bearer: request.headers.get('authorization') });
      const body = await request.json();
      if (name === 'cmd_study_method_v1') {
        assertEquals(body, { p_request: context.request });
        // Preserve this captured service context's exact identities; the
        // separate public-DTO capture is a different synthetic invocation.
        return Response.json({
          ok: true,
          data: {
            kind: 'methodEvidenceCommandIntent',
            intentId: context.intentId,
            expiresAt: context.expiresAt,
            operation: 'method.evidence.create',
          },
        });
      }
      if (name === 'svc_study_method_evidence_intent_resolve_v1') {
        assertEquals(body, { p_intent_id: context.intentId });
        return Response.json({ ok: true, data: context });
      }
      assertEquals(name, 'svc_study_method_evidence_intent_consume_v1');
      completion = body.p_completion;
      // Exact dc8 SQL study_keys predicate, independently grounded in its actual
      // captured completion. This is a transport/shape test, not live SQL proof.
      const valid =
        JSON.stringify(Object.keys(body.p_completion).sort()) ===
          JSON.stringify(Object.keys(contexts.evidenceCompletion).sort()) &&
        JSON.stringify(Object.keys(body.p_completion.artifact).sort()) ===
          JSON.stringify(Object.keys(contexts.evidenceCompletion.artifact).sort());
      return Response.json(
        valid
          ? { ok: true, data: contexts.evidenceRecord.data }
          : { ok: false, code: 'REFERENCE_MISMATCH' },
      );
    };
    const client = (key: string, bearer?: string) =>
      createClient('https://method-evidence-sdk.invalid', key, {
        db: { schema: 'api' },
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
          fetch: transport,
          ...(bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {}),
        },
      }) as unknown as SupabaseClient;
    const actorClient = client('synthetic-publishable', 'exact-evidence-actor');
    const repository = createMethodRepository(actorClient, () =>
      client('synthetic-evidence-service'),
    );
    const actor = {
      userId: context.actorId,
      clientId: context.clientId,
      supabase: actorClient,
    } as unknown as ActorContext;
    const handler = createStudyHandler({
      resolveActor: () => Promise.resolve({ ok: true, value: actor }),
      method: {
        config: () => capabilitiesSchema.parse(publicDtos.responses.authoringCapability),
        repository: () => repository,
      },
    });
    const response = await handler(
      new Request('http://127.0.0.1/method-evidence', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-study-schema': 'lca.study-api.v6' },
        body: JSON.stringify(context.request),
      }),
    );
    assertEquals(completion, contexts.evidenceCompletion);
    assertEquals(response.status, 200);
    assertEquals((await response.json()).data, contexts.evidenceRecord.data);
    assertEquals(await sha256(stored), context.contentHash);
    assertEquals(
      calls.map((c) => c.name),
      [
        'cmd_study_method_v1',
        'svc_study_method_evidence_intent_resolve_v1',
        'svc_study_method_evidence_intent_resolve_v1',
        'svc_study_method_evidence_intent_consume_v1',
      ],
    );
    assertEquals(
      calls.map((c) => c.bearer),
      [
        'Bearer exact-evidence-actor',
        'Bearer synthetic-evidence-service',
        'Bearer synthetic-evidence-service',
        'Bearer synthetic-evidence-service',
      ],
    );
  },
);
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
