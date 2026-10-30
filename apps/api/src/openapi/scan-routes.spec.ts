import {
  Body,
  Controller,
  forwardRef,
  Get,
  Module,
  Post,
  type DynamicModule,
} from '@nestjs/common';
import { Roles } from '../identity/decorators/roles.decorator';
import { scanRoutes } from './scan-routes';
import {
  ProbeController,
  WidgetsController,
  WidgetsModule,
} from './widgets.fixture';

describe('scanRoutes', () => {
  const find = async (method: string, path: string) =>
    (await scanRoutes(WidgetsModule)).find(
      (route) => route.method === method && route.path === path,
    );

  it('prefixes routes, templates path parameters and defaults the success status', async () => {
    const routes = await scanRoutes(WidgetsModule);

    expect(
      routes.map((r) => `${r.method} ${r.path} ${r.successStatus}`),
    ).toEqual([
      'get /api/v1/widgets 200',
      'post /api/v1/widgets 201',
      'delete /api/v1/widgets/{id} 204',
      'get /api/v1/widgets/{id} 200',
      'post /api/v1/widgets/{id}/image 201',
      'get /healthz 200',
    ]);
  });

  it('keeps the platform probes off the prefix', async () => {
    expect((await find('get', '/healthz'))?.controller).toBe(
      ProbeController.name,
    );
  });

  it('reads the declared roles, and marks a public route', async () => {
    expect((await find('post', '/api/v1/widgets'))?.roles).toEqual([
      'ADMIN',
      'MANAGER',
    ]);
    expect((await find('get', '/healthz'))?.roles).toBe('public');
  });

  it('finds the DTOs, the headers read and a file upload', async () => {
    const create = await find('post', '/api/v1/widgets');
    expect(create?.body?.name).toBe('CreateWidgetDto');
    expect(create?.headers).toEqual(['idempotency-key']);

    expect((await find('get', '/api/v1/widgets'))?.query?.name).toBe(
      'WidgetQueryDto',
    );
    expect((await find('get', '/api/v1/widgets/{id}'))?.params?.name).toBe(
      'WidgetIdDto',
    );
    expect((await find('post', '/api/v1/widgets/{id}/image'))?.upload).toBe(
      true,
    );
    expect(create?.upload).toBe(false);
  });

  it('follows imports, forward references and asynchronous modules', async () => {
    @Module({ controllers: [ProbeController] })
    class ProbeModule {}
    const dynamic: DynamicModule = { module: ProbeModule };
    @Module({
      imports: [forwardRef(() => WidgetsModule), Promise.resolve(dynamic)],
    })
    class RootModule {}

    const routes = await scanRoutes(RootModule);
    const controllers = new Set(routes.map((route) => route.controller));

    expect(controllers).toEqual(
      new Set([WidgetsController.name, ProbeController.name]),
    );
  });

  it('refuses a route with no stated policy', async () => {
    @Controller('bare')
    class BareController {
      @Get()
      read() {
        return 1;
      }
    }
    @Module({ controllers: [BareController] })
    class BareModule {}

    await expect(scanRoutes(BareModule)).rejects.toThrow(
      /neither @Public nor @Roles/,
    );
  });

  it('refuses a request body that is not a whole DTO', async () => {
    @Controller('loose')
    class LooseController {
      @Roles('ADMIN')
      @Post()
      write(@Body('name') name: string) {
        return name;
      }
    }
    @Module({ controllers: [LooseController] })
    class LooseModule {}

    await expect(scanRoutes(LooseModule)).rejects.toThrow(
      /LooseController\.write: request input must be one whole Zod DTO/,
    );
  });
});
