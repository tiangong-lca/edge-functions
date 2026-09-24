import '@supabase/functions-js/edge-runtime.d.ts';

import {
  type CommandHandlerOptions,
  createCommandHandler,
} from '../_shared/command_runtime/command.ts';
import {
  executeReviewerContactCommand,
  parseReviewerContactCommand,
  type ReviewerContactRequest,
} from '../_shared/commands/reviewer_contact.ts';

export function createAppReviewContactActivateHandler(
  overrides: Partial<CommandHandlerOptions<ReviewerContactRequest>> = {},
) {
  return createCommandHandler<ReviewerContactRequest>({
    parse: parseReviewerContactCommand,
    execute: executeReviewerContactCommand,
    ...overrides,
  });
}

export const handleAppReviewContactActivate = createAppReviewContactActivateHandler();

if (import.meta.main) {
  Deno.serve(handleAppReviewContactActivate);
}
