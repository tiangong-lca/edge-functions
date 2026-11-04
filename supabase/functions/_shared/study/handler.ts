import { executeAdvanced, type AdvancedOptions } from './advanced_dispatch.ts';
import { executeMethod, type MethodOptions } from './method_dispatch.ts';
import { API_SCHEMA as METHOD_SCHEMA } from '../../../../contracts/lca-study/v6/authoring.ts';
import { API_SCHEMA as ADVANCED_SCHEMA } from '../../../../contracts/lca-study/v5/advanced.ts';
import {
  API_SCHEMA,
  responseSchema,
  requestSchema,
  type StudyApiRequest,
  type StudyApiResponse,
} from '../../../../contracts/lca-study/v2/index.ts';
import { API_SCHEMA as V1_SCHEMA, idSchema } from '../../../../contracts/lca-study/v1/common.ts';
import { validateRequest as validateV1Request } from '../../../../contracts/lca-study/v1/validation.ts';
import {
  StudyCodecError,
  validateResponseForRequest,
} from '../../../../contracts/lca-study/v2/codec.ts';
import { corsHeaders } from '../cors.ts';
import {
  resolveActorContext,
  type ActorContext,
  type ActorContextResult,
} from '../command_runtime/actor_context.ts';
import {
  readAuthorizedArtifact,
  unpack,
  createStudyRepository,
  createStudyActorClient,
  readBounded,
  type StudyRepository,
} from './repository.ts';
import {
  assertIntent,
  configSchema,
  intentSchema,
  profileAllowed,
  readConfig,
  StudyFailure,
  type RuntimeConfig,
  type ServerValidator,
} from './protocol.ts';
import { createPreparedInputValidator } from './validator.ts';
import { executeReporting, type ReportingOptions } from './reporting_executor.ts';
import { executeReview, type ReviewOptions } from './review_executor.ts';
import { API_SCHEMA as REVIEW_SCHEMA } from '../../../../contracts/lca-study/v4/review.ts';
import { API_SCHEMA as REPORTING_SCHEMA } from '../../../../contracts/lca-study/v3/report.ts';

export type HandlerOptions = {
  resolveActor?: (req: Request) => Promise<ActorContextResult>;
  repository?: (actor: ActorContext) => StudyRepository;
  config?: () => RuntimeConfig;
  validateRevision?: ServerValidator | null;
  timeoutMs?: number;
  reporting?: ReportingOptions;
  review?: ReviewOptions;
  advanced?: AdvancedOptions;
  method?: MethodOptions;
};
const MAX_BODY_BYTES = 256 * 1024;
function response(requestId: string, data: unknown): StudyApiResponse {
  return responseSchema.parse({ schemaVersion: API_SCHEMA, requestId, ok: true, data });
}

export function createStudyHandler(options: HandlerOptions = {}) {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    let requestId = crypto.randomUUID() as string;
    const wireHeader = req.headers.get('x-study-schema');
    let responseVersion: string =
      wireHeader === METHOD_SCHEMA
        ? METHOD_SCHEMA
        : wireHeader === ADVANCED_SCHEMA
          ? ADVANCED_SCHEMA
          : wireHeader === REVIEW_SCHEMA
            ? REVIEW_SCHEMA
            : wireHeader === REPORTING_SCHEMA
              ? REPORTING_SCHEMA
              : API_SCHEMA;
    const controller = new AbortController();
    const abort = () => controller.abort(req.signal.reason);
    req.signal.addEventListener('abort', abort, { once: true });
    if (req.signal.aborted) abort();
    const timeoutMs = options.timeoutMs ?? 25000;
    const deadline = performance.now() + timeoutMs;
    const assertActive = () => {
      if (performance.now() >= deadline) {
        controller.abort(new StudyFailure('DEADLINE_EXCEEDED', 504, 'transport.deadline'));
        throw new StudyFailure('DEADLINE_EXCEEDED', 504, 'transport.deadline');
      }
      controller.signal.throwIfAborted();
    };
    const timer = setTimeout(() => controller.abort(new Error('deadline')), timeoutMs);
    let rejectAbort: (reason: unknown) => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () =>
      rejectAbort(new StudyFailure('DEADLINE_EXCEEDED', 504, 'transport.deadline'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
    const run = async () => {
      assertActive();
      if (req.method !== 'POST')
        throw new StudyFailure('METHOD_NOT_ALLOWED', 405, 'transport.method');
      const actor = await (
        options.resolveActor ??
        ((request: Request) =>
          resolveActorContext(request, {
            createSupabaseClient: (token) => createStudyActorClient(token, controller.signal),
          }))
      )(req);
      assertActive();
      if (!actor.ok) throw new StudyFailure('AUTH_REQUIRED', 401, 'transport.authentication');
      if (
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
          req.headers.get('content-type') ?? '',
        )
      )
        throw new StudyFailure('INVALID_REQUEST', 400, 'transport.content_type');
      const bytes = await readBounded(new Response(req.body), MAX_BODY_BYTES, controller.signal);
      let input: unknown;
      try {
        input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        throw new StudyFailure('INVALID_REQUEST', 400, 'transport.json');
      }
      if (
        input &&
        typeof input === 'object' &&
        'requestId' in input &&
        idSchema.safeParse(input.requestId).success
      )
        requestId = input.requestId as string;
      if (
        wireHeader !== null &&
        (!input ||
          typeof input !== 'object' ||
          !('schemaVersion' in input) ||
          input.schemaVersion !== wireHeader)
      )
        throw new StudyFailure('INVALID_REQUEST', 400, 'schema.header_binding');
      if (
        input &&
        typeof input === 'object' &&
        'schemaVersion' in input &&
        input.schemaVersion === METHOD_SCHEMA
      ) {
        responseVersion = METHOD_SCHEMA;
        return await executeMethod(
          input,
          actor.value,
          controller.signal,
          assertActive,
          options.method,
        );
      }
      if (
        input &&
        typeof input === 'object' &&
        'schemaVersion' in input &&
        input.schemaVersion === ADVANCED_SCHEMA
      ) {
        responseVersion = ADVANCED_SCHEMA;
        return await executeAdvanced(
          input,
          actor.value,
          controller.signal,
          assertActive,
          options.advanced,
        );
      }
      if (
        input &&
        typeof input === 'object' &&
        'schemaVersion' in input &&
        input.schemaVersion === REVIEW_SCHEMA
      ) {
        responseVersion = REVIEW_SCHEMA;
        return await executeReview(
          input,
          actor.value,
          controller.signal,
          assertActive,
          options.review,
        );
      }
      if (
        input &&
        typeof input === 'object' &&
        'schemaVersion' in input &&
        input.schemaVersion === REPORTING_SCHEMA
      ) {
        responseVersion = REPORTING_SCHEMA;
        return await executeReporting(
          input,
          actor.value,
          controller.signal,
          assertActive,
          options.reporting,
        );
      }
      if (
        input &&
        typeof input === 'object' &&
        'schemaVersion' in input &&
        input.schemaVersion !== API_SCHEMA
      )
        throw new StudyFailure('UNSUPPORTED_SCHEMA', 400, 'schema.version');
      const parsed = requestSchema.safeParse(input);
      if (!parsed.success) throw new StudyFailure('INVALID_REQUEST', 400, 'request.structure');
      const request = parsed.data;
      if (request.operation === 'artifact.read' && request.artifactRef.type === 'modelSource')
        throw new StudyFailure('DISCLOSURE_DENIED', 403, 'artifact.private_source');
      if (
        request.operation === 'artifact.read' &&
        !['modelInput', 'runResult'].includes(request.artifactRef.type)
      )
        throw new StudyFailure('CAPABILITY_UNAVAILABLE', 503, 'capability.artifact_kind');
      if (
        request.operation === 'model.prepare' &&
        (request.source.type === 'modelSourceSnapshot') !== (request.methodRefs !== undefined)
      )
        throw new StudyFailure('INVALID_REQUEST', 400, 'preparation.method_selection');
      if (
        'overrides' in request &&
        new Set(request.overrides.map((o) => o.path)).size !== request.overrides.length
      )
        throw new StudyFailure('INVALID_REQUEST', 400, 'scenario.unique_override');
      if (
        request.operation === 'study.resources.list' &&
        ![
          'studyRevision',
          'scenarioRevision',
          'modelSourceSnapshot',
          'modelPreparation',
          'modelSourceAcquisition',
          'run',
        ].includes(request.kind)
      )
        throw new StudyFailure('CAPABILITY_UNAVAILABLE', 503, 'capability.resource_kind');
      if (
        ![
          'artifact.read',
          'model.source.read',
          'model.prepare',
          'scenario.create',
          'scenario.save',
          'member.set',
          'task.read',
          'task.cancel',
        ].includes(request.operation)
      ) {
        const checked = validateV1Request({ ...request, schemaVersion: V1_SCHEMA });
        if (!checked.ok) throw new StudyFailure('INVALID_REQUEST', 400, checked.issues[0].ruleId);
      }
      const config = configSchema.parse((options.config ?? readConfig)());
      if (!config.operations.includes(request.operation))
        throw new StudyFailure('CAPABILITY_UNAVAILABLE', 503, 'capability.operation');
      if (
        (request.operation === 'model.prepare' || request.operation === 'run.submit') &&
        !profileAllowed(config.profiles, request.profileId, request.calculationContractRef)
      )
        throw new StudyFailure('CAPABILITY_UNAVAILABLE', 503, 'capability.profile');
      const repository = (options.repository ?? ((a) => createStudyRepository(a.supabase)))(
        actor.value,
      );
      assertActive();
      let data = unpack(await repository.dispatch(request, controller.signal));
      assertActive();
      if (request.operation === 'capability.read') {
        // DB remains authoritative for actor-specific capabilities. Deployment only narrows it.
        const db = configSchema.parse(data);
        data = {
          ...config,
          runtimeEnabled: config.runtimeEnabled && db.runtimeEnabled,
          operations: config.operations.filter((op) => db.operations.includes(op)),
          profiles: config.profiles.filter((p) =>
            profileAllowed(db.profiles, p.profileId, p.calculationContractRef),
          ),
        };
      } else if (request.operation === 'revision.freeze' && intentSchema.safeParse(data).success) {
        const intent = intentSchema.parse(data);
        assertIntent(intent, request, config.profiles);
        if (options.validateRevision === null)
          throw new StudyFailure('CAPABILITY_UNAVAILABLE', 503, 'freeze.validator_unavailable');
        const decision = await (
          options.validateRevision ?? createPreparedInputValidator(repository, assertActive)
        )(intent, controller.signal);
        assertActive();
        data = unpack(await repository.consume(intent.intentId, decision, controller.signal));
      } else if (request.operation === 'artifact.read') {
        const bytes = await readAuthorizedArtifact(
          repository,
          request,
          controller.signal,
          assertActive,
          { data },
        );
        const chunks: string[] = [];
        for (let i = 0; i < bytes.length; i += 16384)
          chunks.push(String.fromCharCode(...bytes.subarray(i, i + 16384)));
        data = {
          type: 'artifact',
          studyId: request.studyId,
          artifactRef: request.artifactRef,
          encoding: 'base64',
          bytes: btoa(chunks.join('')),
        };
      }
      assertActive();
      const value = response(requestId, data);
      validateResponseForRequest(request, value);
      assertActive();
      return value;
    };
    try {
      const value = await Promise.race([run(), aborted]);
      const response = new Response(JSON.stringify(value), {
        headers: {
          ...corsHeaders,
          'content-type': 'application/json',
          'cache-control': 'no-store',
        },
      });
      assertActive();
      return response;
    } catch (error) {
      const failure =
        error instanceof StudyCodecError
          ? new StudyFailure(
              error.code,
              error.code === 'REFERENCE_MISMATCH' ? 502 : 400,
              error.ruleId,
            )
          : error instanceof StudyFailure
            ? error
            : new StudyFailure('UPSTREAM_UNAVAILABLE', 502, 'runtime.invalid_response');
      return new Response(
        JSON.stringify({
          schemaVersion: responseVersion,
          requestId,
          ok: false,
          code: failure.code,
          message: 'Study request could not be completed.',
          retryable: ['UPSTREAM_UNAVAILABLE', 'DEADLINE_EXCEEDED'].includes(failure.code),
          issues: [{ code: failure.code, path: '/', ruleId: failure.ruleId }],
        }),
        {
          status: failure.status,
          headers: {
            ...corsHeaders,
            'content-type': 'application/json',
            'cache-control': 'no-store',
          },
        },
      );
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      req.signal.removeEventListener('abort', abort);
    }
  };
}
