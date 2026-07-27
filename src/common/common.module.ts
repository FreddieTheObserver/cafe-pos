import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { AllExceptionsFilter } from './filters/all-exceptions.filter';
import { ZodValidationPipe } from './validation/zod-validation.pipe';

/**
 * Cross-cutting HTTP concerns: the global exception filter (§9.3) and the
 * global Zod validation pipe (§8). Together they guarantee every handler sees
 * parsed input and every failure leaves as one envelope.
 */
@Module({
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
  ],
})
export class CommonModule {}
