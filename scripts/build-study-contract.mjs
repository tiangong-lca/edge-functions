import { build, version as esbuildVersion } from 'esbuild';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

/** Generate declarations from the exact owner schemas; no parallel hand-written wire types. */
export function declaration(schema, document = schema, depth = 0) {
  if (depth > 64) throw new Error('study_schema_depth');
  const next = (value) => declaration(value, document, depth + 1);
  if (schema === true) return 'unknown';
  if (schema === false) return 'never';
  if (!schema || typeof schema !== 'object') throw new Error('study_schema_invalid');
  if (schema.$ref) {
    if (!schema.$ref.startsWith('#/')) throw new Error('study_schema_external_reference');
    const target = schema.$ref
      .slice(2)
      .split('/')
      .reduce((value, key) => value?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], document);
    return next(target);
  }
  if (Object.hasOwn(schema, 'const')) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  if (schema.anyOf || schema.oneOf)
    return (schema.anyOf ?? schema.oneOf).map((value) => `(${next(value)})`).join(' | ');
  if (schema.allOf) {
    // JSON Schema siblings are conjunctive. In particular, a string with an
    // allOf nonblank assertion must retain its string type in declarations.
    const base = { ...schema };
    delete base.allOf;
    const parts = [next(base), ...schema.allOf.map(next)].filter((part) => part !== 'unknown');
    return parts.length ? parts.map((part) => `(${part})`).join(' & ') : 'unknown';
  }
  if (Array.isArray(schema.type))
    return schema.type.map((type) => next({ ...schema, type })).join(' | ');
  switch (schema.type) {
    case 'null':
      return 'null';
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return `Array<${next(schema.items ?? true)}>`;
    case 'object': {
      const fields = Object.entries(schema.properties ?? {}).map(
        ([key, value]) =>
          `${JSON.stringify(key)}${schema.required?.includes(key) ? '' : '?'}: ${next(value)};`,
      );
      if (schema.additionalProperties && schema.additionalProperties !== false)
        fields.push(`[key: string]: ${next(schema.additionalProperties)};`);
      return `{ ${fields.join(' ')} }`;
    }
    case undefined:
      return 'unknown';
    default:
      throw new Error('study_schema_unsupported_type');
  }
}

export async function buildStudyContract(
  outputDirectory,
  { allowDirty = false, apiVersion = 'v2' } = {},
) {
  if (!['v2', 'v3', 'v4', 'v5', 'v6'].includes(apiVersion)) throw new Error('study_api_version');
  const output = path.resolve(outputDirectory);
  if (output === root || !path.isAbsolute(outputDirectory))
    throw new Error('study_output_absolute_directory_required');
  const exists = await stat(output).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
  if (exists) throw new Error('study_output_must_be_new');
  const dirty = git('status', '--porcelain', '--untracked-files=normal') !== '';
  if (dirty && !allowDirty) throw new Error('study_release_requires_clean_source');
  const sourceCommit = git('rev-parse', 'HEAD');
  const rendererConsumer = apiVersion === 'v4' || apiVersion === 'v5' || apiVersion === 'v6';
  const rendererRoot = `supabase/functions/_shared/study/vendor/${apiVersion === 'v6' ? 'renderer-v3' : apiVersion === 'v5' ? 'renderer-v2' : 'renderer'}`;
  const schemaEntry = {
    v2: 'requests',
    v3: 'report',
    v4: 'review',
    v5: 'requests',
    v6: 'requests',
  }[apiVersion];
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
  const result = await build({
    ...options,
    entryPoints: [`contracts/lca-study/${apiVersion}/codec.ts`],
  });
  const schemaResult = await build({
    ...options,
    stdin: {
      contents: `import { z } from 'zod'; import { requestSchema } from './contracts/lca-study/${apiVersion}/${schemaEntry}.ts'; import { responseSchema } from './contracts/lca-study/${apiVersion}/responses.ts'; export const request = z.toJSONSchema(requestSchema, { target: 'draft-7' }); export const response = z.toJSONSchema(responseSchema, { target: 'draft-7' }); ${apiVersion === 'v6' ? "import {methodFactsSchema,methodEvidenceSchema} from './contracts/lca-study/v6/schemas.ts'; import {methodReportContentSchema} from './contracts/lca-study/v6/report_content.ts'; export const methodFacts=z.toJSONSchema(methodFactsSchema,{target:'draft-7'}); export const methodEvidence=z.toJSONSchema(methodEvidenceSchema,{target:'draft-7'}); export const methodReportContent=z.toJSONSchema(methodReportContentSchema,{target:'draft-7'});" : ''} ${apiVersion !== 'v2' ? `import {exportManifestSchema,exportReceiptSchema,exportTrustAnchorSchema} from './contracts/lca-study/${apiVersion}/export.ts'; export const manifest=z.toJSONSchema(exportManifestSchema); export const receipt=z.toJSONSchema(exportReceiptSchema); export const anchor=z.toJSONSchema(exportTrustAnchorSchema); ${apiVersion === 'v4' ? "import {exportManifestSchema as historicalManifest} from './contracts/lca-study/v3/export.ts'; export const historical=z.toJSONSchema(historicalManifest);" : apiVersion === 'v5' ? "import {exportManifestSchema as v1Manifest} from './contracts/lca-study/v3/export.ts'; import {exportManifestSchema as v2Manifest} from './contracts/lca-study/v4/export.ts'; export const historical=z.toJSONSchema(z.union([v1Manifest,v2Manifest]));" : apiVersion === 'v6' ? "import {exportManifestSchema as v1Manifest} from './contracts/lca-study/v3/export.ts'; import {exportManifestSchema as v2Manifest} from './contracts/lca-study/v4/export.ts'; import {exportManifestSchema as v3Manifest} from './contracts/lca-study/v5/export.ts'; export const historical=z.toJSONSchema(z.union([v1Manifest,v2Manifest,v3Manifest]));" : ''}` : ''}`,
      resolveDir: root,
      sourcefile: 'study-schema-build.ts',
      loader: 'ts',
    },
  });
  const schema = await import(
    `data:text/javascript;base64,${Buffer.from(schemaResult.outputFiles[0].contents).toString('base64')}`
  );
  const codec = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`
  );
  let declarations = `// Generated from exact Edge-owned schemas. Refinements are enforced by the codec.\nexport declare const API_SCHEMA: ${JSON.stringify(codec.API_SCHEMA)};\nexport declare const CONTRACT_VERSION: ${JSON.stringify(codec.CONTRACT_VERSION)};\nexport type StudyApiRequest = ${declaration(schema.request)};\nexport type StudyApiResponse = ${declaration(schema.response)};\nexport declare class StudyCodecError extends Error { readonly code: 'INVALID_REQUEST'|'UNSUPPORTED_SCHEMA'|'REFERENCE_MISMATCH'; readonly ruleId: string; }\nexport declare function parseRequest(input: unknown): StudyApiRequest;\nexport declare function parseResponse(input: unknown): StudyApiResponse;\nexport declare function validateResponseForRequest(request: StudyApiRequest, response: StudyApiResponse): void;\nexport declare const OPERATIONS: ReadonlyArray<StudyApiRequest['operation']>;\nexport declare const operationMetadata: Readonly<Record<StudyApiRequest['operation'], Readonly<{operation: StudyApiRequest['operation']; kind:'query'|'mutation'}>>>;\n`;
  if (apiVersion !== 'v2')
    declarations += `export type ExportManifest = ${declaration(schema.manifest)};\nexport type ExportReceipt = ${declaration(schema.receipt)};\nexport type ExportTrustAnchor = ${declaration(schema.anchor)};\n${apiVersion === 'v3' || apiVersion === 'v5' ? 'export declare function analysisConfigHash(input: unknown): Promise<string>;\n' : ''}export declare function canonicalReceiptBytes(input:unknown):Uint8Array;\nexport declare function validateExportViewBindings(view:unknown,manifest:ExportManifest):void;\nexport declare function parseExportBundle(bytes:Uint8Array):{manifestBytes:Uint8Array;receipt:ExportReceipt;files:Array<{path:'report.html'|'projection.json';bytes:Uint8Array}>};\nexport declare function verifyExport(manifestBytes: Uint8Array, receipt: unknown, files: ReadonlyArray<{path:'report.html'|'projection.json'; bytes:Uint8Array}>, independentlyTrustedAnchors: ReadonlyArray<ExportTrustAnchor>, expected:{issuerId:string;exportId:string;studyId:string;reportRevisionId:string;reportContentHash:string}): Promise<ExportManifest>;\n`;
  if (rendererConsumer)
    declarations += `export type HistoricalExportManifest = ${declaration(schema.historical)};\nexport declare function verifyVersionedExport(manifestBytes: Uint8Array, receipt: unknown, files: ReadonlyArray<{path:'report.html'|'projection.json'; bytes:Uint8Array}>, independentlyTrustedAnchors: ReadonlyArray<ExportTrustAnchor>, expected:{issuerId:string;exportId:string;studyId:string;reportRevisionId:string;reportContentHash:string}): Promise<ExportManifest | HistoricalExportManifest>;\n`;
  if (apiVersion === 'v6') {
    declarations += `export type MethodFacts = ${declaration(schema.methodFacts)};\nexport declare function parseMethodFactsForAssessment(bytes:Uint8Array,assessmentRecord:unknown):Promise<MethodFacts>;\nexport type MethodEvidence = ${declaration(schema.methodEvidence)};\nexport type MethodReportContent = ${declaration(schema.methodReportContent)};\nexport declare function parseMethodEvidenceForRecord(bytes:Uint8Array,evidenceRecord:unknown):Promise<MethodEvidence>;\nexport declare function parseMethodReportContentForRevision(bytes:Uint8Array,reportRevision:unknown):Promise<MethodReportContent>;\n`;
    declarations +=
      'export declare function methodConfigHash(input:unknown):Promise<string>;\nexport declare function methodEvidenceHash(input:unknown):Promise<string>;\nexport declare function canonicalBytes(input:unknown):Uint8Array;\nexport declare function validateResponseContentForRequest(request:StudyApiRequest,response:StudyApiResponse):Promise<void>;\n';
  }
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const importMap = JSON.parse(
    await readFile(path.join(root, 'supabase/functions/deno.json'), 'utf8'),
  );
  if (
    importMap.imports.zod !== `npm:/zod@${metadata.devDependencies.zod}` ||
    esbuildVersion !== metadata.devDependencies.esbuild
  )
    throw new Error('study_build_dependency_drift');
  const files = new Map([
    ['index.mjs', result.outputFiles[0].contents],
    ['index.d.ts', Buffer.from(declarations)],
    ['request.schema.json', Buffer.from(`${JSON.stringify(schema.request, null, 2)}\n`)],
    ['response.schema.json', Buffer.from(`${JSON.stringify(schema.response, null, 2)}\n`)],
    [
      'package.json',
      Buffer.from(
        `${JSON.stringify({ name: '@tiangong-lca/study-contract', version: codec.CONTRACT_VERSION, private: true, type: 'module', exports: { '.': { types: './index.d.ts', import: './index.mjs' } }, files: ['index.mjs', 'index.d.ts', 'request.schema.json', 'response.schema.json', 'manifest.json', 'LICENSE.zod', ...(rendererConsumer ? ['LICENSE.renderer'] : [])], engines: { node: '>=24.19.0 <25' } }, null, 2)}\n`,
      ),
    ],
    ['LICENSE.zod', await readFile(path.join(root, 'node_modules/zod/LICENSE'))],
  ]);
  if (rendererConsumer)
    files.set('LICENSE.renderer', await readFile(path.join(root, rendererRoot, 'LICENSE')));
  const workerInputs =
    apiVersion === 'v5'
      ? JSON.parse(
          await readFile(
            path.join(root, 'contracts/lca-study/worker/advanced-manifest.json'),
            'utf8',
          ),
        )
      : apiVersion === 'v6'
        ? JSON.parse(
            await readFile(
              path.join(root, 'contracts/lca-study/worker/method/manifest.json'),
              'utf8',
            ),
          )
        : null;
  const inputs = [];
  // New method consumers retain the actual independent renderer package and
  // public module metadata as a bounded, fully byte-verified source input.
  const methodRendererInputs = [];
  if (apiVersion === 'v6') {
    const bytes = await readFile(path.join(root, rendererRoot, 'manifest.json'));
    const manifest = JSON.parse(bytes.toString('utf8'));
    const consumption = JSON.parse(
      await readFile(path.join(root, rendererRoot, 'consumption.json'), 'utf8'),
    );
    if (
      digest(bytes) !== consumption.manifestSha256 ||
      manifest.sourceCommit !== consumption.sourceCommit ||
      manifest.sourceDirty !== false ||
      consumption.sourceDirty !== false ||
      manifest.rendererVersion !== '3.0.0' ||
      manifest.viewModelVersion !== 'lca.study-report-view.v3' ||
      !Array.isArray(manifest.files) ||
      manifest.files.length > 64
    )
      throw new Error('study_method_renderer_identity');
    const names = new Set();
    let total = 0;
    for (const file of manifest.files) {
      if (
        !/^[A-Za-z][A-Za-z0-9_.-]*$/u.test(file.path) ||
        names.has(file.path) ||
        file.byteSize > 4 * 1024 * 1024
      )
        throw new Error('study_method_renderer_file');
      names.add(file.path);
      const content = await readFile(path.join(root, rendererRoot, file.path));
      total += content.length;
      if (
        content.length !== file.byteSize ||
        digest(content) !== file.sha256 ||
        total > 4 * 1024 * 1024
      )
        throw new Error('study_method_renderer_integrity');
      methodRendererInputs.push(`${rendererRoot}/${file.path}`);
    }
    const metadataBytes = await readFile(path.join(root, workerInputs.moduleMetadata.path));
    if (digest(metadataBytes) !== workerInputs.moduleMetadata.sha256)
      throw new Error('study_method_module_metadata_drift');
  }
  const sourcePaths = new Set([
    ...Object.keys(result.metafile.inputs).filter((name) => !name.startsWith('node_modules/')),
    ...methodRendererInputs,
    'scripts/build-study-contract.mjs',
    'package.json',
    'pnpm-lock.yaml',
    'supabase/functions/deno.json',
    ...(workerInputs
      ? [
          apiVersion === 'v6'
            ? 'contracts/lca-study/worker/method/manifest.json'
            : 'contracts/lca-study/worker/advanced-manifest.json',
          ...Object.keys(workerInputs.schemas),
          ...(apiVersion === 'v6' ? [workerInputs.moduleMetadata.path] : []),
        ]
      : []),
    ...(rendererConsumer
      ? [`${rendererRoot}/manifest.json`, `${rendererRoot}/consumption.json`]
      : []),
  ]);
  for (const relative of [...sourcePaths].sort()) {
    const bytes = await readFile(path.resolve(root, relative));
    if (workerInputs?.schemas[relative] && digest(bytes) !== workerInputs.schemas[relative])
      throw new Error('study_worker_schema_drift');
    inputs.push({ path: relative, sha256: digest(bytes), bytes: bytes.length });
  }
  const manifest = {
    schemaVersion: 'lca.study-consumer-manifest.v1',
    apiSchema: codec.API_SCHEMA,
    contractVersion: codec.CONTRACT_VERSION,
    sourceRepository: 'tiangong-lca/edge-functions',
    sourceCommit,
    sourceStatus: dirty ? 'worktree' : 'committed',
    toolchain: {
      node: process.versions.node,
      esbuild: esbuildVersion,
      zod: metadata.devDependencies.zod,
    },
    inputs,
    files: [...files].map(([name, bytes]) => ({
      path: name,
      sha256: digest(bytes),
      bytes: bytes.length,
    })),
  };
  await mkdir(output, { recursive: true, mode: 0o700 });
  for (const [name, bytes] of files)
    await writeFile(path.join(output, name), bytes, { flag: 'wx' });
  await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx',
  });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  let output,
    allowDirty = false,
    apiVersion = 'v2';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && output === undefined && args[i + 1]) output = args[++i];
    else if (args[i] === '--api-version' && args[i + 1]) apiVersion = args[++i];
    else if (args[i] === '--allow-dirty' && !allowDirty) allowDirty = true;
    else
      throw new Error(
        'usage: build-study-contract --out <new-absolute-directory> [--api-version v2|v3|v4|v5|v6] [--allow-dirty]',
      );
  }
  if (!output) throw new Error('study_output_required');
  const manifest = await buildStudyContract(output, { allowDirty, apiVersion });
  console.log(
    JSON.stringify({
      sourceCommit: manifest.sourceCommit,
      sourceStatus: manifest.sourceStatus,
      contractVersion: manifest.contractVersion,
      files: manifest.files.length,
    }),
  );
}
