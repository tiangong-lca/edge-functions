import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js@2';

import type { ActorContext } from '../supabase/functions/_shared/command_runtime/actor_context.ts';
import {
  createReviewReportDownloadRepository,
  executeReviewReportDownloadCommand,
  parseReviewReportDownloadCommand,
} from '../supabase/functions/_shared/commands/review/report_download.ts';

const PROCESS_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const request = {
  processId: PROCESS_ID,
  processVersion: '01.01.000',
  sourceId: SOURCE_ID,
  sourceVersion: '01.01.000',
};

class FakeActorClient {
  calls: Array<{ fn: string; args: unknown }> = [];
  result: { data: unknown; error: unknown } = {
    data: {
      ok: true,
      data: {
        attachments: [
          {
            bucket: 'external_docs',
            objectPath: 'reports/current.pdf',
            filename: 'current.pdf',
          },
          {
            bucket: 'external_docs',
            objectPath: 'reports/evidence.xlsx',
            filename: 'evidence.xlsx',
          },
        ],
      },
    },
    error: null,
  };

  rpc(fn: string, args: unknown) {
    this.calls.push({ fn, args: structuredClone(args) });
    return Promise.resolve(this.result);
  }
}

class FakeServiceClient {
  calls: Array<{ bucket: string; path: string; expiresIn: number; download: string }> = [];
  storage = {
    from: (bucket: string) => ({
      createSignedUrl: (path: string, expiresIn: number, options: { download: string }) => {
        this.calls.push({ bucket, path, expiresIn, download: options.download });
        return Promise.resolve({
          data: { signedUrl: `https://storage.example.test/${path}?token=test` },
          error: null,
        });
      },
    }),
  };
}

const actor: ActorContext = {
  userId: USER_ID,
  accessToken: 'access-token',
  supabase: {} as SupabaseClient,
};

Deno.test('review report download payload is strict and accepts no storage authority', () => {
  assertEquals(parseReviewReportDownloadCommand(request).ok, true);
  assertEquals(
    parseReviewReportDownloadCommand({
      ...request,
      bucket: 'external_docs',
      objectPath: 'forged.pdf',
      userId: USER_ID,
    }).ok,
    false,
  );
});

Deno.test('review report download signs every authorized current attachment', async () => {
  const actorClient = new FakeActorClient();
  const serviceClient = new FakeServiceClient();
  const repository = createReviewReportDownloadRepository(
    actorClient as unknown as Pick<SupabaseClient, 'rpc'>,
    serviceClient as unknown as SupabaseClient,
    { now: () => Date.parse('2026-09-29T00:00:00.000Z') },
  );

  const result = await executeReviewReportDownloadCommand(request, actor, repository);
  assertEquals(result.ok, true);
  assertEquals(actorClient.calls, [
    {
      fn: 'qry_review_report_download_descriptor_v1',
      args: {
        p_process_id: PROCESS_ID,
        p_process_version: '01.01.000',
        p_source_id: SOURCE_ID,
        p_source_version: '01.01.000',
      },
    },
  ]);
  assertEquals(serviceClient.calls, [
    {
      bucket: 'external_docs',
      path: 'reports/current.pdf',
      expiresIn: 300,
      download: 'current.pdf',
    },
    {
      bucket: 'external_docs',
      path: 'reports/evidence.xlsx',
      expiresIn: 300,
      download: 'evidence.xlsx',
    },
  ]);
  if (result.ok) {
    const serialized = JSON.stringify(result.body);
    assertEquals(serialized.includes('objectPath'), false);
    assertEquals(serialized.includes('external_docs'), false);
    assertEquals(result.body, {
      ok: true,
      command: 'review_report_download',
      data: {
        downloads: [
          {
            filename: 'current.pdf',
            signedDownloadUrl: 'https://storage.example.test/reports/current.pdf?token=test',
            signedUrlExpiresAt: '2026-09-29T00:05:00.000Z',
          },
          {
            filename: 'evidence.xlsx',
            signedDownloadUrl: 'https://storage.example.test/reports/evidence.xlsx?token=test',
            signedUrlExpiresAt: '2026-09-29T00:05:00.000Z',
          },
        ],
      },
    });
  }
});

Deno.test('review report download preserves a generic relationship denial', async () => {
  const actorClient = new FakeActorClient();
  actorClient.result = {
    data: {
      ok: false,
      code: 'REVIEW_REPORT_DOWNLOAD_NOT_ALLOWED',
      status: 403,
      message: 'Review report download is not allowed',
    },
    error: null,
  };
  const serviceClient = new FakeServiceClient();
  const repository = createReviewReportDownloadRepository(
    actorClient as unknown as Pick<SupabaseClient, 'rpc'>,
    serviceClient as unknown as SupabaseClient,
  );

  const result = await executeReviewReportDownloadCommand(request, actor, repository);
  assertEquals(result, {
    ok: false,
    code: 'REVIEW_REPORT_DOWNLOAD_NOT_ALLOWED',
    status: 403,
    message: 'Review report download is not allowed',
  });
  assertEquals(serviceClient.calls.length, 0);
});

Deno.test('review report download fails closed on invalid internal descriptors', async () => {
  const actorClient = new FakeActorClient();
  actorClient.result = {
    data: {
      ok: true,
      data: {
        attachments: [
          {
            bucket: 'external_docs',
            objectPath: '../secret.pdf',
            filename: 'secret.pdf',
          },
        ],
      },
    },
    error: null,
  };
  const serviceClient = new FakeServiceClient();
  const repository = createReviewReportDownloadRepository(
    actorClient as unknown as Pick<SupabaseClient, 'rpc'>,
    serviceClient as unknown as SupabaseClient,
  );

  const result = await executeReviewReportDownloadCommand(request, actor, repository);
  assertEquals(result, {
    ok: false,
    code: 'REVIEW_REPORT_DOWNLOAD_FAILED',
    status: 502,
    message: 'Unable to prepare review report download',
  });
  assertEquals(serviceClient.calls.length, 0);
});

Deno.test('review report download reports an empty current attachment list', async () => {
  const actorClient = new FakeActorClient();
  actorClient.result = { data: { ok: true, data: { attachments: [] } }, error: null };
  const serviceClient = new FakeServiceClient();
  const repository = createReviewReportDownloadRepository(
    actorClient as unknown as Pick<SupabaseClient, 'rpc'>,
    serviceClient as unknown as SupabaseClient,
  );

  const result = await executeReviewReportDownloadCommand(request, actor, repository);
  assertEquals(result, {
    ok: false,
    code: 'REVIEW_REPORT_NO_ATTACHMENTS',
    status: 404,
    message: 'The review report has no current attachments',
  });
  assertEquals(serviceClient.calls.length, 0);
});
