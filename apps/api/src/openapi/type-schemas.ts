import { isDeepStrictEqual } from 'node:util';
import { createGenerator } from 'ts-json-schema-generator';

export type JsonSchema = Record<string, unknown>;

/**
 * JSON Schema for each named exported type, plus everything it references.
 * One generator serves every name: building its program is the slow part.
 */
export function generateTypeSchemas(
  names: Iterable<string>,
  options: { path: string; tsconfig: string },
): Record<string, JsonSchema> {
  const generator = createGenerator({
    ...options,
    skipTypeCheck: true,
    expose: 'export',
    topRef: true,
    // A client must tolerate fields added later, so responses stay open.
    additionalProperties: true,
    jsDoc: 'none',
    sortProps: true,
  });

  const definitions: Record<string, JsonSchema> = {};
  for (const name of [...new Set(names)].sort()) {
    const schema = generator.createSchema(name);
    for (const [key, value] of Object.entries(schema.definitions ?? {})) {
      if (key in definitions && !isDeepStrictEqual(definitions[key], value)) {
        throw new Error(
          `Two different exported types are both called ${key}; rename one so the API contract can name it.`,
        );
      }
      definitions[key] = value as JsonSchema;
    }
  }
  return definitions;
}
