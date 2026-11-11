// Explicit synthetic cross-repository runner. Release owns creation/cleanup of
// the temporary inputs, actor SQL facade and real Worker. This is not hosted auth.
import { createClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { createLcaReleaseResultsHandler } from '../../supabase/functions/lca_release_results/index.ts';

if (import.meta.main) {
  const config = JSON.parse(await Deno.readTextFile(Deno.args[0]));
  for (const endpoint of [
    config.actorEndpoint,
    config.readerEndpoint,
    ...(config.archiveTarget ? [config.archiveTarget.endpoint] : []),
  ]) {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
      throw new Error('Synthetic loopback endpoints required');
  }
  const actor = createClient(config.actorEndpoint, 'sb_publishable_synthetic', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${config.token}` } },
  });
  const handler = createLcaReleaseResultsHandler({
    resolveActor: async () => ({
      ok: true,
      value: { userId: config.actorId, accessToken: config.token, supabase: actor },
    }),
    resultQuery: { serviceUrl: config.readerEndpoint, secret: config.readerSecret },
    ...(config.archiveTarget
      ? {
          finalDownload: {
            config: {
              ...config.archiveTarget,
              signer: 's3',
              accessKeyId: 'synthetic',
              secretAccessKey: 'synthetic',
            },
          },
        }
      : {}),
  });
  const replies = [];
  for (const body of config.requests) {
    const response = await handler(
      new Request('http://127.0.0.1/lca_release_results', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    replies.push({ status: response.status, body: await response.json() });
  }
  console.log(JSON.stringify(replies));
}
