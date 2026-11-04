import { build, version as esbuildVersion } from 'esbuild';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { declaration } from './build-study-contract.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

/** Pure prepublication contract component. No renderer hash, access or activation authority. */
export async function buildStudyMethodSummary(outputDirectory, { allowDirty = false } = {}) {
  const output = path.resolve(outputDirectory),
    relative = path.relative(root, output);
  if (
    !path.isAbsolute(outputDirectory) ||
    !relative ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  )
    throw new Error('method_summary_output_outside_source_required');
  if (
    await stat(output).then(
      () => true,
      (error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      },
    )
  )
    throw new Error('method_summary_output_must_be_new');
  const dirty = git('status', '--porcelain', '--untracked-files=normal') !== '';
  if (dirty && !allowDirty) throw new Error('method_summary_clean_source_required');
  const sourceCommit = git('rev-parse', 'HEAD');
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const importMap = JSON.parse(
    await readFile(path.join(root, 'supabase/functions/deno.json'), 'utf8'),
  );
  if (
    process.versions.node !== '24.19.0' ||
    esbuildVersion !== metadata.devDependencies.esbuild ||
    importMap.imports.zod !== `npm:/zod@${metadata.devDependencies.zod}`
  )
    throw new Error('method_summary_toolchain_drift');
  const consumption = JSON.parse(
    await readFile(path.join(root, 'contracts/lca-study/worker/method/manifest.json'), 'utf8'),
  );
  for (const [file, expected] of Object.entries({
    ...consumption.schemas,
    ...consumption.fixtures,
    [consumption.moduleMetadata.path]: consumption.moduleMetadata.sha256,
  }))
    if (sha(await readFile(path.join(root, file))) !== expected)
      throw new Error('method_summary_owner_drift');
  const options = {
    absWorkingDir: root,
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: ['es2022'],
    charset: 'utf8',
    legalComments: 'inline',
    metafile: true,
    logLevel: 'silent',
  };
  const runtime = await build({
    ...options,
    entryPoints: ['contracts/lca-study/v6/summary_portable.ts'],
  });
  const schema = await build({
    ...options,
    stdin: {
      contents: `import{z}from'zod';import{methodSummaryJsonSchema,makeMethodSummary}from'./contracts/lca-study/v6/summary.ts';import{methodViewSchema}from'./contracts/lca-study/v6/view_schema.ts';import{canonicalBytes,domainBytes}from'./contracts/lca-study/v3/canonical.ts';export{METHOD_PUBLIC_MODULE_FILE_SHA256,METHOD_PUBLIC_MODULE_PROJECTION_SHA256}from'./contracts/lca-study/v6/module_identity.ts';export const summary=methodSummaryJsonSchema();export const view=z.toJSONSchema(methodViewSchema,{target:'draft-7'});export{makeMethodSummary,canonicalBytes,domainBytes};`,
      resolveDir: root,
      sourcefile: 'method-summary-build.ts',
      loader: 'ts',
    },
  });
  const generated = await import(
    `data:text/javascript;base64,${Buffer.from(schema.outputFiles[0].contents).toString('base64')}`
  );
  const moduleMetadataBytes = await readFile(path.join(root, consumption.moduleMetadata.path));
  if (
    sha(moduleMetadataBytes) !== generated.METHOD_PUBLIC_MODULE_FILE_SHA256 ||
    JSON.parse(moduleMetadataBytes.toString('utf8')).projectionSha256 !==
      generated.METHOD_PUBLIC_MODULE_PROJECTION_SHA256
  )
    throw new Error('method_summary_public_module_drift');
  const factsBytes = await readFile(
    path.join(root, 'test/fixtures/lca-study-v6/facts.synthetic.json'),
  );
  const facts = JSON.parse(factsBytes.toString('utf8'));
  const seams = JSON.parse(
    await readFile(path.join(root, 'test/fixtures/lca-study-v6/worker-service-seams.json'), 'utf8'),
  );
  const factsRef = seams.record.factsRef;
  if (factsRef.byteSize !== factsBytes.length || factsRef.contentHash !== sha(factsBytes))
    throw new Error('method_summary_fixture_byte_binding');
  const summary = generated.makeMethodSummary(facts, factsRef);
  const run = seams.inputContext.input.baseline.run;
  const baseline = {
    runId: run.runId,
    studyId: run.studyId,
    studyRevisionId: run.studyRevisionId,
    scenarioRevisionId: run.scenarioRevisionId,
    effectiveModelRef: run.effectiveModelRef,
    inputHash: run.inputHash,
    profileId: run.profileId,
    engineId: run.engineId,
    calculationContractRef: run.calculationContractRef,
    resultRef: run.resultRef,
    preparedArtifactRef: facts.baseline.preparedArtifactRef,
    sourceSnapshotRef: facts.baseline.sourceSnapshotRef,
  };
  const assessment = {
    assessmentId: facts.assessmentId,
    profileId: facts.profileId,
    configHash: facts.configHash,
    moduleRef: facts.moduleRef,
  };
  const binding = {
    studyId: facts.studyId,
    runIds: [run.runId],
    methodAssessmentIds: [facts.assessmentId],
    factsRefs: [factsRef],
    baseline,
    assessment,
  };
  const fact = facts.factCatalog[0];
  const claim = {
    claimId: 'synthetic-method-claim',
    bundleRef: factsRef,
    factId: fact.factId,
    canonicalValue: fact.canonicalValue,
    unit: fact.unit,
    display: { style: 'exact' },
  };
  const content = {
    schemaVersion: 'lca.study-method-report-draft.v1',
    title: 'Synthetic method report component fixture',
    claims: [claim],
    sections: [],
    tables: [],
    charts: [],
    additionalLimitations: [
      'Synthetic transport/component evidence; no authorization or scientific qualification.',
    ],
  };
  const stored = {
    schemaVersion: 'lca.study-method-report-content.v1',
    reportRevisionId: '10000000-0000-4000-8000-000000000300',
    studyId: facts.studyId,
    templateId: 'lca.study-method-report.v1',
    runIds: [run.runId],
    methodAssessmentIds: [facts.assessmentId],
    factsRefs: [factsRef],
    factsBindingHash: sha(
      generated.domainBytes('lca.study-method-report-facts-binding.v1', binding),
    ),
    content,
    claims: [{ ...claim, fact }],
    methodAssessment: summary,
  };
  const view = {
    schemaVersion: 'lca.study-report-view.v3',
    rendererVersion: '3.0.0',
    report: {
      studyId: facts.studyId,
      reportRevisionId: stored.reportRevisionId,
      contentHash: sha(generated.canonicalBytes(stored)),
      title: content.title,
      generatedAt: '2026-11-04T00:00:00Z',
    },
    definition: {
      goal: 'Synthetic method assessment report; no scientific approval.',
      functionalUnit: facts.frozenEvidence.functionalUnit,
      boundary: facts.frozenEvidence.declaredSystemBoundary,
      methodRefs: facts.frozenEvidence.methodAxes.map((m) => ({
        ...m,
        name: facts.categories.find((c) => c.methodRef.id === m.id)?.name ?? m.id,
      })),
    },
    runs: [
      {
        runId: run.runId,
        scenarioRevisionId: run.scenarioRevisionId,
        label: 'Frozen synthetic baseline Run',
        inputHash: run.inputHash,
        profileId: run.profileId,
        calculationContractRef: run.calculationContractRef,
      },
    ],
    facts: [
      {
        factId: claim.claimId,
        label: 'Supplied characterised method category value',
        runIds: [run.runId],
        methodRef: fact.methodRef,
        canonicalValue: fact.canonicalValue,
        unit: fact.unit,
        coverage: fact.coverage,
        reasonCodes: fact.reasonCodes,
        provenance: {
          type: 'methodAssessmentFacts',
          id: factsRef.id,
          contentHash: factsRef.contentHash,
          sourceFactId: fact.factId,
        },
      },
    ],
    sections: [],
    tables: [],
    charts: [],
    citations: [],
    assumptions: [],
    cutoffs: [],
    limitations: content.additionalLimitations,
    snapshot: {
      validity: 'current',
      checkedAt: facts.baseline.validity.checkedAt,
      review: 'unreviewed',
      reviewIds: [],
      finalization: 'not_finalized',
    },
    methodAssessment: summary,
  };
  const executable = await import(
    `data:text/javascript;base64,${Buffer.from(runtime.outputFiles[0].contents).toString('base64')}`
  );
  executable.parseMethodSummary(summary);
  executable.parseMethodView(view);
  const fixture = {
    classification:
      'synthetic_component_and_producer_projection_not_registered_or_authorized_report',
    sourceFactsRef: factsRef,
    binding,
    stored,
    summary,
    view,
  };
  const types = `// Generated from exact Edge summary/view schemas; no external imports or parallel wire types.\nexport type MethodReportSummary = ${declaration(generated.summary)};\nexport type MethodReportView = ${declaration(generated.view)};\nexport declare const METHOD_SUMMARY_SCHEMA: 'lca.study-method-report-summary.v1';\nexport declare const METHOD_PROJECTION_MAX_BYTES: 2000000;\nexport declare function parseMethodSummary(input: unknown): MethodReportSummary;\nexport declare function parseMethodView(input: unknown): MethodReportView;\n`;
  const files = new Map([
    ['index.mjs', runtime.outputFiles[0].contents],
    ['index.d.ts', Buffer.from(types)],
    ['summary.schema.json', Buffer.from(JSON.stringify(generated.summary, null, 2) + '\n')],
    ['view3.schema.json', Buffer.from(JSON.stringify(generated.view, null, 2) + '\n')],
    ['producer-fixture.json', Buffer.from(JSON.stringify(fixture, null, 2) + '\n')],
    ['module-metadata.json', moduleMetadataBytes],
    ['LICENSE.zod', await readFile(path.join(root, 'node_modules/zod/LICENSE'))],
    [
      'LICENSE.renderer',
      await readFile(
        path.join(root, 'supabase/functions/_shared/study/vendor/renderer-v2/LICENSE'),
      ),
    ],
    [
      'package.json',
      Buffer.from(
        JSON.stringify(
          {
            name: '@tiangong-lca/study-method-summary',
            version: '1.0.0',
            private: true,
            type: 'module',
            exports: { '.': { types: './index.d.ts', import: './index.mjs' } },
            files: [
              'index.mjs',
              'index.d.ts',
              'summary.schema.json',
              'view3.schema.json',
              'producer-fixture.json',
              'module-metadata.json',
              'manifest.json',
              'LICENSE.zod',
              'LICENSE.renderer',
            ],
            engines: { node: '>=24.19.0 <25' },
          },
          null,
          2,
        ) + '\n',
      ),
    ],
  ]);
  const inputNames = new Set(
    [...Object.keys(runtime.metafile.inputs), ...Object.keys(schema.metafile.inputs)].filter(
      (file) => !file.startsWith('node_modules/') && !file.includes('method-summary-build.ts'),
    ),
  );
  for (const file of [
    'scripts/build-study-method-summary.mjs',
    'scripts/build-study-method-module.mjs',
    'scripts/build-study-contract.mjs',
    'package.json',
    'pnpm-lock.yaml',
    'supabase/functions/deno.json',
    'supabase/functions/_shared/study/vendor/renderer-v2/LICENSE',
    'contracts/lca-study/worker/method/manifest.json',
    ...Object.keys(consumption.schemas),
    ...Object.keys(consumption.fixtures),
    consumption.moduleMetadata.path,
  ])
    inputNames.add(file);
  const inputs = [];
  for (const file of [...inputNames].sort()) {
    const bytes = await readFile(path.join(root, file));
    inputs.push({ path: file, sha256: sha(bytes), byteSize: bytes.length });
  }
  const manifest = {
    schemaVersion: 'lca.study-method-summary-consumer-manifest.v1',
    sourceRepository: 'tiangong-lca/edge-functions',
    sourceCommit,
    sourceStatus: dirty ? 'worktree' : 'committed',
    componentVersion: '1.0.0',
    summarySchema: 'lca.study-method-report-summary.v1',
    viewSchema: 'lca.study-report-view.v3',
    rendererVersion: '3.0.0',
    classification:
      'pure schema/summary component and synthetic projection; not a renderer, authorization receipt, activation or scientific qualification',
    workerSourceCommit: consumption.sourceCommit,
    publicModule: consumption.moduleMetadata,
    toolchain: {
      node: process.versions.node,
      esbuild: esbuildVersion,
      zod: metadata.devDependencies.zod,
    },
    inputs,
    files: [...files].map(([file, bytes]) => ({
      path: file,
      sha256: sha(bytes),
      byteSize: bytes.length,
    })),
  };
  await mkdir(output, { recursive: true, mode: 0o700 });
  for (const [file, bytes] of files)
    await writeFile(path.join(output, file), bytes, { flag: 'wx' });
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
  });
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  let output,
    allowDirty = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && !output) output = args[++i];
    else if (args[i] === '--allow-dirty') allowDirty = true;
    else
      throw new Error(
        'usage: build-study-method-summary --out <new-absolute-directory> [--allow-dirty]',
      );
  }
  if (!output) throw new Error('method_summary_output_required');
  const m = await buildStudyMethodSummary(output, { allowDirty });
  console.log(
    JSON.stringify({
      sourceCommit: m.sourceCommit,
      sourceStatus: m.sourceStatus,
      files: m.files.length,
    }),
  );
}
