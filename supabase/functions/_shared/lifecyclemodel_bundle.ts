import type { SupabaseClient } from '@supabase/supabase-js@2';
import { corsHeaders } from './cors.ts';
import { getReviewAdminStatus } from './get_user_role.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION_RE = /^\d{2}\.\d{2}\.\d{3}$/;

export type BundleProcessMutation =
  | {
      op: 'create';
      id: string;
      modelId: string;
      jsonOrdered: unknown;
      ruleVerification?: boolean;
    }
  | {
      op: 'update';
      id: string;
      version: string;
      modelId: string;
      jsonOrdered: unknown;
      ruleVerification?: boolean;
    }
  | {
      op: 'delete';
      id: string;
      version: string;
    };

export type SaveLifecycleModelBundlePlan = {
  mode: 'create' | 'update';
  modelId: string;
  version?: string;
  parent: {
    jsonOrdered: unknown;
    jsonTg: unknown;
    ruleVerification?: boolean;
  };
  processMutations: BundleProcessMutation[];
};

export const MODEL_BUNDLE_PROTOCOL = 'model-bundle.v1';

type GuardedBundleTarget = {
  protocol: typeof MODEL_BUNDLE_PROTOCOL;
  modelId: string;
  version: string;
};

export type GuardedBundleRequest = GuardedBundleTarget &
  (
    | { action: 'inspect' }
    | { action: 'recover'; operationId: string }
    | {
        action: 'save';
        operationId: string;
        expectedRevision: string | null;
        plan: SaveLifecycleModelBundlePlan;
      }
  );

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRevision(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function isGuardedBundleBody(body: unknown): boolean {
  return isRecord(body) && Object.hasOwn(body, 'protocol');
}

export function validateGuardedBundleRequest(
  body: unknown,
): ValidationResult<GuardedBundleRequest> {
  const invalid = { ok: false as const, message: 'Invalid guarded Model bundle request' };
  if (!isRecord(body) || body.protocol !== MODEL_BUNDLE_PROTOCOL) return invalid;
  if (!isUuid(body.modelId) || !isVersion(body.version)) return invalid;
  const target: GuardedBundleTarget = {
    protocol: MODEL_BUNDLE_PROTOCOL,
    modelId: body.modelId,
    version: body.version,
  };
  if (body.action === 'inspect' && Object.keys(body).length === 4)
    return { ok: true, value: { ...target, action: 'inspect' } };
  if (!isUuid(body.operationId)) return invalid;
  if (body.action === 'recover' && Object.keys(body).length === 5)
    return { ok: true, value: { ...target, action: 'recover', operationId: body.operationId } };
  if (body.action !== 'save' || Object.keys(body).length !== 7 || !isRecord(body.plan))
    return invalid;
  const plan = validateSavePlan(body.plan);
  if (
    !plan.ok ||
    plan.value.modelId !== target.modelId ||
    plan.value.version !== target.version ||
    !isRecord(plan.value.parent.jsonOrdered) ||
    !isRecord(plan.value.parent.jsonTg) ||
    Object.hasOwn(body.plan, 'allocateVersion') ||
    Object.hasOwn(body.plan, 'actorUserId') ||
    !(
      (plan.value.mode === 'create' && body.expectedRevision === null) ||
      (plan.value.mode === 'update' && isRevision(body.expectedRevision))
    )
  ) {
    return invalid;
  }
  return {
    ok: true,
    value: {
      ...target,
      action: 'save',
      operationId: body.operationId,
      expectedRevision: body.expectedRevision,
      plan: plan.value,
    },
  };
}

export function isGuardedBundleReply(response: unknown, request: GuardedBundleRequest): boolean {
  if (!isRecord(response) || response.protocol !== MODEL_BUNDLE_PROTOCOL) return false;
  if (request.action === 'inspect') {
    const snapshot = response.snapshot;
    return (
      response.status === 'observed' &&
      (snapshot === null ||
        (isRecord(snapshot) &&
          isRevision(snapshot.revision) &&
          isRecord(snapshot.model) &&
          snapshot.model.id === request.modelId &&
          snapshot.model.version === request.version &&
          Array.isArray(snapshot.members) &&
          Array.isArray(snapshot.processes)))
    );
  }
  if (response.operationId !== request.operationId) return false;
  if (request.action === 'recover' && response.status === 'unknown') return true;
  return (
    response.status === 'committed' &&
    response.modelId === request.modelId &&
    response.version === request.version &&
    isRevision(response.revision) &&
    typeof response.savedAt === 'string' &&
    Array.isArray(response.members) &&
    response.members.length > 0
  );
}

export type DeleteLifecycleModelBundleBody = {
  modelId: string;
  version: string;
};

export type BundleErrorBody = {
  ok: false;
  code: string;
  message: string;
  details?: unknown;
};

type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}

// jsonTg carries the authoring policy. Existing unmarked Model revisions retain their wire shape.
function validResultMembership(parent: Record<string, unknown>): boolean {
  const tg = parent.jsonTg;
  if (!isRecord(tg) || !Object.hasOwn(tg, 'resultPolicy')) return true;
  if (tg.resultPolicy !== 'single-primary-v1' || !Array.isArray(tg.submodels)) {
    return false;
  }
  const ordered = parent.jsonOrdered;
  const model = isRecord(ordered) && ordered.lifeCycleModelDataSet;
  const info = isRecord(model) && model.lifeCycleModelInformation;
  const data = isRecord(info) && info.dataSetInformation;
  if (!isRecord(data)) return false;
  const refs = data.referenceToResultingProcess;
  const ref = Array.isArray(refs) && refs.length === 1 ? refs[0] : refs;
  if (!isRecord(ref) || !isUuid(ref['@refObjectId']) || !isVersion(ref['@version'])) return false;
  const technology = isRecord(info) && info.technology;
  const processes = isRecord(technology) && technology.processes;
  const instances = isRecord(processes) && processes.processInstance;
  const componentKeys = new Set<string>();
  for (const instance of Array.isArray(instances) ? instances : [instances]) {
    const source = isRecord(instance) && instance.referenceToProcess;
    if (isRecord(source)) {
      componentKeys.add(`${source['@refObjectId']}@${source['@version']}`);
    }
  }
  const memberKeys = new Set<string>();
  let primaries = 0;
  for (const member of tg.submodels) {
    if (!isRecord(member) || !isUuid(member.id) || !isVersion(member.version)) {
      return false;
    }
    const key = `${member.id}@${member.version}`;
    if (memberKeys.has(key)) return false;
    memberKeys.add(key);
    if (member.type === 'primary') {
      if (member.id !== ref['@refObjectId'] || member.version !== ref['@version']) return false;
      primaries++;
    } else if (member.type !== 'allocated' || !componentKeys.has(key)) {
      return false;
    }
  }
  return primaries === 1;
}

export function validateSavePlan(body: unknown): ValidationResult<SaveLifecycleModelBundlePlan> {
  if (!body || typeof body !== 'object') {
    return { ok: false, message: 'request body must be an object' };
  }

  const plan = body as Record<string, unknown>;
  const mode = plan.mode;
  const modelId = plan.modelId;
  const version = plan.version;
  const parent = plan.parent;
  const processMutations = plan.processMutations;

  if (mode !== 'create' && mode !== 'update') {
    return { ok: false, message: 'mode must be create or update' };
  }

  if (!isUuid(modelId)) {
    return { ok: false, message: 'modelId must be a UUID' };
  }

  if (mode === 'update' && !isVersion(version)) {
    return { ok: false, message: 'version must be present for update mode' };
  }

  if (!parent || typeof parent !== 'object') {
    return { ok: false, message: 'parent must be an object' };
  }

  const parentRecord = parent as Record<string, unknown>;
  if (!('jsonOrdered' in parentRecord) || !('jsonTg' in parentRecord)) {
    return { ok: false, message: 'parent.jsonOrdered and parent.jsonTg are required' };
  }

  if (!validResultMembership(parentRecord)) {
    return {
      ok: false,
      message: 'Invalid Model result policy or exact primary/component membership',
    };
  }
  if (!Array.isArray(processMutations)) {
    return { ok: false, message: 'processMutations must be an array' };
  }

  for (const mutation of processMutations) {
    const validation = validateProcessMutation(mutation, modelId);
    if (!validation.ok) {
      return validation;
    }
  }

  return { ok: true, value: body as SaveLifecycleModelBundlePlan };
}

export function validateDeleteBody(
  body: unknown,
): ValidationResult<DeleteLifecycleModelBundleBody> {
  if (!body || typeof body !== 'object') {
    return { ok: false, message: 'request body must be an object' };
  }

  const payload = body as Record<string, unknown>;
  if (!isUuid(payload.modelId)) {
    return { ok: false, message: 'modelId must be a UUID' };
  }
  if (!isVersion(payload.version)) {
    return { ok: false, message: 'version must be in 00.00.000 format' };
  }

  return { ok: true, value: body as DeleteLifecycleModelBundleBody };
}

function validateProcessMutation(
  mutation: unknown,
  expectedModelId: string,
): ValidationResult<BundleProcessMutation> {
  if (!mutation || typeof mutation !== 'object') {
    return { ok: false, message: 'process mutation must be an object' };
  }

  const record = mutation as Record<string, unknown>;
  const op = record.op;

  if (op === 'delete') {
    if (!isUuid(record.id) || !isVersion(record.version)) {
      return { ok: false, message: 'delete mutation requires id and version' };
    }
    return { ok: true, value: mutation as BundleProcessMutation };
  }

  if (op !== 'create' && op !== 'update') {
    return { ok: false, message: 'mutation op must be create, update, or delete' };
  }

  if (!isUuid(record.id)) {
    return { ok: false, message: `${String(op)} mutation requires a UUID id` };
  }

  if (record.modelId !== expectedModelId) {
    return { ok: false, message: `${String(op)} mutation modelId must match plan.modelId` };
  }

  if (!('jsonOrdered' in record)) {
    return { ok: false, message: `${String(op)} mutation requires jsonOrdered` };
  }

  if (op === 'update' && !isVersion(record.version)) {
    return { ok: false, message: 'update mutation requires version' };
  }

  return { ok: true, value: mutation as BundleProcessMutation };
}

export async function ensureOwnerOrReviewAdmin(
  supabase: SupabaseClient,
  userId: string,
  modelId: string,
  version: string,
): Promise<{ ok: true } | { ok: false; error: BundleErrorBody }> {
  const { data: row, error } = await supabase
    .schema('public')
    .from('lifecyclemodels')
    .select('id,version,user_id')
    .eq('id', modelId)
    .eq('version', version)
    .maybeSingle();

  if (error) {
    console.error('query lifecycle model owner failed', {
      model_id: modelId,
      version,
      error: error.message,
      code: error.code,
    });
    return {
      ok: false,
      error: {
        ok: false,
        code: 'MODEL_LOOKUP_FAILED',
        message: 'Failed to load lifecycle model metadata',
      },
    };
  }

  if (!row) {
    return {
      ok: false,
      error: {
        ok: false,
        code: 'MODEL_NOT_FOUND',
        message: 'Lifecycle model not found',
      },
    };
  }

  const isReviewAdmin = await userHasReviewAdminRole(supabase, userId);
  if (!isReviewAdmin && row.user_id !== userId) {
    return {
      ok: false,
      error: {
        ok: false,
        code: 'FORBIDDEN',
        message: 'You do not have permission to mutate this lifecycle model',
      },
    };
  }

  return { ok: true };
}

export async function userHasReviewAdminRole(
  supabase: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const { data: isReviewAdmin, error } = await getReviewAdminStatus(userId, supabase);
  if (error) {
    console.error('query user role failed', {
      user_id: userId,
      error: error.message,
      code: error.code,
    });
    return false;
  }

  return isReviewAdmin === true;
}

export function mapRpcError(error: { message?: string; code?: string; details?: unknown }) {
  const code = normalizeRpcErrorCode(error);
  return {
    ok: false as const,
    code,
    message: rpcErrorMessage(code),
    details: code === 'PROCESS_PERSIST_FAILED' ? null : safeRpcDetails(error.details),
  };
}

// Only exact dataset identities are safe public diagnostics; never forward SQL text.
function safeRpcDetails(details: unknown): Record<string, string> | null {
  let value = details;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (['id', 'model_id', 'process_id'].includes(key) && isUuid(item)) result[key] = item;
    if (['version', 'model_version', 'process_version'].includes(key) && isVersion(item))
      result[key] = item;
  }
  return Object.keys(result).length > 0 ? result : null;
}

export function rpcErrorStatusCode(error: { code: string }): number {
  switch (error.code) {
    case 'AUTH_REQUIRED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'MODEL_NOT_FOUND':
    case 'PROCESS_NOT_FOUND':
      return 404;
    case 'VERSION_CONFLICT':
    case 'MODEL_BUNDLE_CONFLICT':
    case 'MODEL_MEMBERSHIP_INVALID':
    case 'MODEL_MEMBERSHIP_BUSY':
    case 'MODEL_OPERATION_CONFLICT':
      return 409;
    case 'INVALID_PAYLOAD':
      return 400;
    default:
      return 500;
  }
}

export function normalizeSaveRpcPayload(payload: any) {
  return {
    ok: true as const,
    modelId: String(payload?.model_id ?? ''),
    version: String(payload?.version ?? ''),
    lifecycleModel: normalizeLifecycleModelRow(payload?.lifecycle_model ?? {}),
  };
}

export function normalizeDeleteRpcPayload(payload: any) {
  return {
    ok: true as const,
    modelId: String(payload?.model_id ?? ''),
    version: String(payload?.version ?? ''),
  };
}

export function normalizeLifecycleModelRow(row: any) {
  return {
    id: String(row?.id ?? ''),
    version: String(row?.version ?? ''),
    json: row?.json ?? row?.json_ordered ?? null,
    json_tg: row?.json_tg ?? null,
    ruleVerification: Boolean(row?.rule_verification),
  };
}

export function permissionErrorStatusCode(error: { code?: string }) {
  switch (error.code) {
    case 'FORBIDDEN':
      return 403;
    case 'MODEL_NOT_FOUND':
      return 404;
    case 'MODEL_LOOKUP_FAILED':
      return 500;
    default:
      return 400;
  }
}

function normalizeRpcErrorCode(error: { message?: string; code?: string }) {
  const message = String(error?.message ?? '').trim();

  if (message === 'MODEL_NOT_FOUND') {
    return 'MODEL_NOT_FOUND';
  }
  if (message === 'PROCESS_NOT_FOUND') {
    return 'PROCESS_NOT_FOUND';
  }
  if (message === 'AUTH_REQUIRED' || message === 'FORBIDDEN') {
    return message;
  }
  if (message === 'INVALID_PLAN') {
    return 'INVALID_PAYLOAD';
  }
  if (message === 'VERSION_CONFLICT') {
    return 'VERSION_CONFLICT';
  }
  if (
    message === 'MODEL_BUNDLE_CONFLICT' ||
    message === 'MODEL_MEMBERSHIP_INVALID' ||
    message === 'MODEL_MEMBERSHIP_BUSY' ||
    message === 'MODEL_OPERATION_CONFLICT'
  ) {
    return message;
  }
  if (error?.code === '23505') {
    return 'VERSION_CONFLICT';
  }

  return 'PROCESS_PERSIST_FAILED';
}

function rpcErrorMessage(code: string) {
  switch (code) {
    case 'AUTH_REQUIRED':
      return 'Authentication required';
    case 'FORBIDDEN':
      return 'You do not have permission to mutate this lifecycle model';
    case 'PROCESS_NOT_FOUND':
      return 'A lifecycle model result process was not found at the requested version';
    case 'MODEL_NOT_FOUND':
      return 'Lifecycle model not found';
    case 'INVALID_PAYLOAD':
      return 'Invalid lifecycle model bundle payload';
    case 'VERSION_CONFLICT':
      return 'A record with the same id and version already exists';
    case 'MODEL_BUNDLE_CONFLICT':
      return 'The Model or its results changed. Reload the Model before saving again';
    case 'MODEL_MEMBERSHIP_INVALID':
      return 'The stored result members do not match the Model declaration';
    case 'MODEL_MEMBERSHIP_BUSY':
      return 'The Model or its results are being changed by another operation';
    case 'MODEL_OPERATION_CONFLICT':
      return 'This save operation identity belongs to a different request';
    case 'PROCESS_PERSIST_FAILED':
    default:
      return 'Failed to persist lifecycle model bundle';
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION_RE.test(value);
}
