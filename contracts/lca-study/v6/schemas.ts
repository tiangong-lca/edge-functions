import { z } from 'zod';
import { resolveOwnerSchema, hasOnlyUnicodeScalars } from './owner_json.ts';
import type {
  MethodConfig,
  MethodFacts,
  MethodAssessmentRecord,
  MethodEvidence,
  MethodEvidenceRecord,
  MethodCatalogFact,
  MethodFactsRef,
} from '../worker/method/types.d.ts';
import { canonicalJson, canonicalBytes, domainBytes, sha256 } from '../v3/canonical.ts';
import { METHOD_PUBLIC_MODULE } from './module_identity.ts';

export type {
  MethodConfig,
  MethodFacts,
  MethodAssessmentRecord,
  MethodEvidence,
  MethodEvidenceRecord,
  MethodCatalogFact,
  MethodFactsRef,
};
export const METHOD_PROFILE = 'lca.study-method-pef-2021-ef31-cement-intermediate.v1' as const;
export const METHOD_FACTS_SCHEMA = 'lca.study-method-assessment-facts.v1' as const;
export const METHOD_FACTS_MAX_BYTES = 4 * 1024 * 1024;
export const METHOD_EVIDENCE_MAX_BYTES = 65536;
export const METHOD_SELECTED_FACTOR_MAX_RECORDS = 8192;

function owner<T>(name: string, pointer = ''): z.ZodType<T> {
  return z
    .fromJSONSchema(resolveOwnerSchema(name, pointer) as Parameters<typeof z.fromJSONSchema>[0])
    .superRefine((value, ctx) => {
      if (!hasOnlyUnicodeScalars(value))
        ctx.addIssue({ code: 'custom', message: 'Unicode scalar values required' });
    }) as z.ZodType<T>;
}
export const methodConfigSchema = owner<MethodConfig>(
  'study-method-assessment-config.v1.schema.json',
);
export const methodAssessmentSchema = owner<MethodAssessmentRecord>(
  'study-method-assessment-record.v1.schema.json',
);
export const methodFactsRefSchema = owner<MethodFactsRef>(
  'study-method-assessment-facts.v1.schema.json',
  '/$defs/methodFactsRef',
);
export const methodEvidenceRecordSchema = owner<MethodEvidenceRecord>(
  'study-method-evidence-record.v1.schema.json',
);
export const methodCatalogFactSchema = owner<MethodCatalogFact>(
  'study-method-fact-catalog-entry.v1.schema.json',
);
export const methodEvidenceSchema = owner<MethodEvidence>(
  'study-method-evidence.v1.schema.json',
).superRefine((value, ctx) => {
  try {
    if (canonicalBytes(value).length > METHOD_EVIDENCE_MAX_BYTES)
      ctx.addIssue({ code: 'custom', message: 'method evidence byte bound exceeded' });
  } catch {
    ctx.addIssue({ code: 'custom', message: 'canonical method evidence required' });
  }
});
const rawFactsSchema = owner<MethodFacts>('study-method-assessment-facts.v1.schema.json');
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
type RelationalFacts = Pick<
  MethodFacts,
  | 'assessmentId'
  | 'studyId'
  | 'config'
  | 'configHash'
  | 'moduleRef'
  | 'baseline'
  | 'categories'
  | 'requirements'
  | 'candidateNormalisationWeighting'
  | 'factCatalog'
  | 'frozenEvidence'
> & {
  methodSourceEvidence: Pick<
    MethodFacts['methodSourceEvidence'],
    | 'frozenCMatchesVerifiedBundle'
    | 'normativeVersion'
    | 'factorPackageVersion'
    | 'interimGuidanceSnapshot'
    | 'normalisationWeightingSourceSha256'
    | 'officialFactorPackageSha256'
  >;
};

/** Exact owner selector relationships only. No characterisation or N/W arithmetic. */
export function assertMethodFactRelations(value: RelationalFacts): void {
  const fail = () => {
    throw new Error('method_fact_binding');
  };
  if (
    value.config.baselineRunId !== value.baseline.runId ||
    !same(value.config.moduleRef, value.moduleRef) ||
    !same(value.moduleRef, METHOD_PUBLIC_MODULE.moduleRef) ||
    value.methodSourceEvidence.normativeVersion !== METHOD_PUBLIC_MODULE.normativeVersion ||
    value.methodSourceEvidence.factorPackageVersion !== METHOD_PUBLIC_MODULE.factorPackageVersion ||
    !same(
      value.methodSourceEvidence.interimGuidanceSnapshot,
      METHOD_PUBLIC_MODULE.interimGuidanceSnapshot,
    ) ||
    value.methodSourceEvidence.normalisationWeightingSourceSha256 !==
      METHOD_PUBLIC_MODULE.normalisationWeightingSourceSha256 ||
    value.methodSourceEvidence.officialFactorPackageSha256 !==
      METHOD_PUBLIC_MODULE.officialFactorPackageSha256 ||
    value.categories.length !== 25 ||
    value.categories.filter((v) => v.role === 'primary').length !== 16 ||
    value.categories.filter((v) => v.role === 'subcategory').length !== 9 ||
    new Set(value.categories.map((v) => canonicalJson(v.methodRef))).size !== 25 ||
    value.requirements.length !== 20 ||
    value.requirements.some(
      (v, i) => v.requirementId !== `PEF-${String(i + 1).padStart(2, '0')}`,
    ) ||
    value.factCatalog.length !== 58 ||
    new Set(value.factCatalog.map((v) => v.factId)).size !== 58 ||
    value.factCatalog.some(
      (v) =>
        v.assessmentId !== value.assessmentId ||
        v.baselineRunId !== value.baseline.runId ||
        (v.coverage === 'unknown' && v.canonicalValue !== null) ||
        (v.canonicalValue !== null &&
          (!Number.isFinite(Number(v.canonicalValue)) ||
            (Number(v.canonicalValue) === 0 && v.canonicalValue !== '0'))),
    )
  )
    fail();
  value.categories.forEach((category, index) => {
    const expected = METHOD_PUBLIC_MODULE.categories[index];
    const fact = value.factCatalog[index];
    const axis = value.frozenEvidence.methodAxes.find(
      (axis) => axis.id === category.methodRef.id && axis.version === category.methodRef.version,
    );
    if (
      !same(category.methodRef, expected.methodRef) ||
      category.name !== expected.name ||
      category.role !== expected.role ||
      category.parentMethodId !== expected.parentMethodId ||
      category.referenceQuantityId !== expected.referenceQuantityId ||
      category.unit !== expected.unit ||
      category.selected !== Boolean(axis) ||
      (category.sourceCompatible &&
        (!value.methodSourceEvidence.frozenCMatchesVerifiedBundle ||
          !axis ||
          axis.unit !== category.unit)) ||
      fact.factId !== `category:${category.methodRef.id}:characterised` ||
      !same(fact.context, {
        kind: 'characterisedCategory',
        methodRef: category.methodRef,
        categoryRole: category.role,
      }) ||
      !same(fact.methodRef, category.methodRef) ||
      fact.canonicalValue !== category.canonicalCharacterisedValue ||
      fact.unit !== category.unit ||
      fact.coverage !== (category.coverage === 'not_selected' ? 'unknown' : category.coverage) ||
      !same(fact.reasonCodes, category.reasonCodes) ||
      !same(fact.unitIdentity, {
        kind: 'characterised',
        methodRef: category.methodRef,
        referenceQuantityId: category.referenceQuantityId,
        unit: category.unit,
      })
    )
      fail();
  });
  value.requirements.forEach((requirement, index) => {
    const expected = METHOD_PUBLIC_MODULE.requirements[index];
    if (
      requirement.requirementId !== expected.requirementId ||
      requirement.sourceApplicability !== expected.sourceApplicability ||
      requirement.sourceCheckKind !== expected.sourceCheckKind ||
      !same(requirement.sourceCitations, expected.sourceCitations)
    )
      fail();
  });
  const score = value.factCatalog[57];
  if (score.context.kind !== 'candidateSingleScore' || score.unitIdentity.kind !== 'candidateScore')
    fail();
  if (score.context.kind !== 'candidateSingleScore' || score.unitIdentity.kind !== 'candidateScore')
    return;
  const methods = score.context.primaryMethods;
  const primaries = value.categories.filter((v) => v.role === 'primary').map((v) => v.methodRef);
  const nw = value.candidateNormalisationWeighting;
  const available = nw.status === 'candidate_arithmetic_available';
  const primaryCategories = value.categories.filter((category) => category.role === 'primary');
  // These are the owner's eligibility/mapping predicates, not an Edge-issued
  // calculation or approval. Ineligible/null/partial rows cannot claim N/W.
  if (
    (available &&
      (!value.methodSourceEvidence.frozenCMatchesVerifiedBundle ||
        nw.reasonCodes.length !== 0 ||
        primaryCategories.some(
          (category) =>
            !category.selected ||
            !category.sourceCompatible ||
            category.coverage !== 'complete' ||
            category.canonicalCharacterisedValue === null,
        ))) ||
    value.categories.some(
      (category) =>
        category.normalisationWeightingIncluded !== (available && category.role === 'primary'),
    )
  )
    fail();
  if (
    methods.length !== 16 ||
    !same(
      methods,
      METHOD_PUBLIC_MODULE.normalisation.map((n) => n.methodRef),
    ) ||
    new Set(methods.map((v) => canonicalJson(v))).size !== 16 ||
    methods.some((m) => !primaries.some((p) => same(m, p))) ||
    !same(score.unitIdentity.primaryMethods, methods) ||
    score.factId !== 'candidate:singleScore' ||
    score.methodRef !== null ||
    score.canonicalValue !== nw.canonicalCandidateSingleScore ||
    score.unit !== nw.scoreUnit ||
    score.coverage !== (available ? 'complete' : 'unknown') ||
    !same(score.reasonCodes, nw.reasonCodes) ||
    score.unitIdentity.unit !== nw.scoreUnit ||
    score.unitIdentity.pointDefinition !== nw.pointDefinition ||
    score.unitIdentity.scalingFactor !== nw.scalingFactor ||
    score.unitIdentity.moduleArtifactSha256 !== value.moduleRef.artifactSha256 ||
    (available
      ? nw.categories.length !== 16
      : nw.categories.length !== 0 || nw.canonicalCandidateSingleScore !== null)
  )
    fail();
  methods.forEach((method, i) => {
    const expected = METHOD_PUBLIC_MODULE.normalisation[i];
    const category = available ? nw.categories[i] : undefined;
    const primary = primaryCategories.find((c) => same(c.methodRef, method));
    if ((category !== undefined) !== available) fail();
    if (
      category &&
      (!primary ||
        !same(category.methodRef, method) ||
        category.canonicalCharacterisedValue !== primary.canonicalCharacterisedValue ||
        category.characterisedUnit !== primary.unit ||
        category.referenceQuantityId !== primary.referenceQuantityId ||
        category.sourceNormalisationFactor !== expected.sourceNormalisationFactor ||
        category.sourceWeightFraction !== expected.sourceWeightFraction ||
        category.sourceUnitLabel !== expected.sourceUnitLabel ||
        category.sourceShortDescription !== expected.sourceShortDescription)
    )
      fail();
    for (const normalised of [true, false]) {
      const fact = value.factCatalog[25 + i * 2 + (normalised ? 0 : 1)];
      if (
        fact.factId !== `${normalised ? 'normalised' : 'weighted'}:${method.id}` ||
        !same(fact.context, {
          kind: normalised ? 'normalisedCategory' : 'weightedCategory',
          methodRef: method,
        }) ||
        !same(fact.methodRef, method) ||
        fact.canonicalValue !==
          (category
            ? normalised
              ? category.canonicalNormalisedValue
              : category.canonicalWeightedValue
            : null) ||
        fact.unit !== (normalised ? '1' : 'Pt') ||
        fact.coverage !== (available ? 'complete' : 'unknown') ||
        !same(fact.reasonCodes, nw.reasonCodes) ||
        fact.unitIdentity.kind !== (normalised ? 'normalised' : 'weighted')
      )
        fail();
      if (fact.unitIdentity.kind !== 'normalised' && fact.unitIdentity.kind !== 'weighted') fail();
      if (fact.unitIdentity.kind === 'normalised' || fact.unitIdentity.kind === 'weighted') {
        if (
          !same(fact.unitIdentity.methodRef, method) ||
          fact.unitIdentity.unit !== fact.unit ||
          fact.unitIdentity.referenceQuantityId !== primary?.referenceQuantityId ||
          fact.unitIdentity.sourceNormalisationFactor !== expected.sourceNormalisationFactor ||
          fact.unitIdentity.moduleArtifactSha256 !== value.moduleRef.artifactSha256
        )
          fail();
        if (
          category &&
          fact.unitIdentity.sourceNormalisationFactor !== category.sourceNormalisationFactor
        )
          fail();
        if (
          fact.unitIdentity.kind === 'weighted' &&
          (fact.unitIdentity.pointDefinition !== nw.pointDefinition ||
            fact.unitIdentity.scalingFactor !== nw.scalingFactor ||
            fact.unitIdentity.sourceWeightFraction !== expected.sourceWeightFraction ||
            (category && fact.unitIdentity.sourceWeightFraction !== category.sourceWeightFraction))
        )
          fail();
      }
    }
  });
}
export const methodFactsSchema = rawFactsSchema.superRefine((value, ctx) => {
  try {
    assertMethodFactRelations(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'exact method fact selector bindings required' });
  }
});
export function parseMethodFacts(input: unknown): MethodFacts {
  return methodFactsSchema.parse(input);
}
export function parseMethodConfig(input: unknown): MethodConfig {
  return methodConfigSchema.parse(input);
}
export async function methodConfigHash(input: unknown): Promise<string> {
  return await sha256(domainBytes('study.method-assessment-config.v1', parseMethodConfig(input)));
}
