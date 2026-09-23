import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.112.4';

import {
  executeOpenDataProcessPublish,
  parseOpenDataProcessPublishRequest,
} from '../supabase/functions/_shared/commands/open_data/process_publish.ts';

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const PROCESS_ID = '22222222-2222-4222-8222-222222222222';

class FakeSupabase {
  calls: Array<{ name: string; args: unknown }> = [];

  rpc(name: string, args: unknown) {
    this.calls.push({ name, args: structuredClone(args) });
    return Promise.resolve({
      data: {
        ok: true,
        data: { requestedCount: 1, publishedCount: 1, alreadyPublishedCount: 0 },
      },
      error: null,
    });
  }
}

Deno.test('Open Data publish parser accepts 1-100 exact Process identities', () => {
  assertEquals(
    parseOpenDataProcessPublishRequest({
      items: [{ id: PROCESS_ID.toUpperCase(), version: '01.00.000' }],
    }),
    {
      ok: true,
      value: { items: [{ id: PROCESS_ID, version: '01.00.000' }] },
    },
  );
  assertEquals(parseOpenDataProcessPublishRequest({ items: [] }).ok, false);
  assertEquals(
    parseOpenDataProcessPublishRequest({
      items: Array.from({ length: 101 }, () => ({ id: PROCESS_ID, version: '01.00.000' })),
    }).ok,
    false,
  );
  assertEquals(
    parseOpenDataProcessPublishRequest({ items: [{ id: PROCESS_ID, version: '1.0' }] }).ok,
    false,
  );
});

Deno.test('Open Data publish command calls only the dedicated batch RPC', async () => {
  const supabase = new FakeSupabase();
  const result = await executeOpenDataProcessPublish(
    { items: [{ id: PROCESS_ID, version: '01.00.000' }] },
    {
      userId: ACTOR_ID,
      accessToken: 'actor-token',
      supabase: supabase as unknown as SupabaseClient,
    },
  );

  assertEquals(result, {
    ok: true,
    status: 200,
    body: {
      ok: true,
      command: 'open_data_process_publish_batch',
      data: { requestedCount: 1, publishedCount: 1, alreadyPublishedCount: 0 },
    },
  });
  assertEquals(supabase.calls, [
    {
      name: 'cmd_open_data_process_publish_batch',
      args: { p_items: [{ id: PROCESS_ID, version: '01.00.000' }] },
    },
  ]);
});
