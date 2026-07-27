import { Body, Controller, Module, Post } from '@nestjs/common';
import { z } from 'zod';
import { CommonModule } from '../../src/common/common.module';
import { createZodDto } from '../../src/common/validation/zod-dto';

const EchoSchema = z.object({
  name: z.string().min(1),
  quantity: z.coerce.number().int().min(1).max(50),
});

export class EchoDto extends createZodDto(EchoSchema) {}

/**
 * Stand-in for the real endpoints Phase 1+ will add. Exists so the HTTP
 * contract (validation envelope, body limits, security headers) can be tested
 * against production wiring without waiting on domain routes.
 */
@Controller('probe')
export class ProbeController {
  /** Validated by the global pipe via the DTO's schema. */
  @Post('echo')
  echo(@Body() body: EchoDto): EchoDto {
    return body;
  }

  /** Unvalidated on purpose — used to exercise the body-size limit. */
  @Post('bulk')
  bulk(): { ok: true } {
    return { ok: true };
  }
}

@Module({ imports: [CommonModule], controllers: [ProbeController] })
export class ProbeModule {}
