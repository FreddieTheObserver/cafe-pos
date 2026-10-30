import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Module,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { createZodDto } from '../common/validation/zod-dto';
import { Public } from '../identity/decorators/public.decorator';
import { Roles } from '../identity/decorators/roles.decorator';

export class CreateWidgetDto extends createZodDto(
  z.object({ name: z.string().min(1) }),
) {}
export class WidgetIdDto extends createZodDto(z.object({ id: z.uuid() })) {}
export class WidgetQueryDto extends createZodDto(
  z.object({ q: z.string().optional(), limit: z.number().int() }),
) {}

@Controller('widgets')
export class WidgetsController {
  @Roles('ADMIN', 'MANAGER')
  @Post()
  create(
    @Body() body: CreateWidgetDto,
    @Headers('Idempotency-Key') key?: string,
  ) {
    return { body, key };
  }

  @Roles('ADMIN')
  @Get()
  list(@Query() query: WidgetQueryDto) {
    return query;
  }

  @Roles('ADMIN')
  @Get(':id')
  one(@Param() params: WidgetIdDto) {
    return params;
  }

  @Roles('ADMIN')
  @HttpCode(204)
  @Delete(':id')
  remove(@Param() params: WidgetIdDto) {
    return params;
  }

  @Roles('MANAGER')
  @UseInterceptors(FileInterceptor('file'))
  @Post(':id/image')
  upload(@Param() params: WidgetIdDto, @UploadedFile() file?: object) {
    return { params, file };
  }
}

// Mounted at the root, like the real probes, which sit outside the prefix.
@Public()
@Controller()
export class ProbeController {
  @Get('healthz')
  live() {
    return { status: 'ok' };
  }
}

@Module({ controllers: [WidgetsController, ProbeController] })
export class WidgetsModule {}
