import { assertEquals } from 'jsr:@std/assert';
import { createClient } from '@supabase/supabase-js@2';

import type { ActorContext } from '../supabase/functions/_shared/command_runtime/actor_context.ts';
import { executeDataProductCommand } from '../supabase/functions/_shared/commands/data_product/command.ts';
import { createDataProductCommandRepository } from '../supabase/functions/_shared/commands/data_product/repository.ts';
import { createAppDataProductCommandsHandler } from '../supabase/functions/app_data_product_commands/index.ts';

const CLOSURE_CHECK_ID = '45454545-4545-4454-8454-454545454545';
const ARTIFACT_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '22222222-2222-4222-8222-222222222222';

Deno.test(
  'data product HTTP handler uses real Supabase HTTP clients without leaking backend failures',
  async () => {
    let baseUrl = '';
    let rpcMode: 'success' | 'failure' = 'success';
    const observedRequests: Array<{ path: string; body: unknown }> = [];
    let resolvePort: (port: number) => void;
    const portPromise = new Promise<number>((resolve) => {
      resolvePort = resolve;
    });

    const server = Deno.serve(
      {
        hostname: '127.0.0.1',
        port: 0,
        onListen: ({ port }) => resolvePort(port),
      },
      async (request) => {
        const url = new URL(request.url);
        const bodyText = await request.text();
        const body = bodyText ? JSON.parse(bodyText) : null;
        observedRequests.push({ path: url.pathname, body });

        if (url.pathname === '/rest/v1/rpc/get_lcia_scope_closure_report_download') {
          if (rpcMode === 'failure') {
            return Response.json(
              {
                code: 'PGRST202',
                message: 'backend source error bucket=private-smoke objectPath=smoke/report.xlsx',
                details: 'credentials=service-role-smoke-secret',
                hint: null,
              },
              { status: 404 },
            );
          }
          return Response.json({
            ok: true,
            data: {
              artifactId: ARTIFACT_ID,
              artifactRole: 'closure_report_xlsx',
              artifactState: 'ready',
              filename: `scope-closure-${CLOSURE_CHECK_ID}.xlsx`,
              format: 'xlsx',
              mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              size: 42,
              checksumSha256: 'a'.repeat(64),
              artifactExpiresAt: '2099-07-29T00:00:00.000Z',
              bucket: 'private-smoke',
              objectPath: 'smoke/report.xlsx',
            },
          });
        }

        if (url.pathname === '/storage/v1/object/sign/private-smoke/smoke/report.xlsx') {
          return Response.json({
            signedURL: '/object/sign/private-smoke/smoke/report.xlsx?token=smoke-token',
          });
        }

        return Response.json({ message: 'unexpected local smoke request' }, { status: 404 });
      },
    );

    try {
      baseUrl = `http://127.0.0.1:${await portPromise}`;
      const actorSupabase = createClient(baseUrl, 'local-anon-key', {
        auth: {
          autoRefreshToken: false,
          detectSessionInUrl: false,
          persistSession: false,
        },
        global: { headers: { Authorization: 'Bearer local-user-token' } },
      });
      const serviceSupabase = createClient(baseUrl, 'local-service-role-key', {
        auth: {
          autoRefreshToken: false,
          detectSessionInUrl: false,
          persistSession: false,
        },
      });
      const actor: ActorContext = {
        userId: USER_ID,
        accessToken: 'local-user-token',
        supabase: actorSupabase,
      };
      const handler = createAppDataProductCommandsHandler({
        resolveActor: () => Promise.resolve({ ok: true, value: actor }),
        execute: (request, resolvedActor) =>
          executeDataProductCommand(
            request,
            resolvedActor,
            createDataProductCommandRepository(actorSupabase, serviceSupabase),
          ),
      });
      const makeRequest = () =>
        new Request(`${baseUrl}/functions/v1/app_data_product_commands`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'create_closure_report_download',
            closureCheckId: CLOSURE_CHECK_ID,
            artifactRole: 'closure_report_xlsx',
          }),
        });

      const successResponse = await handler(makeRequest());
      assertEquals(successResponse.status, 200);
      const successBody = await successResponse.json();
      assertEquals(successBody.ok, true);
      assertEquals(
        successBody.data.signedDownloadUrl,
        `${baseUrl}/storage/v1/object/sign/private-smoke/smoke/report.xlsx?token=smoke-token&download=scope-closure-${CLOSURE_CHECK_ID}.xlsx`,
      );
      assertEquals('bucket' in successBody.data, false);
      assertEquals('objectPath' in successBody.data, false);
      assertEquals(observedRequests, [
        {
          path: '/rest/v1/rpc/get_lcia_scope_closure_report_download',
          body: {
            p_closure_check_id: CLOSURE_CHECK_ID,
            p_artifact_role: 'closure_report_xlsx',
          },
        },
        {
          path: '/storage/v1/object/sign/private-smoke/smoke/report.xlsx',
          body: {
            expiresIn: 900,
          },
        },
      ]);

      rpcMode = 'failure';
      observedRequests.length = 0;
      const failureResponse = await handler(makeRequest());
      assertEquals(failureResponse.status, 502);
      const failureBody = await failureResponse.json();
      assertEquals(failureBody, {
        ok: false,
        code: 'closure_report_backend_failed',
        message: 'Unable to resolve closure report download',
      });
      const serializedFailure = JSON.stringify(failureBody);
      for (const privateText of [
        'private-smoke',
        'smoke/report.xlsx',
        'service-role-smoke-secret',
        'backend source error',
        'PGRST202',
        'details',
      ]) {
        assertEquals(serializedFailure.includes(privateText), false);
      }
      assertEquals(observedRequests, [
        {
          path: '/rest/v1/rpc/get_lcia_scope_closure_report_download',
          body: {
            p_closure_check_id: CLOSURE_CHECK_ID,
            p_artifact_role: 'closure_report_xlsx',
          },
        },
      ]);
    } finally {
      await server.shutdown();
    }
  },
);
