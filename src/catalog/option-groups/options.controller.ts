import {
  Body,
  Controller,
  Param,
  Patch,
  UseInterceptors,
} from '@nestjs/common';
import { Roles } from '../../identity/decorators/roles.decorator';
import { CatalogWriteInterceptor } from '../menu/catalog-write.interceptor';
import {
  OptionIdParamDto,
  SetOptionAvailabilityDto,
  UpdateOptionDto,
} from './option-groups.dto';
import { OptionGroupsService, type Option } from './option-groups.service';

/**
 * Individual options (§5.2, §6.4). Separate controller from the groups because
 * §5.2 addresses them at the root — an option id is unique on its own, so
 * routing through the parent would add a segment that carries no information.
 *
 * §5.2 writes these as one route whose *availability field* has wider roles
 * than the rest. That is not expressible with route-level guards, so it becomes
 * the same split `/items` already uses: repricing here, 86ing next door. The
 * split is the stricter reading — a barista gets exactly the one field FR-3
 * promises and no path to the price.
 */
@UseInterceptors(CatalogWriteInterceptor)
@Controller('options')
export class OptionsController {
  constructor(private readonly groups: OptionGroupsService) {}

  @Roles('ADMIN', 'MANAGER')
  @Patch(':id')
  update(
    @Param() params: OptionIdParamDto,
    @Body() body: UpdateOptionDto,
  ): Promise<Option> {
    return this.groups.updateOption(params.id, body);
  }

  @Roles('ADMIN', 'MANAGER', 'CASHIER', 'BARISTA')
  @Patch(':id/availability')
  setAvailability(
    @Param() params: OptionIdParamDto,
    @Body() body: SetOptionAvailabilityDto,
  ): Promise<Option> {
    return this.groups.setOptionAvailability(params.id, body.isAvailable);
  }
}
