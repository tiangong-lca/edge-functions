import facts from '../worker/method/study-method-assessment-facts.v1.schema.json' with { type: 'json' };
import config from '../worker/method/study-method-assessment-config.v1.schema.json' with { type: 'json' };
import input from '../worker/method/study-method-assessment-input.v1.schema.json' with { type: 'json' };
import record from '../worker/method/study-method-assessment-record.v1.schema.json' with { type: 'json' };
import evidence from '../worker/method/study-method-evidence.v1.schema.json' with { type: 'json' };
import evidenceRecord from '../worker/method/study-method-evidence-record.v1.schema.json' with { type: 'json' };
import fact from '../worker/method/study-method-fact-catalog-entry.v1.schema.json' with { type: 'json' };
import jobContext from '../worker/method/study-method-job-context.v1.schema.json' with { type: 'json' };

export type JsonSchema = Record<string, unknown>;
const owners: Readonly<Record<string, unknown>> = Object.freeze({
  'study-method-assessment-facts.v1.schema.json': facts,
  'study-method-assessment-config.v1.schema.json': config,
  'study-method-assessment-input.v1.schema.json': input,
  'study-method-assessment-record.v1.schema.json': record,
  'study-method-evidence.v1.schema.json': evidence,
  'study-method-evidence-record.v1.schema.json': evidenceRecord,
  'study-method-fact-catalog-entry.v1.schema.json': fact,
  'study-method-job-context.v1.schema.json': jobContext,
});
const object = (v: unknown): v is JsonSchema =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Resolve only the fixed contained owner documents. No owner bytes are rewritten. */
export function resolveOwnerSchema(name: string, pointer = ''): JsonSchema {
  const locate = (document: string, fragment: string): unknown => {
    if (!Object.hasOwn(owners, document)) throw new Error('method_schema_external_reference');
    if (fragment && !fragment.startsWith('/')) throw new Error('method_schema_reference');
    let value = owners[document];
    for (const part of fragment.split('/').slice(1)) {
      const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
      if (!object(value) || !Object.hasOwn(value, key)) throw new Error('method_schema_reference');
      value = value[key];
    }
    return value;
  };
  const expand = (raw: unknown, document: string, active: Set<string>, depth: number): unknown => {
    if (depth > 96) throw new Error('method_schema_depth');
    if (typeof raw === 'boolean') return raw;
    if (!object(raw)) throw new Error('method_schema_structure');
    // Installed Zod maps JSON Schema const directly to z.literal(), whose
    // object comparison is identity-based. JSON Schema const is deep equality.
    // Frozen owner13a has one object constant; express its exact same closed
    // properties structurally in this derived view, never in owned files.
    if (object(raw.const)) {
      const literal = (value: unknown): JsonSchema => {
        if (object(value))
          return {
            type: 'object',
            additionalProperties: false,
            required: Object.keys(value),
            properties: Object.fromEntries(
              Object.entries(value).map(([key, value]) => [key, literal(value)]),
            ),
          };
        if (Array.isArray(value)) throw new Error('method_schema_array_constant_unsupported');
        return { const: value };
      };
      const siblings = { ...raw };
      delete siblings.const;
      const value = literal(raw.const);
      return expand(
        Object.keys(siblings).length ? { allOf: [siblings, value] } : value,
        document,
        active,
        depth + 1,
      );
    }
    if (Array.isArray(raw.const)) throw new Error('method_schema_array_constant_unsupported');
    if (typeof raw.$ref === 'string') {
      const parts = raw.$ref.split('#');
      if (parts.length > 2) throw new Error('method_schema_reference');
      const nextDocument = parts[0] || document;
      const fragment = parts[1] ?? '';
      const key = `${nextDocument}#${fragment}`;
      if (active.has(key)) throw new Error('method_schema_cycle');
      const nextActive = new Set(active).add(key);
      const resolved = expand(locate(nextDocument, fragment), nextDocument, nextActive, depth + 1);
      // Frozen wrapper refs contain annotations only. A validation sibling must
      // be interpreted explicitly rather than silently merged/overwritten.
      if (
        Object.keys(raw).some(
          (key) => !['$ref', '$schema', '$id', '$comment', 'description', '$defs'].includes(key),
        )
      )
        throw new Error('method_schema_reference_sibling');
      if (!object(resolved)) return resolved;
      return {
        ...resolved,
        ...Object.fromEntries(
          Object.entries(raw).filter(([key]) =>
            ['$schema', '$id', '$comment', 'description'].includes(key),
          ),
        ),
      };
    }
    const result = structuredClone(raw);
    delete result.$defs;
    delete result.definitions;
    for (const key of ['properties', 'patternProperties', 'dependentSchemas']) {
      if (!object(raw[key])) continue;
      result[key] = Object.fromEntries(
        Object.entries(raw[key]).map(([key, schema]) => [
          key,
          expand(schema, document, active, depth + 1),
        ]),
      );
    }
    for (const key of [
      'items',
      'additionalItems',
      'additionalProperties',
      'propertyNames',
      'contains',
      'not',
      'if',
      'then',
      'else',
    ]) {
      if (raw[key] !== undefined && !Array.isArray(raw[key]))
        result[key] = expand(raw[key], document, active, depth + 1);
    }
    for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
      if (Array.isArray(raw[key]))
        result[key] = raw[key].map((schema) => {
          // Zod's converter treats an untyped pattern-only allOf branch as
          // any. Within an already-string conjunction the inherited string
          // type is equivalent JSON Schema and retains the owner's nonblank
          // predicate, including legitimate blank-location fields elsewhere.
          const inherited =
            key === 'allOf' &&
            raw.type === 'string' &&
            object(schema) &&
            schema.type === undefined &&
            typeof schema.pattern === 'string'
              ? { type: 'string', ...schema }
              : schema;
          return expand(inherited, document, active, depth + 1);
        });
    }
    return result;
  };
  const value = expand(locate(name, pointer), name, new Set([`${name}#${pointer}`]), 0);
  if (!object(value)) throw new Error('method_schema_root');
  return value;
}

/** Rust/UTF-8 owner strings cannot contain an unpaired UTF-16 surrogate. */
export function hasOnlyUnicodeScalars(value: unknown): boolean {
  if (typeof value === 'string') {
    for (const character of value)
      if (
        character.length === 1 &&
        character.charCodeAt(0) >= 0xd800 &&
        character.charCodeAt(0) <= 0xdfff
      )
        return false;
    return true;
  }
  if (Array.isArray(value)) return value.every(hasOnlyUnicodeScalars);
  if (object(value))
    return Object.entries(value).every(
      ([key, child]) => hasOnlyUnicodeScalars(key) && hasOnlyUnicodeScalars(child),
    );
  return true;
}
