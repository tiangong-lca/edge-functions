import { assertEquals } from 'jsr:@std/assert';
import {
  OPEN_DATA_STATE_CODES,
  buildImportSourceObjectPath,
  buildPackageJobDiagnosticsSummary,
  buildStorageObjectUrl,
  normalizeExportRequestBody,
  normalizeVersionString,
  parseStoragePathFromArtifactUrl,
  resolveExportCacheAction,
} from '../supabase/functions/_shared/tidas_package.ts';

Deno.test('normalizeVersionString pads dotted numeric versions', () => {
  assertEquals(normalizeVersionString('1.1.0'), '01.01.000');
  assertEquals(normalizeVersionString('01.01.000'), '01.01.000');
  assertEquals(normalizeVersionString('1.12.3'), '01.12.003');
  assertEquals(normalizeVersionString('draft'), 'draft');
});

Deno.test('normalizeExportRequestBody defaults to current_user and normalizes roots', () => {
  const normalized = normalizeExportRequestBody({
    roots: [
      {
        table: 'processes',
        id: '11111111-1111-4111-8111-111111111111',
        version: '1.0.0',
      },
      {
        table: 'processes',
        id: '11111111-1111-4111-8111-111111111111',
        version: '01.00.000',
      },
    ],
  });

  assertEquals(normalized.scope, 'selected_roots');
  assertEquals(normalized.roots, [
    {
      table: 'processes',
      id: '11111111-1111-4111-8111-111111111111',
      version: '01.00.000',
    },
  ]);
  assertEquals(normalized.request_payload.scope, 'selected_roots');
});

Deno.test('buildImportSourceObjectPath uses package job folder layout', () => {
  assertEquals(
    buildImportSourceObjectPath('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    'lca-results/packages/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/import-source.zip',
  );
});

Deno.test(
  'buildStorageObjectUrl and parseStoragePathFromArtifactUrl round-trip package artifact urls',
  () => {
    Deno.env.set('S3_ENDPOINT', 'https://example.storage.supabase.co/storage/v1/s3');
    const artifactUrl = buildStorageObjectUrl(
      'lca_results',
      'lca-results/packages/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/export-package.zip',
    );

    assertEquals(artifactUrl.includes('/storage/v1/s3/lca_results/'), true);
    assertEquals(parseStoragePathFromArtifactUrl(artifactUrl), {
      bucket: 'lca_results',
      objectPath:
        'lca-results/packages/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/export-package.zip',
    });
  },
);

Deno.test('resolveExportCacheAction returns in_progress for active export jobs', () => {
  const cacheRow = {
    id: 'cache-1',
    status: 'pending',
    job_id: 'job-1',
    export_artifact_id: null,
    report_artifact_id: null,
    hit_count: 2,
  };

  assertEquals(
    resolveExportCacheAction(cacheRow, {
      status: 'queued',
    }),
    'in_progress',
  );
  assertEquals(
    resolveExportCacheAction(cacheRow, {
      status: 'running',
    }),
    'in_progress',
  );
});

Deno.test(
  'resolveExportCacheAction retries completed export jobs so a fresh package is built',
  () => {
    const cacheRow = {
      id: 'cache-2',
      status: 'ready',
      job_id: 'job-2',
      export_artifact_id: 'artifact-1',
      report_artifact_id: 'artifact-2',
      hit_count: 1,
    };

    assertEquals(
      resolveExportCacheAction(cacheRow, {
        status: 'ready',
      }),
      'retry',
    );
    assertEquals(
      resolveExportCacheAction(cacheRow, {
        status: 'completed',
      }),
      'retry',
    );
  },
);

Deno.test('resolveExportCacheAction retries stale, failed, or orphaned cache rows', () => {
  const cacheRow = {
    id: 'cache-3',
    status: 'pending',
    job_id: 'job-3',
    export_artifact_id: null,
    report_artifact_id: null,
    hit_count: 4,
  };

  assertEquals(
    resolveExportCacheAction(cacheRow, {
      status: 'failed',
    }),
    'retry',
  );
  assertEquals(
    resolveExportCacheAction(cacheRow, {
      status: 'stale',
    }),
    'retry',
  );
  assertEquals(resolveExportCacheAction(cacheRow, null), 'retry');
  assertEquals(
    resolveExportCacheAction(
      {
        ...cacheRow,
        job_id: null,
      },
      {
        status: 'running',
      },
    ),
    'retry',
  );
});

Deno.test('buildPackageJobDiagnosticsSummary preserves structured upload diagnostics', () => {
  const summary = buildPackageJobDiagnosticsSummary({
    status: 'failed',
    diagnostics: {
      error_code: 'artifact_too_large',
      message: 'The export package exceeded the object storage upload size limit.',
      stage: 'upload_object',
      upload_mode: 'multipart',
      artifact_byte_size: 123456,
      http_status: 413,
      storage_error_code: 'EntityTooLarge',
    },
    artifactsByKind: {},
    requestCache: null,
  });

  assertEquals(summary.error_code, 'artifact_too_large');
  assertEquals(
    summary.message,
    'The export package exceeded the object storage upload size limit.',
  );
  assertEquals(summary.stage, 'upload_object');
  assertEquals(summary.upload_mode, 'multipart');
  assertEquals(summary.artifact_byte_size, 123456);
  assertEquals(summary.is_oversize, true);
  assertEquals(summary.source, 'diagnostics');
});

Deno.test(
  'buildPackageJobDiagnosticsSummary suppresses stale errors for successful terminal jobs',
  () => {
    for (const status of ['ready', 'completed'] as const) {
      const summary = buildPackageJobDiagnosticsSummary({
        status,
        diagnostics: {
          error_code: 'artifact_too_large',
          message: 'stale failure from a previous attempt',
          stage: 'upload_object',
          upload_mode: 'multipart',
          artifact_byte_size: 123456,
          http_status: 413,
          storage_error_code: 'EntityTooLarge',
        },
        artifactsByKind: {},
        requestCache: {
          id: 'cache-1',
          status: 'failed',
          error_code: 'job_execution_failed',
          error_message: 'stale cache failure',
          hit_count: 1,
          last_accessed_at: null,
          created_at: null,
          updated_at: null,
          export_artifact_id: null,
          report_artifact_id: null,
        },
      });

      assertEquals(summary, {
        error_code: null,
        message: null,
        stage: 'upload_object',
        upload_mode: 'multipart',
        artifact_byte_size: 123456,
        http_status: null,
        storage_error_code: null,
        is_oversize: false,
        source: 'none',
      });
    }
  },
);

Deno.test(
  'buildPackageJobDiagnosticsSummary classifies legacy oversize strings from request cache',
  () => {
    const summary = buildPackageJobDiagnosticsSummary({
      status: 'failed',
      diagnostics: {
        error: 'object upload failed status=413 Payload Too Large <Code>EntityTooLarge</Code>',
      },
      artifactsByKind: {
        export_zip: {
          artifact_id: 'artifact-1',
          artifact_kind: 'export_zip',
          status: 'failed',
          artifact_format: 'tidas-package-zip:v1',
          content_type: 'application/zip',
          artifact_sha256: null,
          artifact_byte_size: 99,
          artifact_url: 'https://example.com/export.zip',
          storage_bucket: null,
          storage_object_path: null,
          signed_download_url: null,
          signed_download_expires_in_seconds: null,
          download_status: 'not_ready',
          download_error_code: 'PACKAGE_ARTIFACT_NOT_READY',
          download_error_message: 'Package artifact is not ready for download',
          metadata: {},
          expires_at: null,
          is_pinned: false,
          created_at: null,
          updated_at: null,
        },
      },
      requestCache: {
        id: 'cache-1',
        status: 'failed',
        error_code: 'job_execution_failed',
        error_message: 'object upload failed status=413 Payload Too Large',
        hit_count: 1,
        last_accessed_at: null,
        created_at: null,
        updated_at: null,
        export_artifact_id: null,
        report_artifact_id: null,
      },
    });

    assertEquals(summary.error_code, 'artifact_too_large');
    assertEquals(summary.is_oversize, true);
    assertEquals(summary.artifact_byte_size, 99);
    assertEquals(summary.source, 'diagnostics');
  },
);

Deno.test('package open-data scope keeps its support-dataset 100..199 range', () => {
  // This is the TIDAS package export rule, not the Process numerical eligibility rule. Package
  // export stays a support-dataset rule; the exact published-Result Process exclusion is owned by
  // Database selected-root admission and Worker export materialization, and this list must not be
  // narrowed to 100 as if it were a numerical scope.
  assertEquals(OPEN_DATA_STATE_CODES[0], 100);
  assertEquals(OPEN_DATA_STATE_CODES.at(-1), 199);
  assertEquals(OPEN_DATA_STATE_CODES.includes(150), true);
  assertEquals(OPEN_DATA_STATE_CODES.includes(99), false);
});
