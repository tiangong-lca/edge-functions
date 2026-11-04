import { z } from 'zod';
import {
  verifyVersionedExport as verifyRetainedExport,
  parseExportBundle as parseRetainedBundle,
} from '../v4/export.ts';
import { idSchema } from '../v1/common.ts';
import {
  exportManifestSchema as historicalManifestSchema,
  exportReceiptSchema,
  exportTrustAnchorSchema,
  EXPORT_SIGNATURE_DOMAIN,
  EXPORT_RECEIPT_SCHEMA,
  verifyExport as verifyHistoricalExport,
  parseExportBundle as parseHistoricalExportBundle,
  type ExportReceipt,
  type ExportTrustAnchor,
  type ExportFile,
} from '../v3/export.ts';
import {
  base64Url,
  canonicalBytes,
  decodeBase64Url,
  domainBytes,
  parseCanonicalBytes,
  sha256,
} from '../v3/canonical.ts';
import { isCanonicalBase64 } from '../v2/responses.ts';
import { finalizationSchema } from './review.ts';
import { reportViewSchema } from './view.ts';
export { exportReceiptSchema, exportTrustAnchorSchema, canonicalBytes };
export type { ExportReceipt, ExportTrustAnchor, ExportFile };
export const EXPORT_MANIFEST_SCHEMA = 'lca.study-export-manifest.v3' as const;
/** Additive manifest: historical v1 bytes and their verifier are never relabelled. */
export const exportManifestSchema = z
  .object({
    ...historicalManifestSchema.shape,
    renderer: historicalManifestSchema.shape.renderer.extend({
      version: z.literal('2.0.0'),
      viewModelVersion: z.literal('lca.study-report-view.v2'),
    }),
    schemaVersion: z.literal(EXPORT_MANIFEST_SCHEMA),
    reviewIds: z.array(idSchema).max(64),
    finalization: finalizationSchema,
  })
  .strict()
  .superRefine((v, c) => {
    const h = v.files[0],
      p = v.files[1],
      f = v.finalization;
    if (
      h.path !== 'report.html' ||
      h.mediaType !== 'text/html' ||
      p.path !== 'projection.json' ||
      p.mediaType !== 'application/json' ||
      v.files.reduce((n, f) => n + f.byteSize, 0) > 4 * 1024 * 1024 ||
      f.studyId !== v.studyId ||
      f.reportRevisionId !== v.reportRevisionId ||
      f.reportContentHash !== v.reportContentHash ||
      JSON.stringify(f.acceptedReviewIds) !== JSON.stringify(v.reviewIds) ||
      Date.parse(f.finalizedAt) > Date.parse(v.generatedAt)
    )
      c.addIssue({ code: 'custom', message: 'exact finalization and file bindings required' });
  });
export type ExportManifest = z.infer<typeof exportManifestSchema>;
export function validateExportViewBindings(input: unknown, manifest: ExportManifest): void {
  const v = reportViewSchema.parse(input);
  if (
    v.schemaVersion !== manifest.renderer.viewModelVersion ||
    v.rendererVersion !== manifest.renderer.version ||
    v.report.studyId !== manifest.studyId ||
    v.report.reportRevisionId !== manifest.reportRevisionId ||
    v.report.contentHash !== manifest.reportContentHash ||
    v.report.generatedAt !== manifest.generatedAt ||
    v.snapshot.validity !== manifest.validitySnapshot.status ||
    v.snapshot.checkedAt !== manifest.validitySnapshot.checkedAt ||
    v.snapshot.finalization !== 'finalized' ||
    v.snapshot.review !== (manifest.reviewIds.length ? 'reviewed' : 'unreviewed') ||
    JSON.stringify(v.snapshot.reviewIds) !== JSON.stringify(manifest.reviewIds)
  )
    throw new Error('export_view_binding');
}
export function canonicalReceiptBytes(input: unknown): Uint8Array {
  return canonicalBytes(exportReceiptSchema.parse(input));
}
export const exportBundleSchema = z
  .object({
    schemaVersion: z.literal('lca.study-export-bundle.v3'),
    manifestBase64: z.string().max(262144).refine(isCanonicalBase64),
    receipt: exportReceiptSchema,
    files: z
      .array(
        z
          .object({
            path: z.enum(['report.html', 'projection.json']),
            encoding: z.literal('base64'),
            bytes: z.string().max(5592408).refine(isCanonicalBase64),
          })
          .strict(),
      )
      .length(2),
  })
  .strict();
function decode(value: string): Uint8Array {
  if (!isCanonicalBase64(value)) throw new Error('export_base64_invalid');
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
export function parseExportBundle(bytes: Uint8Array): {
  manifestBytes: Uint8Array;
  receipt: ExportReceipt;
  files: ExportFile[];
} {
  const input = parseCanonicalBytes(bytes);
  if (
    input &&
    typeof input === 'object' &&
    'schemaVersion' in input &&
    (input.schemaVersion === 'lca.study-export-bundle.v1' ||
      input.schemaVersion === 'lca.study-export-bundle.v2')
  )
    return parseRetainedBundle(bytes);
  const bundle = exportBundleSchema.parse(input);
  return {
    manifestBytes: decode(bundle.manifestBase64),
    receipt: bundle.receipt,
    files: bundle.files.map((f) => ({ path: f.path, bytes: decode(f.bytes) })),
  };
}
export async function signExportManifest(
  input: unknown,
  keyId: string,
  privateKey: CryptoKey,
): Promise<ExportReceipt> {
  const manifest = exportManifestSchema.parse(input),
    bytes = domainBytes(EXPORT_SIGNATURE_DOMAIN, manifest),
    signature = new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, bytes));
  return exportReceiptSchema.parse({
    schemaVersion: EXPORT_RECEIPT_SCHEMA,
    manifestHash: await sha256(bytes),
    keyId,
    algorithm: 'Ed25519',
    signature: base64Url(signature),
  });
}
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
  const projection = files.find((f) => f.path === 'projection.json')!;
  validateExportViewBindings(parseCanonicalBytes(projection.bytes), manifest);
  return manifest;
}

/** Explicit discriminator for consumers retaining old P2 packages. No current-authority claim. */
export async function verifyVersionedExport(
  ...args: Parameters<typeof verifyExport>
): Promise<ExportManifest | Awaited<ReturnType<typeof verifyRetainedExport>>> {
  const value = parseCanonicalBytes(args[0]);
  if (
    value &&
    typeof value === 'object' &&
    'schemaVersion' in value &&
    (value.schemaVersion === 'lca.study-export-manifest.v1' ||
      value.schemaVersion === 'lca.study-export-manifest.v2')
  )
    return await verifyRetainedExport(...args);
  return await verifyExport(...args);
}
