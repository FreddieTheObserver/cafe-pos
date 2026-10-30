import { z } from 'zod';
import { API_PREFIX } from '../bootstrap';
import {
  KEY_PATTERN,
  MAX_LENGTH,
  MIN_LENGTH,
} from '../orders/idempotency/idempotency-key';
import type { ReturnRef } from './response-types';
import type { Dto, RouteInfo } from './scan-routes';
import type { JsonSchema } from './type-schemas';

type Body = { name: string; array: boolean } | null;

// Handlers that write the response themselves or read the raw request, so the
// declared return type and decorators cannot say what goes in or comes back.
const OVERRIDES: Record<
  string,
  { responses: Record<number, Body>; headers?: string[] }
> = {
  'MenuController.get': {
    responses: { 200: { name: 'Menu', array: false }, 304: null },
    headers: ['if-none-match'],
  },
  'HealthController.readiness': {
    responses: {
      200: { name: 'Readiness', array: false },
      503: { name: 'Readiness', array: false },
    },
  },
};

const HEADERS: Record<
  string,
  { required: boolean; validated: boolean; schema: JsonSchema }
> = {
  'idempotency-key': {
    required: false,
    validated: true,
    schema: {
      type: 'string',
      minLength: MIN_LENGTH,
      maxLength: MAX_LENGTH,
      pattern: KEY_PATTERN.source,
    },
  },
  'stripe-signature': {
    required: true,
    validated: false,
    schema: { type: 'string' },
  },
  'if-none-match': {
    required: false,
    validated: false,
    schema: { type: 'string' },
  },
};

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  304: 'Not Modified',
  503: 'Service Unavailable',
};

const ERROR_RESPONSES = {
  Unauthorized: [401, 'Missing, malformed, expired or revoked credentials.'],
  Forbidden: [403, 'The caller is authenticated but its role may not do this.'],
  ValidationFailed: [422, 'The request failed validation; see `errors`.'],
  RateLimited: [429, 'Too many requests.'],
} as const;

export interface DocumentInput {
  routes: RouteInfo[];
  returnTypes: ReadonlyMap<string, ReturnRef>;
  typeSchemas: Record<string, JsonSchema>;
  version: string;
}

export function responsesOf(
  route: RouteInfo,
  returnTypes: ReadonlyMap<string, ReturnRef>,
): Record<number, Body> {
  const key = `${route.controller}.${route.handler}`;
  const override = OVERRIDES[key];
  if (override) return override.responses;

  const ref = returnTypes.get(key) ?? { kind: 'missing' as const };
  switch (ref.kind) {
    case 'none':
      return { [route.successStatus]: null };
    case 'type':
      return {
        [route.successStatus]: { name: ref.name, array: ref.array },
      };
    case 'unnamed':
      throw new Error(
        `${key} returns \`${ref.text}\`. Give that type an exported name so the API contract can reference it.`,
      );
    case 'missing':
      throw new Error(
        `${key} declares no return type. Annotate it with an exported type so the API contract can reference it.`,
      );
  }
}

export function responseTypeNames(
  routes: RouteInfo[],
  returnTypes: ReadonlyMap<string, ReturnRef>,
): string[] {
  const names = new Set(['ProblemDetails']);
  for (const route of routes) {
    for (const body of Object.values(responsesOf(route, returnTypes))) {
      if (body) names.add(body.name);
    }
  }
  return [...names].sort();
}

export function buildDocument(input: DocumentInput) {
  const schemas: Record<string, JsonSchema> = {};
  for (const [name, schema] of Object.entries(input.typeSchemas)) {
    schemas[name] = retarget(schema);
  }

  const paths: Record<string, Record<string, unknown>> = {};
  const operationIds = new Set<string>();

  for (const route of input.routes) {
    const operationId = `${lowerFirst(route.controller.replace(/Controller$/, ''))}_${route.handler}`;
    if (operationIds.has(operationId)) {
      throw new Error(`Two routes share the operationId ${operationId}.`);
    }
    operationIds.add(operationId);

    if (route.body) schemas[route.body.name] = requestSchema(route.body);

    (paths[route.path] ??= {})[route.method] = operationOf(
      route,
      operationId,
      responsesOf(route, input.returnTypes),
    );
  }

  const tags = [...new Set(input.routes.map(tagOf))].sort();
  return {
    openapi: '3.1.0',
    info: {
      title: 'CafePOS API',
      version: input.version,
      description:
        'Generated from the code by `pnpm openapi`; do not edit by hand. Prose, error codes and recipes live in docs/api.md.',
    },
    tags: tags.map((name) => ({ name })),
    paths: sortKeys(paths),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'A staff access token or a kiosk device token.',
        },
      },
      responses: Object.fromEntries(
        Object.entries(ERROR_RESPONSES).map(([name, [, description]]) => [
          name,
          {
            description,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ProblemDetails' },
              },
            },
          },
        ]),
      ),
      schemas: sortKeys(schemas),
    },
  };
}

function operationOf(
  route: RouteInfo,
  operationId: string,
  bodies: Record<number, Body>,
) {
  const responses: Record<string, unknown> = {};
  for (const [status, body] of Object.entries(bodies)) {
    const description = STATUS_TEXT[Number(status)] ?? `Status ${status}`;
    if (body === null) {
      responses[status] = { description };
      continue;
    }
    const ref = { $ref: `#/components/schemas/${body.name}` };
    responses[status] = {
      description,
      content: {
        'application/json': {
          schema: body.array ? { type: 'array', items: ref } : ref,
        },
      },
    };
  }

  const isPublic = route.roles === 'public';
  const headers = headersOf(route);
  const hasInput =
    route.body ||
    route.query ||
    route.params ||
    headers.some((name) => HEADERS[name]?.validated);
  const errors: (keyof typeof ERROR_RESPONSES)[] = [
    ...(isPublic ? [] : (['Unauthorized', 'Forbidden'] as const)),
    ...(hasInput ? (['ValidationFailed'] as const) : []),
    ...(route.path.startsWith(`/${API_PREFIX}/`)
      ? (['RateLimited'] as const)
      : []),
  ];
  for (const name of errors) {
    responses[ERROR_RESPONSES[name][0]] = {
      $ref: `#/components/responses/${name}`,
    };
  }

  const parameters = parametersOf(route, headers);
  return {
    operationId,
    tags: [tagOf(route)],
    ...(isPublic ? {} : { 'x-roles': route.roles }),
    security: isPublic ? [] : [{ bearerAuth: [] }],
    ...(parameters.length > 0 ? { parameters } : {}),
    ...requestBodyOf(route),
    responses: sortKeys(responses),
  };
}

function requestBodyOf(route: RouteInfo) {
  if (route.upload) {
    return {
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              required: ['file'],
              properties: { file: { type: 'string', format: 'binary' } },
            },
          },
        },
      },
    };
  }
  if (!route.body) return {};
  return {
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: { $ref: `#/components/schemas/${route.body.name}` },
        },
      },
    },
  };
}

function headersOf(route: RouteInfo): string[] {
  const key = `${route.controller}.${route.handler}`;
  return [...route.headers, ...(OVERRIDES[key]?.headers ?? [])];
}

function parametersOf(route: RouteInfo, headers: string[]): unknown[] {
  const params = route.params ? objectProperties(route.params) : undefined;
  const templated = [...route.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);

  for (const name of Object.keys(params?.properties ?? {})) {
    if (!templated.includes(name)) {
      throw new Error(
        `${route.controller}.${route.handler}: ${route.params?.name} declares \`${name}\`, which is not in ${route.path}.`,
      );
    }
  }

  const fromPath = templated.map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: params?.properties[name] ?? { type: 'string' },
  }));

  const query = route.query ? objectProperties(route.query) : undefined;
  const fromQuery = Object.entries(query?.properties ?? {}).map(
    ([name, schema]) => ({
      name,
      in: 'query',
      required: query?.required.includes(name) ?? false,
      schema,
    }),
  );

  const fromHeaders = headers.map((name) => {
    const header = HEADERS[name];
    if (!header) {
      throw new Error(
        `${route.controller}.${route.handler} reads the ${name} header; describe it in HEADERS in build-document.ts.`,
      );
    }
    return {
      name: name.replace(
        /(^|-)([a-z])/g,
        (_, dash: string, c: string) => dash + c.toUpperCase(),
      ),
      in: 'header',
      required: header.required,
      schema: header.schema,
    };
  });

  return [...fromPath, ...fromQuery, ...fromHeaders];
}

function requestSchema(dto: Dto): JsonSchema {
  const { $schema, ...schema } = z.toJSONSchema(dto.schema, {
    io: 'input',
    unrepresentable: 'any',
  }) as JsonSchema;
  void $schema;
  if ('$defs' in schema) {
    throw new Error(`${dto.name} produced shared definitions; inline them.`);
  }
  return schema;
}

function objectProperties(dto: Dto): {
  properties: Record<string, JsonSchema>;
  required: string[];
} {
  const schema = requestSchema(dto);
  if (schema.type !== 'object') {
    throw new Error(`${dto.name} must be an object to describe parameters.`);
  }
  return {
    properties: (schema.properties ?? {}) as Record<string, JsonSchema>,
    required: (schema.required ?? []) as string[],
  };
}

const retarget = (schema: JsonSchema): JsonSchema =>
  JSON.parse(
    JSON.stringify(schema).replaceAll(
      '#/definitions/',
      '#/components/schemas/',
    ),
  ) as JsonSchema;

function tagOf(route: RouteInfo): string {
  const prefix = `/${API_PREFIX}/`;
  if (!route.path.startsWith(prefix)) return 'health';
  return route.path.slice(prefix.length).split('/')[0];
}

const lowerFirst = (value: string): string =>
  value.charAt(0).toLowerCase() + value.slice(1);

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
  );
}
