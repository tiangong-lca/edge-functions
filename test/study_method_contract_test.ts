import { assertEquals, assertThrows } from 'jsr:@std/assert';
import {
  parseRequest,
  parseResponse,
  validateResponseForRequest,
  API_SCHEMA,
  operationMetadata,
} from '../contracts/lca-study/v6/codec.ts';
import {
  capabilitiesSchema as authoringCaps,
  DISABLED_CAPABILITIES as disabledAuthoring,
} from '../contracts/lca-study/v6/authoring.ts';
import {
  capabilitiesSchema as reviewCaps,
  DISABLED_CAPABILITIES as disabledReview,
} from '../contracts/lca-study/v6/review.ts';
import {
  reportContextSchema,
  reviewContextSchema,
  evidenceContextSchema,
  evidenceIntentSchema,
  reportIntentSchema,
} from '../supabase/functions/_shared/study/method_context.ts';
import { methodConfigHash } from '../contracts/lca-study/v6/schemas.ts';
import { methodEvidenceHash } from '../contracts/lca-study/v6/evidence_contract.ts';
import { domainBytes, sha256, canonicalJson } from '../contracts/lca-study/v3/canonical.ts';
import service from './fixtures/lca-study-v6/database-report-contexts.json' with { type: 'json' };
import core from './fixtures/lca-study-v6/database-service-contexts.json' with { type: 'json' };
import actual from './fixtures/lca-study-v6/database-public-dtos.json' with { type: 'json' };
import golden from './fixtures/lca-study-v6/database-binding-golden.json' with { type: 'json' };

const request = (operation: string, fields: Record<string, unknown> = {}) => ({
  schemaVersion: API_SCHEMA,
  requestId: 'method-contract',
  operation,
  ...fields,
});
const response = (data: unknown) => ({
  schemaVersion: API_SCHEMA,
  requestId: 'method-contract',
  ok: true,
  data,
});

Deno.test(
  'V6 strict public/service shapes consume actual immutable Database candidate metadata without asserting blob authority',
  async () => {
    const contexts = service as unknown as Record<string, any>;
    const data = actual.responses;
    assertEquals<unknown>(authoringCaps.parse(data.authoringCapability), data.authoringCapability);
    assertEquals<unknown>(reviewCaps.parse(data.reviewCapability), data.reviewCapability);
    assertEquals<unknown>(
      evidenceIntentSchema.parse(data.evidenceActorIntent),
      data.evidenceActorIntent,
    );
    assertEquals<unknown>(reportIntentSchema.parse(data.reportActorIntent), data.reportActorIntent);
    assertEquals<unknown>(
      evidenceContextSchema.parse(contexts.evidenceContext.data),
      contexts.evidenceContext.data,
    );
    assertEquals<unknown>(
      reportContextSchema.parse(contexts.reportContext.data),
      contexts.reportContext.data,
    );
    for (const key of ['previewContext', 'exportContext', 'shareContext'])
      assertEquals<unknown>(reviewContextSchema.parse(contexts[key].data), contexts[key].data);
    assertEquals(
      await methodConfigHash(contexts.methodRequest.config),
      contexts.methodRequest.configHash,
    );
    assertEquals(
      await methodEvidenceHash(contexts.evidenceContext.data.request.content),
      contexts.evidenceContext.data.contentHash,
    );
    for (const value of [
      data.methodTask,
      data.assessmentActions,
      data.methodResourcePage,
      data.shareActions,
      contexts.methodRecord.data,
      contexts.reportRecord.data,
      contexts.exportRecord.data,
      contexts.evidenceRecord.data,
    ])
      parseResponse(response(value));
  },
);

Deno.test(
  'V6 facts-binding canonical payload agrees byte-for-byte with independent Database/Python golden',
  async () => {
    assertEquals(canonicalJson(golden.payload), golden.canonicalUtf8);
    assertEquals(await sha256(domainBytes(golden.domain, golden.payload)), golden.sha256);
  },
);

Deno.test(
  'V6 report preview/export private producer requests retain original operation/finalization identity',
  () => {
    const data = service as unknown as Record<string, any>;
    for (const key of ['previewContext', 'exportContext']) {
      const outer = reviewContextSchema.parse(data[key].data),
        p = outer.producerContext!;
      assertEquals(p.operation, outer.operation);
      assertEquals<unknown>(p.request, outer.request);
      if (key === 'previewContext')
        for (const field of [
          'contentArtifactId',
          'exportId',
          'projectionArtifactId',
          'resourcesArtifactId',
          'bundleArtifactId',
        ] as const)
          assertEquals(p[field], null);
      else {
        assertEquals(p.request.operation, 'export.request');
        if (
          p.request.operation === 'export.request' &&
          outer.request.operation === 'export.request'
        ) {
          assertEquals(p.request.finalizationId, outer.request.finalizationId);
          assertEquals(p.request.expectedReviewStateHash, outer.request.expectedReviewStateHash);
        }
      }
    }
    const q = parseRequest(data.exportContext.data.request);
    const r = parseResponse({
      schemaVersion: API_SCHEMA,
      requestId: q.requestId,
      ok: true,
      data: data.exportRecord.data,
    });
    validateResponseForRequest(q, r);
    assertThrows(() =>
      validateResponseForRequest(
        parseRequest({ ...q, expectedReviewStateHash: 'f'.repeat(64) }),
        r,
      ),
    );
  },
);

Deno.test(
  'V6 method/resource/evidence and exact retained CAS receipts bind selected identities',
  () => {
    const d = service as unknown as Record<string, any>;
    const pairs = [
      [
        request('method.assessment.read', { assessmentId: d.methodRecord.data.value.assessmentId }),
        d.methodRecord.data,
      ],
      [
        request('method.evidence.read', { evidenceId: d.evidenceRecord.data.value.evidenceId }),
        d.evidenceRecord.data,
      ],
      [
        request('report.read', { reportRevisionId: d.reportRecord.data.value.reportRevisionId }),
        d.reportRecord.data,
      ],
      [
        request('task.read', {
          studyId: actual.responses.methodTask.value.studyId,
          resource: actual.responses.methodTask.value.resource,
        }),
        actual.responses.methodTask,
      ],
      [
        request('resource.actions', { resource: actual.responses.assessmentActions.resource }),
        actual.responses.assessmentActions,
      ],
    ];
    for (const [q, value] of pairs) {
      const r = parseRequest(q);
      validateResponseForRequest(r, parseResponse(response(value)));
      const wrong = structuredClone(value);
      if (wrong.type === 'task') wrong.value.resource.id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      else if (wrong.type === 'actions') wrong.resource.id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      else if (wrong.type === 'methodAssessment')
        wrong.value.assessmentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      else if (wrong.type === 'methodEvidence')
        wrong.value.evidenceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      else wrong.value.reportRevisionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      assertThrows(() => validateResponseForRequest(r, parseResponse(response(wrong))));
    }
    const report = d.reportRecord.data.value;
    const freeze = parseRequest(
      request('report.freeze', {
        idempotencyKey: 'freeze',
        target: {
          type: 'reportRevision',
          id: report.reportRevisionId,
          expectedRevision: report.revision - 1,
        },
        expectedContentHash: report.contentHash,
      }),
    );
    validateResponseForRequest(freeze, parseResponse(response(d.reportRecord.data)));
    assertThrows(() =>
      validateResponseForRequest(
        freeze,
        parseResponse(
          response({ ...d.reportRecord.data, value: { ...report, revision: report.revision + 1 } }),
        ),
      ),
    );
  },
);

Deno.test(
  'V6 closed families reject old aliases/raw source and never advertise membership or permission from capability discovery',
  () => {
    for (const value of [
      request('analysis.request', { analysisId: 'a' }),
      request('member.set'),
      { ...request('capability.read'), unexpected: true },
      { ...request('capability.read'), schemaVersion: 'lca.study-api.v5' },
      request('study.resources.list', {
        studyId: '10000000-0000-4000-8000-000000000001',
        kind: 'analysis',
        limit: 1,
        cursor: null,
      }),
      request('artifact.read', {
        studyId: '10000000-0000-4000-8000-000000000001',
        artifactRef: {
          type: 'modelSource',
          id: 'a',
          contentHash: 'a'.repeat(64),
          digestScope: 'artifact_bytes_sha256',
          byteSize: 1,
          mediaType: 'application/json',
          schemaVersion: 'lca.study-source-snapshot.v1',
        },
      }),
    ])
      assertThrows(() => parseRequest(value));
    assertEquals(operationMetadata['method.assessment.request'].kind, 'mutation');
    assertEquals(operationMetadata['resource.actions'].kind, 'query');
    assertEquals(authoringCaps.parse(disabledAuthoring).operations, ['capability.read']);
    assertEquals(reviewCaps.parse(disabledReview).operations, ['capability.read']);
    const bad = structuredClone(actual.responses.shareActions);
    bad.corePermissions.read = true;
    assertThrows(() => parseResponse(response(bad)));
  },
);
