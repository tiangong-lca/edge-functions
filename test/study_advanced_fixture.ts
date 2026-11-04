import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.118.0';
import {
  createStudyHandler,
  type HandlerOptions,
} from '../supabase/functions/_shared/study/handler.ts';
import { bundledAdvancedRenderer } from '../supabase/functions/_shared/study/advanced_renderer.ts';
import type { AdvancedOptions } from '../supabase/functions/_shared/study/advanced_executor.ts';
import type {
  AdvancedRepository,
  PrivateReportArtifact,
} from '../supabase/functions/_shared/study/advanced_repository.ts';
import {
  API_SCHEMA,
  ANALYSIS_PROFILES,
  OPERATIONS,
  REPORT_TEMPLATE,
} from '../contracts/lca-study/v5/advanced.ts';
import { canonicalBytes, domainBytes, sha256 } from '../contracts/lca-study/v3/canonical.ts';

export const advancedId = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const advancedFixtureRoot = new URL('./fixtures/lca-study-v5/', import.meta.url);
const json = async (name: string) =>
  JSON.parse(await Deno.readTextFile(new URL(name, advancedFixtureRoot)));
const stamp = '2026-11-04T00:00:00Z';
type RecordValue = Record<string, any>;

/** In-memory authoritative RPC fixture; actual Worker bytes retain their issued identities. */
export async function advancedFixture() {
  const input = await json('input-oat.json');
  const facts = await json('facts-oat.json');
  const analysis = await json('public-analysis-oat.json');
  const baseline = structuredClone(input.baseline);
  const baselineBefore = structuredClone(baseline);
  const actor = {
    userId: advancedId(2),
    accessToken: 'synthetic-advanced-actor-context',
    supabase: {} as SupabaseClient,
  };
  const storage = new Map<string, Uint8Array>([
    [
      baseline.preparedArtifact.artifactRef.id,
      await Deno.readFile(new URL('prepared.json', advancedFixtureRoot)),
    ],
    [
      input.sourceArtifact.artifactRef.id,
      await Deno.readFile(new URL('source.json', advancedFixtureRoot)),
    ],
    [
      baseline.resultArtifact.artifactRef.id,
      await Deno.readFile(new URL('result.json', advancedFixtureRoot)),
    ],
    [analysis.factsRef.id, await Deno.readFile(new URL('facts-oat.json', advancedFixtureRoot))],
  ]);
  const selected = [
    'parameter:0:baseline',
    'baseline:method:0',
    'oat:parameter:0:secant:method:0',
  ].map((id) => facts.factCatalog.find((fact: { factId: string }) => fact.factId === id));
  if (selected.some((fact) => !fact)) throw new Error('native catalog fixture shape');
  const content = {
    schemaVersion: 'lca.study-report-draft.v2',
    title: 'Frozen OAT numerical evidence',
    claims: selected.map((fact, index) => ({
      claimId: `claim-${index}`,
      bundleRef: analysis.factsRef,
      factId: fact.factId,
      canonicalValue: fact.canonicalValue,
      unit: fact.unit,
      display: { style: 'exact' },
    })),
    sections: [
      {
        sectionId: 'interpretation',
        title: 'Interpretation',
        paragraphs: ['The submitted interpretation does not issue numerical facts.'],
        claimIds: ['claim-1'],
      },
    ],
    tables: [
      {
        tableId: 'results',
        title: 'Exact selected values',
        claimIds: ['claim-0', 'claim-1', 'claim-2'],
      },
    ],
    charts: [],
    additionalLimitations: [],
  };
  const runtime = {
    type: 'capabilities' as const,
    contractVersion: '5.0.0' as const,
    runtimeEnabled: true,
    operations: OPERATIONS,
    analysisProfiles: [...ANALYSIS_PROFILES],
    reportTemplates: [REPORT_TEMPLATE],
  };
  let report: RecordValue | null = null;
  let context: RecordValue | null = null;
  let parameterContext: RecordValue | null = null;
  let storedContent: PrivateReportArtifact | null = null;
  let committed: unknown = null;
  let allocation = 600;
  let currentKey = '';
  const receipts = new Map<string, unknown>();
  const state = {
    dispatches: 0,
    resolves: 0,
    parameterResolves: 0,
    downloads: 0,
    uploads: 0,
    consumes: 0,
    revoked: false,
    revokeOnDownload: false,
    revokeOnUpload: false,
    corruptDownload: false,
    wrongActor: false,
    changeOnDownload: false,
    contextChanged: false,
    replyOverride: null as unknown,
    mutateContext: null as ((context: RecordValue) => void) | null,
  };
  const success = (data: unknown) => ({ ok: true, data });
  const denied = () => ({ ok: false, code: 'FORBIDDEN' });
  const factsArtifact = {
    studyId: input.analysis.studyId,
    artifactRef: analysis.factsRef,
    storageBucket: 'study-artifacts',
    storageObjectPath: `study/${input.analysis.studyId}/${analysis.factsRef.id}/facts.json`,
  };
  const repository: AdvancedRepository = {
    async dispatch(request) {
      state.dispatches++;
      if (state.revoked) return denied();
      if (state.replyOverride !== null) return success(state.replyOverride);
      if (request.operation === 'capability.read') return success(runtime);
      if (request.operation === 'analysis.request' || request.operation === 'analysis.read')
        return success({ type: 'analysis', value: analysis });
      if (request.operation === 'analysis.parameters.read') {
        parameterContext = {
          kind: 'advancedParameterContext',
          intentId: request.requestId,
          expiresAt: '2026-11-04T00:02:00Z',
          actorId: actor.userId,
          clientId: null,
          studyId: input.analysis.studyId,
          baselineRunId: input.analysis.config.baselineRunId,
          baseline,
          sourceSnapshot: input.sourceSnapshot,
          sourceArtifact: input.sourceArtifact,
        };
        return success({
          kind: 'advancedParameterIntent',
          intentId: request.requestId,
          expiresAt: parameterContext.expiresAt,
          studyId: request.studyId,
          baselineRunId: request.baselineRunId,
        });
      }
      if (request.operation === 'report.read')
        return success({ type: 'reportRevision', value: report });
      if (!['report.create', 'report.save', 'report.freeze'].includes(request.operation))
        return denied();
      currentKey = 'idempotencyKey' in request ? request.idempotencyKey : request.requestId;
      if (receipts.has(currentKey)) return success(receipts.get(currentKey));
      committed = null;
      context = {
        kind: 'reportAdvancedCommandContext',
        intentId: request.requestId,
        expiresAt: '2026-11-04T00:02:00Z',
        operation: request.operation,
        request,
        studyId: input.analysis.studyId,
        actorId: actor.userId,
        clientId: null,
        grantEpoch: 1,
        generatedAt: stamp,
        reportRevisionId: advancedId(1),
        contentArtifactId: request.operation === 'report.freeze' ? null : advancedId(++allocation),
        exportId: null,
        projectionArtifactId: null,
        resourcesArtifactId: null,
        bundleArtifactId: null,
        report,
        contentArtifact: storedContent,
        runs: [baseline],
        analyses: [
          { analysis, factsArtifact, sourceSnapshotRef: input.sourceSnapshot.sourceArtifactRef },
        ],
        factsBindingHash: await sha256(
          domainBytes('lca.study-report-facts-binding.v1', [analysis.factsRef]),
        ),
        disclosureContextHash: null,
        exportProfile: null,
      };
      return success({
        kind: 'reportAdvancedCommandIntent',
        intentId: context.intentId,
        expiresAt: context.expiresAt,
        operation: request.operation,
      });
    },
    async resolveParameters() {
      state.parameterResolves++;
      if (state.revoked) return denied();
      const c = structuredClone(parameterContext!);
      if (state.wrongActor) c.actorId = advancedId(999);
      if (state.contextChanged) c.baseline.run.inputHash = 'a'.repeat(64);
      state.mutateContext?.(c);
      return success(c);
    },
    async resolveIntent() {
      state.resolves++;
      if (state.revoked) return denied();
      if (committed) return success(committed);
      const c = structuredClone(context!);
      if (state.wrongActor) c.actorId = advancedId(999);
      if (state.contextChanged) c.grantEpoch = 2;
      state.mutateContext?.(c);
      return success(c);
    },
    async consumeIntent(_id, raw) {
      if (state.revoked) return denied();
      state.consumes++;
      const c = raw as RecordValue;
      if (c.kind === 'validatedContent') {
        storedContent = c.contentArtifact;
        report = {
          reportRevisionId: advancedId(1),
          studyId: input.analysis.studyId,
          parentReportRevisionId: null,
          authorId: actor.userId,
          revision: report ? report.revision + 1 : 1,
          status: 'draft',
          contentHash: c.contentArtifact.artifactRef.contentHash,
          runIds: [input.analysis.config.baselineRunId],
          analysisIds: [analysis.analysisId],
          factsRefs: [analysis.factsRef],
          contentRef: c.contentArtifact.artifactRef,
          templateId: REPORT_TEMPLATE,
          finalization: {
            status: 'not_finalized',
            profileId: 'lca.study-report-unreviewed.v1',
            reviewRequirement: 'none',
            finalizedAt: null,
            reviewIds: [],
          },
          validitySnapshot: { status: 'current', checkedAt: stamp, reasonCodes: [] },
        };
      } else if (c.kind === 'validatedFreeze')
        report = { ...report, revision: report!.revision + 1, status: 'frozen' };
      else throw new Error('unexpected synthetic completion');
      committed = { type: 'reportRevision', value: report };
      receipts.set(currentKey, committed);
      return success(committed);
    },
    async reconcileIntent() {
      return { ok: false, code: 'CAPABILITY_UNAVAILABLE' };
    },
    async resolveArtifact() {
      return { ok: false, code: 'CAPABILITY_UNAVAILABLE' };
    },
    async download(cap) {
      state.downloads++;
      const bytes = storage.get(cap.artifactRef.id);
      if (!bytes) throw new Error('missing synthetic native bytes');
      if (state.revokeOnDownload) state.revoked = true;
      if (state.changeOnDownload) state.contextChanged = true;
      if (state.corruptDownload) {
        const changed = bytes.slice();
        changed[0] ^= 1;
        return changed;
      }
      return bytes;
    },
    async upload(a, bytes) {
      state.uploads++;
      storage.set(a.artifactRef.id, bytes);
      if (state.revokeOnUpload) state.revoked = true;
    },
  };
  const advanced: AdvancedOptions = {
    config: () => runtime,
    repository: () => repository,
    renderer: bundledAdvancedRenderer,
    allowDevelopmentRenderer: true,
  };
  const handler = (overrides: Partial<HandlerOptions> = {}) =>
    createStudyHandler({
      resolveActor: async () => ({ ok: true, value: actor }),
      advanced,
      ...overrides,
    });
  const call = async (value: unknown, selected = handler(), header: string | null = API_SCHEMA) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (header !== null) headers['x-study-schema'] = header;
    const response = await selected(
      new Request('http://127.0.0.1/functions/v1/app_lca_study', {
        method: 'POST',
        headers,
        body: JSON.stringify(value),
      }),
    );
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const create = {
    schemaVersion: API_SCHEMA,
    requestId: advancedId(10),
    idempotencyKey: advancedId(11),
    operation: 'report.create',
    studyId: input.analysis.studyId,
    parentReportRevisionId: null,
    runIds: [input.analysis.config.baselineRunId],
    analysisIds: [analysis.analysisId],
    content,
    templateId: REPORT_TEMPLATE,
  };
  const catalog = {
    schemaVersion: API_SCHEMA,
    requestId: advancedId(12),
    operation: 'analysis.parameters.read',
    studyId: input.analysis.studyId,
    baselineRunId: input.analysis.config.baselineRunId,
  };
  const analysisRequest = {
    schemaVersion: API_SCHEMA,
    requestId: advancedId(13),
    idempotencyKey: advancedId(14),
    operation: 'analysis.request',
    studyId: input.analysis.studyId,
    profileId: analysis.profileId,
    config: analysis.config,
    configHash: analysis.configHash,
  };
  const save = (replacement = content) => ({
    schemaVersion: API_SCHEMA,
    requestId: advancedId(20),
    idempotencyKey: advancedId(21),
    operation: 'report.save',
    target: { type: 'reportRevision', id: advancedId(1), expectedRevision: report!.revision },
    content: replacement,
  });
  const freeze = () => ({
    schemaVersion: API_SCHEMA,
    requestId: advancedId(30),
    idempotencyKey: advancedId(31),
    operation: 'report.freeze',
    target: { type: 'reportRevision', id: advancedId(1), expectedRevision: report!.revision },
    expectedContentHash: report!.contentHash,
  });
  const stored = () =>
    JSON.parse(new TextDecoder().decode(storage.get(storedContent!.artifactRef.id)!));
  return {
    call,
    handler,
    create,
    catalog,
    analysisRequest,
    save,
    freeze,
    stored,
    advanced,
    repository,
    state,
    storage,
    actor,
    input,
    facts,
    analysis,
    baseline,
    baselineBefore,
    runtime,
    content,
    getReport: () => report!,
    getContext: () => context!,
    getStoredContent: () => storedContent!,
    canonicalBytes,
    sha256,
  };
}
