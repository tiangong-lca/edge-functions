import { z } from 'zod';
import {
  CONTRACT_VERSION,
  errorCodeSchema,
  capabilitiesSchema,
  type QualifiedProfile,
  type StudyApiRequest,
} from '../../../../contracts/lca-study/v2/index.ts';
import { idSchema, timestampSchema } from '../../../../contracts/lca-study/v1/common.ts';
import {
  definitionSchema,
  studyRevisionSchema,
} from '../../../../contracts/lca-study/v1/records.ts';
import { modelPreparationSchema } from '../../../../contracts/lca-study/v2/records.ts';

/** A deployment allowlist, never inferred from the presence of an implementation. */
export const P1_OPERATIONS = [
  'capability.read',
  'study.create',
  'study.read',
  'study.list',
  'study.resources.list',
  'study.archive',
  'study.select_revision',
  'member.set',
  'model.source.resolve',
  'model.source.read',
  'model.prepare',
  'model.read',
  'revision.create',
  'revision.save',
  'revision.read',
  'revision.freeze',
  'scenario.create',
  'scenario.save',
  'scenario.read',
  'scenario.freeze',
  'run.submit',
  'run.read',
  'run.cancel',
  'artifact.read',
] as const;
export const configSchema = capabilitiesSchema.refine(
  (value) =>
    value.operations.every((op) => P1_OPERATIONS.includes(op as (typeof P1_OPERATIONS)[number])) &&
    (value.runtimeEnabled || value.operations.every((op) => op === 'capability.read')),
  'only qualified P1 operations may be enabled',
);
export type RuntimeConfig = z.infer<typeof configSchema>;
export const DISABLED_CONFIG: RuntimeConfig = {
  type: 'capabilities',
  contractVersion: CONTRACT_VERSION,
  runtimeEnabled: false,
  operations: ['capability.read'],
  profiles: [],
};
export function readConfig(): RuntimeConfig {
  const encoded = Deno.env.get('STUDY_RUNTIME_CONFIG');
  return encoded ? configSchema.parse(JSON.parse(encoded)) : DISABLED_CONFIG;
}
export const failureSchema = z
  .object({ ok: z.literal(false), code: errorCodeSchema })
  .passthrough();
export class StudyFailure extends Error {
  constructor(
    public code: z.infer<typeof errorCodeSchema>,
    public status: number,
    public ruleId = 'runtime.failure',
  ) {
    super(code);
  }
}
export const intentSchema = z
  .object({
    kind: z.literal('revisionValidationIntent'),
    intentId: idSchema,
    expiresAt: timestampSchema,
    revision: studyRevisionSchema,
    preparation: modelPreparationSchema,
  })
  .strict();
export type ValidationIntent = z.infer<typeof intentSchema>;
export type ValidationDecision =
  { outcome: 'passed' } | { outcome: 'failed'; code: 'INVALID_REQUEST' | 'REFERENCE_MISMATCH' };
export type ServerValidator = (
  intent: ValidationIntent,
  signal: AbortSignal,
) => Promise<ValidationDecision>;
export function profileAllowed(
  profiles: QualifiedProfile[],
  profileId: string,
  calculationContractRef: unknown,
): boolean {
  return profiles.some(
    (p) =>
      p.profileId === profileId &&
      JSON.stringify(p.calculationContractRef) === JSON.stringify(calculationContractRef),
  );
}
export function isQuery(request: StudyApiRequest): boolean {
  return request.operation.endsWith('.read') || request.operation.endsWith('.list');
}
export function assertIntent(
  intent: ValidationIntent,
  request: StudyApiRequest,
  profiles: QualifiedProfile[],
): void {
  // expiresAt is shape-checked by intentSchema. Database clocks govern issue,
  // replay and consumption; a skewed Edge wall clock must not strand recovery.
  if (request.operation !== 'revision.freeze') throw new StudyFailure('REFERENCE_MISMATCH', 502);
  const r = intent.revision,
    p = intent.preparation;
  if (
    r.revisionId !== request.target.id ||
    r.revision !== request.target.expectedRevision ||
    r.contentHash !== request.expectedContentHash ||
    r.status !== 'draft' ||
    r.validation !== 'not_checked' ||
    p.preparationId !== r.modelPreparationId ||
    p.studyId !== r.studyId ||
    p.execution.status !== 'completed' ||
    JSON.stringify(p.methodRefs) !== JSON.stringify(r.definition.methodRefs) ||
    JSON.stringify(p.modelRef) !== JSON.stringify(r.modelRef) ||
    !p.inputArtifactRef ||
    !definitionSchema.safeParse(r.definition).success
  )
    throw new StudyFailure('REFERENCE_MISMATCH', 409, 'freeze.intent_binding');
  if (!profileAllowed(profiles, p.profileId, p.calculationContractRef))
    throw new StudyFailure('CAPABILITY_UNAVAILABLE', 503, 'freeze.profile');
}
