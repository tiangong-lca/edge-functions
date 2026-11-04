import { reportViewSchema, type ReportView } from '../../../../contracts/lca-study/v6/view.ts';
import { renderReport } from './vendor/renderer-v3/index.js';
// RenderContext is the unchanged three-field presentation protocol. Reuse its
// retained declaration: Deno2.1.4 does not auto-associate new .mjs/.d.mts types.
import type { RenderContext } from './vendor/renderer-v2/viewModel.d.ts';
import consumption from './vendor/renderer-v3/consumption.json' with { type: 'json' };
export type { RenderContext };
export interface MethodRenderer {
  artifactHash: string;
  qualifiedSource: boolean;
  validate(value: unknown): ReportView;
  render(value: unknown, context: RenderContext): Promise<string>;
}
/** Source candidate identity only. Hosted/installed/scientific qualification is separate. */
export const bundledMethodRenderer: MethodRenderer = {
  artifactHash: consumption.archiveSha256,
  qualifiedSource: consumption.sourceDirty === false,
  validate: (value) => reportViewSchema.parse(value),
  render: renderReport,
};
