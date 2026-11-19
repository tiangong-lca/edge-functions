import { createClient } from '@supabase/supabase-js@2';

import type { ActorContext } from '../supabase/functions/_shared/command_runtime/actor_context.ts';
import { executeDataProductCommand } from '../supabase/functions/_shared/commands/data_product/command.ts';
import { createDataProductCommandRepository } from '../supabase/functions/_shared/commands/data_product/repository.ts';
import { createAppDataProductCommandsHandler } from '../supabase/functions/app_data_product_commands/index.ts';

const PROVIDER_OWNER_SCHEMA = 'lcia.scope-closure-provider-owned-result.v1';
const TARGET_CLASS = 'isolated-production-equivalent';
const CONFIRMATION = 'I_CONFIRM_ISOLATED_NON_PRODUCTION_TARGETS';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRODUCTION_FINGERPRINTS = [
  'qgzvkongdjqiiamzbbts',
  'lca.tiangong.earth',
  '/prod/',
  '-prod-',
  '_prod_',
  '.prod.',
] as const;
const SENSITIVE_KEYS = new Set([
  'authorization',
  'bucket',
  'credential',
  'credentials',
  'databaseurl',
  'locator',
  'objectpath',
  'password',
  'payload',
  'privatefixture',
  'secret',
  'signedurl',
  'token',
  'url',
]);

const FIXED_NOW_MS = Date.parse('2035-01-01T00:00:00.000Z');
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '99999999-9999-4999-8999-999999999999';
const READY_XLSX_ID = '45454545-4545-4454-8454-454545454541';
const READY_MANIFEST_ID = '45454545-4545-4454-8454-454545454542';
const EXPIRED_ID = '45454545-4545-4454-8454-454545454543';
const RETRY_ID = '45454545-4545-4454-8454-454545454544';
const ARTIFACT_ID = '33333333-3333-4333-8333-333333333333';
const OWNER_TOKEN = 'qualification-owner-session';
const OTHER_TOKEN = 'qualification-other-session';
const XLSX_BYTES = new TextEncoder().encode(`qualification-xlsx\n${'x'.repeat(4096)}`);
const MANIFEST_BYTES = new TextEncoder().encode(
  JSON.stringify({ schemaVersion: 'qualification-manifest.v1', issues: [] }),
);

export type ProviderOwnedResult = {
  schemaVersion: typeof PROVIDER_OWNER_SCHEMA;
  runId: string;
  owner: 'edge';
  component: 'edge';
  componentSha: string;
  targetClass: typeof TARGET_CLASS;
  productionMutation: false;
  assertions: number;
  evidence: {
    download: { crossOwnerRejected: true; locatorRedacted: true };
    consumers: { edgeContractPassed: true };
  };
};

type QualificationEnvironment = Record<string, string | undefined>;
type ParsedArguments = { output: string; runId: string };
type ArtifactRole = 'closure_report_xlsx' | 'closure_issue_manifest';

function normalizedKey(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
}

function isLoopbackUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname;
    return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
  } catch {
    return false;
  }
}

export function validateQualificationEnvironment(environment: QualificationEnvironment): void {
  if (environment.QUALIFICATION_NON_PRODUCTION_CONFIRMATION !== CONFIRMATION) {
    throw new Error('isolated Edge qualification requires explicit non-production confirmation');
  }
  for (const name of ['QUALIFICATION_SUPABASE_URL', 'QUALIFICATION_S3_ENDPOINT'] as const) {
    const value = environment[name];
    if (!value || !isLoopbackUrl(value)) {
      throw new Error('Edge qualification target fingerprint is not isolated loopback');
    }
  }
  const bucket = environment.QUALIFICATION_S3_BUCKET?.toLowerCase();
  if (
    !bucket ||
    bucket.includes('prod') ||
    !['qualification', 'test', 'local'].some((marker) => bucket.includes(marker))
  ) {
    throw new Error('Edge qualification bucket fingerprint is not isolated non-production');
  }
  for (const [name, value] of Object.entries(environment)) {
    if (
      name.startsWith('QUALIFICATION_') &&
      value &&
      PRODUCTION_FINGERPRINTS.some((fingerprint) => value.toLowerCase().includes(fingerprint))
    ) {
      throw new Error('Edge qualification configuration contains a production fingerprint');
    }
  }
}

function rejectSensitiveEvidence(value: unknown, path = 'evidence'): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => rejectSensitiveEvidence(child, `${path}[${index}]`));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(normalizedKey(key))) {
        throw new Error(`${path} contains a forbidden sensitive field`);
      }
      rejectSensitiveEvidence(child, `${path}.${key}`);
    }
  } else if (
    typeof value === 'string' &&
    (value.includes('://') ||
      value.toLowerCase().includes('service_role') ||
      value.includes('-----BEGIN '))
  ) {
    throw new Error(`${path} contains forbidden locator or credential material`);
  }
}

export function validateProviderOwnedResult(result: ProviderOwnedResult): void {
  const expected = [
    'schemaVersion',
    'runId',
    'owner',
    'component',
    'componentSha',
    'targetClass',
    'productionMutation',
    'assertions',
    'evidence',
  ].sort();
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(expected)) {
    throw new Error('provider-owned result fields drifted');
  }
  if (
    result.schemaVersion !== PROVIDER_OWNER_SCHEMA ||
    !UUID_PATTERN.test(result.runId) ||
    result.owner !== 'edge' ||
    result.component !== 'edge' ||
    !SHA_PATTERN.test(result.componentSha) ||
    result.targetClass !== TARGET_CLASS ||
    result.productionMutation !== false ||
    !Number.isInteger(result.assertions) ||
    result.assertions < 1
  ) {
    throw new Error('provider-owned result identity or assertion count drifted');
  }
  if (
    JSON.stringify(Object.keys(result.evidence).sort()) !==
      JSON.stringify(['consumers', 'download']) ||
    JSON.stringify(Object.keys(result.evidence.download).sort()) !==
      JSON.stringify(['crossOwnerRejected', 'locatorRedacted']) ||
    JSON.stringify(Object.keys(result.evidence.consumers)) !==
      JSON.stringify(['edgeContractPassed']) ||
    result.evidence.download.crossOwnerRejected !== true ||
    result.evidence.download.locatorRedacted !== true ||
    result.evidence.consumers.edgeContractPassed !== true
  ) {
    throw new Error('provider-owned Edge evidence fields drifted');
  }
  rejectSensitiveEvidence(result.evidence);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

export function canonicalProviderOwnedResult(result: ProviderOwnedResult): string {
  validateProviderOwnedResult(result);
  return `${JSON.stringify(sortJson(result))}\n`;
}

function parseArguments(args: string[]): ParsedArguments {
  let output: string | undefined;
  let runId: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--output') output = args[++index];
    else if (args[index] === '--run-id') runId = args[++index];
    else {
      throw new Error('usage: adapter --output <result.json> --run-id <uuid>');
    }
  }
  if (!output || !runId || !UUID_PATTERN.test(runId)) {
    throw new Error('usage: adapter --output <result.json> --run-id <uuid>');
  }
  return { output, runId };
}

async function git(repoRoot: string, ...args: string[]): Promise<string> {
  const result = await new Deno.Command('git', {
    args: ['-C', repoRoot, ...args],
    stdout: 'piped',
    stderr: 'null',
  }).output();
  if (!result.success) {
    throw new Error('Edge qualification git identity check failed');
  }
  return new TextDecoder().decode(result.stdout).trim();
}

async function exactComponentSha(): Promise<string> {
  const repoRoot = new URL('..', import.meta.url).pathname;
  const componentSha = await git(repoRoot, 'rev-parse', 'HEAD');
  if (!SHA_PATTERN.test(componentSha)) {
    throw new Error('Edge qualification component SHA is invalid');
  }
  if (await git(repoRoot, 'status', '--porcelain', '--untracked-files=no')) {
    throw new Error('Edge qualification requires a clean tracked checkout');
  }
  const harness = 'scripts/run_scope_closure_edge_qualification.sh';
  if ((await git(repoRoot, 'ls-files', '--error-unmatch', harness)) !== harness) {
    throw new Error('Edge qualification harness is not git tracked');
  }
  return componentSha;
}

function descriptor(role: ArtifactRole, state: 'ready' | 'expired') {
  const isXlsx = role === 'closure_report_xlsx';
  const bytes = isXlsx ? XLSX_BYTES : MANIFEST_BYTES;
  const extension = isXlsx ? 'xlsx' : 'json';
  return {
    artifactId: ARTIFACT_ID,
    artifactRole: role,
    artifactState: state,
    filename: `scope-closure-qualification.${extension}`,
    format: extension,
    mediaType: isXlsx
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'application/vnd.tiangong.scope-closure-manifest+json',
    size: bytes.byteLength,
    checksumSha256: 'a'.repeat(64),
    artifactExpiresAt:
      state === 'ready'
        ? new Date(FIXED_NOW_MS + 30 * 60 * 1000).toISOString()
        : new Date(FIXED_NOW_MS - 1000).toISOString(),
    bucket: 'qualification-private',
    objectPath: `generated/${role}.${extension}`,
  };
}

function assertNoPrivateLocator(value: unknown): void {
  if (Array.isArray(value)) return value.forEach(assertNoPrivateLocator);
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (['bucket', 'objectpath', 'credentials', 'authorization'].includes(normalizedKey(key))) {
      throw new Error('Edge response exposed a private locator or credential field');
    }
    assertNoPrivateLocator(child);
  }
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const value = await response.json();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Edge handler returned a non-object response');
  }
  return value as Record<string, unknown>;
}

export async function runEdgeQualification(runId: string): Promise<ProviderOwnedResult> {
  validateQualificationEnvironment(Deno.env.toObject());
  const componentSha = await exactComponentSha();
  let assertions = 0;
  const qualify: (condition: unknown, message: string) => void = (condition, message) => {
    if (!condition) {
      throw new Error(`Edge qualification assertion failed: ${message}`);
    }
    assertions += 1;
  };
  let baseUrl = '';
  let retryReady = false;
  const rpcAuthorizations: Array<string | null> = [];
  const signRequests: Array<{ path: string; expiresIn: number }> = [];
  const objectRequests: Array<{ method: string; path: string; range: string | null }> = [];
  let resolvePort: (port: number) => void;
  const portPromise = new Promise<number>((resolve) => (resolvePort = resolve));

  const server = Deno.serve(
    {
      hostname: '127.0.0.1',
      port: 0,
      onListen: ({ port }) => resolvePort(port),
    },
    async (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/rest/v1/rpc/get_lcia_scope_closure_report_download') {
        const body = (await request.json()) as {
          p_closure_check_id: string;
          p_artifact_role: ArtifactRole;
        };
        const authorization = request.headers.get('authorization');
        rpcAuthorizations.push(authorization);
        if (authorization !== `Bearer ${OWNER_TOKEN}`) {
          return Response.json({
            ok: false,
            code: 'not_data_product_manager',
            status: 403,
            message: 'private authorization detail',
          });
        }
        if (body.p_closure_check_id === EXPIRED_ID) {
          return Response.json({
            ok: true,
            data: descriptor(body.p_artifact_role, 'expired'),
          });
        }
        if (body.p_closure_check_id === RETRY_ID && !retryReady) {
          retryReady = true;
          return Response.json({
            ok: false,
            code: 'closure_report_unavailable',
            status: 404,
            message: 'private pending detail',
          });
        }
        return Response.json({
          ok: true,
          data: descriptor(body.p_artifact_role, 'ready'),
        });
      }
      if (
        request.method === 'POST' &&
        url.pathname.startsWith('/storage/v1/object/sign/qualification-private/')
      ) {
        const body = (await request.json()) as { expiresIn: number };
        signRequests.push({ path: url.pathname, expiresIn: body.expiresIn });
        const objectPath = url.pathname.replace(
          '/storage/v1/object/sign/qualification-private/',
          '',
        );
        return Response.json({
          signedURL: `/object/sign/qualification-private/${objectPath}?signature=generated`,
        });
      }
      if (
        url.pathname.startsWith('/object/sign/qualification-private/generated/') ||
        url.pathname.startsWith('/storage/v1/object/sign/qualification-private/generated/')
      ) {
        const role = url.pathname.includes('closure_report_xlsx')
          ? 'closure_report_xlsx'
          : 'closure_issue_manifest';
        const bytes = role === 'closure_report_xlsx' ? XLSX_BYTES : MANIFEST_BYTES;
        const mediaType =
          role === 'closure_report_xlsx'
            ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            : 'application/vnd.tiangong.scope-closure-manifest+json';
        const range = request.headers.get('range');
        objectRequests.push({
          method: request.method,
          path: url.pathname,
          range,
        });
        if (request.method === 'HEAD') {
          return new Response(null, {
            status: 200,
            headers: {
              'accept-ranges': 'bytes',
              'content-length': String(bytes.byteLength),
              'content-type': mediaType,
            },
          });
        }
        if (request.method === 'GET' && range === 'bytes=0-15') {
          return new Response(bytes.slice(0, 16), {
            status: 206,
            headers: {
              'accept-ranges': 'bytes',
              'content-length': '16',
              'content-range': `bytes 0-15/${bytes.byteLength}`,
              'content-type': mediaType,
            },
          });
        }
        return new Response(null, { status: 416 });
      }
      return Response.json(
        {
          message: 'unmatched isolated qualification route',
        },
        { status: 404 },
      );
    },
  );

  try {
    baseUrl = `http://127.0.0.1:${await portPromise}`;
    const makeActor = (userId: string, token: string): ActorContext => ({
      userId,
      accessToken: token,
      supabase: createClient(baseUrl, 'qualification-publishable-key', {
        auth: {
          autoRefreshToken: false,
          detectSessionInUrl: false,
          persistSession: false,
        },
        global: { headers: { Authorization: `Bearer ${token}` } },
      }),
    });
    const owner = makeActor(OWNER_ID, OWNER_TOKEN);
    const other = makeActor(OTHER_ID, OTHER_TOKEN);
    const serviceSupabase = createClient(baseUrl, 'qualification-service-key', {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    });
    const handler = createAppDataProductCommandsHandler({
      resolveActor: (request) => {
        const authorization = request.headers.get('authorization');
        if (authorization === `Bearer ${OWNER_TOKEN}`) {
          return Promise.resolve({ ok: true, value: owner });
        }
        if (authorization === `Bearer ${OTHER_TOKEN}`) {
          return Promise.resolve({ ok: true, value: other });
        }
        return Promise.resolve({
          ok: false,
          response: Response.json(
            {
              ok: false,
              code: 'AUTH_REQUIRED',
              message: 'Authentication required',
            },
            { status: 401 },
          ),
        });
      },
      execute: (request, actor) =>
        executeDataProductCommand(
          request,
          actor,
          createDataProductCommandRepository(actor.supabase, serviceSupabase, {
            now: () => FIXED_NOW_MS,
          }),
        ),
    });
    const request = (closureCheckId: string, role: ArtifactRole, token = OWNER_TOKEN) =>
      new Request(`${baseUrl}/functions/v1/app_data_product_commands`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'create_closure_report_download',
          closureCheckId,
          artifactRole: role,
        }),
      });

    const noAuth = await handler(
      new Request(`${baseUrl}/functions/v1/app_data_product_commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'create_closure_report_download',
          closureCheckId: READY_XLSX_ID,
          artifactRole: 'closure_report_xlsx',
        }),
      }),
    );
    qualify(noAuth.status === 401, 'missing authorization is rejected');
    qualify(signRequests.length === 0, 'missing authorization cannot reach signing');

    const qualifiedRoles: ArtifactRole[] = [];
    for (const [role, closureCheckId, expectedBytes] of [
      ['closure_report_xlsx', READY_XLSX_ID, XLSX_BYTES],
      ['closure_issue_manifest', READY_MANIFEST_ID, MANIFEST_BYTES],
    ] as const) {
      const objectCountBefore = objectRequests.length;
      const response = await handler(request(closureCheckId, role));
      const bodyText = await response.text();
      const body = JSON.parse(bodyText) as Record<string, unknown>;
      qualify(response.status === 200, `${role} owner request is ready`);
      qualify(
        response.headers.get('content-type')?.includes('application/json'),
        'Edge returns metadata',
      );
      qualify(
        !bodyText.includes(new TextDecoder().decode(expectedBytes)),
        'Edge does not buffer artifact bytes',
      );
      qualify(
        objectRequests.length === objectCountBefore,
        'Edge does not fetch the artifact object',
      );
      assertNoPrivateLocator(body);
      assertions += 1;
      const data = body.data as Record<string, unknown>;
      qualify(data.artifactRole === role, `${role} remains bound to its selector`);
      qualify(data.artifactState === 'ready', `${role} is ready`);
      qualify(
        typeof data.expiresInSeconds === 'number' &&
          data.expiresInSeconds > 0 &&
          data.expiresInSeconds <= 900,
        `${role} signed lifetime is bounded`,
      );
      qualify(typeof data.signedDownloadUrl === 'string', `${role} has signed metadata`);
      qualify(
        Date.parse(String(data.signedUrlExpiresAt)) <= Date.parse(String(data.artifactExpiresAt)),
        `${role} signed lifetime does not exceed artifact lifetime`,
      );
      const head = await fetch(String(data.signedDownloadUrl), {
        method: 'HEAD',
      });
      qualify(head.status === 200, `${role} signed HEAD succeeds`);
      qualify(head.headers.get('accept-ranges') === 'bytes', `${role} advertises byte ranges`);
      qualify(
        Number(head.headers.get('content-length')) === expectedBytes.byteLength,
        `${role} HEAD preserves object length`,
      );
      const range = await fetch(String(data.signedDownloadUrl), {
        headers: { range: 'bytes=0-15' },
      });
      qualify(range.status === 206, `${role} signed range succeeds`);
      qualify(
        range.headers.get('content-range') === `bytes 0-15/${expectedBytes.byteLength}`,
        `${role} range response is exact`,
      );
      qualify((await range.arrayBuffer()).byteLength === 16, `${role} range body is bounded`);
      qualifiedRoles.push(role);
    }

    qualify(signRequests.length === 2, 'only the two ready owner artifacts are signed');
    qualify(
      signRequests.every((entry) => entry.expiresIn <= 900),
      'all signing TTLs are bounded',
    );
    qualify(
      objectRequests.every((entry) => entry.path.includes('/object/sign/qualification-private/')),
      'artifact reads go directly to object storage',
    );
    qualify(
      objectRequests.filter((entry) => entry.method === 'HEAD').length === 2 &&
        objectRequests.filter((entry) => entry.range === 'bytes=0-15').length === 2,
      'both roles support HEAD and range reads',
    );

    const unavailableResponse = await handler(request(RETRY_ID, 'closure_report_xlsx'));
    const unavailableBody = await responseJson(unavailableResponse);
    qualify(unavailableResponse.status === 404, 'unavailable artifact is retryable and opaque');
    qualify(unavailableBody.code === 'closure_report_unavailable', 'unavailable code is stable');
    qualify(signRequests.length === 2, 'unavailable artifact is not signed');
    const retryResponse = await handler(request(RETRY_ID, 'closure_report_xlsx'));
    const retryBody = await responseJson(retryResponse);
    qualify(retryResponse.status === 200, 'retry succeeds after artifact readiness');
    qualify(
      (retryBody.data as Record<string, unknown>).artifactState === 'ready',
      'retry returns ready metadata',
    );
    qualify(signRequests.length === 3, 'successful retry signs exactly once');

    const expiredResponse = await handler(request(EXPIRED_ID, 'closure_report_xlsx'));
    const expiredBody = await responseJson(expiredResponse);
    qualify(expiredResponse.status === 410, 'expired owner artifact returns 410');
    qualify(expiredBody.code === 'closure_report_expired', 'expired code is stable');
    qualify(signRequests.length === 3, 'expired artifact is not signed');

    const unauthorizedResponse = await handler(
      request(READY_XLSX_ID, 'closure_report_xlsx', OTHER_TOKEN),
    );
    const unauthorizedBody = await responseJson(unauthorizedResponse);
    qualify(unauthorizedResponse.status === 404, 'cross-owner request is opaque');
    qualify(
      JSON.stringify(unauthorizedBody) === JSON.stringify(unavailableBody),
      'cross-owner and unavailable responses are indistinguishable',
    );
    qualify(signRequests.length === 3, 'cross-owner request is never signed');
    assertNoPrivateLocator(unauthorizedBody);
    assertions += 1;
    qualify(
      rpcAuthorizations.includes(`Bearer ${OWNER_TOKEN}`) &&
        rpcAuthorizations.includes(`Bearer ${OTHER_TOKEN}`),
      'actor sessions reach the actor-bound RPC',
    );
    qualify(
      qualifiedRoles.join(',') === 'closure_report_xlsx,closure_issue_manifest',
      'XLSX and machine-readable manifest roles are both qualified',
    );

    const result: ProviderOwnedResult = {
      schemaVersion: PROVIDER_OWNER_SCHEMA,
      runId,
      owner: 'edge',
      component: 'edge',
      componentSha,
      targetClass: TARGET_CLASS,
      productionMutation: false,
      assertions,
      evidence: {
        download: { crossOwnerRejected: true, locatorRedacted: true },
        consumers: { edgeContractPassed: true },
      },
    };
    validateProviderOwnedResult(result);
    return result;
  } finally {
    await server.shutdown();
  }
}

async function main(): Promise<void> {
  const { output, runId } = parseArguments(Deno.args);
  const result = await runEdgeQualification(runId);
  await Deno.writeTextFile(output, canonicalProviderOwnedResult(result), {
    createNew: true,
  });
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Edge qualification failed');
    Deno.exit(2);
  }
}
