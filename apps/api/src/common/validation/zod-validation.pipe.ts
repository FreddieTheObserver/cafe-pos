import {
  Injectable,
  type ArgumentMetadata,
  type PipeTransform,
} from '@nestjs/common';
import { schemaOf } from './zod-dto';

/**
 * Global validation (§8). Any handler argument whose type is a `createZodDto`
 * class is parsed against its schema; everything else passes through untouched.
 *
 * On failure the raw `ZodError` propagates — `AllExceptionsFilter` is the one
 * place that turns it into the 422 `VALIDATION_FAILED` envelope with `errors[]`
 * (§9.1), so the mapping lives in exactly one file.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const schema = schemaOf(metadata.metatype);
    return schema ? schema.parse(value) : value;
  }
}
