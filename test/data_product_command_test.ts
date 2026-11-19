import { assert, assertEquals, assertThrows } from 'jsr:@std/assert';
import { createClient, type SupabaseClient } from '@supabase/supabase-js@2';

import type { ActorContext } from '../supabase/functions/_shared/command_runtime/actor_context.ts';
import { buildCommandAuditPayload } from '../supabase/functions/_shared/command_runtime/audit_log.ts';
import {
  dataProductCommandRequestSchema,
  executeDataProductCommand,
} from '../supabase/functions/_shared/commands/data_product/command.ts';
import {
  createDataProductCommandRepository,
  type DataProductCommandRepository,
} from '../supabase/functions/_shared/commands/data_product/repository.ts';
import type { DataProductCommandRequest } from '../supabase/functions/_shared/commands/data_product/types.ts';
import {
  buildLciaResultBuildRequestRpcArgs,
  buildLciaResultPackagePublishRpcArgs,
  buildLciaResultSetCreateRpcArgs,
  buildLciaResultSetListRpcArgs,
  buildLciaResultSetReadRpcArgs,
  buildLciaScopeClosureCheckRequestRpcArgs,
  buildLciaScopeClosureReportDownloadRpcArgs,
  buildTaskSummaryV2FeedRpcArgs,
  callLciaResultPackagePublishRpc,
  callLciaScopeClosureCheckRequestRpc,
  type DataProductRpcResult,
} from '../supabase/functions/_shared/db_rpc/data_product_commands.ts';

const TEST_USER_ID = '22222222-2222-4222-8222-222222222222';
const TEST_BUILD_ID = '33333333-3333-4333-8333-333333333333';
const TEST_WORKER_JOB_ID = '44444444-4444-4444-8444-444444444444';
const TEST_CLOSURE_CHECK_ID = '45454545-4545-4454-8454-454545454545';
const TEST_RESULT_SET_ID = '47474747-4747-4474-8474-474747474747';
const TEST_PACKAGE_ID = '55555555-5555-4555-8555-555555555555';
const TEST_PUBLICATION_ID = '66666666-6666-4666-8666-666666666666';

const fakeActor: ActorContext = {
  userId: TEST_USER_ID,
  accessToken: 'access-token',
  supabase: {
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as unknown as SupabaseClient,
};

class FakeRpcSupabase {
  calls: Array<{ fn: string; args: unknown }> = [];

  constructor(private readonly result: { data: unknown; error: unknown }) {}

  rpc(fn: string, args: unknown) {
    this.calls.push({ fn, args: structuredClone(args) });
    return Promise.resolve(this.result);
  }
}

const auditPayload = buildCommandAuditPayload({
  command: 'lcia_result_build_request',
  actorUserId: TEST_USER_ID,
  targetTable: 'worker_jobs',
  targetId: 'pending',
  targetVersion: '',
  payload: {},
});

const unusedPreviewProjectionDeps = {
  fetchSnapshotArtifactUrl: () => Promise.reject(new Error('not used')),
  fetchJsonArtifact: () => Promise.reject(new Error('not used')),
  fetchArtifactBytes: () => Promise.reject(new Error('not used')),
  fetchPreviewMetadata: () => Promise.reject(new Error('not used')),
};

const unusedClosureCommandDeps = {
  createResultSet: () => Promise.reject(new Error('not used')),
  listResultSets: () => Promise.reject(new Error('not used')),
  getResultSet: () => Promise.reject(new Error('not used')),
  createClosureCheck: () => Promise.reject(new Error('not used')),
  getClosureCheck: () => Promise.reject(new Error('not used')),
  listClosureIssues: () => Promise.reject(new Error('not used')),
  createClosureReportDownload: () => Promise.reject(new Error('not used')),
  listTaskFeed: () => Promise.reject(new Error('not used')),
};

Deno.test('dataProductCommandRequestSchema accepts create_build defaults', () => {
  const parsed = dataProductCommandRequestSchema.safeParse({
    action: 'create_build',
    name: 'June public LCIA results',
    defaultImpactCategory: 'climate-change',
  });

  assertEquals(parsed.success, true);
  if (parsed.success && parsed.data.action === 'create_build') {
    assertEquals(parsed.data.coverageMode, 'global_eligible');
    assertEquals(parsed.data.lciaMethodSet, []);
  }
});

Deno.test('dataProductCommandRequestSchema accepts preview pagination controls', () => {
  const parsed = dataProductCommandRequestSchema.safeParse({
    action: 'preview_package',
    packageId: TEST_PACKAGE_ID,
    impactCategoryId: 'climate-change',
    rowOffset: 25,
    rowLimit: 50,
  });

  assertEquals(parsed.success, true);
});

Deno.test('dataProductCommandRequestSchema accepts publication list controls', () => {
  const parsed = dataProductCommandRequestSchema.safeParse({
    action: 'list_publications',
    limit: 50,
  });

  assertEquals(parsed.success, true);
});

Deno.test(
  'dataProductCommandRequestSchema accepts closure intent without client-created bindings',
  () => {
    const parsed = dataProductCommandRequestSchema.safeParse({
      action: 'create_closure_check',
      requestedScope: {
        coverageMode: 'subset',
        processes: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            version: '01.00.000',
          },
        ],
        lciaMethods: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            version: '01.00.000',
          },
        ],
        linkPolicy: { technosphereBoundaryPolicy: 'closed' },
      },
      requestIdempotencyToken: 'new-check-token',
    });
    assertEquals(parsed.success, true);
  },
);

Deno.test('ResultSet commands accept only the bounded persistent-container fields', () => {
  assertEquals(
    dataProductCommandRequestSchema.safeParse({
      action: 'create_result_set',
      name: 'August calculation set',
    }).success,
    true,
  );
  assertEquals(
    dataProductCommandRequestSchema.safeParse({
      action: 'list_result_sets',
      limit: 50,
    }).success,
    true,
  );
  assertEquals(
    dataProductCommandRequestSchema.safeParse({
      action: 'get_result_set',
      resultSetId: TEST_RESULT_SET_ID,
    }).success,
    true,
  );
  assertEquals(
    dataProductCommandRequestSchema.safeParse({
      action: 'create_result_set',
      name: 'bad',
      coverageMode: 'subset',
    }).success,
    false,
  );
  assertEquals(
    dataProductCommandRequestSchema.safeParse({
      action: 'get_result_set',
      resultSetId: 'not-a-uuid',
    }).success,
    false,
  );
});

Deno.test('ResultSet-aware closure intent preserves legacy compatibility', () => {
  const withResultSet = dataProductCommandRequestSchema.safeParse({
    action: 'create_closure_check',
    resultSetId: TEST_RESULT_SET_ID,
    requestedScope: {
      coverageMode: 'global_eligible',
      lciaMethods: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          version: '01.00.000',
        },
      ],
    },
    requestIdempotencyToken: 'result-set-check',
  });
  assertEquals(withResultSet.success, true);

  const legacy = dataProductCommandRequestSchema.safeParse({
    action: 'create_closure_check',
    requestedScope: {
      coverageMode: 'global_eligible',
      lciaMethods: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          version: '01.00.000',
        },
      ],
    },
    requestIdempotencyToken: 'legacy-check',
  });
  assertEquals(legacy.success, true);
});

Deno.test('ResultSet RPC args expose only the minimal database contract', () => {
  assertEquals(
    buildLciaResultSetCreateRpcArgs({
      action: 'create_result_set',
      name: 'August calculation set',
    }),
    { p_name: 'August calculation set' },
  );
  assertEquals(buildLciaResultSetListRpcArgs({ action: 'list_result_sets' }), { p_limit: 100 });
  assertEquals(
    buildLciaResultSetReadRpcArgs({
      action: 'get_result_set',
      resultSetId: TEST_RESULT_SET_ID,
    }),
    { p_result_set_id: TEST_RESULT_SET_ID },
  );
});

Deno.test('closure RPC selects V3 only when a ResultSet is supplied', async () => {
  const client = new FakeRpcSupabase({
    data: { ok: true, data: { closureCheckId: TEST_CLOSURE_CHECK_ID } },
    error: null,
  });
  const baseRequest = {
    action: 'create_closure_check' as const,
    requestedScope: {
      coverageMode: 'global_eligible' as const,
      lciaMethods: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          version: '01.00.000',
        },
      ],
    },
    requestIdempotencyToken: 'check-token',
  };

  await callLciaScopeClosureCheckRequestRpc(
    client as never,
    { ...baseRequest, resultSetId: TEST_RESULT_SET_ID },
    auditPayload,
  );
  await callLciaScopeClosureCheckRequestRpc(client as never, baseRequest, auditPayload);

  assertEquals(client.calls, [
    {
      fn: 'cmd_lcia_scope_closure_check_request_v3',
      args: {
        p_result_set_id: TEST_RESULT_SET_ID,
        p_requested_scope: baseRequest.requestedScope,
        p_request_idempotency_token: 'check-token',
        p_audit: auditPayload,
      },
    },
    {
      fn: 'cmd_lcia_scope_closure_check_request_v2',
      args: {
        p_requested_scope: baseRequest.requestedScope,
        p_request_idempotency_token: 'check-token',
        p_audit: auditPayload,
      },
    },
  ]);
});

Deno.test('closure download schema requires one of the two public artifact roles', () => {
  for (const artifactRole of ['closure_report_xlsx', 'closure_issue_manifest']) {
    const parsed = dataProductCommandRequestSchema.safeParse({
      action: 'create_closure_report_download',
      closureCheckId: TEST_CLOSURE_CHECK_ID,
      artifactRole,
    });
    assertEquals(parsed.success, true);
  }

  for (const request of [
    {
      action: 'create_closure_report_download',
      closureCheckId: TEST_CLOSURE_CHECK_ID,
    },
    {
      action: 'create_closure_report_download',
      closureCheckId: TEST_CLOSURE_CHECK_ID,
      artifactRole: 'closure_bundle',
    },
    {
      action: 'create_closure_report_download',
      closureCheckId: TEST_CLOSURE_CHECK_ID,
      artifactRole: 'closure_issues_partition_000000',
    },
  ]) {
    assertEquals(dataProductCommandRequestSchema.safeParse(request).success, false);
  }
});

Deno.test('closure download RPC args preserve the exact bounded artifact selector', () => {
  for (const artifactRole of ['closure_report_xlsx', 'closure_issue_manifest'] as const) {
    assertEquals(
      buildLciaScopeClosureReportDownloadRpcArgs({
        action: 'create_closure_report_download',
        closureCheckId: TEST_CLOSURE_CHECK_ID,
        artifactRole,
      }),
      {
        p_closure_check_id: TEST_CLOSURE_CHECK_ID,
        p_artifact_role: artifactRole,
      },
    );
  }
});

Deno.test(
  'dataProductCommandRequestSchema rejects a partial certificate binding on create_build',
  () => {
    const parsed = dataProductCommandRequestSchema.safeParse({
      action: 'create_build',
      name: 'partial binding',
      closureCheckId: TEST_BUILD_ID,
    });
    assertEquals(parsed.success, false);
  },
);

Deno.test(
  'dataProductCommandRequestSchema rejects unknown and unbounded closure-scope fields',
  () => {
    const extraField = dataProductCommandRequestSchema.safeParse({
      action: 'create_closure_check',
      requestedScope: {
        coverageMode: 'global_eligible',
        lciaMethods: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            version: '01.00.000',
          },
        ],
        requestedScopeHash: 'client-must-not-bind-this',
      },
      requestIdempotencyToken: 'token',
    });
    assertEquals(extraField.success, false);

    const oversizedMethods = dataProductCommandRequestSchema.safeParse({
      action: 'create_closure_check',
      requestedScope: {
        coverageMode: 'global_eligible',
        lciaMethods: Array.from({ length: 1_001 }, () => ({
          id: '11111111-1111-4111-8111-111111111111',
          version: '01.00.000',
        })),
      },
      requestIdempotencyToken: 'token',
    });
    assertEquals(oversizedMethods.success, false);
  },
);

Deno.test(
  'closure and task feed RPC args preserve keyset cursor and keep bindings server-derived',
  () => {
    assertEquals(
      buildLciaScopeClosureCheckRequestRpcArgs(
        {
          action: 'create_closure_check',
          requestedScope: {
            coverageMode: 'global_eligible',
            lciaMethods: [
              {
                id: '11111111-1111-4111-8111-111111111111',
                version: '01.00.000',
              },
            ],
          },
          requestIdempotencyToken: 'token',
        },
        auditPayload,
      ),
      {
        p_requested_scope: {
          coverageMode: 'global_eligible',
          lciaMethods: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              version: '01.00.000',
            },
          ],
        },
        p_request_idempotency_token: 'token',
        p_audit: auditPayload,
      },
    );
    assertEquals(
      buildTaskSummaryV2FeedRpcArgs({
        action: 'list_task_feed',
        category: 'data_product',
        cursor: {
          updatedAt: '2026-07-22T00:00:00.000Z',
          jobId: TEST_WORKER_JOB_ID,
        },
        rootOnly: true,
      }),
      {
        p_category: 'data_product',
        p_job_kinds: null,
        p_statuses: null,
        p_updated_since: null,
        p_cursor_updated_at: '2026-07-22T00:00:00.000Z',
        p_cursor_job_id: TEST_WORKER_JOB_ID,
        p_limit: 50,
        p_root_only: true,
      },
    );
  },
);

Deno.test(
  'dataProductCommandRequestSchema rejects package ids on create_build process selections',
  () => {
    const parsed = dataProductCommandRequestSchema.safeParse({
      action: 'create_build',
      name: 'bad selection',
      processes: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          version: '01.00.000',
          packageId: TEST_PACKAGE_ID,
        },
      ],
    });

    assertEquals(parsed.success, false);
  },
);

Deno.test('buildLciaResultBuildRequestRpcArgs maps command payload to DB RPC args', () => {
  const request: DataProductCommandRequest = {
    action: 'create_build',
    name: 'June public LCIA results',
    coverageMode: 'subset',
    defaultImpactCategory: 'climate-change',
    lciaMethodSet: [{ method: 'EF', version: 'v1' }],
    idempotencyKey: 'lcia-result:2026-06',
    processes: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        version: '01.00.000',
      },
    ],
  };

  assertEquals(buildLciaResultBuildRequestRpcArgs(request, auditPayload), {
    p_name: 'June public LCIA results',
    p_processes: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        version: '01.00.000',
      },
    ],
    p_coverage_mode: 'subset',
    p_default_impact_category: 'climate-change',
    p_lcia_method_set: [{ method: 'EF', version: 'v1' }],
    p_idempotency_key: 'lcia-result:2026-06',
    p_audit: auditPayload,
  });
});

Deno.test('buildLciaResultPackagePublishRpcArgs maps publish payload to DB RPC args', () => {
  assertEquals(
    buildLciaResultPackagePublishRpcArgs(
      {
        action: 'publish_package',
        packageId: TEST_PACKAGE_ID,
        displayDefaultImpactCategory: 'climate-change',
        reason: 'June publication',
      },
      auditPayload,
    ),
    {
      p_package_id: TEST_PACKAGE_ID,
      p_display_default_impact_category: 'climate-change',
      p_reason: 'June publication',
      p_audit: auditPayload,
    },
  );
});

Deno.test('callLciaResultPackagePublishRpc treats DB command failures as failures', async () => {
  const result = (await callLciaResultPackagePublishRpc(
    new FakeRpcSupabase({
      data: {
        ok: false,
        code: 'default_impact_missing',
        status: 400,
        message: 'Default impact category is required before publication',
      },
      error: null,
    }) as never,
    {
      action: 'publish_package',
      packageId: TEST_PACKAGE_ID,
      displayDefaultImpactCategory: 'missing-impact',
    },
    auditPayload,
  )) as DataProductRpcResult;

  assertEquals(result, {
    ok: false,
    code: 'default_impact_missing',
    status: 400,
    message: 'Default impact category is required before publication',
  });
});

Deno.test('createDataProductCommandRepository requires an explicit actor Supabase client', () => {
  assertThrows(
    () => createDataProductCommandRepository(undefined as never, {} as never),
    Error,
    'Data product command repository requires an explicit actor Supabase client',
  );
});

Deno.test('ResultSet repository exposes only the versioned safe DTO', async () => {
  const resultSet = {
    schemaVersion: 'lcia.result-set.v1',
    resultSetId: TEST_RESULT_SET_ID,
    name: 'August calculation set',
    createdAt: '2026-08-17T12:00:00.000Z',
  };
  const createClient = new FakeRpcSupabase({
    data: { ok: true, data: resultSet },
    error: null,
  });
  const createRepository = createDataProductCommandRepository(createClient as never, {} as never);
  assertEquals(
    await createRepository.createResultSet({
      action: 'create_result_set',
      name: resultSet.name,
    }),
    { ok: true, data: resultSet },
  );
  assertEquals(createClient.calls, [
    {
      fn: 'cmd_lcia_result_set_create',
      args: { p_name: resultSet.name },
    },
  ]);

  const listRepository = createDataProductCommandRepository(
    new FakeRpcSupabase({
      data: { ok: true, data: { items: [resultSet] } },
      error: null,
    }) as never,
    {} as never,
  );
  assertEquals(await listRepository.listResultSets({ action: 'list_result_sets' }), {
    ok: true,
    data: { items: [resultSet] },
  });

  const invalidRepository = createDataProductCommandRepository(
    new FakeRpcSupabase({
      data: {
        ok: true,
        data: { ...resultSet, ownerId: TEST_USER_ID },
      },
      error: null,
    }) as never,
    {} as never,
  );
  assertEquals(
    await invalidRepository.getResultSet({
      action: 'get_result_set',
      resultSetId: TEST_RESULT_SET_ID,
    }),
    {
      ok: false,
      code: 'result_set_projection_invalid',
      status: 502,
      message: 'Result set projection is invalid',
    },
  );
});

Deno.test('createDataProductCommandRepository enqueues LCIA result package payloads', async () => {
  const serviceClient = new FakeRpcSupabase({
    data: {
      ok: true,
      data: {
        id: TEST_WORKER_JOB_ID,
        status: 'queued',
      },
    },
    error: null,
  });
  const repository = createDataProductCommandRepository(
    new FakeRpcSupabase({ data: null, error: null }) as never,
    serviceClient as never,
  );

  const result = await repository.enqueuePackageBuild(
    {
      buildId: TEST_BUILD_ID,
      idempotencyKey: `lcia_result.package_build:${TEST_BUILD_ID}`,
      workerJob: {
        jobKind: 'lcia_result.package_build',
        payload: {
          type: 'lcia_result_package_build',
          build_id: TEST_BUILD_ID,
          requested_by: TEST_USER_ID,
          coverage_mode: 'global_eligible',
          default_impact_category: 'climate-change',
          lcia_method_set: [],
        },
        payloadSchemaVersion: 'lcia_result.package_build.request.v1',
        subjectType: 'lcia_result_build',
        subjectId: TEST_BUILD_ID,
        subjectVersion: null,
        requestedBy: TEST_USER_ID,
        requesterType: 'operator',
        requestHash: 'manifest-hash',
        queueKey: TEST_BUILD_ID,
        visibility: 'operator',
      },
    },
    fakeActor,
  );

  assertEquals(result, {
    ok: true,
    workerJobId: TEST_WORKER_JOB_ID,
    data: {
      id: TEST_WORKER_JOB_ID,
      status: 'queued',
    },
  });
  assertEquals(serviceClient.calls, [
    {
      fn: 'svc_worker_enqueue_job',
      args: {
        p_job_kind: 'lcia_result.package_build',
        p_payload_json: {
          type: 'lcia_result_package_build',
          build_id: TEST_BUILD_ID,
          requested_by: TEST_USER_ID,
          coverage_mode: 'global_eligible',
          default_impact_category: 'climate-change',
          lcia_method_set: [],
        },
        p_payload_schema_version: 'lcia_result.package_build.request.v1',
        p_subject_type: 'lcia_result_build',
        p_subject_id: TEST_BUILD_ID,
        p_subject_version: null,
        p_requested_by: TEST_USER_ID,
        p_requester_type: 'operator',
        p_team_id: null,
        p_idempotency_key: `lcia_result.package_build:${TEST_BUILD_ID}`,
        p_request_hash: 'manifest-hash',
        p_concurrency_key: null,
        p_priority: null,
        p_queue_key: TEST_BUILD_ID,
        p_run_after: null,
        p_visibility: 'operator',
        p_max_attempts: null,
        p_timeout_at: null,
        p_payload_ref: null,
        p_parent_job_id: null,
        p_root_job_id: null,
      },
    },
  ]);
});

function closureDownloadDescriptor(overrides: Record<string, unknown> = {}) {
  return {
    artifactId: TEST_BUILD_ID,
    artifactRole: 'closure_report_xlsx',
    artifactState: 'ready',
    filename: `scope-closure-${TEST_CLOSURE_CHECK_ID}.xlsx`,
    format: 'xlsx',
    mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: 42,
    checksumSha256: 'a'.repeat(64),
    artifactExpiresAt: '2099-07-29T00:00:00.000Z',
    bucket: 'private-reports',
    objectPath: 'reports/check.xlsx',
    ...overrides,
  };
}

function assertFailureContainsNone(result: unknown, sourceValues: string[]) {
  const serialized = JSON.stringify(result);
  for (const sourceValue of sourceValues) {
    assertEquals(serialized.includes(sourceValue), false);
  }
  for (const forbiddenKey of [
    'bucket',
    'objectPath',
    'storagePath',
    'credentials',
    'serviceCredential',
    'details',
  ]) {
    assertEquals(serialized.includes(forbiddenKey), false);
  }
}

Deno.test(
  'closure-check read preserves the exact fixed-order locator-free artifacts projection',
  async () => {
    const data = {
      schemaVersion: 'lcia.scope-closure-check.v1',
      closureCheckId: TEST_CLOSURE_CHECK_ID,
      runStatus: 'passed',
      scanCompleteness: 'complete',
      certificateValidity: 'valid',
      workerJob: {
        jobId: TEST_WORKER_JOB_ID,
        status: 'completed',
        phase: 'finished',
        internalTrace: 'must-not-cross-the-public-allowlist',
      },
      internalDebug: { harmlessButPrivate: true },
      artifacts: [
        {
          artifactRole: 'closure_report_xlsx',
          artifactState: 'ready',
          filename: `scope-closure-${TEST_CLOSURE_CHECK_ID}.xlsx`,
          format: 'xlsx',
          mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          size: 42,
          checksumSha256: 'a'.repeat(64),
          artifactExpiresAt: '2099-07-29T00:00:00.000Z',
        },
        {
          artifactRole: 'closure_issue_manifest',
          artifactState: 'pending',
          filename: `scope-closure-${TEST_CLOSURE_CHECK_ID}-manifest.json`,
          format: 'json',
          mediaType: 'application/vnd.tiangong.scope-closure-manifest+json',
          size: null,
          checksumSha256: null,
          artifactExpiresAt: null,
        },
      ],
    };
    const actorClient = new FakeRpcSupabase({
      data: { ok: true, data },
      error: null,
    });
    const repository = createDataProductCommandRepository(actorClient as never, {} as never);

    assertEquals(
      await repository.getClosureCheck({
        action: 'get_closure_check',
        closureCheckId: TEST_CLOSURE_CHECK_ID,
      }),
      {
        ok: true,
        data: {
          schemaVersion: 'lcia.scope-closure-check.v1',
          closureCheckId: TEST_CLOSURE_CHECK_ID,
          runStatus: 'passed',
          scanCompleteness: 'complete',
          certificateValidity: 'valid',
          workerJob: {
            jobId: TEST_WORKER_JOB_ID,
            status: 'completed',
            phase: 'finished',
          },
          artifacts: data.artifacts,
        },
      },
    );
    assertEquals(actorClient.calls, [
      {
        fn: 'get_lcia_scope_closure_check',
        args: { p_closure_check_id: TEST_CLOSURE_CHECK_ID },
      },
    ]);
    assertEquals(JSON.stringify(data).includes('bucket'), false);
    assertEquals(JSON.stringify(data).includes('objectPath'), false);
  },
);

Deno.test(
  'closure-check read rejects malformed or locator-bearing artifact summaries',
  async () => {
    const validArtifacts = [
      {
        artifactRole: 'closure_report_xlsx',
        artifactState: 'ready',
        filename: `scope-closure-${TEST_CLOSURE_CHECK_ID}.xlsx`,
        format: 'xlsx',
        mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: 42,
        checksumSha256: 'a'.repeat(64),
        artifactExpiresAt: '2099-07-29T00:00:00.000Z',
      },
      {
        artifactRole: 'closure_issue_manifest',
        artifactState: 'pending',
        filename: `scope-closure-${TEST_CLOSURE_CHECK_ID}-manifest.json`,
        format: 'json',
        mediaType: 'application/vnd.tiangong.scope-closure-manifest+json',
        size: null,
        checksumSha256: null,
        artifactExpiresAt: null,
      },
    ];
    const malformedArtifacts = [
      validArtifacts.slice(0, 1),
      [...validArtifacts].reverse(),
      [{ ...validArtifacts[0], artifactId: TEST_BUILD_ID }, validArtifacts[1]],
      [{ ...validArtifacts[0], bucket: 'private-reports' }, validArtifacts[1]],
      [{ ...validArtifacts[0], objectPath: 'reports/check.xlsx' }, validArtifacts[1]],
      [{ ...validArtifacts[0], checksumSha256: 'invalid' }, validArtifacts[1]],
      [validArtifacts[0], { ...validArtifacts[1], artifactState: 'ready' }],
    ];
    const baseProjection = {
      schemaVersion: 'lcia.scope-closure-check.v1',
      closureCheckId: TEST_CLOSURE_CHECK_ID,
      artifacts: validArtifacts,
    };
    const privateProjections = [
      { ...baseProjection, bucket: 'top-level-private-bucket' },
      {
        ...baseProjection,
        summary: { nested: { objectPath: 'reports/private-summary.xlsx' } },
      },
      {
        ...baseProjection,
        workerJob: {
          jobId: TEST_WORKER_JOB_ID,
          storagePath: 'private/worker/job.json',
        },
      },
      {
        ...baseProjection,
        summary: {
          groups: [
            {
              children: [{ serviceCredential: 'service-role-secret' }],
            },
          ],
        },
      },
    ];

    for (const artifacts of malformedArtifacts) {
      const repository = createDataProductCommandRepository(
        new FakeRpcSupabase({
          data: {
            ok: true,
            data: {
              schemaVersion: 'lcia.scope-closure-check.v1',
              closureCheckId: TEST_CLOSURE_CHECK_ID,
              artifacts,
            },
          },
          error: null,
        }) as never,
        {} as never,
      );
      assertEquals(
        await repository.getClosureCheck({
          action: 'get_closure_check',
          closureCheckId: TEST_CLOSURE_CHECK_ID,
        }),
        {
          ok: false,
          code: 'closure_check_projection_invalid',
          status: 502,
          message: 'Closure check projection is invalid',
        },
      );
    }

    for (const projection of privateProjections) {
      const repository = createDataProductCommandRepository(
        new FakeRpcSupabase({
          data: { ok: true, data: projection },
          error: null,
        }) as never,
        {} as never,
      );
      const result = await repository.getClosureCheck({
        action: 'get_closure_check',
        closureCheckId: TEST_CLOSURE_CHECK_ID,
      });
      assertEquals(result, {
        ok: false,
        code: 'closure_check_projection_invalid',
        status: 502,
        message: 'Closure check projection is invalid',
      });
      assertFailureContainsNone(result, [
        'top-level-private-bucket',
        'reports/private-summary.xlsx',
        'private/worker/job.json',
        'service-role-secret',
      ]);
    }
  },
);

Deno.test(
  'closure artifact download rejects malformed or unsupported database descriptors before signing',
  async () => {
    const malformedDescriptors = [
      closureDownloadDescriptor({ size: null }),
      closureDownloadDescriptor({ size: '42' }),
      closureDownloadDescriptor({ checksumSha256: 'abc' }),
      closureDownloadDescriptor({ filename: '../check.xlsx' }),
      closureDownloadDescriptor({ artifactExpiresAt: 'not-a-timestamp' }),
      closureDownloadDescriptor({ artifactState: 'unknown' }),
      closureDownloadDescriptor({
        artifactRole: 'closure_bundle',
        format: 'json',
      }),
      closureDownloadDescriptor({
        artifactRole: 'closure_issues_partition_000000',
        filename: `scope-closure-${TEST_CLOSURE_CHECK_ID}-issues-000000.ndjson.zst`,
        format: 'ndjson+zstd',
        mediaType: 'application/x-ndjson+zstd',
      }),
      closureDownloadDescriptor({
        artifactRole: 'closure_issue_manifest',
        filename: `scope-closure-${TEST_CLOSURE_CHECK_ID}-manifest.json`,
        format: 'json',
        mediaType: 'application/vnd.tiangong.scope-closure-manifest+json',
      }),
      closureDownloadDescriptor({ format: 'json' }),
      closureDownloadDescriptor({ bucket: '' }),
      closureDownloadDescriptor({ objectPath: null }),
      {
        ...closureDownloadDescriptor(),
        serviceCredential: 'must-not-cross-the-boundary',
      },
    ];

    for (const descriptor of malformedDescriptors) {
      const actorClient = new FakeRpcSupabase({
        data: { ok: true, data: descriptor },
        error: null,
      });
      const repository = createDataProductCommandRepository(
        actorClient as never,
        {
          storage: {
            from: () => ({
              createSignedUrl: () =>
                Promise.reject(new Error('must not sign an invalid descriptor')),
            }),
          },
        } as never,
      );

      assertEquals(
        await repository.createClosureReportDownload({
          action: 'create_closure_report_download',
          closureCheckId: TEST_CLOSURE_CHECK_ID,
          artifactRole: 'closure_report_xlsx',
        }),
        {
          ok: false,
          code: 'closure_report_descriptor_invalid',
          status: 502,
          message: 'Closure report descriptor is invalid',
        },
      );
      assertEquals(actorClient.calls[0], {
        fn: 'get_lcia_scope_closure_report_download',
        args: {
          p_closure_check_id: TEST_CLOSURE_CHECK_ID,
          p_artifact_role: 'closure_report_xlsx',
        },
      });
    }
  },
);

Deno.test(
  'closure report download signs the ready actor-authorized XLSX descriptor with a semantic filename',
  async () => {
    const actorClient = new FakeRpcSupabase({
      data: { ok: true, data: closureDownloadDescriptor() },
      error: null,
    });
    const signingCalls: Array<{
      bucket: string;
      objectPath: string;
      expiresIn: number;
      options: unknown;
    }> = [];
    const repository = createDataProductCommandRepository(
      actorClient as never,
      {
        storage: {
          from: (bucket: string) => ({
            createSignedUrl: (objectPath: string, expiresIn: number, options: unknown) => {
              signingCalls.push({ bucket, objectPath, expiresIn, options });
              return Promise.resolve({
                data: { signedUrl: 'https://signed.example/report' },
                error: null,
              });
            },
          }),
        },
      } as never,
    );

    const result = await repository.createClosureReportDownload({
      action: 'create_closure_report_download',
      closureCheckId: TEST_CLOSURE_CHECK_ID,
      artifactRole: 'closure_report_xlsx',
    });

    assertEquals(signingCalls, [
      {
        bucket: 'private-reports',
        objectPath: 'reports/check.xlsx',
        expiresIn: 900,
        options: { download: `scope-closure-${TEST_CLOSURE_CHECK_ID}.xlsx` },
      },
    ]);
    assertEquals(result.ok, true);
    if (!result.ok) {
      throw new Error('expected a signed closure report');
    }
    const resultData = result.data as Record<string, unknown>;
    const { signedUrlExpiresAt, ...stableResultData } = resultData;
    assertEquals(typeof signedUrlExpiresAt, 'string');
    assertEquals(stableResultData, {
      artifactId: TEST_BUILD_ID,
      artifactRole: 'closure_report_xlsx',
      artifactState: 'ready',
      filename: `scope-closure-${TEST_CLOSURE_CHECK_ID}.xlsx`,
      format: 'xlsx',
      mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: 42,
      checksumSha256: 'a'.repeat(64),
      artifactExpiresAt: '2099-07-29T00:00:00.000Z',
      signedDownloadUrl: 'https://signed.example/report',
      expiresInSeconds: 900,
    });
    assertEquals('bucket' in resultData, false);
    assertEquals('objectPath' in resultData, false);
  },
);

Deno.test('closure artifact download supports the complete-machine manifest role', async () => {
  const descriptor = closureDownloadDescriptor({
    artifactRole: 'closure_issue_manifest',
    filename: `scope-closure-${TEST_CLOSURE_CHECK_ID}-manifest.json`,
    format: 'json',
    mediaType: 'application/vnd.tiangong.scope-closure-manifest+json',
    objectPath: 'reports/manifest.json',
  });
  const actorClient = new FakeRpcSupabase({
    data: { ok: true, data: descriptor },
    error: null,
  });
  const signingCalls: unknown[] = [];
  const repository = createDataProductCommandRepository(
    actorClient as never,
    {
      storage: {
        from: (bucket: string) => ({
          createSignedUrl: (objectPath: string, expiresIn: number, options: unknown) => {
            signingCalls.push({ bucket, objectPath, expiresIn, options });
            return Promise.resolve({
              data: { signedUrl: 'https://signed.example/machine-artifact' },
              error: null,
            });
          },
        }),
      },
    } as never,
  );

  const result = await repository.createClosureReportDownload({
    action: 'create_closure_report_download',
    closureCheckId: TEST_CLOSURE_CHECK_ID,
    artifactRole: 'closure_issue_manifest',
  });

  assertEquals(result.ok, true);
  if (!result.ok) {
    throw new Error('expected a signed closure manifest');
  }
  const resultData = result.data as Record<string, unknown>;
  const { signedUrlExpiresAt, ...stableResultData } = resultData;
  assertEquals(typeof signedUrlExpiresAt, 'string');
  assertEquals(stableResultData, {
    artifactId: TEST_BUILD_ID,
    artifactRole: 'closure_issue_manifest',
    artifactState: 'ready',
    filename: `scope-closure-${TEST_CLOSURE_CHECK_ID}-manifest.json`,
    format: 'json',
    mediaType: 'application/vnd.tiangong.scope-closure-manifest+json',
    size: 42,
    checksumSha256: 'a'.repeat(64),
    artifactExpiresAt: '2099-07-29T00:00:00.000Z',
    signedDownloadUrl: 'https://signed.example/machine-artifact',
    expiresInSeconds: 900,
  });
  assertEquals('bucket' in resultData, false);
  assertEquals('objectPath' in resultData, false);
  assertEquals(actorClient.calls, [
    {
      fn: 'get_lcia_scope_closure_report_download',
      args: {
        p_closure_check_id: TEST_CLOSURE_CHECK_ID,
        p_artifact_role: 'closure_issue_manifest',
      },
    },
  ]);
  assertEquals(signingCalls, [
    {
      bucket: descriptor.bucket,
      objectPath: descriptor.objectPath,
      expiresIn: 900,
      options: { download: descriptor.filename },
    },
  ]);
});

Deno.test(
  'closure artifact download caps URL lifetime at artifact expiry and maps expiry to 410',
  async () => {
    const initialNowMs = Date.parse('2099-07-29T00:00:00.000Z');
    let nowMs = initialNowMs;
    const soonExpiresAt = new Date(initialNowMs + 120_000).toISOString();
    let signedTtl = 0;
    const repository = createDataProductCommandRepository(
      new FakeRpcSupabase({
        data: {
          ok: true,
          data: closureDownloadDescriptor({ artifactExpiresAt: soonExpiresAt }),
        },
        error: null,
      }) as never,
      {
        storage: {
          from: () => ({
            createSignedUrl: (_objectPath: string, expiresIn: number) => {
              signedTtl = expiresIn;
              nowMs += 4_000;
              return Promise.resolve({
                data: { signedUrl: 'https://signed.example/report' },
                error: null,
              });
            },
          }),
        },
      } as never,
      { now: () => nowMs },
    );

    const result = await repository.createClosureReportDownload({
      action: 'create_closure_report_download',
      closureCheckId: TEST_CLOSURE_CHECK_ID,
      artifactRole: 'closure_report_xlsx',
    });
    assertEquals(result.ok, true);
    assertEquals(signedTtl, 115);
    if (result.ok) {
      const data = result.data as Record<string, unknown>;
      assertEquals(data.expiresInSeconds, signedTtl);
      assertEquals(data.signedUrlExpiresAt, new Date(initialNowMs + 119_000).toISOString());
      assertEquals(Date.parse(String(data.signedUrlExpiresAt)) < Date.parse(soonExpiresAt), true);
    }

    let delayedNowMs = initialNowMs;
    const delayedRepository = createDataProductCommandRepository(
      new FakeRpcSupabase({
        data: {
          ok: true,
          data: closureDownloadDescriptor({ artifactExpiresAt: soonExpiresAt }),
        },
        error: null,
      }) as never,
      {
        storage: {
          from: () => ({
            createSignedUrl: () => {
              delayedNowMs += 6_000;
              return Promise.resolve({
                data: {
                  signedUrl: 'https://signed.example/must-not-be-returned',
                },
                error: null,
              });
            },
          }),
        },
      } as never,
      { now: () => delayedNowMs },
    );
    const delayedResult = await delayedRepository.createClosureReportDownload({
      action: 'create_closure_report_download',
      closureCheckId: TEST_CLOSURE_CHECK_ID,
      artifactRole: 'closure_report_xlsx',
    });
    assertEquals(delayedResult, {
      ok: false,
      code: 'closure_report_expired',
      status: 410,
      message: 'Closure report has expired',
    });
    assertFailureContainsNone(delayedResult, ['must-not-be-returned']);

    let nearExpirySigningCalled = false;
    const nearExpiryRepository = createDataProductCommandRepository(
      new FakeRpcSupabase({
        data: {
          ok: true,
          data: closureDownloadDescriptor({
            artifactExpiresAt: new Date(initialNowMs + 5_999).toISOString(),
          }),
        },
        error: null,
      }) as never,
      {
        storage: {
          from: () => ({
            createSignedUrl: () => {
              nearExpirySigningCalled = true;
              return Promise.resolve({
                data: { signedUrl: 'https://signed.example/near-expiry' },
                error: null,
              });
            },
          }),
        },
      } as never,
      { now: () => initialNowMs },
    );
    assertEquals(
      await nearExpiryRepository.createClosureReportDownload({
        action: 'create_closure_report_download',
        closureCheckId: TEST_CLOSURE_CHECK_ID,
        artifactRole: 'closure_report_xlsx',
      }),
      {
        ok: false,
        code: 'closure_report_expired',
        status: 410,
        message: 'Closure report has expired',
      },
    );
    assertEquals(nearExpirySigningCalled, false);

    for (const descriptor of [
      closureDownloadDescriptor({
        artifactState: 'expired',
        artifactExpiresAt: '2020-01-01T00:00:00.000Z',
      }),
      closureDownloadDescriptor({
        artifactExpiresAt: '2020-01-01T00:00:00.000Z',
      }),
    ]) {
      const expiredRepository = createDataProductCommandRepository(
        new FakeRpcSupabase({
          data: { ok: true, data: descriptor },
          error: null,
        }) as never,
        {
          storage: {
            from: () => ({
              createSignedUrl: () =>
                Promise.reject(new Error('expired artifacts must not be signed')),
            }),
          },
        } as never,
      );
      assertEquals(
        await expiredRepository.createClosureReportDownload({
          action: 'create_closure_report_download',
          closureCheckId: TEST_CLOSURE_CHECK_ID,
          artifactRole: 'closure_report_xlsx',
        }),
        {
          ok: false,
          code: 'closure_report_expired',
          status: 410,
          message: 'Closure report has expired',
        },
      );
    }

    const databaseExpiredRepository = createDataProductCommandRepository(
      new FakeRpcSupabase({
        data: {
          ok: false,
          code: 'closure_report_expired',
          status: 410,
          message: 'database-owned expiry detail',
        },
        error: null,
      }) as never,
      {} as never,
    );
    assertEquals(
      await databaseExpiredRepository.createClosureReportDownload({
        action: 'create_closure_report_download',
        closureCheckId: TEST_CLOSURE_CHECK_ID,
        artifactRole: 'closure_report_xlsx',
      }),
      {
        ok: false,
        code: 'closure_report_expired',
        status: 410,
        message: 'Closure report has expired',
      },
    );
  },
);

Deno.test(
  'closure artifact download keeps unauthorized, unavailable, deleted, and unready outcomes opaque',
  async () => {
    for (const failure of [
      {
        ok: false,
        code: 'closure_check_not_found',
        status: 404,
        message: 'not found',
      },
      {
        ok: false,
        code: 'not_data_product_manager',
        status: 403,
        message: 'forbidden',
      },
      {
        ok: false,
        code: 'closure_report_unavailable',
        status: 404,
        message: 'integrity failure',
      },
    ]) {
      const repository = createDataProductCommandRepository(
        new FakeRpcSupabase({ data: failure, error: null }) as never,
        {} as never,
      );
      assertEquals(
        await repository.createClosureReportDownload({
          action: 'create_closure_report_download',
          closureCheckId: TEST_CLOSURE_CHECK_ID,
          artifactRole: 'closure_report_xlsx',
        }),
        {
          ok: false,
          code: 'closure_report_unavailable',
          status: 404,
          message: 'Closure report is not available',
        },
      );
    }

    for (const artifactState of ['pending', 'deleted', 'failed']) {
      const repository = createDataProductCommandRepository(
        new FakeRpcSupabase({
          data: {
            ok: true,
            data: closureDownloadDescriptor({ artifactState }),
          },
          error: null,
        }) as never,
        {
          storage: {
            from: () => ({
              createSignedUrl: () =>
                Promise.reject(new Error('unavailable artifacts must not be signed')),
            }),
          },
        } as never,
      );
      assertEquals(
        await repository.createClosureReportDownload({
          action: 'create_closure_report_download',
          closureCheckId: TEST_CLOSURE_CHECK_ID,
          artifactRole: 'closure_report_xlsx',
        }),
        {
          ok: false,
          code: 'closure_report_unavailable',
          status: 404,
          message: 'Closure report is not available',
        },
      );
    }
  },
);

Deno.test(
  'closure artifact DB and RPC failures return a stable 502 without source leakage',
  async () => {
    const sourceValues = [
      'private-db-bucket',
      'private/db/object.xlsx',
      'service-role-db-secret',
      'PGRST source rejection',
    ];
    const actorClients = [
      new FakeRpcSupabase({
        data: null,
        error: {
          code: 'PGRST202',
          message: `PGRST source rejection bucket=${sourceValues[0]}`,
          details: {
            objectPath: sourceValues[1],
            credentials: sourceValues[2],
          },
        },
      }),
      new FakeRpcSupabase({
        data: {
          ok: false,
          code: 'unknown_closure_failure',
          status: 500,
          message: `PGRST source rejection bucket=${sourceValues[0]}`,
          details: {
            objectPath: sourceValues[1],
            credentials: sourceValues[2],
          },
        },
        error: null,
      }),
      {
        rpc: () =>
          Promise.reject(
            new Error(
              `PGRST source rejection ${sourceValues[0]}/${sourceValues[1]} ${sourceValues[2]}`,
            ),
          ),
      },
      {
        rpc: () => {
          throw new Error(
            `PGRST source rejection ${sourceValues[0]}/${sourceValues[1]} ${sourceValues[2]}`,
          );
        },
      },
    ];

    for (const actorClient of actorClients) {
      const repository = createDataProductCommandRepository(actorClient as never, {} as never);
      const result = await repository.createClosureReportDownload({
        action: 'create_closure_report_download',
        closureCheckId: TEST_CLOSURE_CHECK_ID,
        artifactRole: 'closure_report_xlsx',
      });
      assertEquals(result, {
        ok: false,
        code: 'closure_report_backend_failed',
        status: 502,
        message: 'Unable to resolve closure report download',
      });
      assertFailureContainsNone(result, sourceValues);
    }
  },
);

Deno.test(
  'closure artifact signing failures return a stable 502 without locator leakage',
  async () => {
    const sourceValues = [
      'private-storage-bucket',
      'private/storage/object.xlsx',
      'service-role-storage-secret',
      'Storage source failure',
    ];
    const storageClients = [
      {
        storage: {
          from: () => ({
            createSignedUrl: () =>
              Promise.resolve({
                data: null,
                error: {
                  message: `Storage source failure ${sourceValues.join(' ')}`,
                },
              }),
          }),
        },
      },
      {
        storage: {
          from: () => ({
            createSignedUrl: () =>
              Promise.reject(new Error(`Storage source failure ${sourceValues.join(' ')}`)),
          }),
        },
      },
      {
        storage: {
          from: () => ({
            createSignedUrl: () => {
              throw new Error(`Storage source failure ${sourceValues.join(' ')}`);
            },
          }),
        },
      },
      {
        storage: {
          from: () => {
            throw new Error(`Storage source failure ${sourceValues.join(' ')}`);
          },
        },
      },
      {
        storage: {
          from: () => ({
            createSignedUrl: () =>
              Promise.resolve({
                data: { signedUrl: '' },
                error: null,
              }),
          }),
        },
      },
      {
        storage: {
          from: () => ({
            createSignedUrl: () =>
              Promise.resolve({
                data: {
                  signedUrl: `not-a-url ${sourceValues.join(' ')}`,
                },
                error: null,
              }),
          }),
        },
      },
    ];

    for (const serviceClient of storageClients) {
      const repository = createDataProductCommandRepository(
        new FakeRpcSupabase({
          data: { ok: true, data: closureDownloadDescriptor() },
          error: null,
        }) as never,
        serviceClient as never,
      );
      const result = await repository.createClosureReportDownload({
        action: 'create_closure_report_download',
        closureCheckId: TEST_CLOSURE_CHECK_ID,
        artifactRole: 'closure_report_xlsx',
      });
      assertEquals(result, {
        ok: false,
        code: 'closure_report_sign_failed',
        status: 502,
        message: 'Unable to create closure report download',
      });
      assertFailureContainsNone(result, sourceValues);
    }
  },
);

Deno.test(
  'executeDataProductCommand create_build enqueues package build and returns workerJobId',
  async () => {
    const calls: string[] = [];
    const repository: DataProductCommandRepository = {
      createBuild: () => {
        calls.push('createBuild');
        return Promise.resolve({
          ok: true,
          data: {
            buildId: TEST_BUILD_ID,
            coverageMode: 'global_eligible',
            eligibleInputCount: 2,
            includedInputCount: 2,
            inputManifestHash: 'manifest-hash',
            workerJob: {
              jobKind: 'lcia_result.package_build',
              payload: {
                type: 'lcia_result_package_build',
                build_id: TEST_BUILD_ID,
              },
              payloadSchemaVersion: 'lcia_result.package_build.request.v1',
              subjectType: 'lcia_result_build',
              subjectId: TEST_BUILD_ID,
              subjectVersion: null,
              requestedBy: TEST_USER_ID,
              requesterType: 'operator',
              requestHash: 'manifest-hash',
              queueKey: TEST_BUILD_ID,
              visibility: 'operator',
            },
          },
        });
      },
      enqueuePackageBuild: (request, actor) => {
        calls.push('enqueuePackageBuild');
        assertEquals(actor.userId, TEST_USER_ID);
        assertEquals(request.buildId, TEST_BUILD_ID);
        assertEquals(request.idempotencyKey, `lcia_result.package_build:${TEST_BUILD_ID}`);
        return Promise.resolve({
          ok: true,
          workerJobId: TEST_WORKER_JOB_ID,
          data: { id: TEST_WORKER_JOB_ID },
        });
      },
      previewPackage: () => Promise.reject(new Error('not used')),
      ...unusedPreviewProjectionDeps,
      ...unusedClosureCommandDeps,
      publishPackage: () => Promise.reject(new Error('not used')),
      unpublishPublication: () => Promise.reject(new Error('not used')),
      listPublications: () => Promise.reject(new Error('not used')),
    };

    const result = await executeDataProductCommand(
      {
        action: 'create_build',
        name: 'June public LCIA results',
        coverageMode: 'global_eligible',
        defaultImpactCategory: 'climate-change',
        lciaMethodSet: [],
      },
      fakeActor,
      repository,
    );

    assertEquals(calls, ['createBuild', 'enqueuePackageBuild']);
    assertEquals(result, {
      ok: true,
      status: 200,
      body: {
        ok: true,
        command: 'lcia_result_build_request',
        data: {
          buildId: TEST_BUILD_ID,
          coverageMode: 'global_eligible',
          eligibleInputCount: 2,
          includedInputCount: 2,
          inputManifestHash: 'manifest-hash',
          workerJob: {
            jobKind: 'lcia_result.package_build',
            payload: {
              type: 'lcia_result_package_build',
              build_id: TEST_BUILD_ID,
            },
            payloadSchemaVersion: 'lcia_result.package_build.request.v1',
            subjectType: 'lcia_result_build',
            subjectId: TEST_BUILD_ID,
            subjectVersion: null,
            requestedBy: TEST_USER_ID,
            requesterType: 'operator',
            requestHash: 'manifest-hash',
            queueKey: TEST_BUILD_ID,
            visibility: 'operator',
          },
          workerJobId: TEST_WORKER_JOB_ID,
        },
      },
    });
  },
);

Deno.test(
  'executeDataProductCommand create_build does not enqueue a second job when Build V2 persisted it atomically',
  async () => {
    const calls: string[] = [];
    const repository: DataProductCommandRepository = {
      createBuild: () => {
        calls.push('createBuild');
        return Promise.resolve({
          ok: true,
          data: {
            buildId: TEST_BUILD_ID,
            workerJobId: TEST_WORKER_JOB_ID,
            workerJob: { jobId: TEST_WORKER_JOB_ID, status: 'queued' },
            closureCheckId: TEST_CLOSURE_CHECK_ID,
          },
        });
      },
      enqueuePackageBuild: () =>
        Promise.reject(new Error('must not double-enqueue persisted Build V2 job')),
      previewPackage: () => Promise.reject(new Error('not used')),
      ...unusedPreviewProjectionDeps,
      ...unusedClosureCommandDeps,
      publishPackage: () => Promise.reject(new Error('not used')),
      unpublishPublication: () => Promise.reject(new Error('not used')),
      listPublications: () => Promise.reject(new Error('not used')),
    };

    const result = await executeDataProductCommand(
      {
        action: 'create_build',
        name: 'Closure-bound public LCIA results',
        coverageMode: 'global_eligible',
        defaultImpactCategory: 'climate-change',
        lciaMethodSet: [],
        closureCheckId: TEST_CLOSURE_CHECK_ID,
        requestedScopeHash: 'server-owned-scope-hash',
        policyFingerprint: 'server-owned-policy-fingerprint',
      },
      fakeActor,
      repository,
    );

    assertEquals(calls, ['createBuild']);
    assertEquals(result, {
      ok: true,
      status: 200,
      body: {
        ok: true,
        command: 'lcia_result_build_request',
        data: {
          buildId: TEST_BUILD_ID,
          workerJobId: TEST_WORKER_JOB_ID,
          workerJob: { jobId: TEST_WORKER_JOB_ID, status: 'queued' },
          closureCheckId: TEST_CLOSURE_CHECK_ID,
        },
      },
    });
  },
);

Deno.test(
  'executeDataProductCommand preview_package returns enriched result detail rows',
  async () => {
    const testSnapshotId = '77777777-7777-4777-8777-777777777777';
    const testProcessId = '88888888-8888-4888-8888-888888888888';
    const repository: DataProductCommandRepository = {
      createBuild: () => Promise.reject(new Error('not used')),
      enqueuePackageBuild: () => Promise.reject(new Error('not used')),
      previewPackage: () =>
        Promise.resolve({
          ok: true,
          data: {
            summary: {
              packageId: TEST_PACKAGE_ID,
              snapshotId: testSnapshotId,
              defaultImpactCategory: 'impact-climate',
            },
            inputManifest: {
              processes: [
                {
                  id: testProcessId,
                  version: '01.00.000',
                  stateCode: 100,
                },
              ],
            },
            queryArtifact: {
              artifactUrl: 's3://lca-artifacts/results/query-sidecar.json',
            },
          },
        }),
      fetchSnapshotArtifactUrl: (snapshotId) => {
        assertEquals(snapshotId, testSnapshotId);
        return Promise.resolve({
          ok: true,
          data: {
            snapshotId,
            artifactUrl: 's3://lca-artifacts/snapshots/snapshot/sparse.h5',
          },
        });
      },
      fetchJsonArtifact: <T>(artifactUrl: string) => {
        if (artifactUrl.endsWith('snapshot-index-v1.json')) {
          const data = {
            version: 1,
            snapshot_id: testSnapshotId,
            process_count: 1,
            impact_count: 1,
            process_map: [
              {
                process_id: testProcessId,
                process_version: '01.00.000',
                process_index: 0,
              },
            ],
            impact_map: [
              {
                impact_id: 'impact-climate',
                impact_version: '01.00.000',
                impact_key: 'climate-change',
                impact_index: 0,
                impact_name: 'Climate change',
                unit: 'kg CO2 eq',
              },
            ],
          };
          return Promise.resolve({
            ok: true,
            data: data as T,
          });
        }
        assertEquals(artifactUrl, 's3://lca-artifacts/results/query-sidecar.json');
        const data = {
          version: 1,
          format: 'all-unit-query:v1',
          snapshot_id: testSnapshotId,
          job_id: TEST_BUILD_ID,
          process_count: 1,
          impact_count: 1,
          h_matrix: [[42]],
        };
        return Promise.resolve({
          ok: true,
          data: data as T,
        });
      },
      fetchArtifactBytes: () => Promise.reject(new Error('not used for v1 query artifacts')),
      fetchPreviewMetadata: (request) => {
        assertEquals(request, {
          processes: [
            {
              processId: testProcessId,
              processVersion: '01.00.000',
            },
          ],
          impactCategoryIds: ['impact-climate'],
          impactRefs: [{ impactCategoryId: 'impact-climate', impactVersion: '01.00.000' }],
        });
        return Promise.resolve({
          ok: true,
          data: {
            processes: [
              {
                processId: testProcessId,
                processVersion: '01.00.000',
                processName: 'Portland cement production',
              },
            ],
            impacts: [
              {
                impactCategoryId: 'impact-climate',
                impactVersion: '01.00.000',
                impactName: 'Climate change',
                unit: 'kg CO2 equivalents',
              },
            ],
          },
        });
      },
      ...unusedClosureCommandDeps,
      publishPackage: () => Promise.reject(new Error('not used')),
      unpublishPublication: () => Promise.reject(new Error('not used')),
      listPublications: () => Promise.reject(new Error('not used')),
    };

    const result = await executeDataProductCommand(
      {
        action: 'preview_package',
        packageId: TEST_PACKAGE_ID,
        impactCategoryId: 'impact-climate',
        rowLimit: 25,
      },
      fakeActor,
      repository,
    );

    assertEquals(result, {
      ok: true,
      body: {
        ok: true,
        command: 'lcia_result_package_preview',
        data: {
          summary: {
            packageId: TEST_PACKAGE_ID,
            snapshotId: testSnapshotId,
            defaultImpactCategory: 'impact-climate',
          },
          inputManifest: {},
          inputScope: {
            processCount: 1,
            selectionMode: null,
            predicateVersion: null,
            stateCodeCounts: [{ stateCode: '100', count: 1 }],
          },
          queryArtifact: {
            artifactUrl: 's3://lca-artifacts/results/query-sidecar.json',
          },
          detailPage: {
            status: 'ready',
            impactCategoryId: 'impact-climate',
            impactKey: 'climate-change',
            impactIndex: 0,
            impactName: 'Climate change',
            impactVersion: '01.00.000',
            unit: 'kg CO2 eq',
            offset: 0,
            limit: 25,
            returnedCount: 1,
            totalCount: 1,
            omittedInputCount: 0,
            rows: [
              {
                rowNumber: 1,
                processId: testProcessId,
                processVersion: '01.00.000',
                processName: 'Portland cement production',
                processIndex: 0,
                stateCode: 100,
                impactCategoryId: 'impact-climate',
                impactKey: 'climate-change',
                impactIndex: 0,
                impactName: 'Climate change',
                impactVersion: '01.00.000',
                unit: 'kg CO2 eq',
                value: 42,
              },
            ],
          },
          impactOptions: [
            {
              impactCategoryId: 'impact-climate',
              impactKey: 'climate-change',
              impactIndex: 0,
              impactName: 'Climate change',
              impactVersion: '01.00.000',
              unit: 'kg CO2 eq',
            },
          ],
        },
      },
    });
  },
);

Deno.test('executeDataProductCommand preview_package reads a verified v2 LCIA chunk', async () => {
  const snapshotId = '77777777-7777-4777-8777-777777777777';
  const processId = '88888888-8888-4888-8888-888888888888';
  const impactId = '99999999-9999-4999-8999-999999999999';
  const bundleManifestUrl =
    'https://example.supabase.co/storage/v1/s3/lca_results/calculation-bundles/build/hash/calculation-bundle.json';
  const chunkBody = `${JSON.stringify({
    processIndex: 0,
    method: { id: impactId, version: '01.00.000' },
    meanAmount: 17.5,
  })}\n`;
  const compressed = new Blob([chunkBody]).stream().pipeThrough(new CompressionStream('gzip'));
  const chunkBytes = new Uint8Array(await new Response(compressed).arrayBuffer());
  const chunkSha = await sha256HexForTest(chunkBytes);
  const queryDocument = {
    version: 2,
    format: 'all-unit-query:v2',
    snapshotId,
    jobId: '9e353806-c44c-49c5-d9d6-7c0b6f334c1c',
    processCount: 1,
    impactCount: 1,
    calculationBundle: {
      schemaVersion: 'tiangong.calculation-bundle.v2',
      calculationId: TEST_BUILD_ID,
      bundleContentHash: 'a'.repeat(64),
      manifestUrl: bundleManifestUrl,
      manifestSha256: 'b'.repeat(64),
      manifestByteSize: 1024,
      artifactCount: 1,
    },
    lciaChunks: [
      {
        path: 'results/lcia-000000.ndjson.gz',
        schemaVersion: 'tiangong.calculation-bundle.lcia.v1',
        compression: 'gzip',
        sha256: chunkSha,
        byteSize: chunkBytes.byteLength,
        recordCount: 1,
        firstProcessIndex: 0,
        lastProcessIndex: 0,
      },
    ],
  };
  const queryBytes = new TextEncoder().encode(JSON.stringify(queryDocument));
  const querySha = await sha256HexForTest(queryBytes);
  const queryUrl = 's3://lca-artifacts/results/query-v2.json';

  const repository: DataProductCommandRepository = {
    createBuild: () => Promise.reject(new Error('not used')),
    enqueuePackageBuild: () => Promise.reject(new Error('not used')),
    previewPackage: () =>
      Promise.resolve({
        ok: true,
        data: {
          summary: { packageId: TEST_PACKAGE_ID, snapshotId },
          inputManifest: {
            processes: [{ id: processId, version: '01.00.000' }],
          },
          queryArtifact: {
            artifactUrl: queryUrl,
            artifactFormat: 'all-unit-query:v2',
            artifactSha256: querySha,
            artifactByteSize: queryBytes.byteLength,
          },
        },
      }),
    fetchSnapshotArtifactUrl: () =>
      Promise.resolve({
        ok: true,
        data: {
          snapshotId,
          artifactUrl: 's3://lca-artifacts/snapshots/sparse.h5',
        },
      }),
    fetchJsonArtifact: <T>() =>
      Promise.resolve({
        ok: true,
        data: {
          version: 1,
          snapshot_id: snapshotId,
          process_count: 1,
          impact_count: 1,
          process_map: [
            {
              process_id: processId,
              process_version: '01.00.000',
              process_index: 0,
            },
          ],
          impact_map: [
            {
              impact_id: impactId,
              impact_version: '01.00.000',
              impact_key: `method:${impactId}`,
              impact_index: 0,
              impact_name: 'Climate change',
              unit: 'kg CO2 eq',
            },
          ],
        } as T,
      }),
    fetchArtifactBytes: (artifactUrl) => {
      if (artifactUrl === queryUrl) {
        return Promise.resolve({ ok: true, data: queryBytes });
      }
      assertEquals(
        artifactUrl,
        bundleManifestUrl.replace('calculation-bundle.json', 'results/lcia-000000.ndjson.gz'),
      );
      return Promise.resolve({ ok: true, data: chunkBytes });
    },
    fetchPreviewMetadata: () => Promise.resolve({ ok: true, data: { processes: [], impacts: [] } }),
    ...unusedClosureCommandDeps,
    publishPackage: () => Promise.reject(new Error('not used')),
    unpublishPublication: () => Promise.reject(new Error('not used')),
    listPublications: () => Promise.reject(new Error('not used')),
  };

  const result = await executeDataProductCommand(
    {
      action: 'preview_package',
      packageId: TEST_PACKAGE_ID,
      impactCategoryId: impactId,
      rowLimit: 25,
    },
    fakeActor,
    repository,
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    const body = result.body as { data: unknown };
    const data = body.data as {
      detailPage: { status: string; rows: Array<{ value: number }> };
    };
    assertEquals(data.detailPage.status, 'ready');
    assertEquals(data.detailPage.rows[0].value, 17.5);
  }
  // The persisted digest binds the complete query document, including its job ID.
  // Replacing that identity must still fail before any LCIA value is returned.
  const jobOffset = new TextDecoder().decode(queryBytes).indexOf('9e353806');
  queryBytes[jobOffset] = '8'.charCodeAt(0);
  const tampered = await executeDataProductCommand(
    { action: 'preview_package', packageId: TEST_PACKAGE_ID, impactCategoryId: impactId },
    fakeActor,
    repository,
  );
  assert(tampered.ok);
  const tamperedData = (
    tampered.body as {
      data: {
        detailPage: { status: string; rows: Array<{ value: number | null }> };
        previewWarnings: Array<{ code: string }>;
      };
    }
  ).data;
  assertEquals(tamperedData.detailPage.status, 'unavailable');
  assertEquals(tamperedData.detailPage.rows[0].value, null);
  assertEquals(
    tamperedData.previewWarnings[0].code,
    'result_projection_artifact_integrity_invalid',
  );
});

async function sha256HexForTest(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

Deno.test(
  'executeDataProductCommand list_publications returns publication management rows',
  async () => {
    const repository = {
      createBuild: () => Promise.reject(new Error('not used')),
      enqueuePackageBuild: () => Promise.reject(new Error('not used')),
      previewPackage: () => Promise.reject(new Error('not used')),
      ...unusedPreviewProjectionDeps,
      ...unusedClosureCommandDeps,
      publishPackage: () => Promise.reject(new Error('not used')),
      unpublishPublication: () => Promise.reject(new Error('not used')),
      listPublications: () =>
        Promise.resolve({
          ok: true,
          data: [
            {
              publicationId: TEST_PUBLICATION_ID,
              packageId: TEST_PACKAGE_ID,
              packageName: 'June result set',
              packageVersion: '2026-06-public',
              status: 'published',
              isCurrent: true,
              displayDefaultImpactCategory: 'climate-change',
              publishedAt: '2026-06-24T09:00:00Z',
            },
          ],
        }),
    } as unknown as DataProductCommandRepository;

    const result = await executeDataProductCommand(
      {
        action: 'list_publications',
        limit: 50,
      } as unknown as DataProductCommandRequest,
      fakeActor,
      repository,
    );

    assertEquals(result, {
      ok: true,
      body: {
        ok: true,
        command: 'lcia_result_publications_list',
        data: [
          {
            publicationId: TEST_PUBLICATION_ID,
            packageId: TEST_PACKAGE_ID,
            packageName: 'June result set',
            packageVersion: '2026-06-public',
            status: 'published',
            isCurrent: true,
            displayDefaultImpactCategory: 'climate-change',
            publishedAt: '2026-06-24T09:00:00Z',
          },
        ],
      },
    });
  },
);

Deno.test('executeDataProductCommand propagates manager authorization failures', async () => {
  const repository: DataProductCommandRepository = {
    createBuild: () =>
      Promise.resolve({
        ok: false,
        code: 'not_data_product_manager',
        status: 403,
        message: 'Data product manager role is required',
      }),
    enqueuePackageBuild: () => Promise.reject(new Error('not used')),
    previewPackage: () => Promise.reject(new Error('not used')),
    ...unusedPreviewProjectionDeps,
    ...unusedClosureCommandDeps,
    publishPackage: () => Promise.reject(new Error('not used')),
    unpublishPublication: () => Promise.reject(new Error('not used')),
    listPublications: () => Promise.reject(new Error('not used')),
  };

  const result = await executeDataProductCommand(
    {
      action: 'create_build',
      name: 'June public LCIA results',
      coverageMode: 'global_eligible',
      lciaMethodSet: [],
    },
    fakeActor,
    repository,
  );

  assertEquals(result, {
    ok: false,
    code: 'not_data_product_manager',
    status: 403,
    message: 'Data product manager role is required',
  });
});

Deno.test('closure allocation versions are forwarded exactly during v5 rollout', () => {
  const request = {
    action: 'create_closure_check',
    requestedScope: {
      coverageMode: 'global_eligible',
      lciaMethods: [{ id: TEST_USER_ID, version: '01.00.000' }],
    },
    requestIdempotencyToken: 'allocation-v5-contract',
  };
  const omitted = dataProductCommandRequestSchema.parse(request);
  assertEquals('requestedScope' in omitted && omitted.requestedScope.linkPolicy, undefined);
  for (const version of [
    'tidas-reference-allocation-v3',
    'tidas-reference-allocation-v4',
    'tidas-reference-allocation-v5',
  ] as const) {
    const parsed = dataProductCommandRequestSchema.parse({
      ...request,
      requestedScope: {
        ...request.requestedScope,
        linkPolicy: { allocationSemanticsVersion: version },
      },
    });
    assertEquals(
      'requestedScope' in parsed && parsed.requestedScope.linkPolicy?.allocationSemanticsVersion,
      version,
    );
    if (parsed.action !== 'create_closure_check') throw new Error('unexpected action');
    const args = buildLciaScopeClosureCheckRequestRpcArgs(parsed, auditPayload);
    assertEquals(args.p_requested_scope, parsed.requestedScope);
    assertEquals(args.p_request_idempotency_token, request.requestIdempotencyToken);
  }
  for (const version of [
    'tidas-reference-allocation-v2',
    'tidas-reference-allocation-v999',
    '',
    null,
  ]) {
    assertEquals(
      dataProductCommandRequestSchema.safeParse({
        ...request,
        requestedScope: {
          ...request.requestedScope,
          linkPolicy: { allocationSemanticsVersion: version },
        },
      }).success,
      false,
    );
  }
});

Deno.test('allocation v5 closure RPC preserves exact intent and database rejection', async () => {
  for (const version of [
    'tidas-reference-allocation-v4',
    'tidas-reference-allocation-v5',
  ] as const) {
    const client = new FakeRpcSupabase({
      data: {
        ok: false,
        code: 'invalid_closure_link_policy',
        status: 400,
        message: 'invalid_closure_link_policy',
      },
      error: null,
    });
    const parsed = dataProductCommandRequestSchema.parse({
      action: 'create_closure_check',
      resultSetId: TEST_RESULT_SET_ID,
      requestedScope: {
        coverageMode: 'global_eligible',
        lciaMethods: [{ id: TEST_USER_ID, version: '01.00.000' }],
        linkPolicy: { allocationSemanticsVersion: version },
      },
      requestIdempotencyToken: 'allocation-v5-rpc',
    });
    if (parsed.action !== 'create_closure_check') throw new Error('unexpected action');
    const result = await callLciaScopeClosureCheckRequestRpc(client as never, parsed, auditPayload);
    assertEquals(client.calls, [
      {
        fn: 'cmd_lcia_scope_closure_check_request_v3',
        args: {
          p_result_set_id: TEST_RESULT_SET_ID,
          p_requested_scope: parsed.requestedScope,
          p_request_idempotency_token: 'allocation-v5-rpc',
          p_audit: auditPayload,
        },
      },
    ]);
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.code, 'invalid_closure_link_policy');
  }
});

Deno.test(
  'preview metadata joins exact method pairs without a latest-revision fallback',
  async () => {
    const requests: URL[] = [];
    const client = createClient('https://metadata.example.invalid', 'fixture-key', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: (input) => {
          requests.push(new URL(String(input)));
          return Promise.resolve(
            new Response(
              JSON.stringify([
                { id: 'method-a', version: '02.00.000', json: {} },
                { id: 'method-a', version: '01.00.000', json: {} },
                { id: 'method-b', version: '01.00.000', json: {} },
                { id: 'method-b', version: '02.00.000', json: {} },
              ]),
              { headers: { 'content-type': 'application/json' } },
            ),
          );
        },
      },
    });
    const repo = createDataProductCommandRepository(client, client);
    const result = await repo.fetchPreviewMetadata({
      processes: [],
      impactCategoryIds: ['method-a', 'method-b'],
      impactRefs: [
        { impactCategoryId: 'method-a', impactVersion: '01.00.000' },
        { impactCategoryId: 'method-b', impactVersion: '02.00.000' },
        { impactCategoryId: 'method-a', impactVersion: '01.00.000' },
        { impactCategoryId: 'unrequested', impactVersion: '03.00.000' },
      ],
    });
    assert(result.ok);
    assertEquals(
      result.data.impacts.map(({ impactCategoryId, impactVersion }) => [
        impactCategoryId,
        impactVersion,
      ]),
      [
        ['method-a', '01.00.000'],
        ['method-b', '02.00.000'],
      ],
    );
    assertEquals(requests.length, 1);
    assertEquals(requests[0].searchParams.get('id'), 'in.(method-a,method-b)');
    assertEquals(requests[0].searchParams.get('version'), 'in.(01.00.000,02.00.000)');
    assertEquals(requests[0].searchParams.has('order'), false);
    const legacy = await repo.fetchPreviewMetadata({
      processes: [],
      impactCategoryIds: ['method-a'],
    });
    assert(legacy.ok);
    assertEquals(legacy.data.impacts, []);
    assertEquals(requests.length, 1);
  },
);
