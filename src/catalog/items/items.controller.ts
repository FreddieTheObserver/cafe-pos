import { Body, Controller, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { Roles } from '../../identity/decorators/roles.decorator';
import { SetItemOptionGroupsDto } from './item-option-groups.dto';
import {
  ItemOptionGroupsService,
  type AttachedOptionGroup,
} from './item-option-groups.service';
import {
  CreateItemDto,
  ItemIdParamDto,
  SetItemAvailabilityDto,
  UpdateItemDto,
} from './items.dto';
import { ItemsService, type MenuItem } from './items.service';

/**
 * Menu items (§5.2, §6.4).
 *
 * The availability route is the one place in this phase where a cashier or
 * barista may write: FR-3 says *any* staff member can 86 an item, because the
 * person who discovers the oat milk is gone is whoever is standing at the bar,
 * and making them find a manager first is how a kiosk keeps selling something
 * the cafe cannot make. Everything else here stays manager-and-above.
 */
@Controller('items')
export class ItemsController {
  constructor(
    private readonly items: ItemsService,
    private readonly itemOptionGroups: ItemOptionGroupsService,
  ) {}

  @Roles('ADMIN', 'MANAGER')
  @Post()
  create(@Body() body: CreateItemDto): Promise<MenuItem> {
    return this.items.create(body);
  }

  @Roles('ADMIN', 'MANAGER')
  @Get()
  list(): Promise<MenuItem[]> {
    return this.items.list();
  }

  @Roles('ADMIN', 'MANAGER')
  @Patch(':id')
  update(
    @Param() params: ItemIdParamDto,
    @Body() body: UpdateItemDto,
  ): Promise<MenuItem> {
    return this.items.update(params.id, body);
  }

  @Roles('ADMIN', 'MANAGER', 'CASHIER', 'BARISTA')
  @Patch(':id/availability')
  setAvailability(
    @Param() params: ItemIdParamDto,
    @Body() body: SetItemAvailabilityDto,
  ): Promise<MenuItem> {
    return this.items.setAvailability(params.id, body.isAvailable);
  }

  /**
   * PUT, not PATCH: the body is the complete set of groups this item offers,
   * so sending it twice leaves the same rows (§5.2's "idempotent replace").
   */
  @Roles('ADMIN', 'MANAGER')
  @Put(':id/option-groups')
  setOptionGroups(
    @Param() params: ItemIdParamDto,
    @Body() body: SetItemOptionGroupsDto,
  ): Promise<AttachedOptionGroup[]> {
    return this.itemOptionGroups.setForItem(params.id, body.optionGroupIds);
  }
}
