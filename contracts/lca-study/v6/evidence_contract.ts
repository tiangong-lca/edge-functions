import { z } from 'zod';
import { resolveOwnerSchema, hasOnlyUnicodeScalars } from './owner_json.ts';
import { methodEvidenceSchema, type MethodEvidenceRecord } from './schemas.ts';
import { canonicalBytes, sha256 } from '../v3/canonical.ts';
export const methodEvidenceRefSchema = z
  .fromJSONSchema(
    resolveOwnerSchema(
      'study-method-evidence-record.v1.schema.json',
      '/$defs/evidenceRecord/properties/artifactRef',
    ) as Parameters<typeof z.fromJSONSchema>[0],
  )
  .superRefine((value, ctx) => {
    if (!hasOnlyUnicodeScalars(value))
      ctx.addIssue({ code: 'custom', message: 'Unicode scalar evidence reference required' });
  }) as z.ZodType<MethodEvidenceRecord['artifactRef']>;
export async function methodEvidenceHash(input: unknown): Promise<string> {
  return await sha256(canonicalBytes(methodEvidenceSchema.parse(input)));
}
