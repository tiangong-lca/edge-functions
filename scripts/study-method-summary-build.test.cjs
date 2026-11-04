'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

test('method declarations retain sibling string assertions and are generated from contained owner schemas', async () => {
  const { declaration } = await import('./build-study-contract.mjs');
  const { methodInterfaceDeclarations } = await import('./build-study-method-interfaces.mjs');
  assert.match(
    declaration({ type: 'string', maxLength: 256, allOf: [{ pattern: '\\S' }] }),
    /string/u,
  );
  const actual = await readFile(
    path.join(__dirname, '../contracts/lca-study/worker/method/types.d.ts'),
    'utf8',
  );
  assert.equal(actual, await methodInterfaceDeclarations());
  assert.match(actual, /export type MethodEvidence/u);
  assert.doesNotMatch(actual, /"title": unknown/u);
});

test('method summary/view component builds deterministically and validates outside source in Node and Deno', async () => {
  const { buildStudyMethodSummary } = await import('./build-study-method-summary.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'study-method-summary-component-'));
  try {
    const a = path.join(temp, 'component a'),
      b = path.join(temp, 'component b');
    const first = await buildStudyMethodSummary(a, { allowDirty: true });
    const second = await buildStudyMethodSummary(b, { allowDirty: true });
    assert.equal(first.workerSourceCommit, '13a749e619d7ef348e9298bb049e8c01c60e9086');
    assert.equal(first.summarySchema, 'lca.study-method-report-summary.v1');
    assert.deepEqual(first.files, second.files);
    for (const file of first.files) {
      const bytes = await readFile(path.join(a, file.path));
      assert.equal(bytes.length, file.byteSize);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    }
    const declarations = await readFile(path.join(a, 'index.d.ts'), 'utf8');
    assert.match(declarations, /export type MethodReportSummary/u);
    assert.match(declarations, /export type MethodReportView/u);
    assert.doesNotMatch(declarations, /import\s/u);
    const program = `import assert from'node:assert/strict';import{readFileSync}from'node:fs';
globalThis.fetch=()=>{throw new Error('unexpected network')};
const m=await import(${JSON.stringify(pathToFileURL(path.join(a, 'index.mjs')).href)});
const fixture=JSON.parse(readFileSync(${JSON.stringify(path.join(a, 'producer-fixture.json'))},'utf8'));
assert.deepEqual(m.parseMethodSummary(fixture.summary),fixture.summary);
assert.deepEqual(m.parseMethodView(fixture.view),fixture.view);
for(const change of ['machine','catalog','sourceFact','baseline','functionalUnit','bytes']){
 const v=structuredClone(fixture.view);
 if(change==='machine')v.methodAssessment.requirements.pop();
 if(change==='catalog')v.facts[0].canonicalValue='6';
 if(change==='sourceFact')v.facts[0].provenance.sourceFactId='candidate:singleScore';
 if(change==='baseline')v.runs[0].inputHash='f'.repeat(64);
 if(change==='functionalUnit')v.definition.functionalUnit.amount='2';
 if(change==='bytes')v.sections=Array.from({length:32},(_,i)=>({sectionId:'s-'+i,title:'Section',paragraphs:Array.from({length:32},()=> 'x'.repeat(2048)),factIds:[],citationIds:[]}));
 assert.throws(()=>m.parseMethodView(v),/method_view_invalid/);
}
const extra=structuredClone(fixture.summary);extra.methodSourceEvidence.selectedFactors=[];assert.throws(()=>m.parseMethodSummary(extra),/method_summary_invalid/);
console.log('method component Node independent consumer passed');`;
    const script = path.join(temp, 'independent-node.mjs');
    await writeFile(script, program);
    const stdout = execFileSync(process.execPath, [script], {
      cwd: temp,
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.match(stdout, /independent consumer passed/u);
    const deno = `globalThis.fetch=()=>{throw new Error('unexpected network')};const m=await import(${JSON.stringify(pathToFileURL(path.join(a, 'index.mjs')).href)});const fixture=JSON.parse(await Deno.readTextFile(${JSON.stringify(path.join(a, 'producer-fixture.json'))}));const result=m.parseMethodView(fixture.view);if(result.methodAssessment.requirements.length!==20||result.methodAssessment.factCatalog.length!==58)throw new Error('method_component_counts');let rejected=false;try{m.parseMethodSummary({...fixture.summary,businessPilotQualified:true})}catch{rejected=true}if(!rejected)throw new Error('method_component_false_qualification');console.log('method component Deno independent consumer passed');`;
    assert.match(
      execFileSync('deno', ['eval', '--no-config', deno], {
        cwd: temp,
        encoding: 'utf8',
        timeout: 30000,
      }),
      /independent consumer passed/u,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
