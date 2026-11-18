import '@supabase/functions-js/edge-runtime.d.ts';

import {
  type CommandHandlerOptions,
  createCommandHandler,
} from '../_shared/command_runtime/command.ts';
import {
  executeSubmitReviewCommand,
  parseSubmitReviewCommand,
} from '../_shared/commands/dataset/submit_review.ts';
import type { SubmitReviewRequest } from '../_shared/commands/dataset/types.ts';

export function createAppDatasetSubmitReviewHandler(
  overrides: Partial<CommandHandlerOptions<SubmitReviewRequest>> = {},
) {
  return (request: Request) =>
    createCommandHandler<SubmitReviewRequest>({
      parse: (body) =>
        parseSubmitReviewCommand(body, request.headers.get('X-Review-Operation-Key')),
      execute: executeSubmitReviewCommand,
      ...overrides,
    })(request);
}

export const handleAppDatasetSubmitReview = createAppDatasetSubmitReviewHandler();

if (import.meta.main) {
  Deno.serve(handleAppDatasetSubmitReview);
}
