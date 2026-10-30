import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { Roles } from '../decorators/roles.decorator';
import { CreateUserDto, UpdateUserDto, UserIdParamDto } from './users.dto';
import { UsersService, type StaffAccount } from './users.service';

/**
 * Staff accounts (§5.2, §6.4): ADMIN manages them, MANAGER may read the list
 * (they need to know who is on shift), nobody else sees it at all.
 */
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /**
   * ADMIN only, which is also what enforces §8's "only ADMIN assigns ADMIN" —
   * there is no lesser role that can reach this handler to try.
   */
  @Roles('ADMIN')
  @Post()
  create(@Body() body: CreateUserDto): Promise<StaffAccount> {
    return this.users.create(body);
  }

  @Roles('ADMIN', 'MANAGER')
  @Get()
  list(): Promise<StaffAccount[]> {
    return this.users.list();
  }

  @Roles('ADMIN')
  @Patch(':id')
  update(
    @Param() params: UserIdParamDto,
    @Body() body: UpdateUserDto,
  ): Promise<StaffAccount> {
    return this.users.update(params.id, body);
  }
}
