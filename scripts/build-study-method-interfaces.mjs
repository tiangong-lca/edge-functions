import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { declaration } from './build-study-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function methodInterfaceDeclarations() {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['contracts/lca-study/v6/owner_json.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: ['es2022'],
    logLevel: 'silent',
  });
  const owner = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`
  );
  const names = {
    MethodConfig: ['study-method-assessment-config.v1.schema.json', ''],
    MethodFacts: ['study-method-assessment-facts.v1.schema.json', ''],
    MethodInput: ['study-method-assessment-input.v1.schema.json', ''],
    MethodAssessmentRecord: ['study-method-assessment-record.v1.schema.json', ''],
    MethodEvidence: ['study-method-evidence.v1.schema.json', ''],
    MethodEvidenceRecord: ['study-method-evidence-record.v1.schema.json', ''],
    MethodCatalogFact: ['study-method-fact-catalog-entry.v1.schema.json', ''],
    MethodJobContext: ['study-method-job-context.v1.schema.json', ''],
    MethodFactsRef: ['study-method-assessment-facts.v1.schema.json', '/$defs/methodFactsRef'],
  };
  return (
    '// Generated from exact contained Worker13a749e6 JSON schemas; runtime owner refinements remain required.\n' +
    Object.entries(names)
      .map(
        ([name, [file, pointer]]) =>
          `export type ${name} = ${declaration(owner.resolveOwnerSchema(file, pointer))};`,
      )
      .join('\n') +
    '\n'
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const output = path.join(root, 'contracts/lca-study/worker/method/types.d.ts');
  const generated = await methodInterfaceDeclarations();
  if (process.argv.includes('--check')) {
    if ((await readFile(output, 'utf8')) !== generated) throw new Error('method_declaration_drift');
  } else await writeFile(output, generated);
}
