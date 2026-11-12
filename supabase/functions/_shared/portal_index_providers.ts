import { readPortalBoundedStream } from './portal_public_transport.ts';

export const portalIndexOrigin = 'https://www.tiangong.earth';
export const portalIndexLocales = ['zh-CN', 'en', 'de', 'fr'] as const;

export type PortalIndexFetch = (
  url: string,
  init: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    redirect: 'error';
    signal: AbortSignal;
  },
) => Promise<Response>;

export type PortalIndexKey = {
  kind: 'process' | 'flow';
  id: string;
  version: string;
};
export type PortalIndexTarget = PortalIndexKey & {
  operation: 'upsert' | 'withdrawal';
  locale: (typeof portalIndexLocales)[number];
};

export type PortalIndexProvider =
  { name: 'indexnow'; key: string } | { name: 'baidu'; token: string; transport: 'https' | 'http' };

export type PortalIndexReceipt =
  | {
      outcome: 'accepted';
      reason:
        | 'indexnow_accepted'
        | 'indexnow_validation_pending'
        | 'baidu_accepted'
        | 'baidu_accepted_quota_exhausted';
      accepted: PortalIndexTarget[];
      retryAfterSeconds?: number;
    }
  | {
      outcome: 'retry';
      reason:
        | 'provider_rate_limited'
        | 'provider_temporary_failure'
        | 'provider_timeout'
        | 'provider_response_unconfirmed'
        | 'provider_quota_exhausted';
      retryAfterSeconds?: number;
    }
  | {
      outcome: 'blocked';
      reason:
        | 'provider_invalid_request'
        | 'provider_auth_failed'
        | 'provider_endpoint_invalid'
        | 'baidu_success_unattributed'
        | 'baidu_success_unattributed_quota_exhausted'
        | 'provider_rejected_urls'
        | 'provider_rejected_urls_quota_exhausted';
      accepted?: PortalIndexTarget[];
      retryAfterSeconds?: number;
    }
  | { outcome: 'skipped'; reason: 'no_current_urls' | 'withdrawal_unsupported' };

const indexNowEndpoint = 'https://api.indexnow.org/indexnow';
const baiduHost = 'data.zz.baidu.com';
const maximumResponseBytes = 16 * 1024;
const minimumRetrySeconds = 60;
const maximumRetrySeconds = 86_400;

export function portalIndexTargetUrl(target: PortalIndexTarget): string {
  return `${portalIndexOrigin}/${target.locale}/${target.kind}/${target.id}@${target.version}`;
}

function retryAfterSeconds(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = /^\d{1,10}$/u.test(value)
    ? Number(value)
    : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  if (!Number.isSafeInteger(seconds)) return undefined;
  return Math.min(maximumRetrySeconds, Math.max(minimumRetrySeconds, seconds));
}

function transientResponse(response: Response): PortalIndexReceipt | undefined {
  if (response.status === 429) {
    return {
      outcome: 'retry',
      reason: 'provider_rate_limited',
      retryAfterSeconds: retryAfterSeconds(response) ?? minimumRetrySeconds,
    };
  }
  if (response.status === 408 || response.status >= 500) {
    return {
      outcome: 'retry',
      reason: 'provider_temporary_failure',
      retryAfterSeconds: retryAfterSeconds(response),
    };
  }
}

function indexNowReceipt(response: Response, accepted: PortalIndexTarget[]): PortalIndexReceipt {
  const retry = transientResponse(response);
  if (retry) return retry;
  switch (response.status) {
    case 200:
      return { outcome: 'accepted', reason: 'indexnow_accepted', accepted };
    case 202:
      return { outcome: 'accepted', reason: 'indexnow_validation_pending', accepted };
    case 401:
    case 403:
      return { outcome: 'blocked', reason: 'provider_auth_failed' };
    case 400:
    case 422:
      return { outcome: 'blocked', reason: 'provider_invalid_request' };
    default:
      return { outcome: 'blocked', reason: 'provider_endpoint_invalid' };
  }
}

async function readBaiduJson(response: Response): Promise<Record<string, unknown> | null> {
  const bytes = await readPortalBoundedStream(response.body, maximumResponseBytes);
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

const unconfirmed = { outcome: 'retry', reason: 'provider_response_unconfirmed' } as const;

async function baiduReceipt(
  response: Response,
  targetsByUrl: ReadonlyMap<string, PortalIndexTarget>,
): Promise<PortalIndexReceipt> {
  const retry = transientResponse(response);
  if (retry) return retry;
  if (response.status === 401 || response.status === 403) {
    return { outcome: 'blocked', reason: 'provider_auth_failed' };
  }
  if (response.status !== 200 && response.status !== 400) {
    return { outcome: 'blocked', reason: 'provider_endpoint_invalid' };
  }

  let body: Record<string, unknown> | null;
  try {
    body = await readBaiduJson(response);
  } catch (_error) {
    return unconfirmed;
  }
  if (!body) return unconfirmed;
  if (response.status === 400) {
    if (body.error === 400 && body.message === 'over quota') {
      return {
        outcome: 'retry',
        reason: 'provider_quota_exhausted',
        retryAfterSeconds: retryAfterSeconds(response) ?? maximumRetrySeconds,
      };
    }
    return { outcome: 'blocked', reason: 'provider_invalid_request' };
  }

  const rejected = new Set<string>();
  for (const field of ['not_same_site', 'not_valid']) {
    const urls = body[field];
    if (urls === undefined) continue;
    if (!Array.isArray(urls)) return unconfirmed;
    for (const url of urls) {
      if (typeof url !== 'string' || !targetsByUrl.has(url) || rejected.has(url))
        return unconfirmed;
      rejected.add(url);
    }
  }
  const eligibleCount = targetsByUrl.size - rejected.size;
  if (
    body.error !== undefined ||
    typeof body.success !== 'number' ||
    !Number.isSafeInteger(body.success) ||
    body.success < 0 ||
    body.success > eligibleCount ||
    typeof body.remain !== 'number' ||
    !Number.isSafeInteger(body.remain) ||
    body.remain < 0
  ) {
    return unconfirmed;
  }
  const quotaDelay = retryAfterSeconds(response) ?? maximumRetrySeconds;
  if (body.success < eligibleCount) {
    // Baidu omits repeats from its success count without identifying the URLs it counted.
    return body.remain === 0
      ? {
          outcome: 'blocked',
          reason: 'baidu_success_unattributed_quota_exhausted',
          retryAfterSeconds: quotaDelay,
        }
      : { outcome: 'blocked', reason: 'baidu_success_unattributed' };
  }
  const accepted = [...targetsByUrl]
    .filter(([url]) => !rejected.has(url))
    .map(([, target]) => target);
  if (rejected.size > 0) {
    return body.remain === 0
      ? {
          outcome: 'blocked',
          reason: 'provider_rejected_urls_quota_exhausted',
          accepted,
          retryAfterSeconds: quotaDelay,
        }
      : { outcome: 'blocked', reason: 'provider_rejected_urls', accepted };
  }
  if (body.remain === 0) {
    return {
      outcome: 'accepted',
      reason: 'baidu_accepted_quota_exhausted',
      accepted,
      retryAfterSeconds: quotaDelay,
    };
  }
  return { outcome: 'accepted', reason: 'baidu_accepted', accepted };
}

export async function submitPortalIndexTargets(
  provider: PortalIndexProvider,
  targets: PortalIndexTarget[],
  signal: AbortSignal,
  send: PortalIndexFetch = fetch,
): Promise<PortalIndexReceipt> {
  const targetsByUrl = new Map<string, PortalIndexTarget>();
  for (const target of targets) {
    if (provider.name === 'baidu' && target.operation === 'withdrawal') continue;
    targetsByUrl.set(portalIndexTargetUrl(target), target);
  }
  if (targetsByUrl.size === 0) {
    return {
      outcome: 'skipped',
      reason: targets.length === 0 ? 'no_current_urls' : 'withdrawal_unsupported',
    };
  }

  let endpoint: string;
  let body: string;
  let contentType: string;
  const urls = [...targetsByUrl.keys()];
  if (provider.name === 'indexnow') {
    const host = new URL(portalIndexOrigin).hostname;
    endpoint = indexNowEndpoint;
    contentType = 'application/json; charset=utf-8';
    body = JSON.stringify({
      host,
      key: provider.key,
      keyLocation: `${portalIndexOrigin}/${provider.key}.txt`,
      urlList: urls,
    });
  } else {
    const url = new URL(`${provider.transport}://${baiduHost}/urls`);
    url.searchParams.set('site', new URL(portalIndexOrigin).hostname);
    url.searchParams.set('token', provider.token);
    endpoint = url.toString();
    contentType = 'text/plain; charset=utf-8';
    body = urls.join('\n');
  }

  let response: Response | undefined;
  try {
    signal.throwIfAborted();
    response = await send(endpoint, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
      redirect: 'error',
      signal,
    });
    signal.throwIfAborted();
    const receipt =
      provider.name === 'indexnow'
        ? indexNowReceipt(response, [...targetsByUrl.values()])
        : await baiduReceipt(response, targetsByUrl);
    signal.throwIfAborted();
    return receipt;
  } catch (_error) {
    return {
      outcome: 'retry',
      reason: signal.aborted ? 'provider_timeout' : 'provider_temporary_failure',
    };
  } finally {
    if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
  }
}
