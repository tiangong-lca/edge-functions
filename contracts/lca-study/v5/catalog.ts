import { z } from 'zod';
import { artifactRefSchema, hashSchema, text, datasetVersionSchema } from '../v1/common.ts';
import { decimalSchema } from '../v3/report.ts';
import { uuidSchema } from './advanced.ts';
const ref = z.object({ id: text(128), version: datasetVersionSchema }).strict();
export const parameterSchema = z
  .object({
    path: text(256).regex(/^\/instances\/[^/]+\/exchanges\/[^/]+\/amount$/u),
    flow: ref,
    direction: z.enum(['Input', 'Output']),
    unit: text(256),
    support: z.array(ref).max(512),
    baselineAmount: decimalSchema,
  })
  .strict();
export const parameterCatalogSchema = z
  .object({
    type: z.literal('parameterCatalog'),
    studyId: uuidSchema,
    baselineRunId: uuidSchema,
    preparedArtifactRef: artifactRefSchema.extend({
      type: z.literal('modelInput'),
      mediaType: z.literal('application/json'),
      schemaVersion: z.literal('lca.study-prepared-input.v1'),
    }),
    inputHash: hashSchema,
    parameters: z.array(parameterSchema).max(4096),
  })
  .strict()
  .refine(
    (v) => new Set(v.parameters.map((p) => p.path)).size === v.parameters.length,
    'unique parameter paths required',
  );
