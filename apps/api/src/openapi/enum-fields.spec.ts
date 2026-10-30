import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CatalogErrorCode } from '../catalog/errors/catalog.errors';
import { ErrorCode } from '../common/errors/error-codes';
import { IdentityErrorCode } from '../identity/errors/identity.errors';
import { OrderErrorCode } from '../orders/errors/orders.errors';
import { PaymentErrorCode } from '../payments/errors/payments.errors';
import { DOCS_DIR } from './repo-paths';

type Schema = {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  $ref?: string;
  anyOf?: Schema[];
  properties?: Record<string, Schema>;
};

const document = JSON.parse(
  readFileSync(join(DOCS_DIR, 'openapi.json'), 'utf8'),
) as {
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
  'code',
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

  it('types an error response with every code the API can raise', () => {
    const { schemas } = document.components;
    const raised = [
      ErrorCode,
      CatalogErrorCode,
      IdentityErrorCode,
      OrderErrorCode,
      PaymentErrorCode,
    ].flatMap((codes) => Object.values(codes));

    expect(schemas.ProblemDetails.properties?.code.$ref).toBe(
      '#/components/schemas/ApiErrorCode',
    );
    expect([...(schemas.ApiErrorCode.enum ?? [])].sort()).toEqual(
      [...new Set(raised)].sort(),
    );
  });
});
