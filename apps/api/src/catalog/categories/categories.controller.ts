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
  CategoryIdParamDto,
  CreateCategoryDto,
  UpdateCategoryDto,
} from './categories.dto';
import { CategoriesService, type Category } from './categories.service';

/**
 * Menu categories (§5.2, §6.4). Writing the menu is a manager-and-above job;
 * the availability toggles cashiers and baristas may hit live on items and
 * options, not here — a category is structure, not stock.
 *
 * `GET /categories` is an addition to the §5.2 endpoint table, which lists only
 * the two writes. The back office cannot manage what it cannot enumerate, and
 * `GET /menu` will not serve that need: it is the kiosk-shaped read, so it
 * filters to active categories, and a manager reactivating one she deactivated
 * last week needs to see exactly the rows that read omits.
 */
@UseInterceptors(CatalogWriteInterceptor)
@Controller('categories')
export class CategoriesController {
  constructor(private readonly cats: CategoriesService) {}

  @Roles('ADMIN', 'MANAGER')
  @Post()
  create(@Body() body: CreateCategoryDto): Promise<Category> {
    return this.cats.create(body);
  }

  @Roles('ADMIN', 'MANAGER')
  @Get()
  list(): Promise<Category[]> {
    return this.cats.list();
  }

  @Roles('ADMIN', 'MANAGER')
  @Patch(':id')
  update(
    @Param() params: CategoryIdParamDto,
    @Body() body: UpdateCategoryDto,
  ): Promise<Category> {
    return this.cats.update(params.id, body);
  }
}
