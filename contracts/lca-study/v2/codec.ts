import { API_SCHEMA, CONTRACT_VERSION } from './common.ts';
import { requestSchema, OPERATIONS, type StudyApiRequest } from './requests.ts';
import { responseSchema, type StudyApiResponse } from './responses.ts';
import { API_SCHEMA as V1_SCHEMA } from '../v1/common.ts';
import {
  validateRequest as validateV1Request,
  validateResponseForRequest as validateV1Response,
} from '../v1/validation.ts';
import type { StudyApiRequest as V1Request } from '../v1/requests.ts';

/** Pure wire validation only; never authenticates, authorizes or enables a capability. */
export class StudyCodecError extends Error {
  constructor(
    public readonly code: 'INVALID_REQUEST' | 'UNSUPPORTED_SCHEMA' | 'REFERENCE_MISMATCH',
    public readonly ruleId: string,
  ) {
    super('Invalid Study protocol value.');
    this.name = 'StudyCodecError';
  }
}
export { API_SCHEMA, CONTRACT_VERSION, OPERATIONS };
export type { StudyApiRequest, StudyApiResponse };

export function parseRequest(input: unknown): StudyApiRequest {
  if (
    input &&
    typeof input === 'object' &&
    'schemaVersion' in input &&
    input.schemaVersion !== API_SCHEMA
  )
    throw new StudyCodecError('UNSUPPORTED_SCHEMA', 'schema.version');
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) throw new StudyCodecError('INVALID_REQUEST', 'request.structure');
  const request = parsed.data;
  if (
    request.operation === 'model.prepare' &&
    (request.source.type === 'modelSourceSnapshot') !== (request.methodRefs !== undefined)
  )
    throw new StudyCodecError('INVALID_REQUEST', 'preparation.method_selection');
  if (
    'overrides' in request &&
    new Set(request.overrides.map((o) => o.path)).size !== request.overrides.length
  )
    throw new StudyCodecError('INVALID_REQUEST', 'scenario.unique_override');
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
    if (!checked.ok) throw new StudyCodecError('INVALID_REQUEST', checked.issues[0].ruleId);
  }
  return request;
}
export function parseResponse(input: unknown): StudyApiResponse {
  const parsed = responseSchema.safeParse(input);
  if (!parsed.success) throw new StudyCodecError('REFERENCE_MISMATCH', 'response.structure');
  return parsed.data;
}
/** Metadata describes syntax, never current rights or deployment availability. */
export const operationMetadata = Object.freeze(
  Object.fromEntries(
    OPERATIONS.map((operation) => [
      operation,
      Object.freeze({
        operation,
        kind:
          operation.endsWith('.read') || operation.endsWith('.list')
            ? ('query' as const)
            : ('mutation' as const),
      }),
    ]),
  ),
);

export function validateResponseForRequest(
  request: StudyApiRequest,
  value: StudyApiResponse,
): void {
  if (value.schemaVersion !== API_SCHEMA || value.requestId !== request.requestId)
    throw new StudyCodecError('REFERENCE_MISMATCH', 'response.envelope');
  if (!value.ok) return;
  if (request.operation === 'task.read' || request.operation === 'task.cancel') {
    if (
      value.data.type !== 'task' ||
      value.data.value.studyId !== request.studyId ||
      JSON.stringify(value.data.value.resource) !== JSON.stringify(request.resource)
    )
      throw new StudyCodecError('REFERENCE_MISMATCH', 'response.task_selection');
    return;
  }
  if (request.operation === 'model.source.resolve' || request.operation === 'model.source.read') {
    const d = value.data;
    if (d.type !== 'modelSourceAcquisition')
      throw new StudyCodecError('REFERENCE_MISMATCH', 'response.source_kind');
    if (
      request.operation === 'model.source.read'
        ? request.acquisitionId !== d.value.acquisitionId
        : request.studyId !== d.value.studyId ||
          JSON.stringify(request.originRef) !== JSON.stringify(d.value.originRef)
    )
      throw new StudyCodecError('REFERENCE_MISMATCH', 'response.source_binding');
    return;
  }
  if (request.operation === 'artifact.read') {
    const d = value.data;
    if (
      d.type !== 'artifact' ||
      d.studyId !== request.studyId ||
      JSON.stringify(d.artifactRef) !== JSON.stringify(request.artifactRef)
    )
      throw new StudyCodecError('REFERENCE_MISMATCH', 'response.artifact_selection');
    return;
  }
  if (request.operation === 'capability.read') {
    if (value.data.type !== 'capabilities')
      throw new StudyCodecError('REFERENCE_MISMATCH', 'response.capability_kind');
    return;
  }
  if (request.operation === 'study.resources.list') {
    const d = value.data;
    if (
      d.type !== 'resourcePage' ||
      d.studyId !== request.studyId ||
      d.kind !== request.kind ||
      d.items.length > request.limit
    )
      throw new StudyCodecError('REFERENCE_MISMATCH', 'response.page_selection');
    return;
  }
  if (request.operation === 'member.set') {
    if (value.data.type !== 'study' || value.data.value.studyId !== request.target.id)
      throw new StudyCodecError('REFERENCE_MISMATCH', 'response.target');
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
    throw new StudyCodecError('REFERENCE_MISMATCH', 'response.revision_intent');
  if (
    request.operation === 'revision.freeze' &&
    (d.type !== 'studyRevision' ||
      d.value.status !== 'frozen' ||
      d.value.validation !== 'passed' ||
      d.value.contentHash !== request.expectedContentHash)
  )
    throw new StudyCodecError('REFERENCE_MISMATCH', 'response.frozen_revision');
  if (
    (request.operation === 'scenario.create' || request.operation === 'scenario.save') &&
    (d.type !== 'scenarioRevision' ||
      JSON.stringify(d.value.overrides) !== JSON.stringify(request.overrides) ||
      d.value.status !== 'draft' ||
      d.value.modelPreparationId !== null ||
      d.value.effectiveModelRef !== null)
  )
    throw new StudyCodecError('REFERENCE_MISMATCH', 'response.scenario_intent');
  if (
    request.operation === 'scenario.create' &&
    (d.type !== 'scenarioRevision' ||
      d.value.studyRevisionId !== request.studyRevisionId ||
      d.value.parentScenarioRevisionId !== request.parentScenarioRevisionId)
  )
    throw new StudyCodecError('REFERENCE_MISMATCH', 'response.scenario_base');
  if (
    request.operation === 'scenario.freeze' &&
    (d.type !== 'scenarioRevision' ||
      d.value.status !== 'frozen' ||
      d.value.contentHash !== request.expectedContentHash ||
      d.value.modelPreparationId !== request.modelPreparationId ||
      d.value.effectiveModelRef === null)
  )
    throw new StudyCodecError('REFERENCE_MISMATCH', 'response.frozen_scenario');
  if (
    request.operation === 'study.select_revision' &&
    (d.type !== 'study' || d.value.currentRevisionId !== request.revisionId)
  )
    throw new StudyCodecError('REFERENCE_MISMATCH', 'response.study_head');
  if (
    request.operation === 'model.prepare' &&
    request.methodRefs !== undefined &&
    (d.type !== 'modelPreparation' ||
      JSON.stringify(d.value.methodRefs) !== JSON.stringify(request.methodRefs))
  )
    throw new StudyCodecError('REFERENCE_MISMATCH', 'response.method_selection');
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
  if (!checked.ok) throw new StudyCodecError('REFERENCE_MISMATCH', 'response.binding');
  if ('target' in request && 'value' in value.data) {
    const r = value.data.value as Record<string, unknown>;
    const key = {
      study: 'studyId',
      studyRevision: 'revisionId',
      scenarioRevision: 'scenarioRevisionId',
      reportRevision: 'reportRevisionId',
    }[request.target.type];
    if (r[key] !== request.target.id)
      throw new StudyCodecError('REFERENCE_MISMATCH', 'response.target');
  }
}
