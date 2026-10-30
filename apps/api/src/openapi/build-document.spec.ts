import { Controller, Get, Headers, Module } from '@nestjs/common';
import { Roles } from '../identity/decorators/roles.decorator';
import { buildDocument, responseTypeNames } from './build-document';
import { refOf, type ReturnRef } from './response-types';
import { scanRoutes } from './scan-routes';
import { WidgetsModule } from './widgets.fixture';

const RETURNS = new Map<string, ReturnRef>([
  ['WidgetsController.create', refOf('Promise<Widget>')],
  ['WidgetsController.list', refOf('Promise<Widget[]>')],
  ['WidgetsController.one', refOf('Promise<Widget>')],
  ['WidgetsController.remove', refOf('Promise<void>')],
  ['WidgetsController.upload', refOf('Promise<Widget>')],
  ['ProbeController.live', refOf('Liveness')],
]);

const TYPE_SCHEMAS = {
  Widget: {
    type: 'object',
    properties: { part: { $ref: '#/definitions/Part' } },
  },
  Part: { type: 'string' },
  Liveness: { type: 'object' },
  ProblemDetails: { type: 'object' },
};

type Operation = {
  operationId: string;
  tags: string[];
  security: unknown[];
  'x-roles'?: string[];
  parameters?: {
    name: string;
    in: string;
    required: boolean;
    schema: Record<string, unknown>;
  }[];
  requestBody?: {
    content: Record<string, { schema: Record<string, unknown> }>;
  };
  responses: Record<string, unknown>;
};

async function build(returns = RETURNS) {
  return buildDocument({
    routes: await scanRoutes(WidgetsModule),
    returnTypes: returns,
    typeSchemas: TYPE_SCHEMAS,
    version: '1.2.3',
  });
}

const operation = (
  doc: Awaited<ReturnType<typeof build>>,
  path: string,
  method: string,
) => (doc.paths[path] as Record<string, Operation>)[method];

describe('buildDocument', () => {
  it('describes the API as OpenAPI 3.1 with a bearer scheme', async () => {
    const doc = await build();

    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.version).toBe('1.2.3');
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    expect(doc.tags).toEqual([{ name: 'health' }, { name: 'widgets' }]);
  });

  it('gates a route by role and opens a public one', async () => {
    const doc = await build();

    const create = operation(doc, '/api/v1/widgets', 'post');
    expect(create.operationId).toBe('widgets_create');
    expect(create.security).toEqual([{ bearerAuth: [] }]);
    expect(create['x-roles']).toEqual(['ADMIN', 'MANAGER']);

    const live = operation(doc, '/healthz', 'get');
    expect(live.security).toEqual([]);
    expect(live['x-roles']).toBeUndefined();
  });

  it('adds only the error responses that can happen', async () => {
    const doc = await build();
    const statuses = (path: string, method: string) =>
      Object.keys(operation(doc, path, method).responses);

    expect(statuses('/api/v1/widgets', 'post')).toEqual(
      expect.arrayContaining(['201', '401', '403', '422', '429']),
    );
    expect(statuses('/api/v1/widgets/{id}', 'delete')).toEqual([
      '204',
      '401',
      '403',
      '422',
      '429',
    ]);
    // A probe is public, takes no input and is not rate limited.
    expect(statuses('/healthz', 'get')).toEqual(['200']);
  });

  it('describes the success body, an array, and no content', async () => {
    const doc = await build();
    const body = (path: string, method: string, status: string) =>
      (
        operation(doc, path, method).responses[status] as {
          content?: Record<string, { schema: unknown }>;
        }
      ).content?.['application/json']?.schema;

    expect(body('/api/v1/widgets/{id}', 'get', '200')).toEqual({
      $ref: '#/components/schemas/Widget',
    });
    expect(body('/api/v1/widgets', 'get', '200')).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/Widget' },
    });
    expect(body('/api/v1/widgets/{id}', 'delete', '204')).toBeUndefined();
  });

  it('takes path and query parameters from the DTOs and headers from the handler', async () => {
    const doc = await build();

    const one = operation(doc, '/api/v1/widgets/{id}', 'get').parameters;
    expect(one).toEqual([
      expect.objectContaining({ name: 'id', in: 'path', required: true }),
    ]);
    expect(one?.[0].schema).toMatchObject({ type: 'string', format: 'uuid' });

    const list = operation(doc, '/api/v1/widgets', 'get').parameters;
    expect(list?.map((p) => [p.name, p.in, p.required])).toEqual([
      ['q', 'query', false],
      ['limit', 'query', true],
    ]);

    const create = operation(doc, '/api/v1/widgets', 'post').parameters;
    expect(create).toEqual([
      expect.objectContaining({
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
      }),
    ]);
  });

  it('registers each request body schema and references it', async () => {
    const doc = await build();

    expect(doc.components.schemas.CreateWidgetDto).toMatchObject({
      type: 'object',
      required: ['name'],
    });
    expect(
      operation(doc, '/api/v1/widgets', 'post').requestBody?.content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/CreateWidgetDto' });
    expect(
      Object.keys(
        operation(doc, '/api/v1/widgets/{id}/image', 'post').requestBody
          ?.content ?? {},
      ),
    ).toEqual(['multipart/form-data']);
  });

  it('points type schemas at components, wherever they were generated', async () => {
    const doc = await build();

    expect(doc.components.schemas.Widget).toEqual({
      type: 'object',
      properties: { part: { $ref: '#/components/schemas/Part' } },
    });
  });

  it('names every type a response needs, plus the error envelope', async () => {
    const names = responseTypeNames(await scanRoutes(WidgetsModule), RETURNS);

    expect(names).toEqual(['Liveness', 'ProblemDetails', 'Widget']);
  });

  it('refuses a return type the contract cannot name', async () => {
    const returns = new Map(RETURNS).set(
      'WidgetsController.create',
      refOf('Promise<{ id: string }>'),
    );

    await expect(build(returns)).rejects.toThrow(
      /WidgetsController\.create returns `\{ id: string \}`/,
    );
  });

  it('refuses a method that declares no return type', async () => {
    const returns = new Map(RETURNS);
    returns.delete('WidgetsController.one');

    await expect(build(returns)).rejects.toThrow(
      /WidgetsController\.one declares no return type/,
    );
  });

  it('refuses a header it has no description for', async () => {
    @Controller('odd')
    class OddController {
      @Roles('ADMIN')
      @Get()
      read(@Headers('x-mystery') mystery?: string) {
        return mystery;
      }
    }
    @Module({ controllers: [OddController] })
    class OddModule {}

    const input = {
      routes: await scanRoutes(OddModule),
      returnTypes: new Map([['OddController.read', refOf('Widget')]]),
      typeSchemas: TYPE_SCHEMAS,
      version: '1',
    };

    expect(() => buildDocument(input)).toThrow(/reads the x-mystery header/);
  });
});
