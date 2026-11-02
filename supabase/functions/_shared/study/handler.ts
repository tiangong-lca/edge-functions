import {
  API_SCHEMA,
  responseSchema,
  requestSchema,
  type StudyApiRequest,
  type StudyApiResponse,
} from '../../../../contracts/lca-study/v2/index.ts';
import { API_SCHEMA as V1_SCHEMA, idSchema } from '../../../../contracts/lca-study/v1/common.ts';
import {
  validateRequest as validateV1Request,
  validateResponseForRequest as validateV1Response,
} from '../../../../contracts/lca-study/v1/validation.ts';
import type { StudyApiRequest as V1Request } from '../../../../contracts/lca-study/v1/requests.ts';
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

export type HandlerOptions = {
  resolveActor?: (req: Request) => Promise<ActorContextResult>;
  repository?: (actor: ActorContext) => StudyRepository;
  config?: () => RuntimeConfig;
  validateRevision?: ServerValidator | null;
  timeoutMs?: number;
};
const MAX_BODY_BYTES = 256 * 1024;
function response(requestId: string, data: unknown): StudyApiResponse {
  return responseSchema.parse({ schemaVersion: API_SCHEMA, requestId, ok: true, data });
}
function bind(request: StudyApiRequest, value: StudyApiResponse): void {
  if (!value.ok) return;
  if (request.operation === 'task.read' || request.operation === 'task.cancel') {
    if (
      value.data.type !== 'task' ||
      value.data.value.studyId !== request.studyId ||
      JSON.stringify(value.data.value.resource) !== JSON.stringify(request.resource)
    )
      throw new StudyFailure('REFERENCE_MISMATCH', 502, 'response.task_selection');
    return;
  }
  if (request.operation === 'model.source.resolve' || request.operation === 'model.source.read') {
    const d = value.data;
    if (d.type !== 'modelSourceAcquisition')
      throw new StudyFailure('REFERENCE_MISMATCH', 502, 'response.source_kind');
    if (
      request.operation === 'model.source.read'
        ? request.acquisitionId !== d.value.acquisitionId
        : request.studyId !== d.value.studyId ||
          JSON.stringify(request.originRef) !== JSON.stringify(d.value.originRef)
    )
      throw new StudyFailure('REFERENCE_MISMATCH', 502, 'response.source_binding');
    return;
  }
  if (request.operation === 'artifact.read' || request.operation === 'capability.read') return;
  if (request.operation === 'study.resources.list') {
    const d = value.data;
    if (
      d.type !== 'resourcePage' ||
      d.studyId !== request.studyId ||
      d.kind !== request.kind ||
      d.items.length > request.limit
    )
      throw new StudyFailure('REFERENCE_MISMATCH', 502, 'response.page_selection');
    return;
  }
  if (request.operation === 'member.set') {
    if (value.data.type !== 'study' || value.data.value.studyId !== request.target.id)
      throw new StudyFailure('REFERENCE_MISMATCH', 502, 'response.target');
    return;
  }
  const d = value.data;
  if (
    (request.operation === 'revision.create' || request.operation === 'revision.save') &&
    (d.type !== 'studyRevision' ||
      JSON.stringify(d.value.definition) !== JSON.stringify(request.definition) ||
      d.value.modelPreparationId !== request.modelPreparationId ||
      JSON.stringify(d.value.modelRef) !== JSON.stringify(request.modelRef) ||
      d.value.status !== 'draft' ||
      d.value.validation !== 'not_checked')
  )
    throw new StudyFailure('REFERENCE_MISMATCH', 502, 'response.revision_intent');
  if (
    request.operation === 'revision.freeze' &&
    (d.type !== 'studyRevision' ||
      d.value.status !== 'frozen' ||
      d.value.validation !== 'passed' ||
      d.value.contentHash !== request.expectedContentHash)
  )
    throw new StudyFailure('REFERENCE_MISMATCH', 502, 'response.frozen_revision');
  if (
    (request.operation === 'scenario.create' || request.operation === 'scenario.save') &&
    (d.type !== 'scenarioRevision' ||
      JSON.stringify(d.value.overrides) !== JSON.stringify(request.overrides) ||
      d.value.status !== 'draft' ||
      d.value.modelPreparationId !== null ||
      d.value.effectiveModelRef !== null)
  )
    throw new StudyFailure('REFERENCE_MISMATCH', 502, 'response.scenario_intent');
  if (
    request.operation === 'scenario.create' &&
    (d.type !== 'scenarioRevision' ||
      d.value.studyRevisionId !== request.studyRevisionId ||
      d.value.parentScenarioRevisionId !== request.parentScenarioRevisionId)
  )
    throw new StudyFailure('REFERENCE_MISMATCH', 502, 'response.scenario_base');
  if (
    request.operation === 'scenario.freeze' &&
    (d.type !== 'scenarioRevision' ||
      d.value.status !== 'frozen' ||
      d.value.contentHash !== request.expectedContentHash ||
      d.value.modelPreparationId !== request.modelPreparationId ||
      d.value.effectiveModelRef === null)
  )
    throw new StudyFailure('REFERENCE_MISMATCH', 502, 'response.frozen_scenario');
  if (
    request.operation === 'study.select_revision' &&
    (d.type !== 'study' || d.value.currentRevisionId !== request.revisionId)
  )
    throw new StudyFailure('REFERENCE_MISMATCH', 502, 'response.study_head');
  if (
    request.operation === 'model.prepare' &&
    request.methodRefs !== undefined &&
    (d.type !== 'modelPreparation' ||
      JSON.stringify(d.value.methodRefs) !== JSON.stringify(request.methodRefs))
  )
    throw new StudyFailure('REFERENCE_MISMATCH', 502, 'response.method_selection');
  let projected =
    value.data.type === 'scenarioRevision'
      ? { ...value, data: { ...value.data, value: { ...value.data.value, overrides: [] } } }
      : value;
  if (value.data.type === 'modelPreparation') {
    const { methodRefs: _methodRefs, ...legacy } = value.data.value;
    projected = { ...value, data: { ...value.data, value: legacy } } as typeof projected;
  }
  const checked = validateV1Response({ ...request, schemaVersion: V1_SCHEMA } as V1Request, {
    ...projected,
    schemaVersion: V1_SCHEMA,
  });
  if (!checked.ok) throw new StudyFailure('REFERENCE_MISMATCH', 502, 'response.binding');
  if ('target' in request && 'value' in value.data) {
    const r = value.data.value as Record<string, unknown>;
    const key = {
      study: 'studyId',
      studyRevision: 'revisionId',
      scenarioRevision: 'scenarioRevisionId',
      reportRevision: 'reportRevisionId',
    }[request.target.type];
    if (r[key] !== request.target.id)
      throw new StudyFailure('REFERENCE_MISMATCH', 502, 'response.target');
  }
}

export function createStudyHandler(options: HandlerOptions = {}) {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    let requestId = crypto.randomUUID() as string;
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
      bind(request, value);
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
        error instanceof StudyFailure
          ? error
          : new StudyFailure('UPSTREAM_UNAVAILABLE', 502, 'runtime.invalid_response');
      return new Response(
        JSON.stringify({
          schemaVersion: API_SCHEMA,
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
