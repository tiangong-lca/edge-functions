import { reportRevisionSchema, sameMethodJson } from './authoring.ts';
import {
  methodEvidenceRecordSchema,
  methodEvidenceSchema,
  methodConfigHash,
  type MethodEvidence,
} from './schemas.ts';
import { methodReportContentSchema, type MethodReportContent } from './report_content.ts';
import { sha256, parseCanonicalBytes } from '../v3/canonical.ts';
import { StudyCodecError } from '../v2/codec.ts';

async function read(
  bytes: Uint8Array,
  ref: { byteSize: number; contentHash: string },
  max: number,
): Promise<unknown> {
  if (
    bytes.length > max ||
    bytes.length !== ref.byteSize ||
    (await sha256(bytes)) !== ref.contentHash
  )
    throw Error('artifact_binding');
  return parseCanonicalBytes(bytes);
}
/** Verifies retained body/record identities, never source permission or approval. */
export async function parseMethodEvidenceForRecord(
  bytes: Uint8Array,
  evidenceRecord: unknown,
): Promise<MethodEvidence> {
  try {
    const record = methodEvidenceRecordSchema.parse(evidenceRecord);
    const body = methodEvidenceSchema.parse(await read(bytes, record.artifactRef, 65536));
    if (body.requirementId !== record.requirementId || body.declaredKind !== record.declaredKind)
      throw Error('evidence_record');
    return body;
  } catch {
    throw new StudyCodecError('REFERENCE_MISMATCH', 'response.method_evidence');
  }
}
/** Full private producer factsBindingHash verification requires its original Run context.
 * This public parser verifies exact stored bytes and every available public relation.
 */
export async function parseMethodReportContentForRevision(
  bytes: Uint8Array,
  reportRevision: unknown,
): Promise<MethodReportContent> {
  try {
    const record = reportRevisionSchema.parse(reportRevision);
    const content = methodReportContentSchema.parse(await read(bytes, record.contentRef, 4194304));
    if (
      record.contentHash !== record.contentRef.contentHash ||
      content.reportRevisionId !== record.reportRevisionId ||
      content.studyId !== record.studyId ||
      content.templateId !== record.templateId ||
      !sameMethodJson(content.runIds, record.runIds) ||
      !sameMethodJson(content.methodAssessmentIds, record.methodAssessmentIds) ||
      !sameMethodJson(content.factsRefs, record.factsRefs) ||
      (await methodConfigHash(content.methodAssessment.config)) !==
        content.methodAssessment.configHash
    )
      throw Error('report_record');
    return content;
  } catch {
    throw new StudyCodecError('REFERENCE_MISMATCH', 'response.method_report_content');
  }
}
