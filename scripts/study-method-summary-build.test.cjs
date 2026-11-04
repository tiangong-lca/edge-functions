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

test('public module projection binds exact raw/payload identities and isolated Native metadata without a CF catalog', async () => {
  const { projectMethodModule } = await import('./build-study-method-module.mjs');
  assert.throws(() => projectMethodModule(Buffer.from('{}')), /method_module_package_pin/u);
  const bytes = await readFile(
    path.join(__dirname, '../contracts/lca-study/worker/method/module-metadata.json'),
  );
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    'ac1b81a20d9e67f7e8807bcb86ff7cbb47a69772df5e093aa5cb445a43d2492b',
  );
  const value = JSON.parse(bytes.toString('utf8'));
  assert.equal(
    value.rawPackageSha256,
    'b19ba5754b0bc20c44c8c65966bafafd5984cd74636f2c805c0fa4373f5554ad',
  );
  assert.equal(
    value.payloadSha256,
    '407314bc364e5cfeddc8a44696118ee20cc696db5e9ef93812fd02516097a0a1',
  );
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
  assert.equal(
    createHash('sha256')
      .update(JSON.stringify(canonical(value.projection)))
      .digest('hex'),
    value.projectionSha256,
  );
  const arithmetic = JSON.parse(
    await readFile(
      path.join(__dirname, '../test/fixtures/lca-study-v6/arithmetic.native.json'),
      'utf8',
    ),
  );
  assert.equal(arithmetic.classification, 'isolated_arithmetic_not_a_study_or_conformance_case');
  assert.deepEqual(
    value.projection.categories,
    arithmetic.inputCategories.map((c) => ({
      methodRef: c.methodRef,
      name: c.name,
      role: c.role,
      parentMethodId: c.parentMethodId,
      referenceQuantityId: c.referenceQuantityId,
      unit: c.unit,
    })),
  );
  for (let i = 0; i < 16; i++) {
    const row = arithmetic.normalisationWeighting.categories[i],
      expected = value.projection.normalisation[i];
    for (const key of [
      'methodRef',
      'referenceQuantityId',
      'sourceNormalisationFactor',
      'sourceWeightFraction',
      'sourceUnitLabel',
      'sourceShortDescription',
    ])
      assert.deepEqual(row[key], expected[key]);
    assert.equal(row.characterisedUnit, expected.unit);
  }
  assert.equal('factors' in value.projection, false);
  assert.equal('authored_files' in value.projection, false);
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
for(const change of ['machine','catalog','sourceFact','baseline','functionalUnit','availableNW','coupledRoster','coupledNF','bytes']){
 const v=structuredClone(fixture.view);
 if(change==='machine')v.methodAssessment.requirements.pop();
 if(change==='catalog')v.facts[0].canonicalValue='6';
 if(change==='sourceFact')v.facts[0].provenance.sourceFactId='candidate:singleScore';
 if(change==='baseline')v.runs[0].inputHash='f'.repeat(64);
 if(change==='functionalUnit')v.definition.functionalUnit.amount='2';
 if(change==='coupledRoster')Object.assign(v,JSON.parse(JSON.stringify(v).replaceAll(v.methodAssessment.categories[0].methodRef.id,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')));
 if(change==='coupledNF')Object.assign(v,JSON.parse(JSON.stringify(v).replaceAll(v.methodAssessment.factCatalog[25].unitIdentity.sourceNormalisationFactor,'7553.08316285118')));
 if(change==='availableNW'){
  const s=v.methodAssessment,nw=s.candidateNormalisationWeighting;
  nw.status='candidate_arithmetic_available';nw.reasonCodes=[];nw.canonicalCandidateSingleScore='1';
  nw.categories=s.factCatalog[57].context.primaryMethods.map((method,i)=>{
   const c=s.categories.find(x=>x.methodRef.id===method.id),n=s.factCatalog[25+i*2],w=s.factCatalog[26+i*2];
   for(const f of[n,w]){f.canonicalValue='1';f.coverage='complete';f.reasonCodes=[];}
   return{methodRef:method,referenceQuantityId:c.referenceQuantityId,characterisedUnit:c.unit,canonicalCharacterisedValue:c.canonicalCharacterisedValue,sourceNormalisationFactor:n.unitIdentity.sourceNormalisationFactor,sourceWeightFraction:w.unitIdentity.sourceWeightFraction,sourceUnitLabel:'Synthetic unit',sourceShortDescription:'Relation forgery only',canonicalNormalisedValue:'1',normalisedUnit:'1',canonicalWeightedValue:'1',weightedUnit:'Pt'};
  });
  s.factCatalog[57].canonicalValue='1';s.factCatalog[57].coverage='complete';s.factCatalog[57].reasonCodes=[];
 }
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
