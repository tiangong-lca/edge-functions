import { z } from 'zod';
import { responseSchema as a, responseDataSchema as ad } from './authoring_responses.ts';
import { responseDataSchema as rd } from './review_responses.ts';
import { capabilitiesSchema } from './capabilities.ts';
// Capability shape is unified only at the public V5 boundary.
const withoutCapabilities = (schema: typeof ad | typeof rd) =>
  schema.options.filter(
    (s) =>
      !(
        'shape' in s &&
        s.shape.type instanceof z.ZodLiteral &&
        s.shape.type.value === 'capabilities'
      ),
  );
export const responseDataSchema = z.union([
  capabilitiesSchema,
  ...withoutCapabilities(ad),
  ...withoutCapabilities(rd),
]);
export const responseSchema = z.discriminatedUnion('ok', [
  a.options[0].extend({ data: responseDataSchema }),
  a.options[1],
]);
export type AdvancedResponse = z.infer<typeof responseSchema>;
