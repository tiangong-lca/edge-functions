import { assertEquals, assertThrows } from 'jsr:@std/assert';
import {
  parseMethodFacts,
  methodEvidenceSchema,
  methodConfigHash,
} from '../contracts/lca-study/v6/schemas.ts';
import { makeMethodSummary, parseMethodSummary } from '../contracts/lca-study/v6/summary.ts';
import { resolveOwnerSchema } from '../contracts/lca-study/v6/owner_json.ts';
import { canonicalBytes, sha256 } from '../contracts/lca-study/v3/canonical.ts';
import facts from './fixtures/lca-study-v6/facts.synthetic.json' with { type: 'json' };

const ref = {
  type: 'methodAssessmentFacts',
  id: '10000000-0000-4000-8000-000000000201',
  contentHash: 'f779f432bcf1cf1d256352b4c5b9454dd84bbb2e69773591759c18fd96c4d039',
  digestScope: 'artifact_bytes_sha256',
  byteSize: 129906,
  mediaType: 'application/json',
  schemaVersion: 'lca.study-method-assessment-facts.v1',
};
const evidence = () => ({
  schemaVersion: 'lca.study-method-evidence.v1',
  requirementId: 'PEF-01',
  declaredKind: 'applicabilityRecord',
  title: 'Declared scope evidence',
  statement: 'Recording is not professional approval.',
  citations: [],
});

Deno.test(
  'V6 consumes exact Worker facts/catalog and independent configuration golden without method arithmetic',
  async () => {
    assertEquals<unknown>(parseMethodFacts(facts), facts);
    assertEquals<unknown>(await methodConfigHash(facts.config), facts.configHash);
    assertEquals<unknown>(facts.categories.length, 25);
    assertEquals<unknown>(facts.requirements.length, 20);
    assertEquals<unknown>(facts.factCatalog.length, 58);
    const bytes = await Deno.readFile(
      new URL('./fixtures/lca-study-v6/facts.synthetic.json', import.meta.url),
    );
    assertEquals<unknown>(bytes.length, ref.byteSize);
    assertEquals<unknown>(await sha256(bytes), ref.contentHash);
  },
);

Deno.test(
  'V6 derived constant-object schema preserves exact deep owner equality and fails changes/missing/extra',
  () => {
    const clone = structuredClone(facts);
    clone.methodSourceEvidence.interimGuidanceSnapshot = Object.fromEntries(
      Object.entries(clone.methodSourceEvidence.interimGuidanceSnapshot).reverse(),
    ) as typeof clone.methodSourceEvidence.interimGuidanceSnapshot;
    assertEquals<unknown>(parseMethodFacts(clone), clone);
    for (const kind of ['changed', 'missing', 'extra']) {
      const bad = structuredClone(facts);
      const guidance = bad.methodSourceEvidence.interimGuidanceSnapshot as Record<string, unknown>;
      if (kind === 'changed') guidance.announcement_date = '2026-07-15';
      if (kind === 'missing') delete guidance.announcement_date;
      if (kind === 'extra') guidance.claimedApproved = true;
      assertThrows(() => parseMethodFacts(bad));
    }
  },
);

Deno.test(
  'V6 evidence accepts exact Unicode scalar limits and rejects controls/angles/unpaired scalars',
  () => {
    const value = { ...evidence(), title: '😀'.repeat(256), statement: '😀'.repeat(8192) };
    assertEquals<unknown>(methodEvidenceSchema.parse(value), value);
    for (const field of ['title', 'statement']) {
      const bad = { ...value, [field]: value[field as 'title' | 'statement'] + 'a' };
      assertThrows(() => methodEvidenceSchema.parse(bad));
    }
    for (const text of ['\ud800', '\udc00', 'x\ud800y', '\u0085', '<approved>', '\u0000', '\u3000'])
      assertThrows(() => methodEvidenceSchema.parse({ ...evidence(), title: text }));
    const combining = { ...evidence(), title: 'e\u0301'.repeat(128) };
    assertEquals<unknown>(methodEvidenceSchema.parse(combining), combining);
  },
);

Deno.test(
  'V6 evidence enforces 64KiB exact canonical UTF8 bytes independently of legal field scalar counts',
  () => {
    const citations = Array.from({ length: 32 }, (_, i) => ({
      kind: 'document',
      identity: (i < 2 ? '😀' : 'i').repeat(256),
      version: 'v'.repeat(128),
      contentHash: null,
      locator: 'l'.repeat(512),
    }));
    const value = { ...evidence(), citations, statement: '' };
    const remaining = 65536 - canonicalBytes(value).length;
    value.statement = '😀'.repeat(Math.floor(remaining / 4)) + 'a'.repeat(remaining % 4);
    assertEquals<unknown>(canonicalBytes(value).length, 65536);
    assertEquals<unknown>([...value.statement].length <= 8192, true);
    assertEquals<unknown>(methodEvidenceSchema.parse(value), value);
    assertThrows(() => methodEvidenceSchema.parse({ ...value, statement: value.statement + 'a' }));
  },
);

Deno.test(
  'V6 method summary preserves all owner fields except explicitly referenced selected-factor records',
  () => {
    const summary = makeMethodSummary(facts, ref);
    for (const [key, value] of Object.entries(facts)) {
      if (key === 'schemaVersion' || key === 'methodSourceEvidence') continue;
      assertEquals<unknown>(summary[key as keyof typeof summary], value, key);
    }
    for (const [key, value] of Object.entries(facts.methodSourceEvidence)) {
      if (key === 'selectedFactors') continue;
      assertEquals<unknown>(
        summary.methodSourceEvidence[key as keyof typeof summary.methodSourceEvidence],
        value,
        key,
      );
    }
    assertEquals<unknown>(summary.schemaVersion, 'lca.study-method-report-summary.v1');
    assertEquals<unknown>(summary.sourceFactsSchemaVersion, facts.schemaVersion);
    assertEquals<unknown>(summary.factsRef, ref);
    assertEquals<unknown>(summary.methodSourceEvidence.selectedFactorEvidence, {
      factsRef: ref,
      selectedFactorRecordCount: facts.methodSourceEvidence.selectedFactors.length,
      embedded: false,
      disposition: 'complete_selected_factor_records_in_exact_method_facts_artifact',
    });
    assertEquals<unknown>('selectedFactors' in summary.methodSourceEvidence, false);
    assertEquals<unknown>(parseMethodSummary(JSON.parse(JSON.stringify(summary))), summary);
  },
);

Deno.test(
  'V6 selectors reject category/unit/value/context/reason/requirement substitutions without manufacturing status scores',
  () => {
    for (const kind of [
      'value',
      'unit',
      'context',
      'reason',
      'requirement',
      'catalogMissing',
      'qualification',
    ]) {
      const bad = structuredClone(facts);
      if (kind === 'value') bad.factCatalog[0].canonicalValue = '6';
      if (kind === 'unit') bad.factCatalog[0].unit = 'g';
      if (kind === 'context')
        bad.factCatalog[0].context = {
          ...bad.factCatalog[0].context,
          categoryRole: 'subcategory',
        } as (typeof bad.factCatalog)[0]['context'];
      if (kind === 'reason') bad.factCatalog[0].reasonCodes = [];
      if (kind === 'requirement') bad.requirements[0].requirementId = 'PEF-02';
      if (kind === 'catalogMissing') bad.factCatalog.pop();
      if (kind === 'qualification') bad.pefConformityQualified = true;
      assertThrows(() => parseMethodFacts(bad), Error, '', kind);
    }
  },
);

Deno.test(
  'V6 summary refuses offline identity, false embedding, wrong references and invented qualification',
  () => {
    const source = makeMethodSummary(facts, ref);
    for (const kind of [
      'offline',
      'embedded',
      'extraFactors',
      'wrongRef',
      'negativeCount',
      'approved',
    ]) {
      const bad = structuredClone(source) as unknown as Record<string, unknown>;
      const evidence = bad.methodSourceEvidence as Record<string, unknown>;
      const selected = evidence.selectedFactorEvidence as Record<string, unknown>;
      if (kind === 'offline') bad.identityKind = 'offline_candidate_not_registered_or_authorized';
      if (kind === 'embedded') selected.embedded = true;
      if (kind === 'extraFactors') evidence.selectedFactors = [];
      if (kind === 'wrongRef')
        selected.factsRef = { ...ref, id: '10000000-0000-4000-8000-000000000202' };
      if (kind === 'negativeCount') selected.selectedFactorRecordCount = -1;
      if (kind === 'approved') bad.scientificRankingQualified = true;
      assertThrows(() => parseMethodSummary(bad), Error, 'method_summary_invalid', kind);
    }
  },
);

Deno.test(
  'V6 schema source lookup is contained and never treats a caller URL/path as an owner document',
  () => {
    for (const path of [
      'https://provider.invalid/schema.json',
      '../outside.schema.json',
      'file:///etc/passwd',
      'study-method-assessment-facts.v2.schema.json',
    ])
      assertThrows(() => resolveOwnerSchema(path), Error, 'method_schema_external_reference');
  },
);
