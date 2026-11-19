import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js@2';
import {
  executeDatasetDisplay,
  parseDatasetDisplayRequest,
} from '../supabase/functions/_shared/commands/dataset_display.ts';
import { createAppDatasetDisplaySetBatchHandler } from '../supabase/functions/app_dataset_display_set_batch/index.ts';
const ID = 'ABCDEF12-2222-4222-8222-222222222222';
const item = { datasetKind: 'process', id: ID.toLowerCase(), version: '01.00.000' };
const counts = {
  inputCount: 1,
  requestedCount: 1,
  changedCount: 1,
  unchangedCount: 0,
  isVisible: true,
};
const actor = (rpc: SupabaseClient['rpc']) => ({
  userId: ID,
  accessToken: 'actor-token',
  supabase: { rpc } as unknown as SupabaseClient,
});
Deno.test(
  'display parser accepts all seven types, exact versions, both actions and normalized UUIDs',
  () => {
    for (const datasetKind of [
      'lifecyclemodel',
      'process',
      'flow',
      'flowproperty',
      'unitgroup',
      'source',
      'contact',
    ]) {
      for (const isVisible of [true, false]) {
        assertEquals(
          parseDatasetDisplayRequest({
            items: [{ ...item, datasetKind, id: ` ${ID} ` }],
            isVisible,
          }),
          {
            ok: true,
            value: { items: [{ ...item, datasetKind }], isVisible },
          },
        );
      }
    }
    assertEquals(
      parseDatasetDisplayRequest({
        items: Array.from({ length: 100 }, () => item),
        isVisible: true,
      }).ok,
      true,
    );
  },
);
Deno.test(
  'display parser rejects unsupported types, state/actor overrides and malformed batches',
  () => {
    for (const body of [
      null,
      [],
      {},
      { items: [item] },
      { items: [item], isVisible: 0 },
      { items: [], isVisible: true },
      { items: Array.from({ length: 101 }, () => item), isVisible: true },
      { items: [null], isVisible: true },
      ...['lciamethod', 'ilcd', 'PROCESS', ''].map((datasetKind) => ({
        items: [{ ...item, datasetKind }],
        isVisible: true,
      })),
      { items: [{ ...item, id: 'bad' }], isVisible: true },
      { items: [{ ...item, version: '1.0' }], isVisible: true },
      { items: [{ ...item, state_code: 100 }], isVisible: true },
      { items: [item], isVisible: true, actorId: ID },
    ]) {
      assertEquals(parseDatasetDisplayRequest(body).ok, false);
    }
  },
);
Deno.test(
  'display command forwards the verified actor client to one atomic RPC for set and cancel',
  async () => {
    for (const isVisible of [true, false]) {
      const calls: unknown[] = [];
      const result = await executeDatasetDisplay(
        { items: [item], isVisible },
        actor(((name: string, args: unknown) => {
          calls.push({ name, args });
          return Promise.resolve({
            data: { ok: true, data: { ...counts, isVisible } },
            error: null,
          });
        }) as unknown as SupabaseClient['rpc']),
      );
      assertEquals(calls, [
        {
          name: 'cmd_dataset_display_set_batch',
          args: { p_items: [item], p_is_visible: isVisible },
        },
      ]);
      assertEquals(result, {
        ok: true,
        status: 200,
        body: { ok: true, command: 'dataset_display_set_batch', data: { ...counts, isVisible } },
      });
    }
  },
);
Deno.test(
  'display command preserves authentication, role, validation and infrastructure failures',
  async () => {
    for (const [code, status] of [
      ['28000', 401],
      ['42501', 403],
      ['22023', 400],
      ['XX000', 500],
    ] as const) {
      const result = await executeDatasetDisplay(
        { items: [item], isVisible: true },
        actor((() =>
          Promise.resolve({
            data: null,
            error: { code, message: 'rejected' },
          })) as unknown as SupabaseClient['rpc']),
      );
      assertEquals(result, { ok: false, code, status, message: 'rejected', details: null });
    }
  },
);
Deno.test('display command rejects malformed successful RPC responses', async () => {
  for (const data of [
    null,
    {},
    { ok: true, data: null },
    { ok: true, data: {} },
    { ok: true, data: { ...counts, isVisible: false } },
    { ok: true, data: { ...counts, changedCount: 2 } },
    { ok: true, data: { ...counts, inputCount: -1 } },
  ]) {
    const result = await executeDatasetDisplay(
      { items: [item], isVisible: true },
      actor((() => Promise.resolve({ data, error: null })) as unknown as SupabaseClient['rpc']),
    );
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.status, 502);
  }
});
Deno.test(
  'display handler authenticates before parsing or writing and preserves method/CORS handling',
  async () => {
    let reads = 0;
    const handler = createAppDatasetDisplaySetBatchHandler({
      resolveActor: () =>
        Promise.resolve({ ok: false, response: new Response('unauthorized', { status: 401 }) }),
      readBody: () => {
        reads++;
        return Promise.resolve({ ok: true, value: { items: [item], isVisible: true } });
      },
    });
    assertEquals((await handler(new Request('http://local', { method: 'POST' }))).status, 401);
    assertEquals(reads, 0);
    assertEquals((await handler(new Request('http://local', { method: 'GET' }))).status, 405);
    assertEquals((await handler(new Request('http://local', { method: 'OPTIONS' }))).status, 200);
  },
);
