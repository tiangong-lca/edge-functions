import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { z } from 'zod';
import { commandError, json } from './command_runtime/http.ts';

const encoder = new TextEncoder();
const version = z.string().regex(/^\d{2}\.\d{2}\.\d{3}$/);
const identity = z.object({ id: z.string().uuid(), version }).strict();
export const resultQuerySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('overview') }).strict(),
  z.object({ kind: z.literal('lcia') }).strict(),
  z
    .object({
      kind: z.literal('lci'),
      limit: z.number().int().min(1).max(1000),
      cursor: z.string().max(4096).nullable().optional(),
      filter: z
        .string()
        .refine((value) => encoder.encode(value).length <= 256)
        .nullable()
        .optional(),
    })
    .strict(),
]);
export const publishedQueryRequestSchema = z
  .object({
    mode: z.literal('query'),
    processId: z.string().uuid(),
    processVersion: version,
    publicationId: z.string().uuid().optional(),
    query: resultQuerySchema,
  })
  .strict();
export type PublishedQueryRequest = z.infer<typeof publishedQueryRequestSchema>;
const artifactSchema = z
  .object({
    schemaVersion: z.literal('tiangong.query-artifact.v1'),
    artifactId: z.string().uuid(),
    manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
    manifestByteSize: z
      .number()
      .int()
      .min(1)
      .max(1024 * 1024),
  })
  .strict();
const descriptorSchema = z
  .object({
    publicationId: z.string().uuid(),
    releaseRunId: z.string().uuid(),
    releaseVersion: version,
    publishedAt: z.string(),
    artifact: artifactSchema,
    process: identity,
    lciAvailable: z.boolean(),
    lciaAvailable: z.boolean(),
  })
  .strict();
type Descriptor = z.infer<typeof descriptorSchema>;
const processSchema = identity
  .extend({ ordinal: z.number().int().nonnegative(), quantitativeReference: z.unknown() })
  .strict();
const impactSchema = identity
  .extend({
    ordinal: z.number().int().nonnegative(),
    key: z.string(),
    name: z.string(),
    unit: z.string(),
  })
  .strict();
const inventorySchema = z
  .object({
    ordinal: z.number().int().nonnegative(),
    key: z
      .object({
        flowId: z.string().uuid(),
        flowVersion: version,
        direction: z.enum(['Input', 'Output']),
        unit: z.string(),
        location: z.string().nullable(),
      })
      .strict(),
    name: z.unknown(),
    classification: z.unknown(),
  })
  .strict();

export async function readResultQueryBytes(
  stream: ReadableStream<Uint8Array> | null,
  maximum: number,
): Promise<Uint8Array> {
  if (!stream) throw new Error('missing body');
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) throw new Error('body limit');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export async function signResultQuery(
  secret: string,
  timestamp: string,
  body: string,
): Promise<string> {
  if (encoder.encode(secret).length < 32) throw new Error('invalid service configuration');
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${body}`));
  return Array.from(new Uint8Array(signature), (value) => value.toString(16).padStart(2, '0')).join(
    '',
  );
}

export type ResultQueryOptions = {
  serviceUrl?: string;
  secret?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

function serviceEndpoint(value: string): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['', '/'].includes(url.pathname) ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  ) {
    throw new Error('invalid service configuration');
  }
  url.pathname = '/internal/results/query';
  return url;
}
function unavailable(status = 503): Response {
  return commandError(
    'RESULT_QUERY_UNAVAILABLE',
    'Published results are temporarily unavailable',
    status,
  );
}
function projectData(
  value: unknown,
  kind: PublishedQueryRequest['query']['kind'],
  expected: Descriptor,
): unknown {
  const envelope = z
    .object({
      schemaVersion: z.literal('result.query.response.v1'),
      publicationId: z.string(),
      artifactId: z.string(),
      source: identity,
      data: z.unknown(),
    })
    .strict()
    .parse(value);
  if (
    envelope.publicationId !== expected.publicationId ||
    envelope.artifactId !== expected.artifact.artifactId ||
    envelope.source.id !== expected.process.id ||
    envelope.source.version !== expected.process.version
  )
    throw new Error('response identity mismatch');
  let data: Record<string, unknown>;
  if (kind === 'overview') {
    data = z
      .object({ process: processSchema, lciAvailable: z.boolean(), lciaAvailable: z.boolean() })
      .strict()
      .parse(envelope.data);
  } else if (kind === 'lcia') {
    const parsed = z
      .object({
        process: processSchema,
        impacts: z.array(z.tuple([impactSchema, z.number().finite()])).max(4096),
      })
      .strict()
      .parse(envelope.data);
    data = {
      process: parsed.process,
      impacts: parsed.impacts.map(([impact, amount]) => ({
        method: {
          id: impact.id,
          version: impact.version,
          key: impact.key,
          name: impact.name,
          unit: impact.unit,
        },
        amount,
      })),
    };
  } else {
    const parsed = z
      .object({
        process: processSchema,
        items: z
          .array(z.object({ item: inventorySchema, amount: z.number().finite() }).strict())
          .max(1000),
        nextCursor: z.string().max(4096).nullable(),
        nonzeroCount: z.number().int().nonnegative(),
      })
      .strict()
      .parse(envelope.data);
    data = {
      process: parsed.process,
      items: parsed.items.map(({ item, amount }) => ({
        key: item.key,
        name: item.name,
        classification: item.classification,
        amount,
      })),
      nextCursor: parsed.nextCursor,
      nonzeroCount: parsed.nonzeroCount,
    };
  }
  const process = processSchema.parse(data.process);
  if (process.id !== expected.process.id || process.version !== expected.process.version)
    throw new Error('response source mismatch');
  data.process = {
    id: process.id,
    version: process.version,
    quantitativeReference: process.quantitativeReference,
  };
  return {
    schemaVersion: envelope.schemaVersion,
    publicationId: expected.publicationId,
    artifactId: expected.artifact.artifactId,
    source: expected.process,
    publication: {
      releaseRunId: expected.releaseRunId,
      releaseVersion: expected.releaseVersion,
      publishedAt: expected.publishedAt,
    },
    data,
  };
}

let active = 0;
/** Actor RLS and publication lookup are deliberately repeated before every cache read. */
export async function queryPublishedResult(
  request: PublishedQueryRequest,
  actor: SupabaseClient,
  service: SupabaseClient,
  signal: AbortSignal,
  options: ResultQueryOptions = {},
): Promise<Response> {
  if (active >= 8) return unavailable(429);
  active++;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(abort, Math.min(Math.max(options.timeoutMs ?? 8000, 1), 8000));
  try {
    const visible = await actor
      .schema('public')
      .from('processes')
      .select('id,version')
      .eq('id', request.processId)
      .eq('version', request.processVersion)
      .neq('state_code', 120)
      .abortSignal(controller.signal)
      .maybeSingle();
    if (visible.error) return unavailable();
    if (!visible.data)
      return commandError('RESULT_NOT_AVAILABLE', 'Published result is not available', 404);
    const resolved = await service
      .rpc('svc_result_query_resolve', {
        p_process_id: request.processId,
        p_process_version: request.processVersion,
        p_publication_id: request.publicationId ?? null,
      })
      .abortSignal(controller.signal);
    if (resolved.error) return unavailable();
    if (resolved.data?.ok !== true)
      return commandError('RESULT_NOT_AVAILABLE', 'Published result is not available', 404);
    const descriptor = descriptorSchema.parse(resolved.data.data);
    if (
      descriptor.process.id !== request.processId ||
      descriptor.process.version !== request.processVersion ||
      (request.publicationId && descriptor.publicationId !== request.publicationId)
    )
      throw new Error('descriptor identity mismatch');
    const body = JSON.stringify({
      schemaVersion: 'result.query.request.v1',
      publicationId: descriptor.publicationId,
      artifact: descriptor.artifact,
      process: descriptor.process,
      query: request.query,
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await signResultQuery(
      options.secret ?? Deno.env.get('RESULT_QUERY_SERVICE_SECRET') ?? '',
      timestamp,
      body,
    );
    const response = await (options.fetch ?? fetch)(
      serviceEndpoint(options.serviceUrl ?? Deno.env.get('RESULT_QUERY_SERVICE_URL') ?? ''),
      {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-query-timestamp': timestamp,
          'x-query-signature': signature,
        },
        body,
      },
    );
    if (![200, 202].includes(response.status)) {
      await response.body?.cancel();
      return unavailable(response.status === 429 ? 429 : 503);
    }
    const bytes = await readResultQueryBytes(response.body, 2 * 1024 * 1024);
    if (controller.signal.aborted) throw new Error('query deadline');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (response.status === 202) {
      const pending = z
        .object({
          schemaVersion: z.literal('result.query.response.v1'),
          status: z.literal('preparing'),
          artifactId: z.string(),
          publicationId: z.string(),
        })
        .strict()
        .parse(value);
      if (
        pending.artifactId !== descriptor.artifact.artifactId ||
        pending.publicationId !== descriptor.publicationId
      )
        throw new Error('pending identity mismatch');
      const output = json(
        { ok: true, mode: 'query', data: { ...pending, source: descriptor.process } },
        202,
      );
      output.headers.set('Retry-After', '2');
      return output;
    }
    return json({
      ok: true,
      mode: 'query',
      data: projectData(value, request.query.kind, descriptor),
    });
  } catch {
    return unavailable();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    active--;
  }
}
