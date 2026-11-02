import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { z } from 'zod';
import { artifactRefSchema, idSchema, text } from '../../../../contracts/lca-study/v1/common.ts';
import type { StudyApiRequest } from '../../../../contracts/lca-study/v2/index.ts';
import {
  getSupabaseServiceRoleKey,
  getSupabaseUrl,
  getSupabasePublishableKey,
} from '../supabase_client.ts';
import { isQuery, StudyFailure, type ValidationDecision } from './protocol.ts';

export const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const segment = text(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
  .refine((s) => s !== '.' && s !== '..');
export const artifactCapabilitySchema = z
  .object({
    kind: z.literal('artifactCapability'),
    studyId: idSchema,
    artifactRef: artifactRefSchema,
    storageBucket: segment,
    storageObjectPath: text(1024).refine((p) =>
      p.split('/').every((s) => segment.safeParse(s).success),
    ),
  })
  .strict();
export type ArtifactCapability = z.infer<typeof artifactCapabilitySchema>;
function rpcFailure(error: { code?: string }): StudyFailure {
  if (error.code === '42501') return new StudyFailure('FORBIDDEN', 403, 'rpc.permission');
  if (['28000', '28P01', 'PGRST301', 'PGRST302'].includes(error.code ?? ''))
    return new StudyFailure('AUTH_REQUIRED', 401, 'rpc.authentication');
  if (['22023', '22P02', '22003'].includes(error.code ?? ''))
    return new StudyFailure('INVALID_REQUEST', 400, 'rpc.argument');
  return new StudyFailure('UPSTREAM_UNAVAILABLE', 502, 'rpc.transport');
}
export interface StudyRepository {
  dispatch(request: StudyApiRequest, signal: AbortSignal): Promise<unknown>;
  consume(intentId: string, decision: ValidationDecision, signal: AbortSignal): Promise<unknown>;
  download(capability: ArtifactCapability, signal: AbortSignal): Promise<Uint8Array>;
}

/** Keep the shared JWT resolver while binding JWKS/Auth and later RPC I/O to one deadline. */
export function createStudyActorClient(accessToken: string, signal: AbortSignal): SupabaseClient {
  return createClient(getSupabaseUrl(), getSupabasePublishableKey(), {
    db: { schema: 'api' },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
      fetch: (input, init) => fetch(input, { ...init, signal }),
    },
  }) as unknown as SupabaseClient;
}

/** Bounded bytes apply to actual streams, including chunked and dishonest lengths. */
export async function readBounded(
  response: Response,
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  let length = 0;
  const chunks: Uint8Array[] = [];
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum)
        throw new StudyFailure('PAYLOAD_TOO_LARGE', 413, 'transport.byte_limit');
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
    return bytes;
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createStudyRepository(
  actor: SupabaseClient,
  serviceFactory?: (signal: AbortSignal) => SupabaseClient,
): StudyRepository {
  function service(signal: AbortSignal): SupabaseClient {
    if (serviceFactory) return serviceFactory(signal);
    const fetcher: typeof fetch = async (input, init) => {
      const response = await fetch(input, { ...init, signal });
      const bytes = await readBounded(response, MAX_ARTIFACT_BYTES, signal);
      return new Response(bytes, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
    return createClient(getSupabaseUrl(), getSupabaseServiceRoleKey(), {
      db: { schema: 'api' },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: fetcher },
    }) as unknown as SupabaseClient;
  }
  return {
    async dispatch(request, signal) {
      const { data, error } = await actor
        .rpc(isQuery(request) ? 'qry_study_v1' : 'cmd_study_v1', { p_request: request })
        .abortSignal(signal);
      if (error) throw rpcFailure(error);
      return data;
    },
    async consume(intentId, decision, signal) {
      const { data, error } = await service(signal)
        .rpc('svc_study_revision_freeze_consume_v1', {
          p_intent_id: intentId,
          p_outcome: decision.outcome,
          p_error_code: decision.outcome === 'failed' ? decision.code : null,
        })
        .abortSignal(signal);
      if (error) throw rpcFailure(error);
      return data;
    },
    async download(cap, signal) {
      if (cap.artifactRef.byteSize > MAX_ARTIFACT_BYTES)
        throw new StudyFailure('PAYLOAD_TOO_LARGE', 413, 'artifact.byte_limit');
      const { data, error } = await service(signal)
        .storage.from(cap.storageBucket)
        .download(cap.storageObjectPath);
      signal.throwIfAborted();
      if (error || !data) throw new StudyFailure('UPSTREAM_UNAVAILABLE', 502, 'artifact.download');
      const bytes = new Uint8Array(await data.arrayBuffer());
      if (bytes.byteLength > MAX_ARTIFACT_BYTES)
        throw new StudyFailure('PAYLOAD_TOO_LARGE', 413, 'artifact.byte_limit');
      return bytes;
    },
  };
}
