import { methodViewSchema } from './view_schema.ts';
import { validateReportView } from '../../../supabase/functions/_shared/study/vendor/renderer-v3/viewModel.js';
/** Exact independent Platform presentation validator plus method-owned identity. */
export const reportViewSchema = methodViewSchema.superRefine((value, ctx) => {
  try {
    validateReportView(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'exact Platform method view3 required' });
  }
});
export type { MethodReportView as ReportView } from './view_schema.ts';
