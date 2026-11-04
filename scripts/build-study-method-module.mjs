import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
export const METHOD_PACKAGE_SHA256 =
  'b19ba5754b0bc20c44c8c65966bafafd5984cd74636f2c805c0fa4373f5554ad';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function projectMethodModule(bytes) {
  if (bytes.length > 1024 * 1024 || sha(bytes) !== METHOD_PACKAGE_SHA256)
    throw new Error('method_module_package_pin');
  const envelope = JSON.parse(Buffer.from(bytes).toString('utf8')),
    p = envelope.payload;
  const payloadBytes = Buffer.from(JSON.stringify(p, null, 2) + '\n');
  if (
    envelope.schema_version !== 1 ||
    envelope.kind !== 'method_module_package' ||
    sha(payloadBytes) !== envelope.payload_sha256 ||
    p.module_id !== 'method.pef-2021-ef31' ||
    p.module_version !== '0.1.0' ||
    p.manifest.scientific_approval !== false ||
    p.manifest.consumer_policy_included !== false
  )
    throw new Error('method_module_package_identity');
  const bindings = p.source_bindings,
    sourceRaw = p.authored_files['source-bindings.json'];
  if (
    sha(Buffer.from(sourceRaw)) !==
    '3fd9b1dc68228db3e146b6d23daac853b27b9f504f9445a0cc5a971d53257ce2'
  )
    throw new Error('method_module_bindings_pin');
  const canonical = (v) =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canonical(v[k])]),
          )
        : v;
  if (JSON.stringify(canonical(JSON.parse(sourceRaw))) !== JSON.stringify(canonical(bindings)))
    throw new Error('method_module_bindings_projection');
  const projection = {
    moduleRef: {
      repository: 'tiangong-lca/pcr',
      sourceCommit: '51c0842c67b14ba886e2edee2846e26eefac030f',
      moduleId: p.module_id,
      moduleVersion: p.module_version,
      artifactSha256: METHOD_PACKAGE_SHA256,
      reviewBasisSha256: p.review_basis_sha256,
      sourceBindingsSha256: sha(Buffer.from(sourceRaw)),
    },
    normativeVersion: bindings.normative_version,
    factorPackageVersion: bindings.factor_package_version,
    interimGuidanceSnapshot: bindings.interim_guidance,
    normalisationWeightingSourceSha256: bindings.normalisation_weighting_source.sha256,
    officialFactorPackageSha256: bindings.sources.find((s) => s.id === 'jrc-ef31-package').sha256,
    categories: bindings.methods.map((m) => ({
      methodRef: { id: m.id, version: m.version },
      name: m.name,
      role: m.role,
      parentMethodId: m.parent_id,
      referenceQuantityId: m.reference_quantity_id,
      unit: m.unit_label,
    })),
    normalisation: bindings.normalisation_weighting.map((n) => ({
      methodRef: { id: n.method_id, version: n.method_version },
      referenceQuantityId: n.reference_quantity_id,
      unit: n.unit_label,
      sourceNormalisationFactor: n.normalisation_factor,
      sourceWeightFraction: n.weight_fraction,
      sourceUnitLabel: n.source_unit_label,
      sourceShortDescription: n.source_short_description,
    })),
    requirements: p.requirements.map((r) => ({
      requirementId: r.id,
      sourceApplicability: r.applicability,
      sourceCheckKind: r.check_kind,
      sourceCitations: r.sources,
    })),
  };
  if (
    projection.categories.length !== 25 ||
    projection.normalisation.length !== 16 ||
    projection.requirements.length !== 20
  )
    throw new Error('method_module_inventory');
  return {
    schemaVersion: 'lca.study-method-public-module-metadata.v1',
    classification:
      'public immutable module identity/parameters only; no CF catalog, numerical execution, permission or scientific approval',
    sourceRepository: 'tiangong-lca/pcr',
    sourceCommit: projection.moduleRef.sourceCommit,
    workerSourceCommit: '13a749e619d7ef348e9298bb049e8c01c60e9086',
    rawPackageSha256: METHOD_PACKAGE_SHA256,
    rawPackageByteSize: bytes.length,
    payloadSha256: sha(payloadBytes),
    projectionSha256: sha(Buffer.from(JSON.stringify(canonical(projection)))),
    projection,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  let input,
    output,
    check = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && !input) input = args[++i];
    else if (args[i] === '--out' && !output) output = args[++i];
    else if (args[i] === '--check') check = true;
    else
      throw new Error(
        'usage: build-study-method-module --input <exact-public-package> --out <projection> [--check]',
      );
  }
  if (!input || !output) throw new Error('method_module_input_output_required');
  const raw = await readFile(input),
    value = projectMethodModule(raw),
    text = JSON.stringify(value, null, 2) + '\n';
  if (check) {
    if ((await readFile(output, 'utf8')) !== text)
      throw new Error('method_module_projection_drift');
  } else await writeFile(output, text);
  console.log(
    JSON.stringify({
      rawPackageSha256: value.rawPackageSha256,
      payloadSha256: value.payloadSha256,
      projectionSha256: value.projectionSha256,
      projectionFileSha256: sha(Buffer.from(text)),
    }),
  );
}
