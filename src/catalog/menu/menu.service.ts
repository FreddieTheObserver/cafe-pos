import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import { categories } from '../../database/schema';
import { MenuCacheService } from './menu-cache.service';

export interface MenuOption {
  id: string;
  name: string;
  priceDeltaMinor: number;
  isDefault: boolean;
  isAvailable: boolean;
}

export interface MenuOptionGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  sortOrder: number;
  options: MenuOption[];
}

export interface MenuItem {
  id: string;
  name: string;
  description: string | null;
  basePriceMinor: number;
  imageUrl: string | null;
  isAvailable: boolean;
  sortOrder: number;
  optionGroups: MenuOptionGroup[];
}

export interface MenuCategory {
  id: string;
  name: string;
  sortOrder: number;
  items: MenuItem[];
}

export interface Menu {
  categories: MenuCategory[];
}

/** Weak: two renders of one version are equivalent, not guaranteed byte-equal. */
export const etagFor = (version: string): string => `W/"catalog-${version}"`;

/**
 * The composite menu (FR-4, §5.2) — the whole catalog in one request, which is
 * the phase's exit criterion.
 *
 * Two flags with two different meanings, and the difference is the filtering
 * rule here. `categories.is_active` is a publish switch: an inactive category
 * is not part of the menu, so it and its items are absent. `is_available` on an
 * item or option is a stock switch: the row stays in the document carrying the
 * flag, because a kiosk showing "Sold out" is better UX than one where the
 * customer's usual drink silently vanished. The schema makes the same
 * distinction — only categories carry a publish flag.
 */
@Injectable()
export class MenuService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly cache: MenuCacheService,
  ) {}

  currentVersion(): Promise<string | null> {
    return this.cache.currentVersion();
  }

  /**
   * The rendered document, from cache when possible.
   *
   * Returns a JSON *string* rather than an object: the point of caching a
   * rendered document is to skip serialization on the hot path, and re-parsing
   * it here just to let the framework stringify it again would give that back.
   */
  async document(version: string | null): Promise<string> {
    if (version !== null) {
      const cached = await this.cache.read(version);
      if (cached !== null) return cached;
    }

    const document = JSON.stringify(await this.build());
    if (version !== null) await this.cache.write(version, document);
    return document;
  }

  private async build(): Promise<Menu> {
    const rows = await this.db.query.categories.findMany({
      where: eq(categories.isActive, true),
      columns: { id: true, name: true, sortOrder: true },
      orderBy: (category) => [asc(category.sortOrder), asc(category.name)],
      with: {
        items: {
          columns: {
            id: true,
            name: true,
            description: true,
            basePriceMinor: true,
            imageUrl: true,
            isAvailable: true,
            sortOrder: true,
          },
          orderBy: (item) => [asc(item.sortOrder), asc(item.name)],
          with: {
            // The join table, carrying this item's ordering of the groups.
            optionGroups: {
              columns: { sortOrder: true },
              orderBy: (link) => [asc(link.sortOrder)],
              with: {
                optionGroup: {
                  columns: {
                    id: true,
                    name: true,
                    minSelect: true,
                    maxSelect: true,
                  },
                  with: {
                    options: {
                      columns: {
                        id: true,
                        name: true,
                        priceDeltaMinor: true,
                        isDefault: true,
                        isAvailable: true,
                      },
                      orderBy: (option) => [asc(option.name)],
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    // Flattens the join table out of the response: a client rendering a screen
    // cares that a drink has a Size group, not that a row links them.
    return {
      categories: rows.map((category) => ({
        id: category.id,
        name: category.name,
        sortOrder: category.sortOrder,
        items: category.items.map((item) => ({
          id: item.id,
          name: item.name,
          description: item.description,
          basePriceMinor: item.basePriceMinor,
          imageUrl: item.imageUrl,
          isAvailable: item.isAvailable,
          sortOrder: item.sortOrder,
          optionGroups: item.optionGroups.map((link) => ({
            id: link.optionGroup.id,
            name: link.optionGroup.name,
            minSelect: link.optionGroup.minSelect,
            maxSelect: link.optionGroup.maxSelect,
            sortOrder: link.sortOrder,
            options: link.optionGroup.options,
          })),
        })),
      })),
    };
  }
}
