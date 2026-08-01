import { Module } from '@nestjs/common';
import { CategoriesController } from './categories/categories.controller';
import { CategoriesService } from './categories/categories.service';
import { ItemImageService } from './items/item-image.service';
import { ItemOptionGroupsService } from './items/item-option-groups.service';
import { ItemsController } from './items/items.controller';
import { ItemsService } from './items/items.service';
import { CatalogWriteInterceptor } from './menu/catalog-write.interceptor';
import { MenuCacheService } from './menu/menu-cache.service';
import { MenuController } from './menu/menu.controller';
import { MenuService } from './menu/menu.service';
import { OptionGroupsController } from './option-groups/option-groups.controller';
import { OptionGroupsService } from './option-groups/option-groups.service';
import { OptionsController } from './option-groups/options.controller';

/**
 * Phase 2 (§17): the menu — categories, items, option groups, and the composite
 * `GET /menu` kiosks render from.
 *
 * No `imports`: `DatabaseModule` and `RedisModule` are both `@Global`, and
 * `IdentityModule` registers the auth/role guards globally, so every route
 * added here is guarded from the moment it exists and `RolesGuard` rejects it
 * until someone declares who may call it.
 */
@Module({
  controllers: [
    CategoriesController,
    ItemsController,
    OptionGroupsController,
    OptionsController,
    MenuController,
  ],
  providers: [
    CategoriesService,
    ItemsService,
    ItemOptionGroupsService,
    ItemImageService,
    OptionGroupsService,
    MenuService,
    MenuCacheService,
    // Referenced by `@UseInterceptors` on each write controller; listed here so
    // Nest can construct it with its dependency.
    CatalogWriteInterceptor,
  ],
})
export class CatalogModule {}
