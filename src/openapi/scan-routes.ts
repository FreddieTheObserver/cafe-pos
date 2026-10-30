import 'reflect-metadata';
import {
  RequestMethod,
  type DynamicModule,
  type ForwardReference,
  type Type,
} from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import type { z } from 'zod';
import { API_PREFIX, UNPREFIXED_ROUTES } from '../bootstrap';
import { schemaOf } from '../common/validation/zod-dto';
import { IS_PUBLIC_KEY } from '../identity/decorators/public.decorator';
import { ROLES_KEY } from '../identity/decorators/roles.decorator';
import type { PrincipalRole } from '../identity/principal';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface Dto {
  name: string;
  schema: z.ZodType;
}

export interface RouteInfo {
  controller: string;
  handler: string;
  method: HttpMethod;
  /** OpenAPI path template, global prefix included. */
  path: string;
  successStatus: number;
  roles: PrincipalRole[] | 'public';
  body?: Dto;
  params?: Dto;
  query?: Dto;
  /** Lower-case names of headers read through `@Headers('name')`. */
  headers: string[];
  upload: boolean;
}

type ModuleRef =
  Type | DynamicModule | ForwardReference | Promise<DynamicModule>;

const METHODS: Partial<Record<RequestMethod, HttpMethod>> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.DELETE]: 'delete',
};

export async function scanRoutes(root: ModuleRef): Promise<RouteInfo[]> {
  return (await collectControllers(root))
    .flatMap(routesOf)
    .sort(
      (a, b) =>
        a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
    );
}

async function collectControllers(root: ModuleRef): Promise<Type[]> {
  const controllers = new Set<Type>();
  const seen = new Set<unknown>();

  const visit = async (input: ModuleRef): Promise<void> => {
    const ref = await input;
    if ('forwardRef' in ref)
      return visit((ref.forwardRef as () => ModuleRef)());

    const dynamic = typeof ref === 'function' ? undefined : ref;
    const module = dynamic ? dynamic.module : ref;
    if (!dynamic) {
      if (seen.has(module)) return;
      seen.add(module);
    }

    const read = (key: 'controllers' | 'imports'): unknown[] => [
      ...((Reflect.getMetadata(key, module) as unknown[] | undefined) ?? []),
      ...((dynamic?.[key] as unknown[] | undefined) ?? []),
    ];
    read('controllers').forEach((c) => controllers.add(c as Type));
    for (const imported of read('imports')) await visit(imported as ModuleRef);
  };

  await visit(root);
  return [...controllers];
}

function routesOf(controller: Type): RouteInfo[] {
  const prototype = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(prototype).flatMap((handler) => {
    const fn = prototype[handler];
    if (typeof fn !== 'function') return [];
    const verb = Reflect.getMetadata(METHOD_METADATA, fn) as
      RequestMethod | undefined;
    if (verb === undefined) return [];

    const method = METHODS[verb];
    if (!method) {
      throw new Error(
        `${controller.name}.${handler} uses an HTTP method the API contract does not cover.`,
      );
    }

    const controllerPaths = pathsOf(
      Reflect.getMetadata(PATH_METADATA, controller),
    );
    const handlerPaths = pathsOf(Reflect.getMetadata(PATH_METADATA, fn));
    const successStatus =
      (Reflect.getMetadata(HTTP_CODE_METADATA, fn) as number | undefined) ??
      (method === 'post' ? 201 : 200);
    const args = argumentsOf(controller, handler);

    return controllerPaths.flatMap((base) =>
      handlerPaths.map((own): RouteInfo => {
        const route = join(base, own);
        const unprefixed = UNPREFIXED_ROUTES.some(
          (r) => `/${r.path}` === route && METHODS[r.method] === method,
        );
        return {
          controller: controller.name,
          handler,
          method,
          path: toTemplate(unprefixed ? route : join(API_PREFIX, route)),
          successStatus,
          roles: rolesOf(controller, fn),
          ...args,
        };
      }),
    );
  });
}

function rolesOf(controller: Type, fn: unknown): PrincipalRole[] | 'public' {
  const lookup = <T>(key: string): T | undefined =>
    (Reflect.getMetadata(key, fn as object) as T | undefined) ??
    (Reflect.getMetadata(key, controller) as T | undefined);

  if (lookup<boolean>(IS_PUBLIC_KEY)) return 'public';
  const roles = lookup<PrincipalRole[]>(ROLES_KEY);
  if (!roles) {
    throw new Error(
      `${controller.name} has a route with neither @Public nor @Roles.`,
    );
  }
  return roles;
}

function argumentsOf(
  controller: Type,
  handler: string,
): Pick<RouteInfo, 'body' | 'params' | 'query' | 'headers' | 'upload'> {
  const found: ReturnType<typeof argumentsOf> = { headers: [], upload: false };
  const entries = (Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    controller,
    handler,
  ) ?? {}) as Record<string, { index: number; data?: unknown }>;
  const types = (Reflect.getMetadata(
    'design:paramtypes',
    controller.prototype as object,
    handler,
  ) ?? []) as unknown[];

  for (const [key, { index, data }] of Object.entries(entries)) {
    const kind: RouteParamtypes = Number(key.split(':')[0]);
    const where = `${controller.name}.${handler}`;
    const dto = (): Dto => {
      const schema = schemaOf(types[index]);
      if (!schema || data !== undefined) {
        throw new Error(
          `${where}: request input must be one whole Zod DTO, not a bare value.`,
        );
      }
      return { name: (types[index] as Type).name, schema };
    };

    if (kind === RouteParamtypes.BODY) {
      found.body = dto();
    } else if (kind === RouteParamtypes.QUERY) found.query = dto();
    else if (kind === RouteParamtypes.PARAM) found.params = dto();
    else if (kind === RouteParamtypes.HEADERS && typeof data === 'string') {
      found.headers.push(data.toLowerCase());
    } else if (
      kind === RouteParamtypes.FILE ||
      kind === RouteParamtypes.FILES
    ) {
      found.upload = true;
    }
  }
  return found;
}

const pathsOf = (value: unknown): string[] =>
  Array.isArray(value) ? (value as string[]) : [(value as string) ?? ''];

const join = (...parts: string[]): string =>
  '/' + parts.join('/').split('/').filter(Boolean).join('/');

const toTemplate = (path: string): string =>
  path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
