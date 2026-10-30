import { readFileSync } from 'node:fs';

type Schema = {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  $ref?: string;
  anyOf?: Schema[];
  properties?: Record<string, Schema>;
};

const document = JSON.parse(readFileSync('docs/openapi.json', 'utf8')) as {
  components: { schemas: Record<string, Schema> };
};

const ENUM_LIKE = new Set([
  'status',
  'fromStatus',
  'toStatus',
  'channel',
  'provider',
  'actorType',
  'method',
  'role',
]);

const isConstrained = (schema: Schema): boolean =>
  schema.$ref !== undefined ||
  schema.enum !== undefined ||
  schema.const !== undefined ||
  (schema.anyOf?.every(isConstrainedOrNull) ?? false);

const isConstrainedOrNull = (schema: Schema): boolean =>
  schema.type === 'null' || isConstrained(schema);

describe('docs/openapi.json', () => {
  it('constrains every field that holds one of a fixed set of values', () => {
    const loose: string[] = [];
    for (const [name, schema] of Object.entries(document.components.schemas)) {
      for (const [field, property] of Object.entries(schema.properties ?? {})) {
        if (!ENUM_LIKE.has(field)) continue;
        if (property.type === 'number') continue;
        if (!isConstrained(property)) loose.push(`${name}.${field}`);
      }
    }

    expect(loose).toEqual([]);
  });

  it('types an order summary with the order enums', () => {
    const summary = document.components.schemas.OrderSummary.properties ?? {};

    expect(summary.status.$ref).toBe('#/components/schemas/OrderStatus');
    expect(summary.channel.$ref).toBe('#/components/schemas/OrderChannel');
  });
});
