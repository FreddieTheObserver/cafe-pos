import { Module } from '@nestjs/common';
import { CategoriesController } from './categories/categories.controller';
import { CategoriesService } from './categories/categories.service';

/**
 * Phase 2 (§17): the menu — categories, items, option groups, and the composite
 * `GET /menu` kiosks render from.
 *
 * No `imports`: `DatabaseModule` is `@Global`, and `IdentityModule` registers
 * the auth/role guards globally, so every route added here is guarded from the
 * moment it exists and `RolesGuard` rejects it until someone declares who may
 * call it.
 */
@Module({
  controllers: [CategoriesController],
  providers: [CategoriesService],
})
export class CatalogModule {}
