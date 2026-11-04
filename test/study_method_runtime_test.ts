import { assert, assertEquals } from 'jsr:@std/assert';
import { methodRuntimeFixture, methodId } from './study_method_runtime_fixture.ts';
import { DISABLED_CAPABILITIES as disabledAuthoring } from '../contracts/lca-study/v6/authoring.ts';
import { DISABLED_CAPABILITIES as disabledReview } from '../contracts/lca-study/v6/review.ts';
import {
  canonicalBytes,
  parseCanonicalBytes,
  sha256,
  base64Url,
} from '../contracts/lca-study/v3/canonical.ts';
import { verifyExport, parseExportBundle } from '../contracts/lca-study/v6/export.ts';
import { bundledMethodRenderer } from '../supabase/functions/_shared/study/method_renderer.ts';
import actual from './fixtures/lca-study-v6/database-report-contexts.json' with { type: 'json' };
Deno.test(
  'V6 handler defaults off and intersects capabilities/limits with exact per-family Database admission',
  async () => {
    const f = await methodRuntimeFixture();
    const q = f.request('capability.read');
    const disabled = await f.call(q, {
      config: () => disabledAuthoring,
      review: {
        config: () => disabledReview,
        repository: () => {
          throw Error('must not access DB');
        },
      },
    });
    assertEquals(disabled.status, 200);
    assertEquals(disabled.body.data.operations, ['capability.read']);
    assertEquals(f.flags.dispatches, 0);
    const enabled = await f.call(q);
    assertEquals(enabled.status, 200);
    assertEquals(enabled.body.data.contractVersion, '6.0.0');
    assertEquals(enabled.body.data.limits.maxProjectionBytes, 2000000);
    assertEquals(enabled.body.data.operations.length, 33);
    const blocked = await f.call(f.create, { config: () => disabledAuthoring });
    assertEquals(blocked.status, 503);
    const capRead = f.repository.dispatch.bind(f.repository);
    f.repository.dispatch = async (r, s, channel) =>
      r.operation === 'capability.read'
        ? {
            ok: true,
            data:
              channel === 'authoring'
                ? {
                    ...f.options.config!(),
                    limits: {
                      ...f.options.config!().limits,
                      maxEvidenceRefs: 0,
                      maxSelectedFactorRecords: 1,
                    },
                    operations: ['capability.read', 'method.assessment.read'],
                  }
                : disabledReview,
          }
        : await capRead(r, s, channel);
    const bounded = await f.call(q);
    assertEquals(bounded.body.data.limits.maxEvidenceRefs, 0);
    assertEquals(bounded.body.data.limits.maxSelectedFactorRecords, 1);
    assertEquals(bounded.body.data.operations, ['capability.read', 'method.assessment.read']);
    const actions = await f.call(
      f.request('resource.actions', {
        resource: {
          type: 'methodAssessment',
          id: f.f.context.methodAssessments[0].assessment.assessmentId,
        },
      }),
    );
    assertEquals(actions.status, 200);
    assertEquals(actions.body.data.corePermissions, { read: true, write: true });
    assertEquals(actions.body.data.allowedMemberRoles, []);
  },
);
Deno.test(
  'V6 report create/save/freeze use exact original identities and immutable native facts with same-key recovery',
  async () => {
    const f = await methodRuntimeFixture();
    const baseline = structuredClone(f.f.context.runs[0]);
    const created = await f.call(f.create);
    assertEquals(created.status, 200);
    assertEquals(created.body.data.value.revision, 1);
    assertEquals(f.flags.uploads, 1);
    const replay = await f.call({ ...f.create, requestId: methodId(950) });
    assertEquals(replay.body.data, created.body.data);
    assertEquals(f.flags.uploads, 1);
    const body = parseCanonicalBytes(f.storage.get(f.getContentArtifact().artifactRef.id)!) as any;
    assertEquals(body.schemaVersion, 'lca.study-method-report-content.v1');
    assertEquals(body.methodAssessment.requirements.length, 20);
    assertEquals(body.methodAssessment.categories.length, 25);
    assertEquals(body.methodAssessment.factCatalog.length, 58);
    assertEquals(body.methodAssessment.pefConformityQualified, false);
    assertEquals(await sha256(canonicalBytes(body)), created.body.data.value.contentHash);
    const content = {
      ...structuredClone(f.f.content),
      title: 'Saved authored text, mandatory source retained',
    };
    const save = f.request('report.save', {
      idempotencyKey: methodId(951),
      target: { type: 'reportRevision', id: f.getReport().reportRevisionId, expectedRevision: 1 },
      content,
    });
    const saved = await f.call(save);
    assertEquals(saved.status, 200);
    assertEquals(saved.body.data.value.revision, 2);
    const frozen = await f.call(f.freeze());
    assertEquals(frozen.status, 200);
    assertEquals(frozen.body.data.value.status, 'frozen');
    assertEquals(frozen.body.data.value.revision, 3);
    assertEquals(f.f.context.runs[0], baseline);
    const view = await f.call(f.view());
    assertEquals(view.status, 200);
    assertEquals(view.body.data.share, null);
    assertEquals(view.body.data.view.methodAssessment.factCatalog.length, 58);
    const p = f.flags.contexts.find((c) => c.kind === 'studyMethodReviewContext')!.producerContext;
    assertEquals(p.operation, 'report.view');
    assertEquals(p.request.operation, 'report.view');
    for (const key of [
      'contentArtifactId',
      'exportId',
      'projectionArtifactId',
      'resourcesArtifactId',
      'bundleArtifactId',
    ])
      assertEquals(p[key], null);
  },
);
Deno.test(
  'V6 export4 issues canonical projection HTML reproducible outside source with independently trusted signature',
  async () => {
    const f = await methodRuntimeFixture();
    assertEquals((await f.call(f.create)).status, 200);
    assertEquals((await f.call(f.freeze())).status, 200);
    assertEquals((await f.call(f.finalize())).status, 200);
    const request = f.exportRequest(),
      issued = await f.call(request);
    assertEquals(issued.status, 200, JSON.stringify(issued.body));
    const ex = issued.body.data.value;
    const bundle = parseExportBundle(f.storage.get(ex.bundleRef.id)!);
    const anchor = {
      keyId: f.profile.keyId,
      issuerId: f.profile.issuerId,
      publicKeySpki: base64Url(
        new Uint8Array(await crypto.subtle.exportKey('spki', f.keys.publicKey)),
      ),
      validFrom: '2026-01-01T00:00:00Z',
      validUntil: '2027-01-01T00:00:00Z',
      rendererArtifactHashes: [f.profile.rendererArtifactHash],
    };
    const manifest = await verifyExport(
      bundle.manifestBytes,
      bundle.receipt,
      bundle.files,
      [anchor],
      {
        issuerId: f.profile.issuerId,
        exportId: ex.exportId,
        studyId: ex.studyId,
        reportRevisionId: ex.reportRevisionId,
        reportContentHash: ex.reportContentHash,
      },
    );
    assertEquals(manifest.schemaVersion, 'lca.study-export-manifest.v4');
    const projection = bundle.files.find((f) => f.path === 'projection.json')!;
    const html = bundle.files.find((f) => f.path === 'report.html')!;
    const rerender = await bundledMethodRenderer.render(parseCanonicalBytes(projection.bytes), {
      exportId: ex.exportId,
      projectionHash: await sha256(projection.bytes),
      verificationAtGeneration: 'verified_by_trusted_exporter',
    });
    assertEquals(await sha256(html.bytes), await sha256(new TextEncoder().encode(rerender)));
    const replay = await f.call({ ...request, requestId: methodId(952) });
    assertEquals(replay.body.data, issued.body.data);
    assertEquals(f.flags.uploads, 4);
    const download = await f.call(f.request('export.download', { exportId: ex.exportId }));
    assertEquals(download.status, 200);
    assertEquals(
      await sha256(Uint8Array.from(atob(download.body.data.bytes), (c) => c.charCodeAt(0))),
      ex.bundleRef.contentHash,
    );
    const text = JSON.stringify(issued.body);
    for (const field of [
      'storageBucket',
      'storageObjectPath',
      'sourceAuthorization',
      'privateKeyPkcs8',
    ])
      assertEquals(text.includes(field), false);
  },
);
Deno.test(
  'V6 evidence immutable registration binds exact scalar content/current actor and recovers same-key lost consume',
  async () => {
    const f = await methodRuntimeFixture();
    const q = f.request('method.evidence.create', {
      idempotencyKey: methodId(953),
      studyId: f.f.context.studyId,
      content: actual.evidenceContext.data.request.content,
    });
    f.flags.loseConsume = true;
    const unknown = await f.call(q);
    assertEquals(unknown.status, 502);
    assertEquals(JSON.stringify(unknown.body).includes('sentinel'), false);
    assertEquals(f.flags.uploads, 1);
    const recovered = await f.call({ ...q, requestId: methodId(954) });
    assertEquals(recovered.status, 200);
    const e = recovered.body.data.value;
    assertEquals(e.status, 'recorded_unverified');
    assert(e.evidenceId !== e.artifactRef.id);
    assertEquals(await sha256(f.storage.get(e.artifactRef.id)!), e.artifactRef.contentHash);
    assertEquals(f.flags.uploads, 1);
    assertEquals(f.flags.consumes, 1);
  },
);
Deno.test(
  'V6 report/evidence fail closed on transplanted actor/client, revoked I/O and changed immutable source bytes',
  async () => {
    for (const mode of ['actor', 'client', 'read', 'upload', 'bytes', 'context'] as const) {
      const f = await methodRuntimeFixture();
      if (mode === 'actor') f.flags.wrongActor = true;
      if (mode === 'client') f.flags.wrongClient = true;
      if (mode === 'read') f.flags.revokeAfterRead = true;
      if (mode === 'upload') f.flags.revokeAfterUpload = true;
      if (mode === 'bytes')
        f.storage.set(
          f.f.context.runs[0].resultArtifact.artifactRef.id,
          new TextEncoder().encode('{}'),
        );
      if (mode === 'context') f.flags.changeAfterRead = true;
      const r = await f.call(f.create);
      assert(r.status >= 400, mode);
      assertEquals(f.flags.consumes, 0, mode);
      if (mode !== 'upload') assertEquals(f.flags.uploads, 0, mode);
      assertEquals(JSON.stringify(r.body).includes('storageObjectPath'), false);
    }
    for (const mode of ['wrongActor', 'wrongClient', 'revokeAfterUpload'] as const) {
      const f = await methodRuntimeFixture();
      f.flags[mode] = true;
      const r = await f.call(
        f.request('method.evidence.create', {
          idempotencyKey: methodId(955),
          studyId: f.f.context.studyId,
          content: actual.evidenceContext.data.request.content,
        }),
      );
      assert(r.status >= 400);
      assertEquals(f.flags.consumes, 0);
    }
  },
);
Deno.test(
  'V6 unknown immutable upload/consume outcomes retain same identity and current authorization on retry',
  async () => {
    for (const mode of ['failUpload', 'loseConsume'] as const) {
      const f = await methodRuntimeFixture();
      f.flags[mode] = true;
      const unknown = await f.call(f.create);
      assertEquals(unknown.status, 502);
      const ids = [...f.storage.keys()];
      const retry = await f.call({ ...f.create, requestId: methodId(956) });
      assertEquals(retry.status, 200);
      assertEquals([...f.storage.keys()], ids);
      assertEquals(f.flags.consumes, 1);
      f.flags.revoked = true;
      assertEquals((await f.call({ ...f.create, requestId: methodId(957) })).status, 403);
      assertEquals([...f.storage.keys()], ids);
    }
  },
);

Deno.test(
  'V6 current-authorized preview retains historical validity while exports and authoring remain current-only',
  async () => {
    const f = await methodRuntimeFixture();
    await f.call(f.create);
    await f.call(f.freeze());
    f.flags.mutateContext = (c) => {
      if (c.kind === 'studyMethodReviewContext') {
        c.currentState.validity.status = 'superseded';
        c.producerContext.runs[0].run.validity.status = 'superseded';
        c.producerContext.actorId = methodId(999);
      }
    };
    const view = await f.call(f.view());
    assertEquals(view.status, 200);
    assertEquals(view.body.data.view.snapshot.validity, 'superseded');
    await f.call(f.finalize());
    assertEquals((await f.call(f.exportRequest())).status, 409);
  },
);
Deno.test(
  'V6 named shares disclose exact retained method summary/export only to current recipient and never grant core access',
  async () => {
    const f = await methodRuntimeFixture();
    await f.call(f.create);
    await f.call(f.freeze());
    await f.call(f.finalize());
    await f.call(f.exportRequest());
    const shared = await f.call(
      f.request('share.create', {
        idempotencyKey: methodId(958),
        reportRevisionId: f.getReport().reportRevisionId,
        expectedContentHash: f.getReport().contentHash,
        exportId: f.getExport().exportId,
        recipientId: f.actor.userId,
        disclosurePolicyId: 'lca.study-report-summary-share.v1',
        expiresAt: '2026-11-04T01:00:00Z',
      }),
    );
    assertEquals(shared.status, 200);
    const id = shared.body.data.value.shareId;
    const view = await f.call(f.request('share.view', { shareId: id }));
    assertEquals(view.status, 200);
    assertEquals(view.body.data.view.methodAssessment.factCatalog.length, 58);
    assertEquals(view.body.data.share.recipientId, f.actor.userId);
    const download = await f.call(f.request('share.download', { shareId: id }));
    assertEquals(download.status, 200);
    assertEquals(
      await sha256(Uint8Array.from(atob(download.body.data.bytes), (c) => c.charCodeAt(0))),
      f.getExport().bundleRef.contentHash,
    );
    f.flags.mutateContext = (c) => {
      if (c.share) c.share.recipientId = methodId(999);
    };
    assertEquals((await f.call(f.request('share.view', { shareId: id }))).status, 502);
    f.flags.mutateContext = null;
    f.flags.revokeAfterRead = true;
    assertEquals((await f.call(f.request('share.download', { shareId: id }))).status, 403);
    f.flags.revokeAfterRead = false;
    f.flags.revoked = false;
    assertEquals(
      (
        await f.call(
          f.request('share.revoke', {
            idempotencyKey: methodId(959),
            shareId: id,
            reason: 'End synthetic access',
          }),
        )
      ).status,
      200,
    );
    assertEquals((await f.call(f.request('share.view', { shareId: id }))).status, 502);
  },
);
