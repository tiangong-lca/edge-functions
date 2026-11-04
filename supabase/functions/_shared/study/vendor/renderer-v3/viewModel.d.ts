import type { MethodReportSummary } from './methodProtocol.mjs';
export type { MethodReportSummary } from './methodProtocol.mjs';
export declare const VIEW_SCHEMA: 'lca.study-report-view.v3';
export declare const RENDERER_VERSION: '3.0.0';
export type MethodRef = {
    id: string;
    version: string;
};
export type CalculationContractRef = {
    kind: 'calculation_contract';
    schema: 'lca.calculation-contract.v1';
    sha256: string;
};
export type ReportFact = {
    factId: string;
    label: string;
    runIds: string[];
    methodRef: MethodRef | null;
    canonicalValue: string | null;
    unit: string;
    coverage: 'complete' | 'partial' | 'unknown';
    reasonCodes: string[];
    provenance: {
        type: 'runResult' | 'analysisFacts';
        id: string;
        contentHash: string;
    } | {
        type: 'methodAssessmentFacts';
        id: string;
        contentHash: string;
        sourceFactId: string;
    };
};
export type ReportViewModel = {
    report: {
        studyId: string;
        reportRevisionId: string;
        contentHash: string;
        title: string;
        generatedAt: string;
    };
    definition: {
        goal: string;
        functionalUnit: {
            amount: string;
            unit: string;
            referenceFlowId: string;
        };
        boundary: string;
        methodRefs: (MethodRef & {
            name: string;
            unit: string;
        })[];
    };
    runs: {
        runId: string;
        scenarioRevisionId: string;
        label: string;
        inputHash: string;
        profileId: string;
        calculationContractRef: CalculationContractRef;
    }[];
    sections: {
        sectionId: string;
        title: string;
        paragraphs: string[];
        factIds: string[];
        citationIds: string[];
    }[];
    tables: {
        tableId: string;
        title: string;
        factIds: string[];
    }[];
    charts: {
        chartId: string;
        title: string;
        factIds: string[];
    }[];
    citations: {
        citationId: string;
        label: string;
        sourceType: 'datasetRevision' | 'releaseFinalResult' | 'document';
        identity: string;
        version: string;
        contentHash: string | null;
    }[];
    assumptions: string[];
    cutoffs: string[];
    limitations: string[];
    snapshot: {
        validity: 'current' | 'superseded' | 'withdrawn' | 'unknown';
        checkedAt: string;
        review: 'unreviewed' | 'reviewed';
        reviewIds: string[];
        finalization: 'not_finalized' | 'finalized';
    };
} & {
    schemaVersion: typeof VIEW_SCHEMA;
    rendererVersion: typeof RENDERER_VERSION;
    facts: ReportFact[];
    methodAssessment: MethodReportSummary;
};
/** Separate from projection bytes; no embedded key, signature or trust assertion is accepted. */
export type RenderContext = {
    exportId: string;
    projectionHash: string;
    verificationAtGeneration: 'unverified' | 'verified_by_trusted_exporter';
};
export declare class ReportViewError extends Error {
    readonly path: string;
    constructor(path: string);
}
/** A bounded decimal spelling, never converted through Number for validation or display. */
export declare function isCanonicalDecimal(value: unknown): value is string;
export declare function validateReportView(input: unknown, expectedRendererVersion?: string): ReportViewModel;
export declare function validateRenderContext(input: unknown): RenderContext;
