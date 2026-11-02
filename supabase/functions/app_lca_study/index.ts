import '@supabase/functions-js/edge-runtime.d.ts';
import { createStudyHandler } from '../_shared/study/handler.ts';

export const handleStudy = createStudyHandler();
if (import.meta.main) Deno.serve(handleStudy);
