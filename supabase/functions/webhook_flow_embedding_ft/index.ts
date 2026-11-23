import { handleExtractionWebhook } from '../_shared/extraction_webhook.ts';
import '@supabase/functions-js/edge-runtime.d.ts';
import { generateFlowMarkdown } from '../_shared/flow_extraction.ts';
import { projectFlowSearchText } from '../_shared/search_text_projection.ts';

if (import.meta.main) {
  Deno.serve((req) =>
    handleExtractionWebhook(req, 'flows', generateFlowMarkdown, projectFlowSearchText),
  );
}
