import type { ArgumentMetadata } from '@nestjs/common';
import { ZodError, z } from 'zod';
import { createZodDto } from './zod-dto';
import { ZodValidationPipe } from './zod-validation.pipe';

const CreateThingSchema = z.object({
  name: z.string().min(1),
  quantity: z.coerce.number().int().min(1).max(50),
});

class CreateThingDto extends createZodDto(CreateThingSchema) {}

const bodyOf = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({
  type: 'body',
  metatype,
});

describe('ZodValidationPipe', () => {
  let pipe: ZodValidationPipe;

  beforeEach(() => {
    pipe = new ZodValidationPipe();
  });

  it('returns validated data for a well-formed payload', () => {
    const result = pipe.transform(
      { name: 'Latte', quantity: 2 },
      bodyOf(CreateThingDto),
    );

    expect(result).toEqual({ name: 'Latte', quantity: 2 });
  });

  it('applies the schema coercions so handlers get real types', () => {
    const result = pipe.transform(
      { name: 'Latte', quantity: '2' },
      bodyOf(CreateThingDto),
    );

    expect(result).toEqual({ name: 'Latte', quantity: 2 });
  });

  it('strips unknown keys so clients cannot smuggle fields through', () => {
    const result = pipe.transform(
      { name: 'Latte', quantity: 1, totalMinor: 0 },
      bodyOf(CreateThingDto),
    );

    expect(result).toEqual({ name: 'Latte', quantity: 1 });
  });

  it('throws ZodError when the payload violates the schema', () => {
    expect(() =>
      pipe.transform({ name: '', quantity: 999 }, bodyOf(CreateThingDto)),
    ).toThrow(ZodError);
  });

  it('reports every offending field, not just the first', () => {
    try {
      pipe.transform({ name: '', quantity: 999 }, bodyOf(CreateThingDto));
      fail('expected the pipe to throw');
    } catch (err) {
      const paths = (err as ZodError).issues.map((i) => i.path.join('.'));
      expect(paths).toEqual(expect.arrayContaining(['name', 'quantity']));
    }
  });

  it('passes through arguments whose metatype carries no schema', () => {
    // Route params, primitives, and plain classes must not be touched.
    expect(pipe.transform('A-042', { type: 'param', metatype: String })).toBe(
      'A-042',
    );
  });

  it('passes through arguments with no metatype at all', () => {
    const raw = { anything: true };

    expect(pipe.transform(raw, { type: 'body', metatype: undefined })).toBe(
      raw,
    );
  });
});
