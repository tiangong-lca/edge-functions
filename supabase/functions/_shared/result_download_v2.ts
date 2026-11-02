import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { z } from 'zod';
import { json } from './command_runtime/http.ts';
import { readResultQueryBytes } from './result_query.ts';
import {
  finalResultRpc,
  withFinalResultBudget,
  type FinalDownloadRequest,
} from './result_query_v2.ts';

const sha = z.string().regex(/^[0-9a-f]{64}$/);
const descriptorSchema = z
  .object({
    publicationId: z.string().uuid(),
    candidateHash: sha,
    targetHash: sha,
    file: z
      .object({
        name: z.enum(['result.tidas.zip', 'result.ilcd.zip']),
        sha256: sha,
        byteSize: z
          .number()
          .int()
          .min(1)
          .max(32 * 1024 ** 3),
      })
      .strict(),
  })
  .strict();
export type FinalDownloadConfig = {
  signer?: 's3' | 'supabase-storage';
  signingKey?: string;
  publicApiKey?: string;
  databaseTargetHash: string;
  bucket: string;
  region: string;
  endpoint?: string | null;
  prefix?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};
export type FinalDownloadOptions = {
  config?: FinalDownloadConfig;
  timeoutMs?: number;
  fetch?: typeof fetch;
};
function configuration(): FinalDownloadConfig {
  const get = (name: string) => Deno.env.get(`FINAL_RESULT_S3_${name}`) ?? '';
  const signer = get('SIGNER') || 's3';
  if (signer !== 's3' && signer !== 'supabase-storage') throw new Error('Invalid ZIP signer');
  return {
    signer,
    signingKey: get('SIGNING_KEY') || undefined,
    publicApiKey: get('PUBLIC_API_KEY') || undefined,
    databaseTargetHash: get('DATABASE_TARGET_HASH'),
    bucket: get('BUCKET'),
    region: get('REGION'),
    endpoint: get('ENDPOINT') || null,
    prefix: get('PREFIX'),
    accessKeyId: get('ACCESS_KEY_ID'),
    secretAccessKey: get('SECRET_ACCESS_KEY'),
    sessionToken: get('SESSION_TOKEN') || undefined,
  };
}
/** Exact Release storage-target.v1 hash domain: sorted ASCII field names, no trailing LF. */
export async function finalDownloadTarget(config: FinalDownloadConfig) {
  const prefix = config.prefix ?? '';
  if (
    !sha.safeParse(config.databaseTargetHash).success ||
    typeof config.bucket !== 'string' ||
    !/^[a-z0-9-]{1,64}$/.test(config.region) ||
    prefix.length > 256 ||
    (prefix !== '' &&
      (!/^[A-Za-z0-9._/-]+$/.test(prefix) ||
        prefix.split('/').some((p) => !p || p === '.' || p === '..')))
  )
    throw new Error('Invalid final Result storage configuration');
  let endpoint = null;
  if (config.endpoint != null) {
    const url = new URL(config.endpoint);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !(
        url.pathname === '/' ||
        (url.pathname === '/storage/v1/s3' &&
          (/^[a-z0-9]{20}\.storage\.supabase\.co$/.test(url.hostname) ||
            ['127.0.0.1', '[::1]'].includes(url.hostname)))
      ) ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
    )
      throw new Error('Invalid final Result storage configuration');
    endpoint = url.origin + (url.pathname === '/' ? '' : url.pathname);
  }
  const bucketPattern = endpoint?.endsWith('/storage/v1/s3')
    ? /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/
    : /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
  if (!bucketPattern.test(config.bucket))
    throw new Error('Invalid final Result storage configuration');
  const target = {
    bucket: config.bucket,
    databaseTargetHash: config.databaseTargetHash,
    endpoint,
    prefix,
    region: config.region,
    schemaVersion: 'tiangong.final-result-storage-target.v1',
  };
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(target))),
  );
  return {
    target,
    targetHash: Array.from(digest, (v) => v.toString(16).padStart(2, '0')).join(''),
  };
}
function jwtClaims(value: string): Record<string, unknown> {
  if (value.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value))
    throw new Error('Invalid ZIP credential');
  const decode = (part: string) =>
    JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
      ),
    );
  const [header, payload] = value.split('.').slice(0, 2).map(decode);
  if (
    !['HS256', 'ES256', 'RS256'].includes(header?.alg) ||
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  )
    throw new Error('Invalid ZIP credential');
  return payload;
}
function validateStorageCredential(config: FinalDownloadConfig, project: string) {
  // Configuration guards are not signature verification or actor authorization.
  // Storage verifies the JWT signature and applies the generation role's real ACL/RLS.
  const claims = jwtClaims(config.signingKey ?? '');
  const now = Math.floor(Date.now() / 1000);
  if (
    claims.ref !== project ||
    claims.iss !== 'supabase' ||
    typeof claims.role !== 'string' ||
    !/^lca_result_zip_reader_g[0-9]{8}(?:_[0-9]{1,4})?$/.test(claims.role) ||
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.exp) ||
    (claims.iat as number) <= 0 ||
    (claims.iat as number) > now + 60 ||
    (claims.exp as number) <= now + 60 ||
    (claims.exp as number) - (claims.iat as number) > 90 * 86400 ||
    !z.string().uuid().safeParse(claims.jti).success
  )
    throw new Error('Invalid ZIP credential scope or lifetime');
  const apiKey = config.publicApiKey ?? '';
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(apiKey) && jwtClaims(apiKey).role !== 'anon')
    throw new Error('ZIP gateway key must be public');
}
async function signSupabaseZip(
  config: FinalDownloadConfig,
  key: string,
  fileName: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<string> {
  const endpoint = new URL(config.endpoint ?? '');
  if (
    endpoint.protocol !== 'https:' ||
    !/^[a-z0-9]{20}\.storage\.supabase\.co$/.test(endpoint.hostname) ||
    endpoint.pathname !== '/storage/v1/s3' ||
    endpoint.port ||
    !config.signingKey ||
    config.accessKeyId ||
    config.secretAccessKey ||
    config.sessionToken
  )
    throw new Error('Invalid restricted Storage signer configuration');
  const project = endpoint.hostname.split('.')[0];
  validateStorageCredential(config, project);
  const origin = `https://${project}.supabase.co`;
  const objectPath = [config.bucket, ...key.split('/')].map(encodeURIComponent).join('/');
  const response = await fetcher(`${origin}/storage/v1/object/sign/${objectPath}`, {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: {
      apikey: config.publicApiKey!,
      Authorization: `Bearer ${config.signingKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: 60 }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Restricted ZIP signing failed');
  }
  const value = z
    .object({ signedURL: z.string().min(1).max(4096) })
    .strict()
    .parse(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          await readResultQueryBytes(response.body, 8192),
        ),
      ),
    );
  const expectedPath = `/object/sign/${objectPath}`;
  // Only the provider's single-object token may cross the browser boundary.
  // A service key, Auth JWT, foreign URL, extra query or substituted path is never returned.
  const url = new URL(value.signedURL, origin);
  if (
    url.origin !== origin ||
    url.pathname !== expectedPath ||
    url.hash ||
    url.username ||
    url.password ||
    [...url.searchParams.keys()].join(',') !== 'token' ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(url.searchParams.get('token') ?? '') ||
    value.signedURL.includes(config.signingKey)
  )
    throw new Error('Invalid signed ZIP response');
  url.pathname = '/storage/v1' + expectedPath;
  url.searchParams.set('download', fileName);
  return url.href;
}

export function downloadFinalResult(
  request: FinalDownloadRequest,
  actor: SupabaseClient,
  signal: AbortSignal,
  options: FinalDownloadOptions = {},
): Promise<Response> {
  return withFinalResultBudget(signal, options.timeoutMs, async (signal) => {
    const args = { p_publication_id: request.publicationId, p_format: request.format };
    const resolve = async () =>
      descriptorSchema.parse(
        await finalResultRpc(actor, 'qry_final_result_download_v2', args, signal),
      );
    const descriptor = await resolve();
    if (
      descriptor.publicationId !== request.publicationId ||
      descriptor.file.name !== `result.${request.format}.zip`
    )
      throw new Error('Result ZIP identity mismatch');
    const config = options.config ?? configuration();
    const { target, targetHash } = await finalDownloadTarget(config);
    if (targetHash !== descriptor.targetHash) throw new Error('Result ZIP target mismatch');
    const expiresIn = 60;
    const issuedAt = Date.now();
    const key = [
      target.prefix,
      'release-candidates',
      descriptor.candidateHash,
      descriptor.file.name,
    ]
      .filter(Boolean)
      .join('/');
    let url: string;
    if (config.signer === 'supabase-storage') {
      url = await signSupabaseZip(
        config,
        key,
        descriptor.file.name,
        signal,
        options.fetch ?? fetch,
      );
    } else {
      if (
        (config.signer !== undefined && config.signer !== 's3') ||
        !config.accessKeyId ||
        !config.secretAccessKey ||
        config.signingKey ||
        config.publicApiKey ||
        (target.endpoint?.endsWith('/storage/v1/s3') && config.sessionToken)
      )
        throw new Error('Invalid S3 ZIP credentials');
      const client = new S3Client({
        region: target.region,
        endpoint: target.endpoint ?? undefined,
        forcePathStyle: target.endpoint !== null,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
          sessionToken: config.sessionToken,
        },
        maxAttempts: 1,
        defaultUserAgentProvider: async () => [['tiangong-final-result-download', '2']],
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      });
      try {
        url = await getSignedUrl(
          client,
          new GetObjectCommand({
            Bucket: target.bucket,
            Key: key,
            ResponseContentType: 'application/zip',
            ResponseContentDisposition: `attachment; filename="${descriptor.file.name}"`,
          }),
          { expiresIn, signingDate: new Date(issuedAt) },
        );
      } finally {
        client.destroy();
      }
    }
    // A signed URL is returned only after a second current-publication and complete-closure RLS check.
    // Already issued S3 URLs remain bearer capabilities until their short expiry.
    if (JSON.stringify(await resolve()) !== JSON.stringify(descriptor))
      throw new Error('Result ZIP authorization changed');
    return json({
      ok: true,
      mode: 'final_download',
      data: {
        publicationId: descriptor.publicationId,
        file: descriptor.file,
        url,
        expiresAt: new Date(issuedAt + expiresIn * 1000).toISOString(),
      },
    });
  });
}
