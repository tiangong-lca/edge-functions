import '@supabase/functions-js/edge-runtime.d.ts';

import {
  type CommandHandlerOptions,
  createCommandHandler,
} from '../_shared/command_runtime/command.ts';
import {
  executeStableDraftRequestCommand,
  parseStableDraftCommand,
  type StableDraftRequest,
} from '../_shared/commands/dataset/stable_draft.ts';

export function createAppDatasetStableDraftRequestHandler(
  overrides: Partial<CommandHandlerOptions<StableDraftRequest>> = {},
) {
  return createCommandHandler<StableDraftRequest>({
    parse: parseStableDraftCommand,
    execute: executeStableDraftRequestCommand,
    ...overrides,
  });
}

export const handleRequest = createAppDatasetStableDraftRequestHandler();

if (import.meta.main) {
  Deno.serve(handleRequest);
}
