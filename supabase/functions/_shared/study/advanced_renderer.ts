import type { ReportView } from '../../../../contracts/lca-study/v5/view.ts';
import { reportViewSchema } from '../../../../contracts/lca-study/v5/view.ts';
import { renderReport } from './vendor/renderer-v2/index.js';
import consumption from './vendor/renderer-v2/consumption.json' with { type: 'json' };
import type { RenderContext } from './vendor/renderer-v2/viewModel.d.ts';
export type { RenderContext };
export interface AdvancedRenderer {
  artifactHash: string;
  qualifiedSource: boolean;
  validate(value: unknown): ReportView;
  render(value: unknown, context: RenderContext): Promise<string>;
}
/** Exact independently built Platform artifact. Deployment admission and integrated qualification remain separate. */
export const bundledAdvancedRenderer: AdvancedRenderer = {
  artifactHash: consumption.archiveSha256,
  qualifiedSource: !consumption.sourceDirty,
  validate: (value) => reportViewSchema.parse(value),
  render: renderReport,
};
