// Generated from the byte-bound Worker JSON Schema; do not hand-edit.
export type AnalysisFacts = {
  schemaVersion: 'lca.study-analysis-facts.v1';
  profileId: 'lca.study-analysis-explicit-v1';
  analyzerVersion: 'study.analysis.v1';
  studyId: string;
  analysisId: string;
  config:
    | { schemaVersion: 'lca.study-analysis-config.v1'; kind: 'contribution'; runIds: Array<string> }
    | { schemaVersion: 'lca.study-analysis-config.v1'; kind: 'comparison'; runIds: Array<string> };
  configHash: string;
  inputs: Array<{
    runId: string;
    studyRevisionId: string;
    scenarioRevisionId: string;
    modelPreparationId: string;
    inputHash: string;
    effectiveModelRef: {
      type: 'modelRevision';
      modelRevisionId: string;
      contentHash: string;
      digestScope: 'worker_prepared_model';
    };
    preparedArtifactRef: {
      type: 'modelInput' | 'runResult';
      id: string;
      contentHash: string;
      digestScope: 'artifact_bytes_sha256';
      byteSize: number;
      mediaType: 'application/json';
      schemaVersion: string;
    };
    resultRef: {
      type: 'modelInput' | 'runResult';
      id: string;
      contentHash: string;
      digestScope: 'artifact_bytes_sha256';
      byteSize: number;
      mediaType: 'application/json';
      schemaVersion: string;
    };
    calculationContractRef: {
      kind: 'calculation_contract';
      schema: 'lca.calculation-contract.v1';
      sha256: string;
    };
    methodSourceHash: string;
    validity: {
      status: 'current' | 'superseded' | 'withdrawn' | 'unknown';
      checkedAt: string;
      reasonCodes: Array<string>;
    };
  }>;
  comparability: {
    status: 'not_assessed' | 'comparable' | 'not_comparable';
    reasonCodes: Array<string>;
    scope: 'frozen_numerical_inputs_only';
    rankingAllowed: false;
    checks: Array<{ ruleId: string; status: 'passed' | 'failed' | 'unknown' }>;
  };
  facts: Array<
    | {
        factId: string;
        kind:
          | 'activity'
          | 'inventory'
          | 'impact'
          | 'viewContribution'
          | 'inventoryContribution'
          | 'comparisonDelta'
          | 'relativeDelta';
        label: string;
        runIds: Array<string>;
        methodRef: { id: string; version: string } | null;
        canonicalValue: string;
        unit: string;
        unitIdentity: {
          kind:
            | 'model_view_reference_unit'
            | 'flow_reference_unit'
            | 'lcia_method_quantity'
            | 'dimensionless';
          flow: { id: string; version: string } | null;
          method: { id: string; version: string } | null;
          support: Array<{ id: string; version: string }>;
          view: { instanceId: string; exchangeId: string } | null;
        };
        coverage: 'complete' | 'partial';
        scope:
          | 'declared_model_activity'
          | 'declared_inventory'
          | 'characterized_subtotal'
          | 'characterized_inventory_term'
          | 'numeric_delta_of_characterized_subtotals'
          | 'delta_divided_by_absolute_baseline';
        reasonCodes: Array<string>;
        subject: {
          view: { instanceId: string; exchangeId: string } | null;
          inventory: {
            flow: { id: string; version: string };
            direction: 'Input' | 'Output';
            unit: string;
          } | null;
        };
      }
    | {
        factId: string;
        kind:
          | 'activity'
          | 'inventory'
          | 'impact'
          | 'viewContribution'
          | 'inventoryContribution'
          | 'comparisonDelta'
          | 'relativeDelta';
        label: string;
        runIds: Array<string>;
        methodRef: { id: string; version: string } | null;
        canonicalValue: null;
        unit: string;
        unitIdentity: {
          kind:
            | 'model_view_reference_unit'
            | 'flow_reference_unit'
            | 'lcia_method_quantity'
            | 'dimensionless';
          flow: { id: string; version: string } | null;
          method: { id: string; version: string } | null;
          support: Array<{ id: string; version: string }>;
          view: { instanceId: string; exchangeId: string } | null;
        };
        coverage: 'unknown';
        scope:
          | 'declared_model_activity'
          | 'declared_inventory'
          | 'characterized_subtotal'
          | 'characterized_inventory_term'
          | 'numeric_delta_of_characterized_subtotals'
          | 'delta_divided_by_absolute_baseline';
        reasonCodes: Array<string>;
        subject: {
          view: { instanceId: string; exchangeId: string } | null;
          inventory: {
            flow: { id: string; version: string };
            direction: 'Input' | 'Output';
            unit: string;
          } | null;
        };
      }
  >;
  coverage: Array<{
    runId: string;
    gaps: Array<{ method: { id: string; version: string }; inventoryIndex: number }>;
    qualityFindings: Array<string>;
    completeLciaScores: boolean;
  }>;
  scenarioEvidence: Array<{
    runId: string;
    scenarioRevisionId: string;
    contentHash: string;
    overrides: Array<{ path: string; value: string }>;
  }>;
  hotspots: Array<{
    runId: string;
    methodRef: { id: string; version: string };
    coverage: 'complete' | 'partial' | 'unknown';
    ordering: 'absolute_characterized_contribution_desc_then_fact_id';
    factIds: Array<string>;
  }>;
  businessPilotQualified: false;
  scientificRankingQualified: false;
};
