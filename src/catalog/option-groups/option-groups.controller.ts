import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseInterceptors,
} from '@nestjs/common';
import { Roles } from '../../identity/decorators/roles.decorator';
import { CatalogWriteInterceptor } from '../menu/catalog-write.interceptor';
import {
  CreateOptionDto,
  CreateOptionGroupDto,
  OptionGroupIdParamDto,
  UpdateOptionGroupDto,
} from './option-groups.dto';
import {
  OptionGroupsService,
  type Option,
  type OptionGroup,
  type OptionGroupWithOptions,
} from './option-groups.service';

/**
 * Option groups (§5.2, §6.4). Structure, so manager-and-above throughout —
 * the routes any staff member may reach are the availability toggles, and
 * those live on the individual option.
 */
@UseInterceptors(CatalogWriteInterceptor)
@Controller('option-groups')
export class OptionGroupsController {
  constructor(private readonly groups: OptionGroupsService) {}

  @Roles('ADMIN', 'MANAGER')
  @Post()
  create(@Body() body: CreateOptionGroupDto): Promise<OptionGroup> {
    return this.groups.createGroup(body);
  }

  @Roles('ADMIN', 'MANAGER')
  @Get()
  list(): Promise<OptionGroupWithOptions[]> {
    return this.groups.listGroups();
  }

  @Roles('ADMIN', 'MANAGER')
  @Patch(':id')
  update(
    @Param() params: OptionGroupIdParamDto,
    @Body() body: UpdateOptionGroupDto,
  ): Promise<OptionGroup> {
    return this.groups.updateGroup(params.id, body);
  }

  @Roles('ADMIN', 'MANAGER')
  @Post(':id/options')
  createOption(
    @Param() params: OptionGroupIdParamDto,
    @Body() body: CreateOptionDto,
  ): Promise<Option> {
    return this.groups.createOption(params.id, body);
  }
}
