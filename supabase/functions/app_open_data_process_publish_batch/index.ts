import '@supabase/functions-js/edge-runtime.d.ts';

import {
  createCommandHandler,
  type CommandHandlerOptions,
} from '../_shared/command_runtime/command.ts';
import {
  executeOpenDataProcessPublish,
  type OpenDataProcessPublishRequest,
  parseOpenDataProcessPublishRequest,
} from '../_shared/commands/open_data/process_publish.ts';

export function createAppOpenDataProcessPublishBatchHandler(
  overrides: Partial<CommandHandlerOptions<OpenDataProcessPublishRequest>> = {},
) {
  return createCommandHandler<OpenDataProcessPublishRequest>({
    parse: parseOpenDataProcessPublishRequest,
    execute: executeOpenDataProcessPublish,
    ...overrides,
  });
}

export const handleAppOpenDataProcessPublishBatch = createAppOpenDataProcessPublishBatchHandler();

if (import.meta.main) {
  Deno.serve(handleAppOpenDataProcessPublishBatch);
}
