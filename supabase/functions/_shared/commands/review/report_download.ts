import type { SupabaseClient } from '@supabase/supabase-js@2';
import { z } from 'zod';

import type { ActorContext } from '../../command_runtime/actor_context.ts';
import type { CommandParseResult } from '../../command_runtime/command.ts';
import { callReviewReportDownloadDescriptorRpc } from '../../db_rpc/review_report_download.ts';
import { createSupabaseServiceClient } from '../../supabase_client.ts';
import type { ReviewCommandExecutionResult, ReviewReportDownloadRequest } from './types.ts';

const SIGNED_URL_TTL_SECONDS = 300;
const VERSION_PATTERN = /^\d{2}\.\d{2}\.\d{3}$/;
const OBJECT_PATH_INVALID_PATTERN = /[\\\u0000-\u001f\u007f]|(^|\/)\.{1,2}(\/|$)/;
const FILENAME_INVALID_PATTERN = /[/\\\u0000-\u001f\u007f]/;

const requestSchema = z
  .object({
    processId: z.string().uuid(),
    processVersion: z.string().regex(VERSION_PATTERN),
    sourceId: z.string().uuid(),
    sourceVersion: z.string().regex(VERSION_PATTERN),
  })
  .strict();

type AttachmentDescriptor = {
  bucket: 'external_docs';
  objectPath: string;
  filename: string;
};

type RepositoryResult =
  | {
      ok: true;
      data: {
        downloads: Array<{
          filename: string;
          signedDownloadUrl: string;
          signedUrlExpiresAt: string;
        }>;
      };
    }
  | {
      ok: false;
      code: string;
      message: string;
      status: number;
    };

export type ReviewReportDownloadRepository = {
  createDownloads: (request: ReviewReportDownloadRequest) => Promise<RepositoryResult>;
};

type RepositoryOptions = {
  now?: () => number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function genericFailure(code: string, status: number, message: string): RepositoryResult {
  return { ok: false, code, status, message };
}

function decodeDescriptors(value: unknown): AttachmentDescriptor[] | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.data)) {
    return null;
  }
  const attachments = value.data.attachments;
  if (!Array.isArray(attachments) || attachments.length > 20) {
    return null;
  }

  const decoded: AttachmentDescriptor[] = [];
  for (const attachment of attachments) {
    if (!isRecord(attachment)) {
      return null;
    }
    const { bucket, objectPath, filename } = attachment;
    if (
      bucket !== 'external_docs' ||
      typeof objectPath !== 'string' ||
      objectPath.length === 0 ||
      objectPath.length > 1024 ||
      objectPath.startsWith('/') ||
      objectPath.endsWith('/') ||
      OBJECT_PATH_INVALID_PATTERN.test(objectPath) ||
      typeof filename !== 'string' ||
      filename.length === 0 ||
      filename.length > 255 ||
      FILENAME_INVALID_PATTERN.test(filename) ||
      objectPath.split('/').at(-1) !== filename
    ) {
      return null;
    }
    decoded.push({ bucket, objectPath, filename });
  }
  return decoded;
}

function isSafeSignedUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export function parseReviewReportDownloadCommand(
  body: unknown,
): CommandParseResult<ReviewReportDownloadRequest> {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      message: 'Invalid review report download payload',
      details: parsed.error.flatten(),
    };
  }
  return { ok: true, value: parsed.data };
}

export function createReviewReportDownloadRepository(
  actorSupabase: Pick<SupabaseClient, 'rpc'>,
  serviceSupabase: SupabaseClient = createSupabaseServiceClient(),
  options: RepositoryOptions = {},
): ReviewReportDownloadRepository {
  const now = options.now ?? Date.now;
  return {
    createDownloads: async (request) => {
      let rpcResult;
      try {
        rpcResult = await callReviewReportDownloadDescriptorRpc(actorSupabase, request);
      } catch {
        return genericFailure(
          'REVIEW_REPORT_DOWNLOAD_FAILED',
          502,
          'Unable to prepare review report download',
        );
      }

      if (rpcResult.error) {
        return genericFailure(
          'REVIEW_REPORT_DOWNLOAD_FAILED',
          502,
          'Unable to prepare review report download',
        );
      }
      if (isRecord(rpcResult.data) && rpcResult.data.ok === false) {
        const code = rpcResult.data.code;
        if (code === 'AUTH_REQUIRED') {
          return genericFailure('AUTH_REQUIRED', 401, 'Authentication required');
        }
        if (code === 'REVIEW_REPORT_ATTACHMENT_INVALID') {
          return genericFailure(
            'REVIEW_REPORT_ATTACHMENT_INVALID',
            409,
            'Review report attachments are unavailable',
          );
        }
        return genericFailure(
          'REVIEW_REPORT_DOWNLOAD_NOT_ALLOWED',
          403,
          'Review report download is not allowed',
        );
      }

      const descriptors = decodeDescriptors(rpcResult.data);
      if (!descriptors) {
        return genericFailure(
          'REVIEW_REPORT_DOWNLOAD_FAILED',
          502,
          'Unable to prepare review report download',
        );
      }
      if (descriptors.length === 0) {
        return genericFailure(
          'REVIEW_REPORT_NO_ATTACHMENTS',
          404,
          'The review report has no current attachments',
        );
      }

      const downloads = [];
      for (const descriptor of descriptors) {
        try {
          const { data, error } = await serviceSupabase.storage
            .from(descriptor.bucket)
            .createSignedUrl(descriptor.objectPath, SIGNED_URL_TTL_SECONDS, {
              download: descriptor.filename,
            });
          if (error || !isSafeSignedUrl(data?.signedUrl)) {
            return genericFailure(
              'REVIEW_REPORT_DOWNLOAD_FAILED',
              502,
              'Unable to prepare review report download',
            );
          }
          downloads.push({
            filename: descriptor.filename,
            signedDownloadUrl: data.signedUrl,
            signedUrlExpiresAt: new Date(now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
          });
        } catch {
          return genericFailure(
            'REVIEW_REPORT_DOWNLOAD_FAILED',
            502,
            'Unable to prepare review report download',
          );
        }
      }

      return { ok: true, data: { downloads } };
    },
  };
}

export async function executeReviewReportDownloadCommand(
  request: ReviewReportDownloadRequest,
  actor: ActorContext,
  repository: ReviewReportDownloadRepository = createReviewReportDownloadRepository(actor.supabase),
): Promise<ReviewCommandExecutionResult> {
  const result = await repository.createDownloads(request);
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      command: 'review_report_download',
      data: result.data,
    },
  };
}
