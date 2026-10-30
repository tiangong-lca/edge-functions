import '@supabase/functions-js/edge-runtime.d.ts';

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { z } from 'zod';

import { isSupabasePublishableApiKey } from '../_shared/auth.ts';
import {
  type ActorContextResult,
  resolveActorContext,
} from '../_shared/command_runtime/actor_context.ts';
import { commandError, json } from '../_shared/command_runtime/http.ts';
import {
  publishedQueryRequestSchema,
  queryPublishedResult,
  readResultQueryBytes,
  type ResultQueryOptions,
} from '../_shared/result_query.ts';
import {
  createLcaReleaseCommandRepository,
  createPublicLcaReleaseRepository,
  type LcaReleaseCommandRepository,
} from '../_shared/commands/lca_release/repository.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { createSupabaseServiceClient } from '../_shared/supabase_client.ts';

const uuidSchema = z.string().uuid();

export const lcaReleaseResultsRequestSchema = z.preprocess(
  (value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (typeof record.mode !== 'string') {
        return { ...record, mode: 'current' };
      }
    }
    return value;
  },
  z.discriminatedUnion('mode', [
    publishedQueryRequestSchema,
    z.object({ mode: z.literal('current') }).strict(),
    z
      .object({
        mode: z.literal('process'),
        processId: uuidSchema,
        processVersion: z.string().regex(/^\d{2}\.\d{2}\.\d{3}$/),
      })
      .strict(),
    z.object({ mode: z.literal('release'), releaseRunId: uuidSchema }).strict(),
    z.object({ mode: z.literal('artifact_download'), artifactId: uuidSchema }).strict(),
  ]),
);

export type LcaReleaseResultsRequest = z.infer<typeof lcaReleaseResultsRequestSchema>;
type ResultsRepository = Pick<
  LcaReleaseCommandRepository,
  'getRun' | 'getCurrent' | 'getCurrentProcess' | 'createArtifactDownload'
>;

export type LcaReleaseResultsHandlerOptions = {
  serviceSupabase?: SupabaseClient;
  resultQuery?: ResultQueryOptions;
  publicRepository?: ResultsRepository;
  repositoryForActor?: (supabase: SupabaseClient) => ResultsRepository;
  resolveActor?: (req: Request) => Promise<ActorContextResult>;
  publishableApiKey?: string;
};

function parseQuery(req: Request): Record<string, string> {
  return Object.fromEntries(new URL(req.url).searchParams.entries());
}

async function readRequestPayload(req: Request) {
  if (req.method === 'GET') return { ok: true as const, value: parseQuery(req) };
  try {
    const bytes = await readResultQueryBytes(req.body, 64 * 1024);
    return {
      ok: true as const,
      value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    };
  } catch {
    return {
      ok: false as const,
      response: commandError('INVALID_PAYLOAD', 'Invalid or oversized request body', 400),
    };
  }
}

async function resolveRepository(
  req: Request,
  options: LcaReleaseResultsHandlerOptions,
): Promise<{ ok: true; value: ResultsRepository } | { ok: false; response: Response }> {
  const authorization = req.headers.get('Authorization');
  const bearerToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const usesProjectCredential =
    bearerToken !== undefined &&
    isSupabasePublishableApiKey(bearerToken, options.publishableApiKey);

  if (authorization && !usesProjectCredential) {
    const actor = await (options.resolveActor ?? resolveActorContext)(req);
    if (!actor.ok) {
      return actor;
    }
    return {
      ok: true,
      value:
        options.repositoryForActor?.(actor.value.supabase) ??
        createLcaReleaseCommandRepository(
          actor.value.supabase,
          options.serviceSupabase ?? createSupabaseServiceClient(),
        ),
    };
  }

  return {
    ok: true,
    value:
      options.publicRepository ??
      createPublicLcaReleaseRepository(options.serviceSupabase ?? createSupabaseServiceClient()),
  };
}

export function createLcaReleaseResultsHandler(options: LcaReleaseResultsHandlerOptions = {}) {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: corsHeaders });
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
      return commandError('METHOD_NOT_ALLOWED', 'Only GET and POST are supported', 405);
    }

    const payload = await readRequestPayload(req);
    if (!payload.ok) {
      return payload.response;
    }
    const parsed = lcaReleaseResultsRequestSchema.safeParse(payload.value);
    if (!parsed.success) {
      return commandError(
        'INVALID_PAYLOAD',
        'Invalid LCA release result lookup payload',
        400,
        parsed.error.flatten(),
      );
    }

    if (parsed.data.mode === 'query') {
      const actor = await (options.resolveActor ?? resolveActorContext)(req);
      if (!actor.ok) return actor.response;
      const response = await queryPublishedResult(
        parsed.data,
        actor.value.supabase,
        options.serviceSupabase ?? createSupabaseServiceClient(),
        req.signal,
        options.resultQuery,
      );
      response.headers.set('Cache-Control', 'no-store');
      return response;
    }

    const resolved = await resolveRepository(req, options);
    if (!resolved.ok) {
      return resolved.response;
    }

    const result =
      parsed.data.mode === 'current'
        ? await resolved.value.getCurrent()
        : parsed.data.mode === 'process'
          ? await resolved.value.getCurrentProcess(
              parsed.data.processId,
              parsed.data.processVersion,
            )
          : parsed.data.mode === 'release'
            ? await resolved.value.getRun(parsed.data.releaseRunId)
            : await resolved.value.createArtifactDownload(parsed.data.artifactId);

    if (!result.ok) {
      return commandError(result.code, result.message, result.status, result.details);
    }
    return json({ ok: true, mode: parsed.data.mode, data: result.data });
  };
}

export const handleLcaReleaseResults = createLcaReleaseResultsHandler();

if (import.meta.main) {
  Deno.serve(handleLcaReleaseResults);
}
