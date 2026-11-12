import '@supabase/functions-js/edge-runtime.d.ts';
import { z } from 'zod';
import { portalAllowedBrandCodesSchema } from '../_shared/portal_brand_scope.ts';
import { constantTimeEqual, decodeCanonicalBase64Url } from '../_shared/portal_hmac.ts';
import {
  portalIndexLocales,
  portalIndexOrigin,
  portalIndexTargetUrl,
  type PortalIndexFetch,
  type PortalIndexProvider,
  type PortalIndexTarget,
  submitPortalIndexTargets,
} from '../_shared/portal_index_providers.ts';
import {
  readPortalBoundedStream,
  validatePortalSupabaseUrl,
} from '../_shared/portal_public_transport.ts';

const functionName = 'dispatch_portal_index_notifications';
const allowedPaths = new Set([`/${functionName}`, `/functions/v1/${functionName}`]);
const feedPaths = new Set([...allowedPaths].map((path) => `${path}/baidu-withdrawals.txt`));
const schedulerHeader = 'x-portal-index-dispatch-secret';
const feedHeader = 'x-portal-index-feed-secret';
const schedulerSecretName = 'PORTAL_INDEX_DISPATCH_SECRET';
const feedSecretName = 'PORTAL_INDEX_FEED_SECRET';
const withdrawalEnabledName = 'PORTAL_INDEX_BAIDU_WITHDRAWALS_ENABLED';
const batchLimit = 2;
const rpcTimeoutMs = 4_000;
const providerTimeoutMs = 6_000;
const invocationTimeoutMs = 35_000;
const maxRpcResponseBytes = 32 * 1024;
const maxFeedRpcBytes = 10_000_000;
const feedRpcTimeoutMs = 12_000;
const maxFeedTargets = 50_000;
const maxFeedBytes = 5 * 1024 * 1024;

type Environment = Pick<typeof Deno.env, 'get'>;
type Provider = PortalIndexProvider | { name: 'baidu_withdrawal' };
type ProviderName = Provider['name'];
type RpcName =
  | 'svc_portal_index_claim_v1'
  | 'svc_portal_index_recheck_v1'
  | 'svc_portal_index_settle_v1'
  | 'svc_portal_index_withdrawal_feed_v1';
type DispatcherDependencies = { env?: Environment; send?: PortalIndexFetch };

const uuidSchema = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
const keySchema = z.strictObject({
  kind: z.enum(['process', 'flow']),
  id: uuidSchema,
  version: z.string().regex(/^\d{2}\.\d{2}\.\d{3}$/u),
});
const targetSchema = keySchema.extend({
  operation: z.enum(['upsert', 'withdrawal']),
  locale: z.enum(portalIndexLocales),
});
const feedKeySchema = keySchema.extend({ locale: z.enum(portalIndexLocales) });
const eventSchema = z.strictObject({
  eventId: z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/u)
    .refine((value) => value.length < 19 || value <= '9223372036854775807'),
  leaseToken: uuidSchema,
  attempt: z.number().int().positive(),
  upserts: z.array(keySchema).max(1),
  withdrawals: z.array(keySchema).max(1),
  accepted: z.array(targetSchema).max(8),
});
type Event = z.infer<typeof eventSchema>;

function readSchedulerSecret(value: string | null | undefined): Uint8Array | null {
  if (value?.length !== 43) return null;
  const decoded = decodeCanonicalBase64Url(value);
  return decoded?.length === 32 ? decoded : null;
}

function readDatabaseConfig(env: Environment) {
  const configuredUrl = env.get('SUPABASE_URL');
  const name = env.get('PORTAL_INDEX_DB_SECRET_NAME');
  if (
    !configuredUrl ||
    configuredUrl !== configuredUrl.trim() ||
    !name ||
    !/^[a-z0-9_-]{1,64}$/u.test(name)
  ) {
    throw new Error('database_config_invalid');
  }
  const origin = validatePortalSupabaseUrl(configuredUrl);
  const registry: unknown = JSON.parse(env.get('SUPABASE_SECRET_KEYS') ?? 'null');
  const key =
    registry &&
    typeof registry === 'object' &&
    !Array.isArray(registry) &&
    Object.hasOwn(registry, name)
      ? (registry as Record<string, unknown>)[name]
      : undefined;
  if (typeof key !== 'string' || !/^sb_secret_[A-Za-z0-9_-]{8,256}$/u.test(key)) {
    throw new Error('database_config_invalid');
  }
  return { origin, key };
}

function readProvider(env: Environment, name: ProviderName): Provider | null {
  if (name === 'baidu_withdrawal') {
    return env.get(withdrawalEnabledName) === 'true' ? { name } : null;
  }
  if (name === 'indexnow') {
    if (env.get('PORTAL_INDEX_INDEXNOW_ENABLED') !== 'true') return null;
    const key = env.get('PORTAL_INDEX_INDEXNOW_KEY');
    if (!key || !/^[A-Za-z0-9-]{8,128}$/u.test(key)) throw new Error('provider_config_invalid');
    return { name, key };
  }
  if (env.get('PORTAL_INDEX_BAIDU_ENABLED') !== 'true') return null;
  const transport = env.get('PORTAL_INDEX_BAIDU_TRANSPORT');
  const token = env.get('PORTAL_INDEX_BAIDU_TOKEN');
  const allowHttp = env.get('PORTAL_INDEX_BAIDU_ALLOW_HTTP') === 'true';
  if (
    !token ||
    !/^[A-Za-z0-9]{16}$/u.test(token) ||
    (transport !== 'https' && !(transport === 'http' && allowHttp))
  ) {
    throw new Error('provider_config_invalid');
  }
  return { name, token, transport };
}

function targetIdentity(target: PortalIndexTarget): string {
  return `${target.operation}:${target.kind}:${target.id}:${target.version}:${target.locale}`;
}

function pendingTargets(event: Event): PortalIndexTarget[] {
  const accepted = new Set(event.accepted.map(targetIdentity));
  return [
    ...event.upserts.flatMap((key) =>
      portalIndexLocales.map((locale) => ({
        ...key,
        operation: 'upsert' as const,
        locale,
      })),
    ),
    ...event.withdrawals.flatMap((key) =>
      portalIndexLocales.map((locale) => ({
        ...key,
        operation: 'withdrawal' as const,
        locale,
      })),
    ),
  ].filter((target) => !accepted.has(targetIdentity(target)));
}

async function withinTimeout<T>(
  parent: AbortSignal,
  milliseconds: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), milliseconds);
  const signal = AbortSignal.any([parent, controller.signal]);
  try {
    signal.throwIfAborted();
    return await operation(signal);
  } finally {
    clearTimeout(timeout);
  }
}

function createRpc(
  database: ReturnType<typeof readDatabaseConfig>,
  send: PortalIndexFetch,
  parent: AbortSignal,
) {
  return (name: RpcName, args: Record<string, unknown>) => {
    const isFeed = name === 'svc_portal_index_withdrawal_feed_v1';
    return withinTimeout(
      parent,
      isFeed ? feedRpcTimeoutMs : rpcTimeoutMs,
      async (signal): Promise<unknown> => {
        const response = await send(`${database.origin}/rest/v1/rpc/${name}`, {
          method: 'POST',
          headers: {
            apikey: database.key,
            'Content-Type': 'application/json',
            'Content-Profile': 'api',
            Accept: 'application/json',
          },
          redirect: 'error',
          body: JSON.stringify(args),
          signal,
        });
        if (!response.ok) {
          if (response.body) await response.body.cancel().catch(() => {});
          throw new Error('database_rpc_failed');
        }
        const bytes = await readPortalBoundedStream(
          response.body,
          isFeed ? maxFeedRpcBytes : maxRpcResponseBytes,
        );
        signal.throwIfAborted();
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
      },
    );
  };
}

async function verifyWithdrawals(
  targets: PortalIndexTarget[],
  signal: AbortSignal,
  send: PortalIndexFetch,
) {
  if (targets.some(({ operation }) => operation !== 'withdrawal')) {
    throw new Error('database_contract_invalid');
  }
  if (targets.length === 0) return { outcome: 'skipped', reason: 'no_current_urls' } as const;

  const proofs = await Promise.all(
    targets.map(async (target) => {
      try {
        signal.throwIfAborted();
        const response = await send(portalIndexTargetUrl(target), {
          method: 'GET',
          headers: { 'cache-control': 'no-cache' },
          redirect: 'error',
          signal,
        });
        if (response.body) await response.body.cancel().catch(() => {});
        signal.throwIfAborted();
        return response.status === 404 ? target : null;
      } catch (_error) {
        return null;
      }
    }),
  );
  const accepted = proofs.filter((proof) => proof !== null);
  if (accepted.length !== targets.length) {
    return {
      outcome: 'retry',
      reason: 'withdrawal_http_unconfirmed',
      retryAfterSeconds: 300,
      accepted,
    } as const;
  }
  return { outcome: 'manifest_ready', reason: 'manual_registration_pending', accepted } as const;
}

async function dispatchProvider(
  provider: Provider,
  allowedBrands: string[],
  rpc: ReturnType<typeof createRpc>,
  send: PortalIndexFetch,
  parent: AbortSignal,
) {
  const counts = { accepted: 0, retry: 0, blocked: 0, skipped: 0, manifest_ready: 0, stale: 0 };
  const events = z
    .array(eventSchema)
    .max(batchLimit)
    .parse(
      await rpc('svc_portal_index_claim_v1', {
        p_provider: provider.name,
        p_origin: portalIndexOrigin,
        p_allowed_brands: allowedBrands,
        p_limit: batchLimit,
      }),
    );

  for (const claimed of events) {
    const identity = {
      p_provider: provider.name,
      p_event_id: claimed.eventId,
      p_lease_token: claimed.leaseToken,
    };
    const event = eventSchema.nullable().parse(await rpc('svc_portal_index_recheck_v1', identity));
    if (!event) {
      counts.stale++;
      continue;
    }
    if (event.eventId !== claimed.eventId || event.leaseToken !== claimed.leaseToken) {
      throw new Error('database_contract_invalid');
    }
    const targets = pendingTargets(event);
    const receipt = await withinTimeout(parent, providerTimeoutMs, async (signal) =>
      provider.name === 'baidu_withdrawal'
        ? verifyWithdrawals(targets, signal, send)
        : submitPortalIndexTargets(provider, targets, signal, send),
    );
    const retryDelay = 'retryAfterSeconds' in receipt ? receipt.retryAfterSeconds : undefined;
    const settled = z.boolean().parse(
      await rpc('svc_portal_index_settle_v1', {
        ...identity,
        p_outcome: receipt.outcome,
        p_reason: receipt.reason,
        p_retry_after_seconds:
          retryDelay ??
          (receipt.outcome === 'retry'
            ? Math.min(3_600, 60 * 2 ** Math.min(event.attempt - 1, 6))
            : null),
        p_accepted: 'accepted' in receipt ? (receipt.accepted ?? []) : [],
      }),
    );
    if (settled) counts[receipt.outcome]++;
    else counts.stale++;
    if (
      receipt.reason === 'provider_rate_limited' ||
      receipt.reason === 'provider_quota_exhausted' ||
      receipt.reason === 'baidu_accepted_quota_exhausted' ||
      receipt.reason === 'baidu_success_unattributed_quota_exhausted' ||
      receipt.reason === 'provider_rejected_urls_quota_exhausted'
    )
      break;
  }
  return counts;
}

function json(body: object, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

async function readWithdrawalFeed(
  allowedBrands: string[],
  rpc: ReturnType<typeof createRpc>,
): Promise<Response> {
  const keys = z
    .array(feedKeySchema)
    .max(maxFeedTargets)
    .parse(
      await rpc('svc_portal_index_withdrawal_feed_v1', {
        p_origin: portalIndexOrigin,
        p_allowed_brands: allowedBrands,
      }),
    );
  const urls = keys.map((key) => portalIndexTargetUrl({ ...key, operation: 'withdrawal' }));
  if (new Set(urls).size !== urls.length) throw new Error('database_contract_invalid');
  const body = urls.length > 0 ? urls.join('\n') + '\n' : '';
  if (new TextEncoder().encode(body).length >= maxFeedBytes) throw new Error('feed_too_large');
  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
      'x-portal-index-feed-version': '1',
      'x-portal-index-origin': portalIndexOrigin,
      'x-portal-index-brands': allowedBrands.join(','),
    },
  });
}

export function createPortalIndexDispatchHandler({
  env = Deno.env,
  send = fetch,
}: DispatcherDependencies = {}) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const feed = feedPaths.has(url.pathname);
    if (
      (!feed && !allowedPaths.has(url.pathname)) ||
      url.href.includes('?') ||
      url.href.includes('#')
    ) {
      return json({ status: 'not_found' }, 404);
    }
    if (request.method !== (feed ? 'GET' : 'POST')) {
      return json({ status: 'method_not_allowed' }, 405);
    }
    try {
      const enabledName = feed ? withdrawalEnabledName : 'PORTAL_INDEX_DISPATCH_ENABLED';
      if (env.get(enabledName) !== 'true') return json({ status: 'disabled' }, 503);
      const header = feed ? feedHeader : schedulerHeader;
      const otherHeader = feed ? schedulerHeader : feedHeader;
      const expectedSecret = readSchedulerSecret(
        env.get(feed ? feedSecretName : schedulerSecretName),
      );
      const otherSecret = readSchedulerSecret(env.get(feed ? schedulerSecretName : feedSecretName));
      const providedSecret = readSchedulerSecret(request.headers.get(header));
      if (!expectedSecret || (otherSecret && constantTimeEqual(expectedSecret, otherSecret))) {
        return json({ status: 'credential_unavailable' }, 503);
      }
      if (
        !providedSecret ||
        !constantTimeEqual(providedSecret, expectedSecret) ||
        request.headers.has(otherHeader) ||
        request.headers.has('authorization') ||
        request.headers.has('cookie')
      ) {
        return json({ status: 'unauthorized' }, 401);
      }
      // The scheduler sends an empty object. Caller input cannot select work or destinations.
      const names = ['indexnow', 'baidu', 'baidu_withdrawal'] as const;
      const allowedBrands = portalAllowedBrandCodesSchema.parse(
        env.get('PORTAL_INDEX_ALLOWED_BRANDS')?.split(','),
      );
      const database = readDatabaseConfig(env);
      return await withinTimeout(request.signal, invocationTimeoutMs, async (signal) => {
        const rpc = createRpc(database, send, signal);
        if (feed) return await readWithdrawalFeed(allowedBrands, rpc);
        const providers = await Promise.all(
          names.map(async (name) => {
            let provider: Provider | null;
            try {
              provider = readProvider(env, name);
            } catch (_error) {
              return { name, status: 'configuration_invalid' };
            }
            if (!provider) return { name, status: 'disabled' };
            try {
              return {
                name,
                status: 'complete',
                ...(await dispatchProvider(provider, allowedBrands, rpc, send, signal)),
              };
            } catch (_error) {
              return { name, status: 'dispatch_failed' };
            }
          }),
        );
        const healthy = providers.every(
          ({ status }) => status === 'complete' || status === 'disabled',
        );
        return json(
          { status: healthy ? 'complete' : 'incomplete', providers },
          healthy ? 200 : 503,
        );
      });
    } catch (_error) {
      return json({ status: 'dispatcher_unavailable' }, 503);
    }
  };
}

export const handlePortalIndexDispatch = createPortalIndexDispatchHandler();

if (import.meta.main) Deno.serve(handlePortalIndexDispatch);
