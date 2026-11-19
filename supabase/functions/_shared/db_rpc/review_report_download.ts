import type { SupabaseClient } from '@supabase/supabase-js@2';

import type { ReviewReportDownloadRequest } from '../commands/review/types.ts';

type RpcClient = Pick<SupabaseClient, 'rpc'>;

export function buildReviewReportDownloadDescriptorRpcArgs(
  request: ReviewReportDownloadRequest,
): Record<string, unknown> {
  return {
    p_process_id: request.processId,
    p_process_version: request.processVersion,
    p_source_id: request.sourceId,
    p_source_version: request.sourceVersion,
  };
}

export async function callReviewReportDownloadDescriptorRpc(
  supabase: RpcClient,
  request: ReviewReportDownloadRequest,
) {
  return await supabase.rpc(
    'qry_review_report_download_descriptor_v1',
    buildReviewReportDownloadDescriptorRpcArgs(request),
  );
}
