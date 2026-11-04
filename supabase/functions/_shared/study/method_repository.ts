import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.118.0';
import type { MethodRequest } from '../../../../contracts/lca-study/v6/requests.ts';
import { operationMetadata } from '../../../../contracts/lca-study/v6/codec.ts';
import { sha256 } from '../../../../contracts/lca-study/v3/canonical.ts';
import {
  createStudyRepository,
  createStudyServiceClient,
  rpcFailure,
  MAX_ARTIFACT_BYTES,
  type ArtifactCapability,
} from './repository.ts';
import {
  methodCapabilitySchema,
  type MethodCapability,
  type MethodPrivateArtifact,
} from './method_context.ts';
import { StudyFailure } from './protocol.ts';
export type MethodIntentKind = 'evidence' | 'report' | 'review';
export type MethodChannel = 'authoring' | 'review';
export interface MethodRepository {
  dispatch(request: MethodRequest, signal: AbortSignal, channel: MethodChannel): Promise<unknown>;
  resolveIntent(kind: MethodIntentKind, id: string, signal: AbortSignal): Promise<unknown>;
  consumeIntent(
    kind: MethodIntentKind,
    id: string,
    completion: unknown,
    signal: AbortSignal,
  ): Promise<unknown>;
  reconcileIntent(
    kind: MethodIntentKind,
    id: string,
    artifactId: string,
    contentHash: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  resolveArtifact(id: string, signal: AbortSignal): Promise<unknown>;
  download(capability: MethodCapability, signal: AbortSignal): Promise<Uint8Array>;
  upload(artifact: MethodPrivateArtifact, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
}
const intentPrefixes = {
  evidence: 'svc_study_method_evidence_intent',
  report: 'svc_study_report_method_intent',
  review: 'svc_study_review_method_intent',
} as const;
export function createMethodRepository(
  actor: SupabaseClient,
  serviceFactory = (signal: AbortSignal) => createStudyServiceClient(signal),
): MethodRepository {
  const core = createStudyRepository(actor, serviceFactory);
  const serviceCall = async (name: string, args: Record<string, unknown>, signal: AbortSignal) => {
    const { data, error } = await serviceFactory(signal).rpc(name, args).abortSignal(signal);
    if (error) throw rpcFailure(error);
    return data;
  };
  const download = async (capability: MethodCapability, signal: AbortSignal) => {
    const cap = methodCapabilitySchema.parse(capability);
    // The shared bounded Storage reader uses the same already-validated locator
    // and byte fields; the new family is checked before this private type bridge.
    const bytes = await core.download(cap as ArtifactCapability, signal);
    if (
      bytes.length !== cap.artifactRef.byteSize ||
      (await sha256(bytes)) !== cap.artifactRef.contentHash
    )
      throw new StudyFailure('REFERENCE_MISMATCH', 502, 'method.artifact_integrity');
    return bytes;
  };
  return {
    async dispatch(request, signal, channel) {
      const query = operationMetadata[request.operation].kind === 'query';
      const name =
        channel === 'review'
          ? query
            ? 'qry_study_method_review_v1'
            : 'cmd_study_method_review_v1'
          : query
            ? 'qry_study_method_v1'
            : 'cmd_study_method_v1';
      const { data, error } = await actor.rpc(name, { p_request: request }).abortSignal(signal);
      if (error) throw rpcFailure(error);
      return data;
    },
    resolveIntent: (kind, id, signal) =>
      serviceCall(`${intentPrefixes[kind]}_resolve_v1`, { p_intent_id: id }, signal),
    consumeIntent: (kind, id, completion, signal) =>
      serviceCall(
        `${intentPrefixes[kind]}_consume_v1`,
        { p_intent_id: id, p_completion: completion },
        signal,
      ),
    reconcileIntent: (kind, id, artifactId, contentHash, signal) =>
      serviceCall(
        `${intentPrefixes[kind]}_reconcile_v1`,
        { p_intent_id: id, p_artifact_id: artifactId, p_content_hash: contentHash },
        signal,
      ),
    resolveArtifact: (id, signal) =>
      serviceCall('svc_study_artifact_read_resolve_v1', { p_intent_id: id }, signal),
    download,
    async upload(artifact, bytes, signal) {
      const cap = methodCapabilitySchema.parse({ kind: 'artifactCapability', ...artifact });
      if (
        bytes.length > MAX_ARTIFACT_BYTES ||
        bytes.length !== cap.artifactRef.byteSize ||
        (await sha256(bytes)) !== cap.artifactRef.contentHash
      )
        throw new StudyFailure('PAYLOAD_TOO_LARGE', 413, 'method.upload_binding');
      const { error } = await serviceFactory(signal)
        .storage.from(cap.storageBucket)
        .upload(cap.storageObjectPath, bytes, {
          contentType: cap.artifactRef.mediaType,
          upsert: false,
          cacheControl: '0',
        });
      signal.throwIfAborted();
      // Never overwrite/delete on unknown acknowledgments. Exact immutable
      // readback also makes a duplicate same-request upload recoverable.
      try {
        await download(cap, signal);
      } catch (cause) {
        if (error) throw new StudyFailure('UPSTREAM_UNAVAILABLE', 502, 'method.upload_unknown');
        throw cause;
      }
    },
  };
}
