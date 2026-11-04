import { z } from 'zod';
import { modelSourceSnapshotSchema } from '../../../../contracts/lca-study/v1/records.ts';
import { idSchema, timestampSchema } from '../../../../contracts/lca-study/v1/common.ts';
import {
  parameterCatalogSchema,
  parameterSchema,
} from '../../../../contracts/lca-study/v5/catalog.ts';
import { reportContextSchema } from './advanced_context.ts';
import { artifactCapabilitySchema } from './repository.ts';
import { preparedInputSchema } from './validator.ts';
import { sameJson } from './reporting_producer.ts';
import { StudyFailure } from './protocol.ts';
export const parameterIntentSchema = z
  .object({
    kind: z.literal('advancedParameterIntent'),
    intentId: idSchema,
    expiresAt: timestampSchema,
  })
  .strict();
export const parameterContextSchema = z
  .object({
    kind: z.literal('advancedParameterContext'),
    intentId: idSchema,
    expiresAt: timestampSchema,
    actorId: idSchema,
    clientId: idSchema.nullable(),
    studyId: idSchema,
    baselineRunId: idSchema,
    baseline: reportContextSchema.shape.runs.element,
    sourceSnapshot: modelSourceSnapshotSchema,
    sourceArtifact: artifactCapabilitySchema.omit({ kind: true }),
  })
  .strict();
/** Read original finite Worker numeric tokens; JSON Number serialization is not its canonical codec. */
function tokens(text: string): Map<string, string> {
  let i = 0,
    nodes = 0;
  const found = new Map<string, string>();
  const ws = () => {
    while (/\s/u.test(text[i] ?? '') && i < text.length) i++;
  };
  const string = () => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') {
        i += 2;
        continue;
      }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i)) as string;
    }
    throw new Error('advanced_json_string');
  };
  const walk = (path: string, depth: number) => {
    if (++nodes > 262144 || depth > 128) throw new Error('advanced_json_bounds');
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      ws();
      const keys = new Set<string>();
      if (text[i] === '}') {
        i++;
        return;
      }
      while (i < text.length) {
        ws();
        if (text[i] !== '"') throw new Error('advanced_json_key');
        const k = string();
        if (keys.has(k)) throw new Error('advanced_json_duplicate');
        keys.add(k);
        ws();
        if (text[i++] !== ':') throw new Error('advanced_json_colon');
        walk(`${path}/${k.replaceAll('~', '~0').replaceAll('/', '~1')}`, depth + 1);
        ws();
        const next = text[i++];
        if (next === '}') return;
        if (next !== ',') throw new Error('advanced_json_object');
      }
      throw new Error('advanced_json_object');
    }
    if (c === '[') {
      i++;
      ws();
      let index = 0;
      if (text[i] === ']') {
        i++;
        return;
      }
      while (i < text.length) {
        walk(`${path}/${index++}`, depth + 1);
        ws();
        const next = text[i++];
        if (next === ']') return;
        if (next !== ',') throw new Error('advanced_json_array');
      }
      throw new Error('advanced_json_array');
    }
    if (c === '"') {
      string();
      return;
    }
    const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/u.exec(
      text.slice(i),
    );
    if (!match) throw new Error('advanced_json_value');
    i += match[0].length;
    if (/^-?\d/u.test(match[0])) found.set(path, match[0]);
  };
  walk('', 0);
  ws();
  if (i !== text.length) throw new Error('advanced_json_tail');
  return found;
}
export function canonicalWorkerToken(token: string): string {
  if (Number(token) === 0) return '0';
  let [m, e] = token.toLowerCase().split('e');
  if (m.includes('.')) m = m.replace(/0+$/u, '').replace(/\.$/u, '');
  if (e !== undefined) {
    const exponent = Number(e);
    if (exponent !== 0) return `${m}e${exponent}`;
  }
  return m;
}
export function makeParameterCatalog(
  context: z.infer<typeof parameterContextSchema>,
  bytes: Uint8Array,
) {
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    p = preparedInputSchema.parse(JSON.parse(raw)),
    b = context.baseline;
  if (
    [
      b.revision.studyId,
      b.scenario.studyId,
      b.preparation.studyId,
      b.preparedArtifact.studyId,
      b.resultArtifact.studyId,
      context.sourceSnapshot.studyId,
      context.sourceArtifact.studyId,
    ].some((id) => id !== context.studyId) ||
    b.run.studyRevisionId !== b.revision.revisionId ||
    b.run.scenarioRevisionId !== b.scenario.scenarioRevisionId ||
    b.scenario.studyRevisionId !== b.revision.revisionId ||
    b.run.modelPreparationId !== b.preparation.preparationId ||
    b.scenario.modelPreparationId !== b.preparation.preparationId ||
    !sameJson(b.run.effectiveModelRef, b.scenario.effectiveModelRef) ||
    !sameJson(b.resultArtifact.artifactRef, b.run.resultRef) ||
    !sameJson(context.sourceSnapshot.sourceArtifactRef, context.sourceArtifact.artifactRef) ||
    p.model.origin.id !== context.sourceSnapshot.originRef.id ||
    p.model.origin.version !== context.sourceSnapshot.originRef.version ||
    b.run.studyId !== context.studyId ||
    b.run.runId !== context.baselineRunId ||
    b.run.execution.status !== 'completed' ||
    b.run.validity.status !== 'current' ||
    b.revision.status !== 'frozen' ||
    b.scenario.status !== 'frozen' ||
    b.preparation.execution.status !== 'completed' ||
    p.modelHash !== b.run.effectiveModelRef.contentHash ||
    p.inputHash !== b.run.inputHash ||
    !sameJson(b.preparedArtifact.artifactRef, b.preparation.inputArtifactRef) ||
    !sameJson(b.run.effectiveModelRef, b.preparation.modelRef) ||
    !sameJson(b.run.calculationContractRef, p.calculationContractRef) ||
    !p.studyBinding ||
    p.studyBinding.studyRevisionId !== b.revision.revisionId ||
    p.studyBinding.studyRevisionContentHash !== b.revision.contentHash ||
    !sameJson(p.studyBinding.definition, b.revision.definition)
  )
    throw new StudyFailure('REFERENCE_MISMATCH', 502, 'advanced.catalog_binding');
  const numbers = tokens(raw),
    parameters: z.infer<typeof parameterCatalogSchema>['parameters'] = [];
  p.model.instances.forEach((instance, i) =>
    instance.exchanges.forEach((e, j) => {
      if (e.id === instance.referenceExchangeId) return;
      const token = numbers.get(`/model/instances/${i}/exchanges/${j}/amount`);
      if (!token) throw new Error('advanced_catalog_amount');
      parameters.push(
        parameterSchema.parse({
          path: `/instances/${instance.id}/exchanges/${e.id}/amount`,
          flow: e.flow,
          direction: e.direction,
          unit: e.unit,
          support: e.unitIdentity,
          baselineAmount: canonicalWorkerToken(token),
        }),
      );
    }),
  );
  return parameterCatalogSchema.parse({
    type: 'parameterCatalog',
    studyId: context.studyId,
    baselineRunId: context.baselineRunId,
    preparedArtifactRef: b.preparedArtifact.artifactRef,
    inputHash: b.run.inputHash,
    parameters,
  });
}
