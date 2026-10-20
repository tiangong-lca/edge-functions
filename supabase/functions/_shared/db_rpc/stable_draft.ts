import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.118.0';

import type { StableDraftRequest } from '../commands/dataset/stable_draft.ts';
import type { DatasetRpcResult } from './dataset_commands.ts';

export type StableDraftRpcClient = Pick<SupabaseClient, 'rpc'>;

export async function callStableDraftRpc(
  client: StableDraftRpcClient,
  input: StableDraftRequest,
  readOnly: boolean,
): Promise<DatasetRpcResult> {
  let response;
  try {
    // Never retry or fall back: an uncertain prepare is recovered by the read-only endpoint.
    response = await client.rpc(
      readOnly ? 'get_dataset_stable_draft_request' : 'cmd_dataset_prepare_stable_draft',
      { p_request_id: input.requestId, p_request: input.request },
    );
  } catch (_error) {
    return {
      ok: false,
      code: 'STABLE_DRAFT_TRANSPORT_ERROR',
      status: 502,
      message: readOnly
        ? 'Stable draft request readback failed'
        : 'Stable draft prepare outcome is unknown; use read-only request recovery',
    };
  }
  const { data, error } = response;
  if (error) {
    const code = error.code ?? 'RPC_ERROR';
    return {
      ok: false,
      code,
      status: code === 'PGRST202' || code === '42883' ? 503 : code === '42501' ? 403 : 502,
      message: error.message ?? 'Stable draft RPC failed',
      details: error.details ?? null,
    };
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    if (
      data.ok === false &&
      typeof data.code === 'string' &&
      typeof data.message === 'string' &&
      Number.isInteger(data.status) &&
      data.status >= 400 &&
      data.status <= 599
    ) {
      return data;
    }
    if (
      data.ok === true &&
      data.data &&
      typeof data.data === 'object' &&
      !Array.isArray(data.data)
    ) {
      return { ok: true, data: data.data };
    }
  }
  return {
    ok: false,
    code: 'INVALID_STABLE_DRAFT_RESPONSE',
    status: 502,
    message: 'Stable draft RPC returned an invalid response',
  };
}
