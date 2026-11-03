import { assertEquals, assertRejects, assertThrows } from 'jsr:@std/assert';
import {
  canonicalBytes,
  canonicalJson,
  domainBytes,
  base64Url,
  parseCanonicalBytes,
  sha256,
} from '../contracts/lca-study/v3/canonical.ts';
import {
  exportManifestSchema,
  signExportManifest,
  verifyExport,
  EXPORT_SIGNATURE_DOMAIN,
  type ExportTrustAnchor,
} from '../contracts/lca-study/v3/export.ts';
import { createPublicKey, verify as nodeVerify } from 'node:crypto';
import { Buffer } from 'node:buffer';

async function fixture() {
  const keys = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const files = [
    {
      path: 'report.html' as const,
      bytes: new TextEncoder().encode(
        '<!doctype html><p>1.796202 mol H+ eq; partial coverage, unreviewed</p>',
      ),
    },
    {
      path: 'projection.json' as const,
      bytes: canonicalBytes({ canonicalValue: '1.796202', unit: 'mol H+ eq', coverage: 'partial' }),
    },
  ];
  const manifest = exportManifestSchema.parse({
    schemaVersion: 'lca.study-export-manifest.v1',
    issuerId: 'fixture-project',
    exportId: 'export-1',
    studyId: 'study-1',
    reportRevisionId: 'report-1',
    reportContentHash: '1'.repeat(64),
    actorId: 'actor-1',
    clientId: 'client-1',
    grantEpoch: 1,
    policyId: 'lca.study-report-disclosure.v1',
    disclosureContextHash: '2'.repeat(64),
    generatedAt: '2026-11-03T00:00:00.000Z',
    validitySnapshot: { status: 'current', checkedAt: '2026-11-03T00:00:00.000Z', reasonCodes: [] },
    reviewIds: [],
    renderer: {
      version: '1.0.0',
      viewModelVersion: 'lca.study-report-view.v1',
      artifactHash: '3'.repeat(64),
    },
    files: await Promise.all(
      files.map(async (f) => ({
        path: f.path,
        mediaType: f.path.endsWith('.html') ? 'text/html' : 'application/json',
        sha256: await sha256(f.bytes),
        byteSize: f.bytes.length,
      })),
    ),
  });
  const anchor: ExportTrustAnchor = {
    keyId: 'fixture-key',
    issuerId: 'fixture-project',
    publicKeySpki: base64Url(new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey))),
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: '2027-01-01T00:00:00.000Z',
    rendererArtifactHashes: ['3'.repeat(64)],
  };
  const receipt = await signExportManifest(manifest, anchor.keyId, keys.privateKey);
  const expected = {
    issuerId: manifest.issuerId,
    exportId: manifest.exportId,
    studyId: manifest.studyId,
    reportRevisionId: manifest.reportRevisionId,
    reportContentHash: manifest.reportContentHash,
  };
  return { keys, files, manifest, anchor, receipt, expected };
}

Deno.test(
  'detached Study signature authenticates actual HTML and exact generation identity',
  async () => {
    const f = await fixture();
    assertEquals(
      await verifyExport(canonicalBytes(f.manifest), f.receipt, f.files, [f.anchor], f.expected),
      f.manifest,
    );
    // Independent Node crypto implementation verifies the exact WebCrypto-produced signature.
    const publicKey = createPublicKey({
      key: Buffer.from(await crypto.subtle.exportKey('spki', f.keys.publicKey)),
      format: 'der',
      type: 'spki',
    });
    assertEquals(
      nodeVerify(
        null,
        domainBytes(EXPORT_SIGNATURE_DOMAIN, f.manifest),
        publicKey,
        Buffer.from(f.receipt.signature, 'base64url'),
      ),
      true,
    );
    const changedHtml = [
      { ...f.files[0], bytes: new TextEncoder().encode('<p>Approved; zero emissions</p>') },
      f.files[1],
    ];
    await assertRejects(
      () =>
        verifyExport(canonicalBytes(f.manifest), f.receipt, changedHtml, [f.anchor], f.expected),
      Error,
      'export_file_integrity',
    );
    await assertRejects(
      () =>
        verifyExport(
          canonicalBytes(f.manifest),
          f.receipt,
          [f.files[0], { ...f.files[1], bytes: canonicalBytes({ canonicalValue: '0' }) }],
          [f.anchor],
          f.expected,
        ),
      Error,
      'export_file_integrity',
    );
    for (const key of [
      'issuerId',
      'exportId',
      'studyId',
      'reportRevisionId',
      'reportContentHash',
    ] as const)
      await assertRejects(
        () =>
          verifyExport(canonicalBytes(f.manifest), f.receipt, f.files, [f.anchor], {
            ...f.expected,
            [key]: 'different',
          }),
        Error,
        'export_trust_binding',
      );
    await assertRejects(
      () =>
        verifyExport(
          canonicalBytes({ ...f.manifest, grantEpoch: 2 }),
          f.receipt,
          f.files,
          [f.anchor],
          f.expected,
        ),
      Error,
      'export_manifest_digest',
    );
    await assertRejects(
      () =>
        verifyExport(
          canonicalBytes(f.manifest),
          f.receipt,
          [f.files[0], f.files[0]],
          [f.anchor],
          f.expected,
        ),
      Error,
      'export_file_inventory',
    );
  },
);

Deno.test(
  'Study verifier refuses self-supplied keys, ambiguous anchors and noncanonical manifests',
  async () => {
    const f = await fixture(),
      attacker = await fixture();
    const forged = await signExportManifest(f.manifest, f.anchor.keyId, attacker.keys.privateKey);
    await assertRejects(
      () => verifyExport(canonicalBytes(f.manifest), forged, f.files, [f.anchor], f.expected),
      Error,
      'export_signature_invalid',
    );
    await assertRejects(() =>
      verifyExport(
        canonicalBytes(f.manifest),
        { ...forged, publicKey: attacker.anchor.publicKeySpki },
        f.files,
        [f.anchor],
        f.expected,
      ),
    );
    await assertRejects(
      () => verifyExport(canonicalBytes(f.manifest), f.receipt, f.files, [], f.expected),
      Error,
      'export_trust_binding',
    );
    await assertRejects(
      () =>
        verifyExport(
          canonicalBytes(f.manifest),
          f.receipt,
          f.files,
          [f.anchor, f.anchor],
          f.expected,
        ),
      Error,
      'export_trust_binding',
    );
    await assertRejects(
      () =>
        verifyExport(
          canonicalBytes(f.manifest),
          f.receipt,
          f.files,
          [{ ...f.anchor, validUntil: '2026-11-02T00:00:00.000Z' }],
          f.expected,
        ),
      Error,
      'export_trust_scope',
    );
    await assertRejects(
      () =>
        verifyExport(
          canonicalBytes(f.manifest),
          f.receipt,
          f.files,
          [{ ...f.anchor, rendererArtifactHashes: ['4'.repeat(64)] }],
          f.expected,
        ),
      Error,
      'export_trust_scope',
    );
    await assertRejects(
      () =>
        verifyExport(
          new TextEncoder().encode(JSON.stringify(f.manifest, null, 2)),
          f.receipt,
          f.files,
          [f.anchor],
          f.expected,
        ),
      Error,
      'report_noncanonical_bytes',
    );
    assertThrows(
      () => parseCanonicalBytes(new TextEncoder().encode('{"x":1,"x":1}')),
      Error,
      'report_noncanonical_bytes',
    );
    assertThrows(() => canonicalJson({ value: 0.1 }), Error, 'report_integer_required');
    assertThrows(() => canonicalJson({ value: '\ud800' }), Error, 'report_unicode_invalid');
    assertEquals(
      canonicalJson({ z: ['5e-324', '0', '-1.2'], a: true }),
      '{"a":true,"z":["5e-324","0","-1.2"]}',
    );
  },
);
