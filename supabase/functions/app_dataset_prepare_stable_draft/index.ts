import '@supabase/functions-js/edge-runtime.d.ts';

import {
  type CommandHandlerOptions,
  createCommandHandler,
} from '../_shared/command_runtime/command.ts';
import {
  executePrepareStableDraftCommand,
  parseStableDraftCommand,
  type StableDraftRequest,
} from '../_shared/commands/dataset/stable_draft.ts';

export function createAppDatasetPrepareStableDraftHandler(
  overrides: Partial<CommandHandlerOptions<StableDraftRequest>> = {},
) {
  return createCommandHandler<StableDraftRequest>({
    parse: parseStableDraftCommand,
    execute: executePrepareStableDraftCommand,
    ...overrides,
  });
}

export const handleRequest = createAppDatasetPrepareStableDraftHandler();

if (import.meta.main) {
  Deno.serve(handleRequest);
}
