import type { z } from 'zod';

/**
 * A DTO class that carries its Zod schema as a static, so the global
 * `ZodValidationPipe` can find it from Nest's `ArgumentMetadata.metatype`.
 * Instances are never constructed — the class exists purely as the runtime
 * handle Nest's metadata reflection can see.
 */
export interface ZodDtoClass<S extends z.ZodType = z.ZodType> {
  new (): z.infer<S>;
  readonly zodSchema: S;
}

/**
 * Builds a DTO class from a Zod schema (§8). Usage:
 *
 * ```ts
 * const CreateOrderSchema = z.object({ ... });
 * export class CreateOrderDto extends createZodDto(CreateOrderSchema) {}
 * ```
 *
 * The controller then types its `@Body()` as `CreateOrderDto` and receives a
 * fully parsed value — the inferred type and the runtime check come from the
 * same schema, so they cannot drift.
 *
 * Hand-rolled rather than pulling in `nestjs-zod`: it is ~10 lines, and it
 * keeps us off a third-party package's release cadence for Zod v4 support on
 * the validation path every money-mutating endpoint depends on.
 */
export function createZodDto<S extends z.ZodType>(schema: S): ZodDtoClass<S> {
  class ZodDto {
    static readonly zodSchema = schema;
  }
  return ZodDto as unknown as ZodDtoClass<S>;
}

/** Narrows an unknown metatype to a schema-carrying DTO class. */
export function schemaOf(metatype: unknown): z.ZodType | undefined {
  const candidate = (metatype as Partial<ZodDtoClass> | undefined)?.zodSchema;
  return typeof candidate?.parse === 'function' ? candidate : undefined;
}
