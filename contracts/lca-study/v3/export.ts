import { z } from 'zod';
import { hashSchema, idSchema, timestampSchema, validitySchema } from '../v1/common.ts';
import {
  base64Url,
  canonicalBytes,
  decodeBase64Url,
  domainBytes,
  parseCanonicalBytes,
  sha256,
} from './canonical.ts';

export const EXPORT_MANIFEST_SCHEMA = 'lca.study-export-manifest.v1' as const;
export const EXPORT_RECEIPT_SCHEMA = 'lca.study-export-receipt.v2' as const;
export const EXPORT_SIGNATURE_DOMAIN = 'lca.study-export-signature.v1' as const;
const fileSchema = z
  .object({
    path: z.enum(['report.html', 'projection.json']),
    mediaType: z.enum(['text/html', 'application/json']),
    sha256: hashSchema,
    byteSize: z
      .number()
      .int()
      .min(1)
      .max(4 * 1024 * 1024),
  })
  .strict();
export const exportManifestSchema = z
  .object({
    schemaVersion: z.literal(EXPORT_MANIFEST_SCHEMA),
    issuerId: idSchema,
    exportId: idSchema,
    studyId: idSchema,
    reportRevisionId: idSchema,
    reportContentHash: hashSchema,
    actorId: idSchema,
    clientId: idSchema.nullable(),
    grantEpoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    policyId: z.literal('lca.study-report-disclosure.v1'),
    disclosureContextHash: hashSchema,
    generatedAt: timestampSchema,
    validitySnapshot: validitySchema,
    reviewIds: z.array(idSchema).max(0),
    renderer: z
      .object({
        version: z.literal('1.0.0'),
        viewModelVersion: z.literal('lca.study-report-view.v1'),
        artifactHash: hashSchema,
      })
      .strict(),
    files: z.array(fileSchema).length(2),
  })
  .strict()
  .superRefine((value, ctx) => {
    const html = value.files[0],
      projection = value.files[1];
    if (
      html.path !== 'report.html' ||
      html.mediaType !== 'text/html' ||
      projection.path !== 'projection.json' ||
      projection.mediaType !== 'application/json' ||
      value.files.reduce((total, f) => total + f.byteSize, 0) > 4 * 1024 * 1024
    )
      ctx.addIssue({
        code: 'custom',
        message: 'exact bounded self-contained export files required',
      });
  });
export const exportReceiptSchema = z
  .object({
    schemaVersion: z.literal(EXPORT_RECEIPT_SCHEMA),
    manifestHash: hashSchema,
    keyId: idSchema,
    algorithm: z.literal('Ed25519'),
    signature: z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/u),
  })
  .strict();
export const exportTrustAnchorSchema = z
  .object({
    keyId: idSchema,
    issuerId: idSchema,
    publicKeySpki: z.string().min(1).max(128),
    validFrom: timestampSchema,
    validUntil: timestampSchema,
    rendererArtifactHashes: z.array(hashSchema).min(1).max(32),
  })
  .strict()
  .refine((v) => Date.parse(v.validFrom) < Date.parse(v.validUntil), 'key lifetime required');
export type ExportManifest = z.infer<typeof exportManifestSchema>;
export type ExportReceipt = z.infer<typeof exportReceiptSchema>;
export type ExportTrustAnchor = z.infer<typeof exportTrustAnchorSchema>;
export type ExportFile = { path: 'report.html' | 'projection.json'; bytes: Uint8Array };

export async function signExportManifest(
  input: unknown,
  keyId: string,
  privateKey: CryptoKey,
): Promise<ExportReceipt> {
  const manifest = exportManifestSchema.parse(input);
  const bytes = domainBytes(EXPORT_SIGNATURE_DOMAIN, manifest);
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, bytes));
  return exportReceiptSchema.parse({
    schemaVersion: EXPORT_RECEIPT_SCHEMA,
    manifestHash: await sha256(bytes),
    keyId,
    algorithm: 'Ed25519',
    signature: base64Url(signature),
  });
}

/** Caller supplies independently trusted anchors. Keys or trust flags from the export are never inputs. */
export async function verifyExport(
  manifestBytes: Uint8Array,
  receiptInput: unknown,
  files: readonly ExportFile[],
  independentlyTrustedAnchors: readonly ExportTrustAnchor[],
  expected: {
    issuerId: string;
    exportId: string;
    studyId: string;
    reportRevisionId: string;
    reportContentHash: string;
  },
): Promise<ExportManifest> {
  const manifest = exportManifestSchema.parse(parseCanonicalBytes(manifestBytes));
  const receipt = exportReceiptSchema.parse(receiptInput);
  if (independentlyTrustedAnchors.length > 32) throw new Error('export_trust_bounds');
  const anchors = independentlyTrustedAnchors
    .map((v) => exportTrustAnchorSchema.parse(v))
    .filter((v) => v.keyId === receipt.keyId && v.issuerId === manifest.issuerId);
  if (
    anchors.length !== 1 ||
    manifest.issuerId !== expected.issuerId ||
    manifest.exportId !== expected.exportId ||
    manifest.studyId !== expected.studyId ||
    manifest.reportRevisionId !== expected.reportRevisionId ||
    manifest.reportContentHash !== expected.reportContentHash
  )
    throw new Error('export_trust_binding');
  const anchor = anchors[0],
    generated = Date.parse(manifest.generatedAt);
  if (
    generated < Date.parse(anchor.validFrom) ||
    generated >= Date.parse(anchor.validUntil) ||
    !anchor.rendererArtifactHashes.includes(manifest.renderer.artifactHash)
  )
    throw new Error('export_trust_scope');
  const signed = domainBytes(EXPORT_SIGNATURE_DOMAIN, manifest);
  if ((await sha256(signed)) !== receipt.manifestHash) throw new Error('export_manifest_digest');
  // Ed25519 SPKI is exactly 44 bytes. Algorithm selection cannot be supplied by the document.
  const key = await crypto.subtle.importKey(
    'spki',
    decodeBase64Url(anchor.publicKeySpki, 44),
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  if (!(await crypto.subtle.verify('Ed25519', key, decodeBase64Url(receipt.signature, 64), signed)))
    throw new Error('export_signature_invalid');
  if (
    files.length !== manifest.files.length ||
    new Set(files.map((f) => f.path)).size !== files.length
  )
    throw new Error('export_file_inventory');
  for (const descriptor of manifest.files) {
    const file = files.find((f) => f.path === descriptor.path);
    if (
      !file ||
      file.bytes.length !== descriptor.byteSize ||
      (await sha256(file.bytes)) !== descriptor.sha256
    )
      throw new Error('export_file_integrity');
  }
  return manifest;
}

export { canonicalBytes };
