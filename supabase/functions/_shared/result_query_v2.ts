import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { z } from 'zod';
import { commandError, json } from './command_runtime/http.ts';
import { readResultQueryBytes, signResultQuery, type ResultQueryOptions } from './result_query.ts';

const encoder = new TextEncoder();
const uuid = z.string().uuid();
const version = z.string().regex(/^\d{2}\.\d{2}\.\d{3}$/);
const releaseVersion = z.string().regex(/^\d{4}\.\d{2}\.\d+$/);
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const bytes = (maximum: number) => z.string().refine((v) => encoder.encode(v).length <= maximum);
const cursor = bytes(4096);
const identity = z.object({ uuid, version }).strict();
const scope = z.object({ kind: z.literal('publication'), publicationId: uuid }).strict();
const relationKind = z.enum(['direct', 'derived']);
export const finalQueryRequestSchema = z
  .object({
    mode: z.literal('final_query'),
    resultId: uuid,
    resultVersion: version,
    publicationId: uuid.optional(),
    runtimeRevision: uuid.optional(),
    query: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('overview') }).strict(),
      z.object({ kind: z.literal('lcia') }).strict(),
      z
        .object({
          kind: z.literal('lci'),
          limit: z.number().int().min(1).max(1000),
          cursor: cursor.nullable().optional(),
          filter: bytes(256).nullable().optional(),
        })
        .strict(),
    ]),
  })
  .strict()
  .refine(
    (v) =>
      v.query.kind !== 'lci' ||
      v.query.cursor == null ||
      (v.publicationId !== undefined && v.runtimeRevision !== undefined),
  );
export const sourceResultsRequestSchema = z
  .object({
    mode: z.literal('source_results'),
    sourceId: uuid,
    sourceVersion: version,
    publicationId: uuid.optional(),
    afterKey: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@\d{2}\.\d{2}\.\d{3}$/)
      .optional(),
    limit: z.number().int().min(1).max(100).default(100),
  })
  .strict()
  .refine((v) => v.afterKey === undefined || v.publicationId !== undefined);
export const finalDownloadRequestSchema = z
  .object({
    mode: z.literal('final_download'),
    publicationId: uuid.optional(),
    format: z.enum(['tidas', 'ilcd']),
  })
  .strict();
export type FinalQueryRequest = z.infer<typeof finalQueryRequestSchema>;
export type SourceResultsRequest = z.infer<typeof sourceResultsRequestSchema>;
export type FinalDownloadRequest = z.infer<typeof finalDownloadRequestSchema>;

const descriptorSchema = z
  .object({
    publicationId: uuid,
    releaseVersion,
    scope,
    artifact: z
      .object({
        schemaVersion: z.literal('tiangong.query-artifact.v2'),
        artifactId: uuid,
        manifestSha256: sha,
        manifestByteSize: z
          .number()
          .int()
          .min(1)
          .max(1024 * 1024),
      })
      .strict(),
    result: identity,
    relationKind,
    lciAvailable: z.literal(true),
    lciaAvailable: z.boolean(),
    runtimeRevision: uuid,
    readerSha256: sha,
  })
  .strict();
type Descriptor = z.infer<typeof descriptorSchema>;
const unitSchema = z
  .object({
    flowPropertyId: uuid,
    flowPropertyVersion: version,
    unitGroupId: uuid,
    unitGroupVersion: version,
    internalId: z.string(),
    name: z.string(),
  })
  .strict();
const inventoryFields = {
  flowId: uuid,
  flowVersion: version,
  flowName: z.string(),
  flowClassification: z.unknown(),
  direction: z.enum(['Input', 'Output']),
  location: z.string().nullable(),
  functionType: z.string().nullable(),
  unit: unitSchema,
};
const resultSchema = identity
  .extend({
    quantitativeReference: z
      .object({
        ...inventoryFields,
        value: z.number().finite(),
        amountField: z.literal('resultingAmount'),
      })
      .strict(),
    relationKind,
  })
  .strict();
const inventorySchema = z
  .object({ ordinal: z.number().int().nonnegative(), ...inventoryFields })
  .strict();
const impactSchema = z
  .object({
    ordinal: z.number().int().nonnegative(),
    id: uuid,
    version,
    key: z.string(),
    name: z.string(),
    unit: z.string(),
  })
  .strict();

class ResultFailure extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const failures: Record<string, [string, number, string]> = {
  auth_required: ['AUTH_REQUIRED', 401, 'Authentication required'],
  source_not_available: ['SOURCE_NOT_AVAILABLE', 404, 'Source process is not available'],
  published_result_not_available: [
    'RESULT_NOT_AVAILABLE',
    404,
    'Published result is not available',
  ],
  result_package_not_available: [
    'RESULT_PACKAGE_NOT_AVAILABLE',
    404,
    'No complete result ZIP is available',
  ],
  publication_changed: ['PUBLICATION_CHANGED', 409, 'Restart against the current publication'],
  result_query_runtime_unavailable: [
    'RESULT_QUERY_UNAVAILABLE',
    503,
    'Published results are temporarily unavailable',
  ],
};
/** Only authenticated actor clients may call this helper. Never substitute a service client. */
export async function finalResultRpc(
  actor: SupabaseClient,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await actor.schema('api').rpc(name, args).abortSignal(signal);
  if (response.error || signal.aborted) throw new Error('Result lookup failed');
  const value = response.data;
  if (value?.ok !== true) {
    const failure = failures[value?.code];
    if (failure && value.status === failure[1]) throw new ResultFailure(...failure);
    throw new Error('Result lookup failed');
  }
  return value.data;
}
let active = 0;
/** One bounded budget covers authorization, private I/O, and the final live recheck. */
export async function withFinalResultBudget(
  signal: AbortSignal,
  timeoutMs: number | undefined,
  action: (signal: AbortSignal) => Promise<Response>,
): Promise<Response> {
  if (active >= 8) {
    const response = commandError('RESULT_QUERY_UNAVAILABLE', 'Result capacity exceeded', 429);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }
  active++;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, Math.min(Math.max(timeoutMs ?? 8000, 1), 8000));
  let response: Response;
  try {
    if (controller.signal.aborted) throw new Error('Result request aborted');
    response = await action(controller.signal);
    if (controller.signal.aborted) throw new Error('Result request aborted');
  } catch (error) {
    response =
      error instanceof ResultFailure
        ? commandError(error.code, error.message, error.status)
        : commandError(
            'RESULT_QUERY_UNAVAILABLE',
            'Published results are temporarily unavailable',
            503,
          );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    active--;
  }
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
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
  )
    throw new Error('Invalid result service configuration');
  url.pathname = '/internal/results/query-v2';
  return url;
}
async function resolve(
  request: FinalQueryRequest,
  actor: SupabaseClient,
  signal: AbortSignal,
): Promise<Descriptor> {
  const value = descriptorSchema.parse(
    await finalResultRpc(
      actor,
      'qry_final_result_query_v2',
      {
        p_result_id: request.resultId,
        p_result_version: request.resultVersion,
        p_publication_id: request.publicationId ?? null,
      },
      signal,
    ),
  );
  if (
    value.result.uuid !== request.resultId ||
    value.result.version !== request.resultVersion ||
    value.scope.publicationId !== value.publicationId ||
    (request.publicationId && value.publicationId !== request.publicationId)
  )
    throw new Error('Result identity mismatch');
  if (request.runtimeRevision && value.runtimeRevision !== request.runtimeRevision)
    throw new ResultFailure(
      'RESULT_RUNTIME_CHANGED',
      409,
      'Restart against the current result reader',
    );
  return value;
}
function publicData(raw: unknown, request: FinalQueryRequest, expected: Descriptor): unknown {
  const envelope = z
    .object({
      schemaVersion: z.literal('result.query.response.v2'),
      reader: z
        .object({
          schemaVersion: z.literal('tiangong.final-result-reader.v1'),
          executableSha256: sha,
        })
        .strict(),
      scope,
      artifactId: uuid,
      result: identity,
      data: z.unknown(),
    })
    .strict()
    .parse(raw);
  if (
    envelope.scope.publicationId !== expected.publicationId ||
    envelope.artifactId !== expected.artifact.artifactId ||
    envelope.reader.executableSha256 !== expected.readerSha256 ||
    envelope.result.uuid !== request.resultId ||
    envelope.result.version !== request.resultVersion
  )
    throw new Error('Result response mismatch');
  let data;
  if (request.query.kind === 'overview') {
    data = z
      .object({ result: resultSchema, lciAvailable: z.literal(true), lciaAvailable: z.boolean() })
      .strict()
      .parse(envelope.data);
    if (data.lciaAvailable !== expected.lciaAvailable)
      throw new Error('Result capability mismatch');
  } else if (request.query.kind === 'lcia') {
    const parsed = z
      .object({
        result: resultSchema,
        impacts: z.array(z.tuple([impactSchema, z.number().finite()])).max(4096),
      })
      .strict()
      .parse(envelope.data);
    if (!expected.lciaAvailable || parsed.impacts.length === 0)
      throw new Error('Result capability mismatch');
    data = {
      result: parsed.result,
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
        result: resultSchema,
        items: z
          .array(z.object({ item: inventorySchema, amount: z.number().finite() }).strict())
          .max(request.query.limit),
        nextCursor: cursor.nullable(),
        nonzeroCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .parse(envelope.data);
    data = {
      result: parsed.result,
      items: parsed.items.map(({ item, amount }) => ({
        key: {
          flowId: item.flowId,
          flowVersion: item.flowVersion,
          direction: item.direction,
          location: item.location,
          functionType: item.functionType,
          unit: item.unit,
        },
        name: item.flowName,
        classification: item.flowClassification,
        amount,
      })),
      nextCursor: parsed.nextCursor,
      nonzeroCount: parsed.nonzeroCount,
    };
  }
  if (
    data.result.uuid !== request.resultId ||
    data.result.version !== request.resultVersion ||
    data.result.relationKind !== expected.relationKind
  )
    throw new Error('Result row mismatch');
  return data;
}
export function queryFinalResult(
  request: FinalQueryRequest,
  actor: SupabaseClient,
  signal: AbortSignal,
  options: ResultQueryOptions = {},
): Promise<Response> {
  return withFinalResultBudget(signal, options.timeoutMs, async (signal) => {
    const descriptor = await resolve(request, actor, signal);
    if (request.query.kind === 'lcia' && !descriptor.lciaAvailable)
      throw new ResultFailure('RESULT_LCIA_NOT_AVAILABLE', 404, 'This result has no LCIA');
    const body = JSON.stringify({
      schemaVersion: 'result.query.request.v2',
      scope: descriptor.scope,
      artifact: descriptor.artifact,
      result: descriptor.result,
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
        signal,
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
      if (response.status === 422)
        throw new ResultFailure(
          'RESULT_QUERY_REJECTED',
          422,
          'Result query cannot be served; restart without a cursor',
        );
      if (response.status === 429)
        throw new ResultFailure('RESULT_QUERY_UNAVAILABLE', 429, 'Result capacity exceeded');
      throw new Error('Result reader unavailable');
    }
    const raw = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        await readResultQueryBytes(response.body, 2 * 1024 * 1024),
      ),
    );
    let data: unknown;
    if (response.status === 202) {
      const pending = z
        .object({
          schemaVersion: z.literal('result.query.response.v2'),
          status: z.literal('preparing'),
          artifactId: uuid,
          scope,
        })
        .strict()
        .parse(raw);
      if (
        pending.artifactId !== descriptor.artifact.artifactId ||
        pending.scope.publicationId !== descriptor.publicationId
      )
        throw new Error('Result pending mismatch');
      data = { status: 'preparing' };
    } else data = publicData(raw, request, descriptor);
    const current = await resolve(
      {
        ...request,
        publicationId: descriptor.publicationId,
        runtimeRevision: descriptor.runtimeRevision,
      },
      actor,
      signal,
    );
    if (JSON.stringify(current) !== JSON.stringify(descriptor))
      throw new Error('Result descriptor changed');
    const output = json(
      {
        ok: true,
        mode: 'final_query',
        data: {
          schemaVersion: 'result.query.response.v2',
          publicationId: descriptor.publicationId,
          releaseVersion: descriptor.releaseVersion,
          runtimeRevision: descriptor.runtimeRevision,
          result: descriptor.result,
          data,
        },
      },
      response.status,
    );
    if (response.status === 202) output.headers.set('Retry-After', '2');
    return output;
  });
}
const sourcePageSchema = z
  .object({
    publication: z
      .object({
        publicationId: uuid,
        releaseVersion,
        format: z.enum(['final-result-pair.v2', 'legacy-four-zip.v1']),
      })
      .strict()
      .nullable(),
    results: z
      .array(
        identity
          .extend({
            relationKind: z.literal('direct'),
            lciAvailable: z.literal(true),
            lciaAvailable: z.boolean(),
          })
          .strict(),
      )
      .max(100),
    nextResultKey: sourceResultsRequestSchema.shape.afterKey.unwrap().nullable(),
  })
  .strict();
export function sourceFinalResults(
  request: SourceResultsRequest,
  actor: SupabaseClient,
  signal: AbortSignal,
  options: ResultQueryOptions = {},
): Promise<Response> {
  return withFinalResultBudget(signal, options.timeoutMs, async (signal) => {
    const data = sourcePageSchema.parse(
      await finalResultRpc(
        actor,
        'qry_source_final_results_v2',
        {
          p_source_id: request.sourceId,
          p_source_version: request.sourceVersion,
          p_after_key: request.afterKey ?? null,
          p_limit: request.limit,
          p_publication_id: request.publicationId ?? null,
        },
        signal,
      ),
    );
    if (
      (request.publicationId && data.publication?.publicationId !== request.publicationId) ||
      data.results.length > request.limit ||
      (data.publication?.format !== 'final-result-pair.v2' &&
        (data.results.length || data.nextResultKey))
    )
      throw new Error('Result selection mismatch');
    let previous = request.afterKey ?? '';
    for (const row of data.results) {
      const key = `${row.uuid}@${row.version}`;
      if (key <= previous) throw new Error('Result selection order mismatch');
      previous = key;
    }
    if (data.nextResultKey !== null && (!data.results.length || data.nextResultKey !== previous))
      throw new Error('Result selection cursor mismatch');
    return json({ ok: true, mode: 'source_results', data });
  });
}

const currentPublicationSchema = z
  .object({
    publication: z
      .object({
        publicationId: uuid,
        releaseVersion,
        format: z.literal('final-result-pair.v2'),
      })
      .strict()
      .nullable(),
  })
  .strict();

export function currentFinalPublication(
  actor: SupabaseClient,
  signal: AbortSignal,
  options: ResultQueryOptions = {},
): Promise<Response> {
  return withFinalResultBudget(signal, options.timeoutMs, async (signal) => {
    const data = currentPublicationSchema.parse(
      await finalResultRpc(actor, 'qry_current_final_result_publication', {}, signal),
    );
    return json({ ok: true, mode: 'final_current', data });
  });
}

const publicationHistoryCursor = z
  .object({ publishedAt: z.iso.datetime({ offset: true }), publicationId: uuid })
  .strict();
export const finalHistoryRequestSchema = z
  .object({
    mode: z.literal('final_history'),
    limit: z.number().int().min(1).max(50).default(20),
    before: publicationHistoryCursor.optional(),
  })
  .strict();
const publicationHistorySchema = z
  .object({
    publications: z
      .array(
        z
          .object({
            publicationId: uuid,
            releaseVersion,
            publishedAt: z.iso.datetime({ offset: true }),
            status: z.literal('superseded'),
            formats: z.array(z.enum(['tidas', 'ilcd'])).max(2),
          })
          .strict(),
      )
      .max(50),
    nextCursor: publicationHistoryCursor.nullable(),
  })
  .strict();
export function finalPublicationHistory(
  request: z.infer<typeof finalHistoryRequestSchema>,
  actor: SupabaseClient,
  signal: AbortSignal,
  options: ResultQueryOptions = {},
): Promise<Response> {
  return withFinalResultBudget(signal, options.timeoutMs, async (signal) => {
    const data = publicationHistorySchema.parse(
      await finalResultRpc(
        actor,
        'qry_final_result_publication_history',
        {
          p_limit: request.limit,
          p_before_published_at: request.before?.publishedAt ?? null,
          p_before_id: request.before?.publicationId ?? null,
        },
        signal,
      ),
    );
    if (data.publications.length > request.limit) throw new Error('Invalid publication history');
    return json({ ok: true, mode: 'final_history', data });
  });
}
