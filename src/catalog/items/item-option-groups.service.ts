import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { ResourceNotFoundError } from '../../common/errors/resource-not-found.error';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import {
  menuItemOptionGroups,
  menuItems,
  optionGroups,
} from '../../database/schema';
import { OptionGroupUnknownError } from '../errors/catalog.errors';

/** An option group as attached to one item, carrying its place in the list. */
export interface AttachedOptionGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  sortOrder: number;
}

/**
 * Which option groups an item offers, and in what order (§5.2).
 *
 * Its own service rather than a method on `ItemsService`: this owns a different
 * table, and the operation is a set replacement rather than a row edit.
 */
@Injectable()
export class ItemOptionGroupsService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Replaces the whole attachment set for an item — idempotent by construction
   * (§5.2), because the same body always leaves the same rows.
   *
   * Delete-then-insert rather than diffing: the set is at most a handful of
   * rows inside one transaction, and computing the minimal change would be
   * more code defending a property (fewer writes) nothing here needs. An empty
   * list is a legitimate body — a croissant has no decisions attached to it.
   */
  async setForItem(
    itemId: string,
    optionGroupIds: string[],
  ): Promise<AttachedOptionGroup[]> {
    return this.db.transaction(async (tx) => {
      const item = await tx.query.menuItems.findFirst({
        where: eq(menuItems.id, itemId),
        columns: { id: true },
      });
      if (!item) throw new ResourceNotFoundError('menu item', itemId);

      if (optionGroupIds.length > 0) {
        // Checked up front so the error can name *which* ids were wrong. The
        // FK on the join table is still the thing that makes it true; this
        // only buys a better message than a constraint violation gives.
        const found = await tx
          .select({ id: optionGroups.id })
          .from(optionGroups)
          .where(inArray(optionGroups.id, optionGroupIds));

        const known = new Set(found.map((row) => row.id));
        const unknown = optionGroupIds.filter((id) => !known.has(id));
        if (unknown.length > 0) throw new OptionGroupUnknownError(unknown);
      }

      await tx
        .delete(menuItemOptionGroups)
        .where(eq(menuItemOptionGroups.menuItemId, itemId));

      if (optionGroupIds.length > 0) {
        await tx.insert(menuItemOptionGroups).values(
          optionGroupIds.map((optionGroupId, index) => ({
            menuItemId: itemId,
            optionGroupId,
            sortOrder: index,
          })),
        );
      }

      // Read back rather than echo the request: the response then describes
      // rows that exist, and carries the group names a back office needs to
      // render the result without a second call.
      return tx
        .select({
          id: optionGroups.id,
          name: optionGroups.name,
          minSelect: optionGroups.minSelect,
          maxSelect: optionGroups.maxSelect,
          sortOrder: menuItemOptionGroups.sortOrder,
        })
        .from(menuItemOptionGroups)
        .innerJoin(
          optionGroups,
          eq(menuItemOptionGroups.optionGroupId, optionGroups.id),
        )
        .where(eq(menuItemOptionGroups.menuItemId, itemId))
        .orderBy(menuItemOptionGroups.sortOrder);
    });
  }
}
