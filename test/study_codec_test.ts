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
