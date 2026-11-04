import worker from './fixtures/lca-study-v6/worker-service-seams.json' with { type: 'json' };
import facts from './fixtures/lca-study-v6/facts.synthetic.json' with { type: 'json' };
import { reportContextSchema } from '../supabase/functions/_shared/study/method_context.ts';
import { methodFactsBindingPayload } from '../supabase/functions/_shared/study/method_producer.ts';
import { domainBytes, sha256, canonicalBytes } from '../contracts/lca-study/v3/canonical.ts';
const root = new URL('./fixtures/lca-study-v6/', import.meta.url);
export async function methodFixture() {
  const baseline = structuredClone(worker.inputContext.input.baseline),
    assessment = structuredClone(worker.record),
    ref = assessment.factsRef!;
  const claim = {
    claimId: 'method-claim',
    bundleRef: ref,
    factId: facts.factCatalog[0].factId,
    canonicalValue: facts.factCatalog[0].canonicalValue,
    unit: facts.factCatalog[0].unit,
    display: { style: 'exact' },
  };
  const content = {
    schemaVersion: 'lca.study-method-report-draft.v1',
    title: 'Synthetic source-bound method report',
    claims: [claim],
    sections: [
      {
        sectionId: 'authored',
        title: 'Author narrative (unverified)',
        paragraphs: ['Synthetic transport test, not actual source/scientific authority.'],
        claimIds: [claim.claimId],
      },
    ],
    tables: [{ tableId: 'claims', title: 'Selected exact claim', claimIds: [claim.claimId] }],
    charts: [],
    additionalLimitations: [
      'This is a synthetic interface/producer fixture, not a registered Study or industry case.',
    ],
  };
  const request = {
    schemaVersion: 'lca.study-api.v6',
    requestId: 'method-create',
    idempotencyKey: 'method-create',
    operation: 'report.create',
    studyId: facts.studyId,
    parentReportRevisionId: null,
    runIds: [baseline.run.runId],
    methodAssessmentIds: [assessment.assessmentId],
    templateId: 'lca.study-method-report.v1',
    content,
  };
  const raw = {
    kind: 'reportMethodCommandContext',
    intentId: '10000000-0000-4000-8000-000000000302',
    expiresAt: '2026-11-04T00:02:00Z',
    operation: 'report.create',
    request,
    studyId: facts.studyId,
    actorId: '10000000-0000-4000-8000-000000000501',
    clientId: null,
    grantEpoch: 1,
    generatedAt: '2026-11-04T00:00:00Z',
    reportRevisionId: '10000000-0000-4000-8000-000000000300',
    contentArtifactId: '10000000-0000-4000-8000-000000000301',
    exportId: null,
    projectionArtifactId: null,
    resourcesArtifactId: null,
    bundleArtifactId: null,
    report: null,
    contentArtifact: null,
    runs: [baseline],
    methodAssessments: [
      {
        assessment,
        factsArtifact: {
          studyId: facts.studyId,
          artifactRef: ref,
          storageBucket: 'study-artifacts',
          storageObjectPath: `study/${facts.studyId}/${ref.id}/method-facts.json`,
        },
        sourceSnapshotRef: facts.baseline.sourceSnapshotRef,
      },
    ],
    factsBindingHash: '0'.repeat(64),
    disclosureContextHash: null,
    exportProfile: null,
  };
  const context = reportContextSchema.parse(raw);
  context.factsBindingHash = await sha256(
    domainBytes('lca.study-method-report-facts-binding.v1', methodFactsBindingPayload(context)),
  );
  const bytes = new Map<string, Uint8Array>([
    [
      baseline.preparedArtifact.artifactRef.id,
      await Deno.readFile(new URL('prepared.synthetic.json', root)),
    ],
    [
      baseline.resultArtifact.artifactRef.id,
      await Deno.readFile(new URL('result.synthetic.json', root)),
    ],
    [ref.id, await Deno.readFile(new URL('facts.synthetic.json', root))],
  ]);
  return {
    context,
    bytes,
    content,
    classification:
      'synthetic exact Worker fixture bytes; no current actor/service/Storage/scientific authority',
  };
}
export async function replaceFixtureFacts(
  fixture: Awaited<ReturnType<typeof methodFixture>>,
  raw: unknown,
) {
  const ref = fixture.context.methodAssessments[0].factsArtifact.artifactRef;
  const bytes = new TextEncoder().encode(JSON.stringify(raw));
  const current = { ...ref, byteSize: bytes.length, contentHash: await sha256(bytes) };
  fixture.context.methodAssessments[0].factsArtifact.artifactRef = current;
  fixture.context.methodAssessments[0].assessment.factsRef = current;
  if (fixture.context.request.operation === 'report.create')
    fixture.context.request.content.claims.forEach((c) => (c.bundleRef = current));
  fixture.content.claims.forEach((c) => (c.bundleRef = current));
  fixture.bytes.set(current.id, bytes);
  fixture.context.factsBindingHash = await sha256(
    domainBytes(
      'lca.study-method-report-facts-binding.v1',
      methodFactsBindingPayload(fixture.context),
    ),
  );
  return current;
}
