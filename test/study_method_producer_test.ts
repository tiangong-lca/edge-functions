import { assertEquals, assertRejects, assertThrows, assertStringIncludes } from 'jsr:@std/assert';
import { methodFixture, replaceFixtureFacts } from './study_method_fixture.ts';
import {
  validateMethodReportInputs,
  makeMethodContent,
  methodContentValidation,
  assertMethodReportContext,
} from '../supabase/functions/_shared/study/method_producer.ts';
import { makeMethodView } from '../supabase/functions/_shared/study/method_view.ts';
import { bundledMethodRenderer } from '../supabase/functions/_shared/study/method_renderer.ts';
import { canonicalBytes, domainBytes, sha256 } from '../contracts/lca-study/v3/canonical.ts';
import { StudyFailure } from '../supabase/functions/_shared/study/protocol.ts';
import facts from './fixtures/lca-study-v6/facts.synthetic.json' with { type: 'json' };

Deno.test(
  'V6 method producer validates exact frozen bytes and issues complete new content/11-key byte validation',
  async () => {
    const fixture = await methodFixture(),
      input = await validateMethodReportInputs(fixture.context, fixture.bytes);
    const content = makeMethodContent(
      input,
      fixture.context.request.operation === 'report.create'
        ? fixture.context.request.content
        : fixture.content,
    );
    const validation = await methodContentValidation(input, content);
    assertEquals(Object.keys(validation).length, 11);
    assertEquals(validation.contentHash, await sha256(canonicalBytes(content)));
    assertEquals(
      validation.contentHash ===
        (await sha256(domainBytes('study.method-report-content.v1', content))),
      false,
    );
    assertEquals(content.methodAssessmentIds, [facts.assessmentId]);
    assertEquals('analysisIds' in content, false);
    assertEquals(content.methodAssessment.requirements.length, 20);
    assertEquals(content.methodAssessment.categories.length, 25);
    assertEquals(content.methodAssessment.factCatalog.length, 58);
    assertEquals(content.methodAssessment.pefConformityQualified, false);
    assertEquals(
      content.methodAssessment.methodSourceEvidence.selectedFactorEvidence.embedded,
      false,
    );
    assertEquals(validation.factsBindingHash, fixture.context.factsBindingHash);
  },
);

Deno.test(
  'V6 method producer rejects transplanted source/config/baseline and physical-result identities after valid byte rebinding',
  async () => {
    for (const kind of ['source', 'config', 'input', 'methodSource', 'resultIdentity']) {
      const fixture = await methodFixture(),
        raw = structuredClone(facts);
      if (kind === 'source') raw.baseline.sourceSnapshotRef.contentHash = 'f'.repeat(64);
      if (kind === 'input') raw.baseline.inputHash = 'f'.repeat(64);
      if (kind === 'methodSource') raw.baseline.methodSourceHash = 'f'.repeat(64);
      if (kind === 'config') raw.config.declarations.studyPhase = 'screeningStudy';
      if (kind === 'resultIdentity') {
        const ref = fixture.context.runs[0].resultArtifact.artifactRef;
        const result = JSON.parse(new TextDecoder().decode(fixture.bytes.get(ref.id)));
        result.compilerVersion = 'invented.compiler.v9';
        const bytes = new TextEncoder().encode(JSON.stringify(result));
        const changed = { ...ref, byteSize: bytes.length, contentHash: await sha256(bytes) };
        fixture.context.runs[0].resultArtifact.artifactRef = changed;
        fixture.context.runs[0].run.resultRef = changed;
        raw.baseline.resultRef = changed;
        fixture.bytes.set(ref.id, bytes);
      }
      await replaceFixtureFacts(fixture, raw);
      await assertRejects(
        () => validateMethodReportInputs(fixture.context, fixture.bytes),
        Error,
        '',
        kind,
      );
    }
  },
);

Deno.test(
  'V6 report claims are exact catalog selections and authored prose cannot replace mandatory evidence',
  async () => {
    const fixture = await methodFixture(),
      input = await validateMethodReportInputs(fixture.context, fixture.bytes);
    for (const kind of ['value', 'unit', 'fact', 'reference', 'status']) {
      const content = structuredClone(fixture.content) as Record<string, any>;
      if (kind === 'value') content.claims[0].canonicalValue = '6';
      if (kind === 'unit') content.claims[0].unit = 'g';
      if (kind === 'fact') content.claims[0].factId = 'invented:fact';
      if (kind === 'reference')
        content.claims[0].bundleRef = {
          ...content.claims[0].bundleRef,
          contentHash: 'f'.repeat(64),
        };
      if (kind === 'status') content.methodAssessment = { pefConformityQualified: true };
      assertThrows(() => makeMethodContent(input, content));
    }
    const raw = structuredClone(fixture.content);
    raw.sections[0].paragraphs = ['Author assertion: all approved.'];
    const stored = makeMethodContent(input, raw);
    assertEquals(stored.methodAssessment.pefConformityQualified, false);
    assertEquals(
      stored.methodAssessment.requirements.map((r) => r.professional.status),
      facts.requirements.map((r) => r.professional.status),
    );
    const forged = structuredClone(stored);
    forged.methodAssessment.requirements.pop();
    await assertRejects(() => methodContentValidation(input, forged));
  },
);

Deno.test(
  'V6 complete source summaries that exceed reportability fail explicitly without truncation',
  async () => {
    const fixture = await methodFixture(),
      raw = structuredClone(facts);
    raw.limitations = Array.from({ length: 1000 }, () => 'x'.repeat(2048));
    await replaceFixtureFacts(fixture, raw);
    const input = await validateMethodReportInputs(fixture.context, fixture.bytes);
    const error = assertThrows(() => makeMethodContent(input, fixture.content));
    assertEquals(error instanceof StudyFailure, true);
    if (error instanceof StudyFailure) assertEquals(error.code, 'PAYLOAD_TOO_LARGE');
    assertEquals(raw.limitations.length, 1000);
  },
);

Deno.test(
  'V6 renderer projection preserves original definition and all mandatory source states independently of authored sections',
  async () => {
    const fixture = await methodFixture(),
      input = await validateMethodReportInputs(fixture.context, fixture.bytes),
      content = makeMethodContent(input, fixture.content);
    const view = await makeMethodView(content, input, bundledMethodRenderer);
    assertEquals(view.definition.goal, input.context.runs[0].revision.definition.goal);
    assertEquals(view.methodAssessment.requirements.length, 20);
    assertEquals(view.methodAssessment.factCatalog.length, 58);
    assertEquals(view.facts[0].provenance.type, 'methodAssessmentFacts');
    const html = await bundledMethodRenderer.render(view, {
      exportId: `validation:${fixture.context.reportRevisionId}`,
      projectionHash: await sha256(canonicalBytes(view)),
      verificationAtGeneration: 'unverified',
    });
    assertStringIncludes(html, 'PEF-20');
    assertStringIncludes(html, 'PEF-01');
    assertStringIncludes(html, facts.factCatalog[0].factId);
    assertStringIncludes(html, facts.moduleRef.artifactSha256);
    assertEquals(fixture.context.exportId, null);
    assertEquals(fixture.context.bundleArtifactId, null);
  },
);
