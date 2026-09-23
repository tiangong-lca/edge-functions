import type { ActorContext } from '../../command_runtime/actor_context.ts';
import type { CommandExecutionResult, CommandParseResult } from '../../command_runtime/command.ts';

export type OpenDataProcessPublicationItem = {
  id: string;
  version: string;
};

export type OpenDataProcessPublishRequest = {
  items: OpenDataProcessPublicationItem[];
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const VERSION_PATTERN = /^\d{2}\.\d{2}\.\d{3}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseOpenDataProcessPublishRequest(
  body: unknown,
): CommandParseResult<OpenDataProcessPublishRequest> {
  if (!isRecord(body) || !Array.isArray(body.items)) {
    return { ok: false, message: 'items must be an array' };
  }
  if (body.items.length < 1 || body.items.length > 100) {
    return { ok: false, message: 'items must contain between 1 and 100 Process versions' };
  }

  const items: OpenDataProcessPublicationItem[] = [];
  for (const value of body.items) {
    if (!isRecord(value) || Object.keys(value).some((key) => key !== 'id' && key !== 'version')) {
      return { ok: false, message: 'each item must contain only id and version' };
    }
    const id = typeof value.id === 'string' ? value.id.trim().toLowerCase() : '';
    const version = typeof value.version === 'string' ? value.version.trim() : '';
    if (!UUID_PATTERN.test(id) || !VERSION_PATTERN.test(version)) {
      return { ok: false, message: 'each item must contain a valid id and version' };
    }
    items.push({ id, version });
  }

  return { ok: true, value: { items } };
}

function rpcFailure(error: { code?: string; message?: string; details?: unknown }) {
  const code = error.code ?? 'OPEN_DATA_PROCESS_PUBLISH_FAILED';
  const status = code === '42501' ? 403 : code === '28000' ? 401 : 400;
  return {
    ok: false as const,
    code,
    status,
    message: error.message ?? 'Open Data Process publication failed',
    details: error.details ?? null,
  };
}

export async function executeOpenDataProcessPublish(
  request: OpenDataProcessPublishRequest,
  actor: ActorContext,
): Promise<CommandExecutionResult> {
  const { data, error } = await actor.supabase.rpc('cmd_open_data_process_publish_batch', {
    p_items: request.items,
  });
  if (error) {
    return rpcFailure(error);
  }

  if (!isRecord(data) || data.ok !== true || !('data' in data)) {
    return {
      ok: false,
      code: 'OPEN_DATA_PROCESS_PUBLISH_INVALID_RESPONSE',
      status: 502,
      message: 'Open Data Process publication returned an invalid response',
    };
  }

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      command: 'open_data_process_publish_batch',
      data: data.data,
    },
  };
}
