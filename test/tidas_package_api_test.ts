import { assert, assertEquals, assertMatch } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.112.4';

import { AuthMethod, type AuthResult } from '../supabase/functions/_shared/auth.ts';

type JsonRecord = Record<string, unknown>;
type Filter = {
  field: string;
  value: unknown;
  op: 'eq' | 'in' | 'contains';
};
type TableName =
  | 'lca_package_artifacts'
  | 'lca_package_jobs'
  | 'lca_package_request_cache'
  | 'roles'
  | 'worker_jobs';

const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const TEST_WORKER_JOB_ID = '22222222-2222-4222-8222-222222222222';
const TEST_JWT = 'header.payload.signature';
const TEST_SUPABASE_URL = 'https://example.supabase.co';
const TEST_SERVICE_API_KEY = 'service-role-key-for-tests';
const EMPTY_ZIP_BYTES = Uint8Array.from([
  0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

class FakeSupabase {
  tables: Record<TableName, JsonRecord[]> = {
    lca_package_jobs: [],
    lca_package_artifacts: [],
    lca_package_request_cache: [],
    roles: [],
    worker_jobs: [],
  };
  rpcCalls: Array<{ fn: string; args: unknown }> = [];
  rpcResults = new Map<string, { data: unknown; error: unknown }>();
  missingTables = new Set<TableName>();
  signedUploadCalls: Array<{ bucket: string; objectPath: string }> = [];
  signedDownloadCalls: Array<{ bucket: string; objectPath: string; expiresIn: number }> = [];
  signedDownloadErrors = new Map<string, JsonRecord>();

  from(table: TableName): FakeQueryBuilder {
    return new FakeQueryBuilder(this, table);
  }

  rpc(fn: string, args: unknown) {
    this.rpcCalls.push({ fn, args: structuredClone(args) });
    const configured = this.rpcResults.get(fn);
    if (configured) {
      return Promise.resolve(structuredClone(configured));
    }
    const record = asJsonRecord(args);
    if (fn === 'svc_tidas_package_export_enqueue') {
      const existing = this.tables.lca_package_request_cache.find(
        (row) =>
          row.requested_by === record.p_requested_by && row.request_key === record.p_request_key,
      );
      if (existing) {
        return Promise.resolve({
          data: {
            ok: true,
            mode: 'in_progress',
            job_id: existing.job_id,
            worker_job_id: existing.worker_job_id,
          },
          error: null,
        });
      }
      const nowIso = new Date().toISOString();
      const payload = {
        type: 'export_package',
        job_id: record.p_job_id,
        requested_by: record.p_requested_by,
        scope: record.p_scope,
        roots: record.p_roots,
      };
      this.tables.worker_jobs.push({
        id: TEST_WORKER_JOB_ID,
        job_kind: 'tidas.export_package',
        subject_id: record.p_job_id,
        status: 'queued',
        requested_by: record.p_requested_by,
        request_hash: record.p_request_key,
        payload_json: payload,
        diagnostics: {},
        created_at: nowIso,
        updated_at: nowIso,
      });
      this.tables.lca_package_request_cache.push({
        id: crypto.randomUUID(),
        requested_by: record.p_requested_by,
        operation: 'export_package',
        request_key: record.p_request_key,
        status: 'pending',
        job_id: record.p_job_id,
        worker_job_id: TEST_WORKER_JOB_ID,
        hit_count: 1,
        created_at: nowIso,
        updated_at: nowIso,
      });
      return Promise.resolve({
        data: {
          ok: true,
          mode: 'queued',
          job_id: record.p_job_id,
          worker_job_id: TEST_WORKER_JOB_ID,
        },
        error: null,
      });
    }
    if (fn === 'svc_tidas_package_import_prepare') {
      const existing = this.tables.lca_package_artifacts.find((row) => {
        const metadata = asJsonRecord(row.metadata);
        return (
          metadata.requested_by === record.p_requested_by &&
          record.p_idempotency_key &&
          metadata.import_prepare_idempotency_key === record.p_idempotency_key
        );
      });
      if (existing) {
        return Promise.resolve({
          data: {
            ok: true,
            mode: 'reused',
            job_id: existing.job_id,
            source_artifact_id: existing.id,
            artifact_url: existing.artifact_url,
          },
          error: null,
        });
      }
      const nowIso = new Date().toISOString();
      this.tables.lca_package_artifacts.push({
        id: record.p_source_artifact_id,
        job_id: record.p_job_id,
        worker_job_id: null,
        artifact_kind: 'import_source',
        status: 'pending',
        artifact_url: record.p_artifact_url,
        artifact_format: 'tidas-package-zip:v1',
        content_type: record.p_content_type,
        metadata: {
          filename: record.p_filename,
          original_filename: record.p_filename,
          upload_state: 'prepared',
          requested_by: record.p_requested_by,
          import_prepare_idempotency_key: record.p_idempotency_key,
        },
        created_at: nowIso,
        updated_at: nowIso,
      });
      return Promise.resolve({
        data: {
          ok: true,
          mode: 'prepared',
          job_id: record.p_job_id,
          source_artifact_id: record.p_source_artifact_id,
          artifact_url: record.p_artifact_url,
        },
        error: null,
      });
    }
    if (fn === 'svc_tidas_package_import_enqueue' || fn === 'svc_tidas_package_import_enqueue_v2') {
      const artifact = this.tables.lca_package_artifacts.find(
        (row) => row.id === record.p_source_artifact_id && row.job_id === record.p_job_id,
      );
      if (!artifact || asJsonRecord(artifact.metadata).requested_by !== record.p_requested_by) {
        return Promise.resolve({
          data: { ok: false, code: 'PACKAGE_JOB_NOT_FOUND', status: 404 },
          error: null,
        });
      }
      if (artifact.status === 'deleted') {
        return Promise.resolve({
          data: {
            ok: false,
            code: 'PACKAGE_ARTIFACT_DELETED',
            status: 410,
            message: 'Package artifact payload has been deleted; create a new package job',
          },
          error: null,
        });
      }
      const existingWorker = artifact.worker_job_id
        ? this.tables.worker_jobs.find((row) => row.id === artifact.worker_job_id)
        : null;
      if (existingWorker) {
        return Promise.resolve({
          data: {
            ok: true,
            mode: existingWorker.status === 'completed' ? 'completed' : 'in_progress',
            job_id: record.p_job_id,
            worker_job_id: existingWorker.id,
            source_artifact_id: artifact.id,
          },
          error: null,
        });
      }
      const metadata = asJsonRecord(artifact.metadata);
      artifact.status = 'ready';
      artifact.artifact_sha256 = record.p_artifact_sha256;
      artifact.artifact_byte_size = record.p_artifact_byte_size;
      artifact.content_type = record.p_content_type;
      artifact.worker_job_id = TEST_WORKER_JOB_ID;
      artifact.metadata = {
        ...metadata,
        filename: record.p_filename,
        original_filename: record.p_filename,
        upload_state: 'uploaded',
        phase: 'enqueue_import',
      };
      const nowIso = new Date().toISOString();
      this.tables.worker_jobs.push({
        id: TEST_WORKER_JOB_ID,
        job_kind: 'tidas.import_package',
        subject_id: record.p_job_id,
        status: 'queued',
        requested_by: record.p_requested_by,
        request_hash: record.p_artifact_sha256,
        payload_json: {
          type: 'import_package',
          ...(fn.endsWith('_v2') ? { import_policy: 'root_closure_v2' } : {}),
          job_id: record.p_job_id,
          requested_by: record.p_requested_by,
          source_artifact_id: artifact.id,
        },
        diagnostics: {},
        created_at: nowIso,
        updated_at: nowIso,
      });
      return Promise.resolve({
        data: {
          ok: true,
          mode: 'queued',
          job_id: record.p_job_id,
          worker_job_id: TEST_WORKER_JOB_ID,
          source_artifact_id: artifact.id,
        },
        error: null,
      });
    }
    if (fn === 'svc_tidas_package_read_v2') {
      const cache = this.tables.lca_package_request_cache.find(
        (row) =>
          row.requested_by === record.p_requested_by &&
          (row.job_id === record.p_lookup_id || row.worker_job_id === record.p_lookup_id),
      );
      const effectiveJobId = cache?.job_id ?? record.p_lookup_id;
      const worker = this.tables.worker_jobs.find(
        (row) =>
          row.requested_by === record.p_requested_by &&
          (row.id === record.p_lookup_id ||
            row.subject_id === effectiveJobId ||
            asJsonRecord(row.payload_json).job_id === effectiveJobId),
      );
      const artifacts = this.tables.lca_package_artifacts.filter(
        (row) =>
          row.job_id === effectiveJobId &&
          asJsonRecord(row.metadata).requested_by === record.p_requested_by,
      );
      if (!cache && !worker && artifacts.length === 0) {
        return Promise.resolve({ data: { ok: true, data: null }, error: null });
      }
      const payload = asJsonRecord(worker?.payload_json);
      return Promise.resolve({
        data: {
          ok: true,
          data: {
            jobId: effectiveJobId,
            workerJobId: worker?.id ?? cache?.worker_job_id,
            status: worker?.status ?? cache?.status,
            operation:
              cache?.operation ??
              (worker?.job_kind === 'tidas.import_package' ? 'import_package' : 'export_package'),
            scope: payload.scope,
            rootCount: Array.isArray(payload.roots) ? payload.roots.length : 0,
            requestKey: cache?.request_key ?? worker?.request_hash,
            payload,
            diagnostics: worker?.diagnostics ?? {},
            artifacts: artifacts.map((artifact) => ({
              id: artifact.id,
              workerJobId: artifact.worker_job_id,
              artifactKind: artifact.artifact_kind,
              status: artifact.status,
              artifactUrl: artifact.artifact_url,
              artifactSha256: artifact.artifact_sha256,
              artifactByteSize: artifact.artifact_byte_size,
              artifactFormat: artifact.artifact_format,
              contentType: artifact.content_type,
              metadata: artifact.metadata,
              expiresAt: artifact.expires_at,
              isPinned: artifact.is_pinned,
              createdAt: artifact.created_at,
              updatedAt: artifact.updated_at,
            })),
            requestCache: cache
              ? {
                  id: cache.id,
                  status: cache.status,
                  hit_count: cache.hit_count,
                  created_at: cache.created_at,
                  updated_at: cache.updated_at,
                  export_artifact_id: cache.export_artifact_id,
                  report_artifact_id: cache.report_artifact_id,
                }
              : null,
            createdAt: worker?.created_at ?? cache?.created_at,
            updatedAt: worker?.updated_at ?? cache?.updated_at,
          },
        },
        error: null,
      });
    }
    if (fn === 'svc_worker_enqueue_job') {
      const payload = asJsonRecord(record.p_payload_json);
      const nowIso = new Date().toISOString();
      this.tables.worker_jobs.push({
        id: TEST_WORKER_JOB_ID,
        job_kind: String(record.p_job_kind ?? ''),
        status: 'queued',
        requested_by: record.p_requested_by ?? null,
        request_hash: record.p_request_hash ?? null,
        payload_json: payload,
        diagnostics: {},
        error_code: null,
        error_message: null,
        created_at: nowIso,
        started_at: null,
        finished_at: null,
        updated_at: nowIso,
      });
      return Promise.resolve({
        data: {
          ok: true,
          data: {
            id: TEST_WORKER_JOB_ID,
            payload,
            status: 'queued',
          },
        },
        error: null,
      });
    }
    return Promise.resolve({ data: null, error: null });
  }

  storage = {
    from: (bucket: string) => ({
      createSignedUploadUrl: async (objectPath: string) => {
        this.signedUploadCalls.push({ bucket, objectPath });
        return {
          data: {
            path: objectPath,
            token: `upload-token:${objectPath}`,
            signedUrl: `https://upload.example/${bucket}/${encodePath(objectPath)}`,
          },
          error: null,
        };
      },
      createSignedUrl: async (objectPath: string, expiresIn: number) => {
        this.signedDownloadCalls.push({ bucket, objectPath, expiresIn });
        const error = this.signedDownloadErrors.get(objectPath);
        if (error) {
          return {
            data: null,
            error,
          };
        }

        return {
          data: {
            signedUrl: `https://download.example/${bucket}/${encodePath(
              objectPath,
            )}?expires=${expiresIn}`,
          },
          error: null,
        };
      },
    }),
  };

  getRows(table: TableName): JsonRecord[] {
    return this.tables[table].map((row) => structuredClone(row));
  }

  insert(table: TableName, payload: JsonRecord | JsonRecord[]) {
    const rows = Array.isArray(payload) ? payload : [payload];
    for (const row of rows) {
      if (this.isDuplicate(table, row)) {
        return Promise.resolve({
          data: null,
          error: {
            code: '23505',
            message: 'duplicate key value violates unique constraint',
          },
        });
      }
    }

    this.tables[table].push(...rows.map((row) => structuredClone(row)));
    return Promise.resolve({ data: null, error: null });
  }

  executeSelect(query: FakeQueryBuilder) {
    if (this.missingTables.has(query.table)) {
      return {
        data: null,
        error: {
          code: 'PGRST205',
          message: `Could not find the table 'public.${query.table}' in the schema cache`,
        },
      };
    }

    let rows = this.filterRows(query.table, query.filters);

    if (query.orderField) {
      rows = rows.slice().sort((left, right) => {
        const leftValue = normalizeSortValue(left[query.orderField!]);
        const rightValue = normalizeSortValue(right[query.orderField!]);
        if (leftValue < rightValue) {
          return query.orderAscending ? -1 : 1;
        }
        if (leftValue > rightValue) {
          return query.orderAscending ? 1 : -1;
        }
        return 0;
      });
    }

    if (query.limitCount !== null) {
      rows = rows.slice(0, query.limitCount);
    }

    return { data: rows.map((row) => structuredClone(row)), error: null };
  }

  executeMaybeSingle(query: FakeQueryBuilder) {
    const { data, error } = this.executeSelect(query);
    if (error || !Array.isArray(data)) {
      return Promise.resolve({
        data: null,
        error,
      });
    }

    return Promise.resolve({
      data: data[0] ?? null,
      error,
    });
  }

  executeUpdate(query: FakeQueryBuilder) {
    if (this.missingTables.has(query.table)) {
      return {
        data: null,
        error: {
          code: 'PGRST205',
          message: `Could not find the table 'public.${query.table}' in the schema cache`,
        },
      };
    }

    const rows = this.filterRows(query.table, query.filters);
    for (const row of rows) {
      Object.assign(row, structuredClone(query.updateValues));
    }
    return { data: null, error: null };
  }

  private filterRows(table: TableName, filters: Filter[]): JsonRecord[] {
    return this.tables[table].filter((row) =>
      filters.every((filter) => {
        const actual = row[filter.field];
        if (filter.op === 'eq') {
          return actual === filter.value;
        }
        if (filter.op === 'contains') {
          return jsonContains(actual, filter.value);
        }

        return Array.isArray(filter.value) && filter.value.includes(actual);
      }),
    );
  }

  private isDuplicate(table: TableName, row: JsonRecord): boolean {
    return this.tables[table].some((existing) => {
      if (existing.id === row.id) {
        return true;
      }

      if (table !== 'lca_package_jobs') {
        return false;
      }

      return (
        existing.requested_by === row.requested_by &&
        existing.idempotency_key !== null &&
        existing.idempotency_key !== undefined &&
        existing.idempotency_key === row.idempotency_key
      );
    });
  }
}

class FakeQueryBuilder implements PromiseLike<{ data: unknown; error: unknown }> {
  filters: Filter[] = [];
  orderField: string | null = null;
  orderAscending = true;
  limitCount: number | null = null;
  updateValues: JsonRecord = {};
  private mode: 'select' | 'update' | null = null;

  constructor(
    private readonly supabase: FakeSupabase,
    readonly table: TableName,
  ) {}

  select(_columns: string): this {
    this.mode = 'select';
    return this;
  }

  insert(payload: JsonRecord | JsonRecord[]) {
    return this.supabase.insert(this.table, payload);
  }

  update(values: JsonRecord): this {
    this.mode = 'update';
    this.updateValues = values;
    return this;
  }

  eq(field: string, value: unknown): this {
    this.filters.push({ field, value, op: 'eq' });
    return this;
  }

  in(field: string, value: unknown[]): this {
    this.filters.push({ field, value, op: 'in' });
    return this;
  }

  contains(field: string, value: unknown): this {
    this.filters.push({ field, value, op: 'contains' });
    return this;
  }

  order(field: string, options?: { ascending?: boolean }): this {
    this.orderField = field;
    this.orderAscending = options?.ascending ?? true;
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  maybeSingle() {
    return this.supabase.executeMaybeSingle(this);
  }

  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onfulfilled?:
      ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    const result =
      this.mode === 'update'
        ? Promise.resolve(this.supabase.executeUpdate(this))
        : Promise.resolve(this.supabase.executeSelect(this));

    return result.then(onfulfilled ?? undefined, onrejected ?? undefined);
  }
}

function encodePath(objectPath: string): string {
  return objectPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function normalizeSortValue(value: unknown): string | number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return value;
  }
  return '';
}

function asJsonRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as JsonRecord;
}

function jsonContains(actual: unknown, expected: unknown): boolean {
  const actualRecord = asJsonRecord(actual);
  const expectedRecord = asJsonRecord(expected);

  return Object.entries(expectedRecord).every(([key, expectedValue]) => {
    const actualValue = actualRecord[key];
    if (expectedValue && typeof expectedValue === 'object' && !Array.isArray(expectedValue)) {
      return jsonContains(actualValue, expectedValue);
    }

    return actualValue === expectedValue;
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const payload = new Uint8Array(bytes.byteLength);
  payload.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', payload.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function createAuthResult(userId = TEST_USER_ID): AuthResult {
  return {
    isAuthenticated: true,
    principal: {
      userId,
      authMethod: 'supabase_jwt',
      assurance: 'claims',
    },
    user: { id: userId } as AuthResult['user'],
  };
}

type TidasHandlersModule = {
  createExportTidasPackageHandler: typeof import('../supabase/functions/export_tidas_package/handler.ts').createExportTidasPackageHandler;
  createImportTidasPackageHandler: typeof import('../supabase/functions/import_tidas_package/handler.ts').createImportTidasPackageHandler;
  createTidasPackageJobsHandler: typeof import('../supabase/functions/tidas_package_jobs/handler.ts').createTidasPackageJobsHandler;
  queueExportTidasPackage: typeof import('../supabase/functions/_shared/tidas_package.ts').queueExportTidasPackage;
};

let handlersModulePromise: Promise<TidasHandlersModule> | undefined;

async function loadTidasHandlers(): Promise<TidasHandlersModule> {
  handlersModulePromise ??= (async () => {
    const [exportModule, importModule, jobsModule, packageModule] = await Promise.all([
      import('../supabase/functions/export_tidas_package/handler.ts'),
      import('../supabase/functions/import_tidas_package/handler.ts'),
      import('../supabase/functions/tidas_package_jobs/handler.ts'),
      import('../supabase/functions/_shared/tidas_package.ts'),
    ]);

    return {
      createExportTidasPackageHandler: exportModule.createExportTidasPackageHandler,
      createImportTidasPackageHandler: importModule.createImportTidasPackageHandler,
      createTidasPackageJobsHandler: jobsModule.createTidasPackageJobsHandler,
      queueExportTidasPackage: packageModule.queueExportTidasPackage,
    };
  })();

  return await handlersModulePromise;
}

function withPackageStorageEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previous = {
    REMOTE_SUPABASE_URL: Deno.env.get('REMOTE_SUPABASE_URL'),
    REMOTE_SERVICE_API_KEY: Deno.env.get('REMOTE_SERVICE_API_KEY'),
    S3_ENDPOINT: Deno.env.get('S3_ENDPOINT'),
    S3_BUCKET: Deno.env.get('S3_BUCKET'),
    S3_PREFIX: Deno.env.get('S3_PREFIX'),
    TIDAS_PACKAGE_WORKER_JOBS_ENABLED: Deno.env.get('TIDAS_PACKAGE_WORKER_JOBS_ENABLED'),
  };

  Deno.env.set('REMOTE_SUPABASE_URL', TEST_SUPABASE_URL);
  Deno.env.set('REMOTE_SERVICE_API_KEY', TEST_SERVICE_API_KEY);
  Deno.env.set('S3_ENDPOINT', 'https://example.storage.supabase.co/storage/v1/s3');
  Deno.env.set('S3_BUCKET', 'lca_results');
  Deno.env.set('S3_PREFIX', 'lca-results');
  Deno.env.delete('TIDAS_PACKAGE_WORKER_JOBS_ENABLED');

  return fn().finally(() => {
    restoreEnvVar('REMOTE_SUPABASE_URL', previous.REMOTE_SUPABASE_URL);
    restoreEnvVar('REMOTE_SERVICE_API_KEY', previous.REMOTE_SERVICE_API_KEY);
    restoreEnvVar('S3_ENDPOINT', previous.S3_ENDPOINT);
    restoreEnvVar('S3_BUCKET', previous.S3_BUCKET);
    restoreEnvVar('S3_PREFIX', previous.S3_PREFIX);
    restoreEnvVar('TIDAS_PACKAGE_WORKER_JOBS_ENABLED', previous.TIDAS_PACKAGE_WORKER_JOBS_ENABLED);
  });
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    Deno.env.delete(name);
    return;
  }

  Deno.env.set(name, value);
}

Deno.test('export_tidas_package API exposes queued worker job before artifacts exist', async () => {
  await withPackageStorageEnv(async () => {
    const {
      createExportTidasPackageHandler,
      createTidasPackageJobsHandler,
      queueExportTidasPackage,
    } = await loadTidasHandlers();
    const supabase = new FakeSupabase();
    supabase.missingTables.add('lca_package_jobs');
    const exportAuthCalls: AuthMethod[][] = [];
    const jobsAuthCalls: AuthMethod[][] = [];

    const exportHandler = createExportTidasPackageHandler({
      authClient: {} as SupabaseClient,
      supabase: supabase as unknown as SupabaseClient,
      authenticateRequest: async (_req, config) => {
        exportAuthCalls.push([...config.allowedMethods]);
        return createAuthResult();
      },
      queueExportTidasPackage,
    });

    const jobsHandler = createTidasPackageJobsHandler({
      authClient: {} as SupabaseClient,
      supabase: supabase as unknown as SupabaseClient,
      authenticateRequest: async (_req, config) => {
        jobsAuthCalls.push([...config.allowedMethods]);
        return createAuthResult();
      },
    });

    const exportResponse = await exportHandler(
      new Request('https://example.com/functions/v1/export_tidas_package', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_JWT}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ scope: 'current_user' }),
      }),
    );

    assertEquals(exportResponse.status, 202);
    const queued = await exportResponse.json();
    assertEquals(queued.ok, true);
    assertEquals(queued.mode, 'queued');
    assertMatch(
      queued.job_id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    assertEquals(queued.worker_job_id, TEST_WORKER_JOB_ID);
    assertEquals(queued.scope, 'current_user');
    assertEquals(queued.root_count, 0);
    assertEquals(exportAuthCalls, [[AuthMethod.JWT]]);

    assertEquals(supabase.getRows('lca_package_jobs').length, 0);
    assertEquals(supabase.getRows('lca_package_artifacts').length, 0);

    const cacheRow = supabase.getRows('lca_package_request_cache')[0];
    assertEquals(cacheRow.status, 'pending');
    assertEquals(cacheRow.job_id, queued.job_id);
    assertEquals(cacheRow.worker_job_id, TEST_WORKER_JOB_ID);

    const workerJobRow = supabase.getRows('worker_jobs')[0];
    assertEquals(workerJobRow.status, 'queued');
    assertEquals(workerJobRow.job_kind, 'tidas.export_package');
    assertEquals(workerJobRow.requested_by, TEST_USER_ID);
    assertEquals((workerJobRow.payload_json as JsonRecord).job_id, queued.job_id);
    assertEquals((workerJobRow.payload_json as JsonRecord).scope, 'current_user');
    assertEquals(supabase.rpcCalls.length, 1);
    assertEquals(supabase.rpcCalls[0].fn, 'svc_tidas_package_export_enqueue');

    const lookupResponse = await jobsHandler(
      new Request(`https://example.com/functions/v1/tidas_package_jobs/${queued.job_id}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${TEST_JWT}`,
        },
      }),
    );
    assertEquals(lookupResponse.status, 200);

    const jobLookup = await lookupResponse.json();
    assertEquals(jobLookup.ok, true);
    assertEquals(jobLookup.job_id, queued.job_id);
    assertEquals(jobLookup.job_type, 'export_package');
    assertEquals(jobLookup.status, 'queued');
    assertEquals(jobLookup.scope, 'current_user');
    assertEquals(jobLookup.root_count, 0);
    assertEquals(jobLookup.request_key, workerJobRow.request_hash);
    assertEquals(jobLookup.request_cache.status, 'pending');
    assertEquals(jobLookup.request_cache.export_artifact_id, null);
    assertEquals(jobLookup.request_cache.report_artifact_id, null);
    assertEquals(jobLookup.artifacts.length, 0);
    assertEquals(jobsAuthCalls, [[AuthMethod.JWT]]);

    const workerIdLookupResponse = await jobsHandler(
      new Request('https://example.com/functions/v1/tidas_package_jobs', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_JWT}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ job_id: TEST_WORKER_JOB_ID }),
      }),
    );
    assertEquals(workerIdLookupResponse.status, 200);

    const workerIdLookup = await workerIdLookupResponse.json();
    assertEquals(workerIdLookup.ok, true);
    assertEquals(workerIdLookup.job_id, queued.job_id);
    assertEquals(workerIdLookup.status, 'queued');
  });
});

Deno.test('import_tidas_package API completes prepare, enqueue, and job lookup flow', async () => {
  await withPackageStorageEnv(async () => {
    const { createImportTidasPackageHandler, createTidasPackageJobsHandler } =
      await loadTidasHandlers();
    const supabase = new FakeSupabase();
    supabase.missingTables.add('lca_package_jobs');
    const importAuthCalls: AuthMethod[][] = [];
    const jobsAuthCalls: AuthMethod[][] = [];

    const importHandler = createImportTidasPackageHandler({
      authClient: {} as SupabaseClient,
      supabase: supabase as unknown as SupabaseClient,
      authenticateRequest: async (_req, config) => {
        importAuthCalls.push([...config.allowedMethods]);
        return createAuthResult();
      },
    });

    const jobsHandler = createTidasPackageJobsHandler({
      authClient: {} as SupabaseClient,
      supabase: supabase as unknown as SupabaseClient,
      authenticateRequest: async (_req, config) => {
        jobsAuthCalls.push([...config.allowedMethods]);
        return createAuthResult();
      },
    });

    const prepareRequest = new Request('https://example.com/functions/v1/import_tidas_package', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_JWT}`,
        'Content-Type': 'application/json',
        'x-idempotency-key': 'demo-package',
      },
      body: JSON.stringify({
        action: 'prepare_upload',
        filename: 'fixtures/Demo Package.zip',
        byte_size: EMPTY_ZIP_BYTES.byteLength,
        content_type: 'application/zip',
      }),
    });

    const prepareResponse = await importHandler(prepareRequest);
    assertEquals(prepareResponse.status, 200);
    const prepared = await prepareResponse.json();

    assertEquals(prepared.ok, true);
    assertEquals(prepared.action, 'prepare_upload');
    assertMatch(
      prepared.job_id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    assertMatch(
      prepared.source_artifact_id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    assertEquals(prepared.upload.bucket, 'lca_results');
    assertEquals(
      prepared.upload.object_path,
      `lca-results/packages/jobs/${prepared.job_id}/import-source.zip`,
    );
    assertEquals(prepared.upload.filename, 'Demo_Package.zip');
    assertEquals(prepared.upload.byte_size, EMPTY_ZIP_BYTES.byteLength);
    assertEquals(prepared.upload.content_type, 'application/zip');
    assertEquals(importAuthCalls, [[AuthMethod.JWT]]);
    assertEquals(supabase.getRows('lca_package_jobs').length, 0);
    assertEquals(supabase.getRows('lca_package_artifacts').length, 1);

    const repeatedPrepareResponse = await importHandler(
      new Request('https://example.com/functions/v1/import_tidas_package', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_JWT}`,
          'Content-Type': 'application/json',
          'x-idempotency-key': 'demo-package',
        },
        body: JSON.stringify({
          action: 'prepare_upload',
          filename: 'fixtures/Demo Package.zip',
          byte_size: EMPTY_ZIP_BYTES.byteLength,
          content_type: 'application/zip',
        }),
      }),
    );
    const repeatedPrepared = await repeatedPrepareResponse.json();

    assertEquals(repeatedPrepareResponse.status, 200);
    assertEquals(repeatedPrepared.job_id, prepared.job_id);
    assertEquals(repeatedPrepared.source_artifact_id, prepared.source_artifact_id);
    assertEquals(supabase.getRows('lca_package_jobs').length, 0);
    assertEquals(supabase.getRows('lca_package_artifacts').length, 1);

    const artifactSha256 = await sha256Hex(EMPTY_ZIP_BYTES);
    const enqueueBody = {
      action: 'enqueue',
      job_id: prepared.job_id,
      source_artifact_id: prepared.source_artifact_id,
      artifact_sha256: artifactSha256,
      artifact_byte_size: EMPTY_ZIP_BYTES.byteLength,
      filename: './uploads/Demo Package.zip',
      content_type: 'application/zip',
    };

    const enqueueResponse = await importHandler(
      new Request('https://example.com/functions/v1/import_tidas_package', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_JWT}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(enqueueBody),
      }),
    );
    assertEquals(enqueueResponse.status, 202);
    assertEquals(await enqueueResponse.json(), {
      ok: true,
      mode: 'queued',
      job_id: prepared.job_id,
      worker_job_id: TEST_WORKER_JOB_ID,
      source_artifact_id: prepared.source_artifact_id,
    });

    const artifactRow = supabase.getRows('lca_package_artifacts')[0];
    assertEquals(artifactRow.status, 'ready');
    assertEquals(artifactRow.artifact_sha256, artifactSha256);
    assertEquals(artifactRow.artifact_byte_size, EMPTY_ZIP_BYTES.byteLength);
    assertEquals(artifactRow.content_type, 'application/zip');
    assertEquals((artifactRow.metadata as JsonRecord).upload_state, 'uploaded');
    assertEquals((artifactRow.metadata as JsonRecord).filename, 'Demo_Package.zip');
    assertEquals((artifactRow.metadata as JsonRecord).phase, 'enqueue_import');
    assertEquals(artifactRow.worker_job_id, TEST_WORKER_JOB_ID);

    assertEquals(supabase.getRows('lca_package_jobs').length, 0);
    const workerJobRow = supabase.getRows('worker_jobs')[0];
    assertEquals(workerJobRow.status, 'queued');
    assertEquals(workerJobRow.job_kind, 'tidas.import_package');
    assertEquals(workerJobRow.request_hash, artifactSha256);
    assertEquals((workerJobRow.payload_json as JsonRecord).job_id, prepared.job_id);
    assertEquals(
      (workerJobRow.payload_json as JsonRecord).source_artifact_id,
      prepared.source_artifact_id,
    );
    assertEquals(supabase.rpcCalls.length, 3);
    assertEquals(supabase.rpcCalls[2].fn, 'svc_tidas_package_import_enqueue');

    const repeatedEnqueueResponse = await importHandler(
      new Request('https://example.com/functions/v1/import_tidas_package', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_JWT}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(enqueueBody),
      }),
    );

    assertEquals(repeatedEnqueueResponse.status, 200);
    assertEquals(await repeatedEnqueueResponse.json(), {
      ok: true,
      mode: 'in_progress',
      job_id: prepared.job_id,
      worker_job_id: TEST_WORKER_JOB_ID,
      source_artifact_id: prepared.source_artifact_id,
    });
    assertEquals(supabase.rpcCalls.length, 4);

    const lookupResponse = await jobsHandler(
      new Request(`https://example.com/functions/v1/tidas_package_jobs/${prepared.job_id}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${TEST_JWT}`,
        },
      }),
    );
    assertEquals(lookupResponse.status, 200);

    const jobLookup = await lookupResponse.json();
    assertEquals(jobLookup.ok, true);
    assertEquals(jobLookup.job_id, prepared.job_id);
    assertEquals(jobLookup.job_type, 'import_package');
    assertEquals(jobLookup.status, 'queued');
    assertEquals(jobLookup.request_key, artifactSha256);
    assertEquals(jobLookup.request_cache, null);
    assertEquals(jobLookup.diagnostics_summary.stage, 'enqueue_import');
    assertEquals(jobLookup.diagnostics_summary.source, 'none');
    assertEquals(jobLookup.artifacts.length, 1);
    assertEquals(
      jobLookup.artifacts_by_kind.import_source.artifact_id,
      prepared.source_artifact_id,
    );
    assertEquals(jobLookup.artifacts_by_kind.import_source.status, 'ready');
    assertEquals(
      jobLookup.artifacts_by_kind.import_source.storage_object_path,
      `lca-results/packages/jobs/${prepared.job_id}/import-source.zip`,
    );
    assertEquals(
      jobLookup.artifacts_by_kind.import_source.signed_download_url,
      `https://download.example/lca_results/lca-results/packages/jobs/${prepared.job_id}/import-source.zip?expires=3600`,
    );
    assertEquals(jobLookup.artifacts_by_kind.import_source.download_status, 'available');
    assertEquals(jobLookup.artifacts_by_kind.import_source.download_error_code, null);
    assertEquals(jobsAuthCalls, [[AuthMethod.JWT]]);
  });
});

Deno.test(
  'import_tidas_package fails without creating a legacy job row when worker enqueue fails',
  async () => {
    await withPackageStorageEnv(async () => {
      const { createImportTidasPackageHandler } = await loadTidasHandlers();
      const supabase = new FakeSupabase();
      const handler = createImportTidasPackageHandler({
        authClient: {} as SupabaseClient,
        supabase: supabase as unknown as SupabaseClient,
        authenticateRequest: async () => createAuthResult(),
      });

      const prepareResponse = await handler(
        new Request('https://example.com/functions/v1/import_tidas_package', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${TEST_JWT}`,
            'Content-Type': 'application/json',
            'x-idempotency-key': 'enqueue-fails',
          },
          body: JSON.stringify({
            action: 'prepare_upload',
            filename: 'fixtures/Demo Package.zip',
            byte_size: EMPTY_ZIP_BYTES.byteLength,
            content_type: 'application/zip',
          }),
        }),
      );
      assertEquals(prepareResponse.status, 200);
      const prepared = await prepareResponse.json();
      const artifactSha256 = await sha256Hex(EMPTY_ZIP_BYTES);

      supabase.rpcResults.set('svc_tidas_package_import_enqueue', {
        data: {
          ok: false,
          code: 'WORKER_JOBS_ENQUEUE_FAILED',
          status: 403,
          message: 'Failed to enqueue import worker job',
        },
        error: null,
      });

      const enqueueResponse = await handler(
        new Request('https://example.com/functions/v1/import_tidas_package', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${TEST_JWT}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            action: 'enqueue',
            job_id: prepared.job_id,
            source_artifact_id: prepared.source_artifact_id,
            artifact_sha256: artifactSha256,
            artifact_byte_size: EMPTY_ZIP_BYTES.byteLength,
            filename: './uploads/Demo Package.zip',
            content_type: 'application/zip',
          }),
        }),
      );

      assertEquals(enqueueResponse.status, 403);
      assertEquals(await enqueueResponse.json(), {
        ok: false,
        code: 'WORKER_JOBS_ENQUEUE_FAILED',
        message: 'Failed to enqueue import worker job',
      });
      assertEquals(supabase.getRows('lca_package_jobs').length, 0);
      const artifactRow = supabase.getRows('lca_package_artifacts')[0];
      assertEquals(artifactRow.status, 'pending');
      assertEquals(artifactRow.worker_job_id, null);
      assertEquals(supabase.rpcCalls.length, 2);
    });
  },
);

Deno.test(
  'import_tidas_package fails closed when package worker_jobs cutover is disabled',
  async () => {
    await withPackageStorageEnv(async () => {
      Deno.env.set('TIDAS_PACKAGE_WORKER_JOBS_ENABLED', 'false');
      const { createImportTidasPackageHandler } = await loadTidasHandlers();
      const supabase = new FakeSupabase();
      const handler = createImportTidasPackageHandler({
        authClient: {} as SupabaseClient,
        supabase: supabase as unknown as SupabaseClient,
        authenticateRequest: async () => createAuthResult(),
      });

      const prepareResponse = await handler(
        new Request('https://example.com/functions/v1/import_tidas_package', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${TEST_JWT}`,
            'Content-Type': 'application/json',
            'x-idempotency-key': 'cutover-disabled',
          },
          body: JSON.stringify({
            action: 'prepare_upload',
            filename: 'fixtures/Demo Package.zip',
            byte_size: EMPTY_ZIP_BYTES.byteLength,
            content_type: 'application/zip',
          }),
        }),
      );
      assertEquals(prepareResponse.status, 200);
      const prepared = await prepareResponse.json();
      const artifactSha256 = await sha256Hex(EMPTY_ZIP_BYTES);

      const enqueueResponse = await handler(
        new Request('https://example.com/functions/v1/import_tidas_package', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${TEST_JWT}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            action: 'enqueue',
            job_id: prepared.job_id,
            source_artifact_id: prepared.source_artifact_id,
            artifact_sha256: artifactSha256,
            artifact_byte_size: EMPTY_ZIP_BYTES.byteLength,
            filename: './uploads/Demo Package.zip',
            content_type: 'application/zip',
          }),
        }),
      );

      assertEquals(enqueueResponse.status, 503);
      assertEquals(await enqueueResponse.json(), {
        ok: false,
        code: 'LEGACY_QUEUE_DISABLED',
        message: 'Package worker_jobs cutover must be enabled',
      });
      assertEquals(supabase.getRows('lca_package_jobs').length, 0);
      const artifactRow = supabase.getRows('lca_package_artifacts')[0];
      assertEquals(artifactRow.status, 'pending');
      assertEquals((artifactRow.metadata as JsonRecord).upload_state, 'prepared');
      assertEquals(supabase.rpcCalls.length, 1);
    });
  },
);

Deno.test(
  'tidas_package_jobs marks expired and deleted package artifacts as unavailable',
  async () => {
    await withPackageStorageEnv(async () => {
      const { createTidasPackageJobsHandler } = await loadTidasHandlers();
      const supabase = new FakeSupabase();
      const jobId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const expiredPath = `lca-results/packages/jobs/${jobId}/export-package.zip`;
      const deletedPath = `lca-results/packages/jobs/${jobId}/export-report.json`;

      await supabase.insert('lca_package_artifacts', [
        {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          job_id: jobId,
          artifact_kind: 'export_zip',
          status: 'ready',
          artifact_url: `${TEST_SUPABASE_URL}/storage/v1/s3/lca_results/${expiredPath}`,
          artifact_sha256: null,
          artifact_byte_size: 100,
          artifact_format: 'tidas-package-zip:v1',
          content_type: 'application/zip',
          metadata: { requested_by: TEST_USER_ID },
          expires_at: '2020-01-01T00:00:00.000Z',
          is_pinned: false,
          created_at: '2026-05-01T00:00:00.000Z',
          updated_at: '2026-05-01T00:00:00.000Z',
        },
        {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          job_id: jobId,
          artifact_kind: 'export_report',
          status: 'deleted',
          artifact_url: `${TEST_SUPABASE_URL}/storage/v1/s3/lca_results/${deletedPath}`,
          artifact_sha256: null,
          artifact_byte_size: 50,
          artifact_format: 'tidas-package-export-report:v1',
          content_type: 'application/json',
          metadata: { requested_by: TEST_USER_ID },
          expires_at: '2099-01-01T00:00:00.000Z',
          is_pinned: false,
          created_at: '2026-05-01T00:00:01.000Z',
          updated_at: '2026-05-01T00:00:01.000Z',
        },
      ]);

      const handler = createTidasPackageJobsHandler({
        authClient: {} as SupabaseClient,
        supabase: supabase as unknown as SupabaseClient,
        authenticateRequest: async () => createAuthResult(),
      });

      const response = await handler(
        new Request(`https://example.com/functions/v1/tidas_package_jobs/${jobId}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${TEST_JWT}`,
          },
        }),
      );

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.artifacts_by_kind.export_zip.signed_download_url, null);
      assertEquals(body.artifacts_by_kind.export_zip.download_status, 'expired');
      assertEquals(
        body.artifacts_by_kind.export_zip.download_error_code,
        'PACKAGE_ARTIFACT_EXPIRED',
      );
      assertEquals(body.artifacts_by_kind.export_report.signed_download_url, null);
      assertEquals(body.artifacts_by_kind.export_report.download_status, 'deleted');
      assertEquals(
        body.artifacts_by_kind.export_report.download_error_code,
        'PACKAGE_ARTIFACT_DELETED',
      );
      assertEquals(supabase.signedDownloadCalls.length, 0);
    });
  },
);

Deno.test(
  'tidas_package_jobs reports object-missing when signing an unexpired artifact fails',
  async () => {
    await withPackageStorageEnv(async () => {
      const { createTidasPackageJobsHandler } = await loadTidasHandlers();
      const supabase = new FakeSupabase();
      const jobId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      const objectPath = `lca-results/packages/jobs/${jobId}/export-package.zip`;

      await supabase.insert('lca_package_artifacts', {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        job_id: jobId,
        artifact_kind: 'export_zip',
        status: 'ready',
        artifact_url: `${TEST_SUPABASE_URL}/storage/v1/s3/lca_results/${objectPath}`,
        artifact_sha256: null,
        artifact_byte_size: 100,
        artifact_format: 'tidas-package-zip:v1',
        content_type: 'application/zip',
        metadata: { requested_by: TEST_USER_ID },
        expires_at: '2099-01-01T00:00:00.000Z',
        is_pinned: false,
        created_at: '2026-05-01T00:00:00.000Z',
        updated_at: '2026-05-01T00:00:00.000Z',
      });
      supabase.signedDownloadErrors.set(objectPath, {
        code: 'NoSuchKey',
        statusCode: '404',
        message: 'Object not found',
      });

      const handler = createTidasPackageJobsHandler({
        authClient: {} as SupabaseClient,
        supabase: supabase as unknown as SupabaseClient,
        authenticateRequest: async () => createAuthResult(),
      });

      const response = await handler(
        new Request(`https://example.com/functions/v1/tidas_package_jobs/${jobId}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${TEST_JWT}`,
          },
        }),
      );

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.artifacts_by_kind.export_zip.signed_download_url, null);
      assertEquals(body.artifacts_by_kind.export_zip.download_status, 'object_missing');
      assertEquals(
        body.artifacts_by_kind.export_zip.download_error_code,
        'PACKAGE_ARTIFACT_OBJECT_MISSING',
      );
      assertEquals(supabase.signedDownloadCalls.length, 1);
    });
  },
);

Deno.test('import_tidas_package rejects enqueue for deleted source artifacts', async () => {
  await withPackageStorageEnv(async () => {
    const { createImportTidasPackageHandler } = await loadTidasHandlers();
    const supabase = new FakeSupabase();
    const jobId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const sourceArtifactId = '99999999-9999-4999-8999-999999999999';

    await supabase.insert('lca_package_artifacts', {
      id: sourceArtifactId,
      job_id: jobId,
      artifact_kind: 'import_source',
      status: 'deleted',
      artifact_url: `${TEST_SUPABASE_URL}/storage/v1/s3/lca_results/lca-results/packages/jobs/${jobId}/import-source.zip`,
      artifact_sha256: null,
      artifact_byte_size: 100,
      artifact_format: 'tidas-package-zip:v1',
      content_type: 'application/zip',
      metadata: { requested_by: TEST_USER_ID },
      expires_at: '2099-01-01T00:00:00.000Z',
      is_pinned: false,
      created_at: '2026-05-01T00:00:00.000Z',
      updated_at: '2026-05-01T00:00:00.000Z',
    });

    const handler = createImportTidasPackageHandler({
      authClient: {} as SupabaseClient,
      supabase: supabase as unknown as SupabaseClient,
      authenticateRequest: async () => createAuthResult(),
    });

    const response = await handler(
      new Request('https://example.com/functions/v1/import_tidas_package', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_JWT}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'enqueue',
          job_id: jobId,
          source_artifact_id: sourceArtifactId,
          artifact_sha256: await sha256Hex(EMPTY_ZIP_BYTES),
          artifact_byte_size: EMPTY_ZIP_BYTES.byteLength,
          filename: 'Demo Package.zip',
          content_type: 'application/zip',
        }),
      }),
    );

    assertEquals(response.status, 410);
    assertEquals(await response.json(), {
      ok: false,
      code: 'PACKAGE_ARTIFACT_DELETED',
      message: 'Package artifact payload has been deleted; create a new package job',
    });
    assertEquals(supabase.rpcCalls.length, 1);
  });
});

Deno.test('import_tidas_package uses JWT-only auth and rejects opaque legacy bearers', async () => {
  await withPackageStorageEnv(async () => {
    const { createImportTidasPackageHandler } = await loadTidasHandlers();
    const supabase = new FakeSupabase();
    const authCalls: AuthMethod[][] = [];

    const handler = createImportTidasPackageHandler({
      authClient: {} as SupabaseClient,
      supabase: supabase as unknown as SupabaseClient,
      authenticateRequest: async (_req, config) => {
        authCalls.push([...config.allowedMethods]);
        return {
          isAuthenticated: false,
          response: new Response('Unauthorized', { status: 401 }),
        };
      },
    });

    const jwtResponse = await handler(
      new Request('https://example.com/functions/v1/import_tidas_package', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_JWT}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
    );
    assertEquals(jwtResponse.status, 401);

    const apiKeyResponse = await handler(
      new Request('https://example.com/functions/v1/import_tidas_package', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer opaque-user-api-key',
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
    );
    assertEquals(apiKeyResponse.status, 401);

    assertEquals(authCalls, [[AuthMethod.JWT], [AuthMethod.JWT]]);
    assertEquals(supabase.getRows('lca_package_jobs').length, 0);
  });
});

Deno.test('tidas_package_jobs rejects missing job identifiers', async () => {
  await withPackageStorageEnv(async () => {
    const { createTidasPackageJobsHandler } = await loadTidasHandlers();
    const handler = createTidasPackageJobsHandler({
      authClient: {} as SupabaseClient,
      supabase: new FakeSupabase() as unknown as SupabaseClient,
      authenticateRequest: async () => createAuthResult(),
    });

    const response = await handler(
      new Request('https://example.com/functions/v1/tidas_package_jobs', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${TEST_JWT}`,
        },
      }),
    );

    assertEquals(response.status, 400);
    assertEquals(await response.json(), {
      ok: false,
      code: 'MISSING_JOB_ID',
      message: 'A package job id is required',
    });
    assert(response.headers.get('content-type')?.includes('application/json'));
  });
});

Deno.test('partial import policy selects v2 and rejects unknown policies before RPC', async () => {
  await withPackageStorageEnv(async () => {
    const { createImportTidasPackageHandler } = await loadTidasHandlers();
    const supabase = new FakeSupabase();
    supabase.rpcResults.set('svc_tidas_package_import_enqueue_v2', {
      data: {
        ok: true,
        mode: 'queued',
        job_id: TEST_WORKER_JOB_ID,
        worker_job_id: TEST_WORKER_JOB_ID,
        source_artifact_id: TEST_WORKER_JOB_ID,
      },
      error: null,
    });
    const handler = createImportTidasPackageHandler({
      authClient: {} as SupabaseClient,
      supabase: supabase as unknown as SupabaseClient,
      authenticateRequest: async () => createAuthResult(),
    });
    const body = {
      action: 'enqueue',
      import_policy: 'root_closure_v2',
      job_id: TEST_WORKER_JOB_ID,
      source_artifact_id: TEST_WORKER_JOB_ID,
      artifact_sha256: 'a'.repeat(64),
      artifact_byte_size: 100,
      filename: 'partial.zip',
    };
    const request = (value: unknown) =>
      new Request('https://example.com/functions/v1/import_tidas_package', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TEST_JWT}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
    assertEquals((await handler(request(body))).status, 202);
    assertEquals(supabase.rpcCalls[0].fn, 'svc_tidas_package_import_enqueue_v2');
    const rejected = await handler(request({ ...body, import_policy: 'unknown' }));
    assertEquals(rejected.status, 400);
    assertEquals((await rejected.json()).code, 'INVALID_IMPORT_POLICY');
    assertEquals(supabase.rpcCalls.length, 1);
  });
});
