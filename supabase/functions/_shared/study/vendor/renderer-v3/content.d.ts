import type { ReportViewModel } from './viewModel.js';
export declare function escapeHtml(value: string): string;
/** Evidence is generated escaped markup, repeated outside native details for non-JS printing. */
export declare function evidenceDisclosure(title: string, escapedEvidence: string): string;
/** Internal presentation shared by the frozen exporter and Platform online preview. */
export declare function renderReportContent(view: ReportViewModel): string;
