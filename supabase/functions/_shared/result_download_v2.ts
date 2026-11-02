import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { z } from 'zod';
import { json } from './command_runtime/http.ts';
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
  databaseTargetHash: string;
  bucket: string;
  region: string;
  endpoint?: string | null;
  prefix?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};
export type FinalDownloadOptions = { config?: FinalDownloadConfig; timeoutMs?: number };
function configuration(): FinalDownloadConfig {
  const get = (name: string) => Deno.env.get(`FINAL_RESULT_S3_${name}`) ?? '';
  return {
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
    if (targetHash !== descriptor.targetHash || !config.accessKeyId || !config.secretAccessKey)
      throw new Error('Result ZIP target mismatch');
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
    const expiresIn = 60;
    let url;
    const issuedAt = Date.now();
    try {
      url = await getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: target.bucket,
          Key: [target.prefix, 'release-candidates', descriptor.candidateHash, descriptor.file.name]
            .filter(Boolean)
            .join('/'),
          ResponseContentType: 'application/zip',
          ResponseContentDisposition: `attachment; filename="${descriptor.file.name}"`,
        }),
        { expiresIn, signingDate: new Date(issuedAt) },
      );
    } finally {
      client.destroy();
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
