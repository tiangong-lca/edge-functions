import { authenticateRequest, AuthMethod } from './auth.ts';
import { corsHeaders } from './cors.ts';
import { projectExtraction, refreshDatasetExtraction } from './dataset_extraction_worker.ts';
import type { SearchTextProjector } from './search_text_projection.ts';
import { supabaseClient } from './supabase_client.ts';

// Pre-cutover pg_net requests can arrive after newer saves or queue completions.
// Treat their record as a locator. Never project the body carried in the event.
export async function handleExtractionWebhook(
  req: Request,
  expectedTable: string,
  generator: (body: unknown) => string,
  projector: SearchTextProjector,
  client = supabaseClient,
): Promise<Response> {
  const auth = await authenticateRequest(req, { allowedMethods: [AuthMethod.SERVICE_API_KEY] });
  if (!auth.isAuthenticated) return auth.response!;
  const headers = { ...corsHeaders, 'Content-Type': 'application/json' };
  try {
    const payload = await req.json();
    const results = [];
    for (const [index, event] of (Array.isArray(payload) ? payload : [payload]).entries()) {
      const { type, table, schema, record } = event ?? {};
      if ((table && table !== expectedTable) || (schema && schema !== 'public')) {
        throw new Error(`Unexpected dataset at batch index ${index}`);
      }
      if (type !== 'INSERT' && type !== 'UPDATE') {
        results.push({ index, type, table, status: 'ignored' });
        continue;
      }
      const { id, version } = record ?? {};
      if (typeof id !== 'string' || !id || typeof version !== 'string' || !version) {
        throw new Error(`Missing dataset identity at batch index ${index}`);
      }
      const result = await refreshDatasetExtraction(client, expectedTable, id, version, (body) =>
        projectExtraction(body, id, projector, generator),
      );
      results.push({
        index,
        type,
        table,
        id,
        version,
        ...result,
        status: result.status === 'stale' ? 'skipped' : 'success',
      });
    }
    return Response.json({ success: true, results }, { headers });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Extraction failed' },
      { status: 500, headers },
    );
  }
}
