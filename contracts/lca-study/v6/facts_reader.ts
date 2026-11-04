import { assessmentSchema, sameMethodJson } from './authoring.ts';
import {
  parseMethodFacts,
  methodConfigHash,
  METHOD_FACTS_MAX_BYTES,
  type MethodFacts,
} from './schemas.ts';
import { sha256 } from '../v3/canonical.ts';
import { StudyCodecError } from '../v2/codec.ts';

/** Byte/record identity verification only; current authorization is server-owned. */
export async function parseMethodFactsForAssessment(
  bytes: Uint8Array,
  assessmentRecord: unknown,
): Promise<MethodFacts> {
  try {
    const record = assessmentSchema.parse(assessmentRecord),
      ref = record.factsRef;
    if (
      record.execution.status !== 'completed' ||
      !ref ||
      bytes.length > METHOD_FACTS_MAX_BYTES ||
      bytes.length !== ref.byteSize ||
      (await sha256(bytes)) !== ref.contentHash
    )
      throw new Error('facts_bytes');
    const facts = parseMethodFacts(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
    if (
      facts.studyId !== record.studyId ||
      facts.assessmentId !== record.assessmentId ||
      facts.profileId !== record.profileId ||
      facts.configHash !== record.configHash ||
      (await methodConfigHash(record.config)) !== record.configHash ||
      !sameMethodJson(facts.config, record.config) ||
      !sameMethodJson(facts.moduleRef, record.config.moduleRef) ||
      facts.baseline.runId !== record.config.baselineRunId
    )
      throw new Error('facts_record');
    return facts;
  } catch {
    throw new StudyCodecError('REFERENCE_MISMATCH', 'response.method_facts');
  }
}
