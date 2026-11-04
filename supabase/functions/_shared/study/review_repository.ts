import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.118.0';
import type { ReviewRequest } from '../../../../contracts/lca-study/v4/review.ts';
import { operationMetadata } from '../../../../contracts/lca-study/v4/codec.ts';
import { createReportingRepository, type ReportingRepository } from './reporting_repository.ts';
import { createStudyServiceClient, rpcFailure } from './repository.ts';
export interface ReviewRepository {
  dispatch(request: ReviewRequest, signal: AbortSignal): Promise<unknown>;
  resolveIntent(intentId: string, signal: AbortSignal): Promise<unknown>;
  consumeIntent(intentId: string, completion: unknown, signal: AbortSignal): Promise<unknown>;
  download: ReportingRepository['download'];
  upload: ReportingRepository['upload'];
}
export function createReviewRepository(
  actor: SupabaseClient,
  serviceFactory = (signal: AbortSignal) => createStudyServiceClient(signal),
): ReviewRepository {
  const artifacts = createReportingRepository(actor, serviceFactory);
  const serviceCall = async (name: string, args: Record<string, unknown>, signal: AbortSignal) => {
    const { data, error } = await serviceFactory(signal).rpc(name, args).abortSignal(signal);
    if (error) throw rpcFailure(error);
    return data;
  };
  return {
    async dispatch(request, signal) {
      const { data, error } = await actor
        .rpc(
          operationMetadata[request.operation].kind === 'query'
            ? 'qry_study_review_v1'
            : 'cmd_study_review_v1',
          { p_request: request },
        )
        .abortSignal(signal);
      if (error) throw rpcFailure(error);
      return data;
    },
    resolveIntent: (id, signal) =>
      serviceCall('svc_study_review_intent_resolve_v1', { p_intent_id: id }, signal),
    consumeIntent: (id, completion, signal) =>
      serviceCall(
        'svc_study_review_intent_consume_v1',
        { p_intent_id: id, p_completion: completion },
        signal,
      ),
    download: artifacts.download,
    upload: artifacts.upload,
  };
}
