import { z } from 'zod';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.118.0';
import type { AdvancedRequest } from '../../../../contracts/lca-study/v5/advanced.ts';
import { reportingArtifactRefSchema } from '../../../../contracts/lca-study/v5/advanced.ts';
import { sha256 } from '../../../../contracts/lca-study/v3/canonical.ts';
import {
  artifactCapabilitySchema,
  artifactReadIntentSchema,
  createStudyRepository,
  createStudyServiceClient,
  rpcFailure,
  MAX_ARTIFACT_BYTES,
  type ArtifactCapability,
} from './repository.ts';
import { StudyFailure } from './protocol.ts';

export const reportingCapabilitySchema = artifactCapabilitySchema.extend({
  artifactRef: reportingArtifactRefSchema.or(artifactCapabilitySchema.shape.artifactRef),
});
export const reportingReadIntentSchema = artifactReadIntentSchema.extend({
  artifactRef: reportingArtifactRefSchema,
});
export type ReportingCapability = z.infer<typeof reportingCapabilitySchema>;
export type PrivateReportArtifact = Omit<ReportingCapability, 'kind'>;
export interface AdvancedRepository {
  dispatch(request: AdvancedRequest, signal: AbortSignal): Promise<unknown>;
  resolveParameters(intentId: string, signal: AbortSignal): Promise<unknown>;
  resolveIntent(intentId: string, signal: AbortSignal): Promise<unknown>;
  consumeIntent(intentId: string, completion: unknown, signal: AbortSignal): Promise<unknown>;
  reconcileIntent(
    intentId: string,
    artifactId: string,
    contentHash: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  resolveArtifact(intentId: string, signal: AbortSignal): Promise<unknown>;
  download(capability: ReportingCapability, signal: AbortSignal): Promise<Uint8Array>;
  upload(artifact: PrivateReportArtifact, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
}
export function createAdvancedRepository(
  actor: SupabaseClient,
  serviceFactory = (signal: AbortSignal) => createStudyServiceClient(signal),
): AdvancedRepository {
  const core = createStudyRepository(actor, serviceFactory);
  const serviceCall = async (name: string, args: Record<string, unknown>, signal: AbortSignal) => {
    const { data, error } = await serviceFactory(signal).rpc(name, args).abortSignal(signal);
    if (error) throw rpcFailure(error);
    return data;
  };
  const download = async (cap: ReportingCapability, signal: AbortSignal) => {
    // Only the tagged artifact kind expands. The bounded Storage reader uses identical locator/size fields.
    const bytes = await core.download(cap as ArtifactCapability, signal);
    if (
      bytes.length !== cap.artifactRef.byteSize ||
      (await sha256(bytes)) !== cap.artifactRef.contentHash
    )
      throw new StudyFailure('REFERENCE_MISMATCH', 502, 'report.artifact_integrity');
    return bytes;
  };
  return {
    async dispatch(request, signal) {
      const { data, error } = await actor
        .rpc(
          request.operation.endsWith('.read') || request.operation.endsWith('.list')
            ? 'qry_study_advanced_v1'
            : 'cmd_study_advanced_v1',
          { p_request: request },
        )
        .abortSignal(signal);
      if (error) throw rpcFailure(error);
      return data;
    },
    resolveParameters: (id, signal) =>
      serviceCall('svc_study_analysis_parameters_resolve_v1', { p_intent_id: id }, signal),
    resolveIntent: (id, signal) =>
      serviceCall('svc_study_report_advanced_intent_resolve_v1', { p_intent_id: id }, signal),
    consumeIntent: (id, completion, signal) =>
      serviceCall(
        'svc_study_report_advanced_intent_consume_v1',
        { p_intent_id: id, p_completion: completion },
        signal,
      ),
    reconcileIntent: (id, artifactId, contentHash, signal) =>
      serviceCall(
        'svc_study_report_advanced_intent_reconcile_v1',
        { p_intent_id: id, p_artifact_id: artifactId, p_content_hash: contentHash },
        signal,
      ),
    resolveArtifact: (id, signal) =>
      serviceCall('svc_study_artifact_read_resolve_v1', { p_intent_id: id }, signal),
    download,
    async upload(artifact, bytes, signal) {
      const cap = reportingCapabilitySchema.parse({ kind: 'artifactCapability', ...artifact });
      if (
        bytes.length > MAX_ARTIFACT_BYTES ||
        bytes.length !== cap.artifactRef.byteSize ||
        (await sha256(bytes)) !== cap.artifactRef.contentHash
      )
        throw new StudyFailure('PAYLOAD_TOO_LARGE', 413, 'report.upload_binding');
      const { error } = await serviceFactory(signal)
        .storage.from(cap.storageBucket)
        .upload(cap.storageObjectPath, bytes, {
          contentType: cap.artifactRef.mediaType,
          upsert: false,
          cacheControl: '0',
        });
      signal.throwIfAborted();
      // Successful writes and unknown/duplicate acknowledgements both require exact byte readback.
      // A failure is never followed by an overwrite or deletion. The original intent remains recoverable.
      try {
        await download(cap, signal);
      } catch (cause) {
        if (error) throw new StudyFailure('UPSTREAM_UNAVAILABLE', 502, 'report.upload_unknown');
        throw cause;
      }
    },
  };
}
