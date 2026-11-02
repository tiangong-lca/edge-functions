import { z } from 'zod';
import { API_SCHEMA } from '../../../../contracts/lca-study/v2/common.ts';
import {
  calculationContractRefSchema,
  hashSchema,
  text,
} from '../../../../contracts/lca-study/v1/common.ts';
import { definitionSchema } from '../../../../contracts/lca-study/v1/records.ts';
import { overrideSchema } from '../../../../contracts/lca-study/v2/records.ts';
import { artifactCapabilitySchema, type StudyRepository } from './repository.ts';
import { StudyFailure, type ServerValidator } from './protocol.ts';

// Projection of Worker crates/solver-worker/src/study/contracts.rs, INPUT_SCHEMA v1.
// This checks the producer wire and declared bindings, never recalculates its model fingerprint.
const str = text(512),
  num = z.number().finite(),
  ref = z.object({ id: str, version: z.string().regex(/^\d{2}\.\d{2}\.\d{3}$/u) }).strict();
const port = z.object({ instanceId: str, exchangeId: str }).strict();
const cutoff = z.object({ port, reason: str }).strict();
const view = z.object({ port, flow: ref, unit: str, pivot: num }).strict();
const exchange = z
  .object({
    id: str,
    flow: ref,
    direction: str,
    amount: num,
    kind: str,
    unit: str,
    unitIdentity: z.array(ref).max(512),
    allocations: z.unknown().nullable(),
  })
  .strict();
const model = z
  .object({
    schemaVersion: z.literal('lca.study-normalized-model.v1'),
    origin: ref,
    reference: port,
    overrides: z.array(overrideSchema).max(256),
    instances: z
      .array(
        z
          .object({
            id: str,
            process: ref,
            referenceExchangeId: str,
            exchanges: z.array(exchange).max(4096),
          })
          .strict(),
      )
      .max(64),
    connections: z.array(z.object({ supplier: port, consumer: port }).strict()).max(4096),
    cutoffs: z.array(cutoff).max(4096),
    sourceDocuments: z
      .array(
        z
          .object({
            kind: str,
            identity: ref,
            sha256: hashSchema,
            stateCode: z.union([z.literal(0), z.literal(100)]),
          })
          .strict(),
      )
      .max(512),
    qualityFindings: z.array(text(4096)).max(4096),
  })
  .strict();
const workerDefinition = definitionSchema;
const matrix = z.array(z.array(num).max(4096)).max(4096);
const bound = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const preparedInputSchema = z
  .object({
    schemaVersion: z.literal('lca.study-prepared-input.v1'),
    profileId: z.literal('lca.study-explicit-v1'),
    compilerVersion: z.literal('study.compiler.v1'),
    calculationContractRef: calculationContractRefSchema,
    sourceHash: hashSchema,
    modelHash: hashSchema,
    inputHash: hashSchema.nullable(),
    methodSourceHash: hashSchema,
    studyBinding: z
      .object({
        studyRevisionId: str,
        studyRevisionContentHash: hashSchema,
        definition: workerDefinition,
      })
      .strict()
      .nullable(),
    model,
    numeric: z
      .object({
        views: z.array(view).max(128),
        inventoryAxes: z
          .array(z.object({ flow: ref, direction: str, unit: str }).strict())
          .max(4096),
        methodAxes: z
          .array(z.object({ id: str, version: ref.shape.version, unit: str }).strict())
          .max(25),
        reference: view,
        a: matrix,
        b: matrix,
        c: matrix,
        y: z.array(num).max(128),
      })
      .strict(),
    coverage: z.array(z.object({ method: ref, inventoryIndex: bound }).strict()).max(102400),
    limits: z
      .object({
        maxSourceBytes: bound,
        maxDocuments: bound,
        maxInstances: bound,
        maxViews: bound,
        maxExchanges: bound,
        maxMethods: bound,
        maxNonzeros: bound,
        maxDenseCells: bound,
        maxArtifactBytes: bound,
        maxElapsedMillis: bound,
        maxFunctionalUnitAmount: num.positive(),
        maxOwnedBytes: bound,
      })
      .strict(),
  })
  .strict();
export async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function createPreparedInputValidator(repository: StudyRepository): ServerValidator {
  return async (intent, signal) => {
    const r = intent.revision,
      p = intent.preparation,
      artifact = p.inputArtifactRef;
    if (
      !artifact ||
      artifact.type !== 'modelInput' ||
      artifact.schemaVersion !== 'lca.study-prepared-input.v1' ||
      p.profileId !== 'lca.study-explicit-v1'
    )
      throw new StudyFailure('CAPABILITY_UNAVAILABLE', 503, 'freeze.producer_schema');
    const raw = await repository.dispatch(
      {
        schemaVersion: API_SCHEMA,
        requestId: intent.intentId,
        operation: 'artifact.read',
        studyId: r.studyId,
        artifactRef: artifact,
      },
      signal,
    );
    if (!raw || typeof raw !== 'object' || !('ok' in raw) || raw.ok !== true || !('data' in raw))
      throw new StudyFailure('FORBIDDEN', 403, 'freeze.artifact_authorization');
    const cap = artifactCapabilitySchema.parse(raw.data);
    if (cap.studyId !== r.studyId || JSON.stringify(cap.artifactRef) !== JSON.stringify(artifact))
      return { outcome: 'failed', code: 'REFERENCE_MISMATCH' };
    const bytes = await repository.download(cap, signal);
    signal.throwIfAborted();
    if (bytes.length !== artifact.byteSize || (await sha256(bytes)) !== artifact.contentHash)
      return { outcome: 'failed', code: 'REFERENCE_MISMATCH' };
    let input: unknown;
    try {
      input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      return { outcome: 'failed', code: 'INVALID_REQUEST' };
    }
    const result = preparedInputSchema.safeParse(input);
    if (!result.success) return { outcome: 'failed', code: 'INVALID_REQUEST' };
    const m = result.data,
      d = r.definition;
    if (
      m.modelHash !== r.modelRef.contentHash ||
      m.profileId !== p.profileId ||
      m.inputHash !== p.inputHash ||
      JSON.stringify(p.methodRefs) !== JSON.stringify(d.methodRefs) ||
      JSON.stringify(m.calculationContractRef) !== JSON.stringify(p.calculationContractRef) ||
      d.methodRefs.some(
        (method) =>
          !m.numeric.methodAxes.some(
            (axis) => axis.id === method.id && axis.version === method.version,
          ),
      ) ||
      d.methodRefs.length > m.limits.maxMethods ||
      d.functionalUnit.referenceFlowId !== m.numeric.reference.flow.id ||
      d.functionalUnit.unit !== m.numeric.reference.unit ||
      !Number.isFinite(Number(d.functionalUnit.amount)) ||
      Number(d.functionalUnit.amount) <= 0 ||
      Number(d.functionalUnit.amount) > m.limits.maxFunctionalUnitAmount
    )
      return { outcome: 'failed', code: 'REFERENCE_MISMATCH' };
    // A prior Scenario preparation can be adopted as a new revision; its old studyBinding
    // remains historical. The new definition is checked against the qualified axes/reference.
    return { outcome: 'passed' };
  };
}
