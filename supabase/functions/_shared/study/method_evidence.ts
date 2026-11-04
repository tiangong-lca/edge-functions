import type { MethodRequest } from '../../../../contracts/lca-study/v6/requests.ts';
import { methodEvidenceRecordSchema } from '../../../../contracts/lca-study/v6/schemas.ts';
import { canonicalBytes, sha256 } from '../../../../contracts/lca-study/v3/canonical.ts';
import type { ActorContext } from '../command_runtime/actor_context.ts';
import {
  evidenceIntentSchema,
  evidenceContextSchema,
  type MethodEvidenceContext,
  type MethodPrivateArtifact,
} from './method_context.ts';
import type { MethodRepository } from './method_repository.ts';
import { sameJson } from './reporting_producer.ts';
import { unpack } from './repository.ts';
import { StudyFailure } from './protocol.ts';
type Request = Extract<MethodRequest, { operation: 'method.evidence.create' }>;
const semantic = (r: Request) => {
  const { requestId: _transport, ...rest } = r;
  return rest;
};
export async function executeMethodEvidence(
  request: Request,
  actor: ActorContext,
  repository: MethodRepository,
  initial: unknown,
  signal: AbortSignal,
  assertActive: () => void,
): Promise<unknown> {
  const bytes = canonicalBytes(request.content),
    contentHash = await sha256(bytes);
  const record = (raw: unknown) => {
    if (
      !raw ||
      typeof raw !== 'object' ||
      !('type' in raw) ||
      raw.type !== 'methodEvidence' ||
      !('value' in raw)
    )
      return null;
    if (Object.keys(raw).length !== 2)
      throw new StudyFailure('REFERENCE_MISMATCH', 502, 'method.evidence_receipt_structure');
    const value = methodEvidenceRecordSchema.parse(raw.value);
    if (
      value.studyId !== request.studyId ||
      value.requirementId !== request.content.requirementId ||
      value.declaredKind !== request.content.declaredKind ||
      value.artifactRef.contentHash !== contentHash ||
      value.artifactRef.byteSize !== bytes.length
    )
      throw new StudyFailure('REFERENCE_MISMATCH', 502, 'method.evidence_receipt_binding');
    return { type: 'methodEvidence' as const, value };
  };
  const committed = record(initial);
  if (committed) return committed;
  const intent = evidenceIntentSchema.parse(initial);
  let expected: MethodEvidenceContext | undefined;
  const resolve = async () => {
    assertActive();
    const raw = unpack(await repository.resolveIntent('evidence', intent.intentId, signal));
    assertActive();
    const completed = record(raw);
    if (completed) return { completed };
    const context = evidenceContextSchema.parse(raw);
    if (
      context.intentId !== intent.intentId ||
      context.expiresAt !== intent.expiresAt ||
      context.actorId !== actor.userId ||
      context.clientId !== (actor.clientId ?? null) ||
      context.studyId !== request.studyId ||
      !sameJson(semantic(context.request), semantic(request)) ||
      context.contentHash !== contentHash ||
      context.byteSize !== bytes.length ||
      (expected && !sameJson(context, expected))
    )
      throw new StudyFailure('REFERENCE_MISMATCH', 502, 'method.evidence_intent_identity');
    expected = context;
    return { context };
  };
  const before = await resolve();
  if (before.completed) return before.completed;
  const c = before.context!;
  const artifact: MethodPrivateArtifact = {
    studyId: c.studyId,
    artifactRef: {
      type: 'methodEvidence',
      id: c.artifactId,
      contentHash,
      digestScope: 'artifact_bytes_sha256',
      byteSize: bytes.length,
      mediaType: 'application/json',
      schemaVersion: 'lca.study-method-evidence.v1',
    },
    storageBucket: 'study-artifacts',
    storageObjectPath: `study/${c.studyId}/${c.artifactId}/evidence.json`,
  };
  assertActive();
  await repository.upload(artifact, bytes, signal);
  assertActive();
  const after = await resolve();
  if (after.completed) return after.completed;
  // SQL consume repeats current original actor/client/Study/source checks and
  // binds exact immutable body registration. Unknown outcomes retain bytes.
  const result = record(
    unpack(await repository.consumeIntent('evidence', intent.intentId, { artifact }, signal)),
  );
  assertActive();
  if (
    !result ||
    result.value.evidenceId !== c.evidenceId ||
    result.value.artifactRef.id !== c.artifactId ||
    result.value.recordedAt !== c.recordedAt
  )
    throw new StudyFailure('REFERENCE_MISMATCH', 502, 'method.evidence_consumed_identity');
  return result;
}
