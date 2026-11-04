import { assertEquals, assertThrows } from 'jsr:@std/assert';
import {
  API_SCHEMA,
  parseRequest,
  parseResponse,
  validateResponseForRequest,
} from '../contracts/lca-study/v2/codec.ts';

Deno.test('portable v2 codec binds exact artifact, request and current wire fields', () => {
  const ref = {
    type: 'runResult',
    id: 'result',
    contentHash: 'a'.repeat(64),
    mediaType: 'application/json',
    byteSize: 2,
    digestScope: 'artifact_bytes_sha256',
    schemaVersion: 'lca.study-result.v1',
  };
  const request = parseRequest({
    schemaVersion: API_SCHEMA,
    requestId: 'request',
    operation: 'artifact.read',
    studyId: 'study',
    artifactRef: ref,
  });
  const artifact = parseResponse({
    schemaVersion: API_SCHEMA,
    requestId: 'request',
    ok: true,
    data: {
      type: 'artifact',
      studyId: 'study',
      artifactRef: ref,
      encoding: 'base64',
      bytes: 'e30=',
    },
  });
  validateResponseForRequest(request, artifact);
  assertThrows(() =>
    validateResponseForRequest(
      request,
      parseResponse({ ...artifact, data: { ...(artifact.ok && artifact.data), studyId: 'other' } }),
    ),
  );
  assertThrows(() =>
    validateResponseForRequest(
      request,
      parseResponse({
        ...artifact,
        data: {
          ...(artifact.ok && artifact.data),
          artifactRef: { ...ref, contentHash: 'b'.repeat(64) },
        },
      }),
    ),
  );
  assertEquals(
    parseRequest({
      schemaVersion: API_SCHEMA,
      requestId: 'request',
      operation: 'study.list',
      limit: 1,
      cursor: null,
    }).operation,
    'study.list',
  );
  const selected = parseRequest({
    schemaVersion: API_SCHEMA,
    requestId: 'request',
    operation: 'study.read',
    studyId: 'study',
  });
  const value = parseResponse({
    schemaVersion: API_SCHEMA,
    requestId: 'request',
    ok: true,
    data: {
      type: 'study',
      value: {
        studyId: 'other',
        revision: 1,
        scope: { kind: 'user', id: 'owner' },
        title: 'Study',
        status: 'active',
        currentRevisionId: null,
      },
    },
  });
  assertThrows(() => validateResponseForRequest(selected, value));
  assertThrows(() => parseResponse({ ...value, requestId: undefined }));
});

Deno.test('v2 archive success binds archived state and the exact CAS successor', () => {
  const request = parseRequest({
    schemaVersion: API_SCHEMA,
    requestId: 'archive-request',
    idempotencyKey: 'original-archive-key',
    operation: 'study.archive',
    target: { type: 'study', id: 'study', expectedRevision: 7 },
  });
  const reply = (patch: Record<string, unknown> = {}) =>
    parseResponse({
      schemaVersion: API_SCHEMA,
      requestId: request.requestId,
      ok: true,
      data: {
        type: 'study',
        value: {
          studyId: 'study',
          revision: 8,
          scope: { kind: 'user', id: 'owner' },
          title: 'Study',
          status: 'archived',
          currentRevisionId: null,
          ...patch,
        },
      },
    });
  const original = reply();
  validateResponseForRequest(request, original);
  validateResponseForRequest(request, original); // Exact receipt replay has the same successor.
  for (const patch of [
    { status: 'active', revision: 1 },
    { status: 'active' },
    { revision: 7 },
    { revision: 9 },
    { studyId: 'another-study' },
  ]) {
    assertThrows(() => validateResponseForRequest(request, reply(patch)));
  }
  validateResponseForRequest(
    request,
    parseResponse({
      schemaVersion: API_SCHEMA,
      requestId: request.requestId,
      ok: false,
      code: 'REVISION_CONFLICT',
      message: 'Study request could not be completed.',
      retryable: false,
      issues: [],
    }),
  );
});
