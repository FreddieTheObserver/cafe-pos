import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { isForeignKeyViolation } from '../../common/database/postgres-errors';
import { ResourceNotFoundError } from '../../common/errors/resource-not-found.error';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import { menuItems } from '../../database/schema';
import { CategoryUnknownError } from '../errors/catalog.errors';

/** A menu item as the API returns it. */
export interface MenuItem {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  basePriceMinor: number;
  imageUrl: string | null;
  isAvailable: boolean;
  sortOrder: number;
}

export interface CreateItemInput {
  categoryId: string;
  name: string;
  description?: string | null;
  basePriceMinor: number;
  imageUrl?: string | null;
  sortOrder?: number;
  isAvailable?: boolean;
}

export interface UpdateItemInput {
  categoryId?: string;
  name?: string;
  description?: string | null;
  basePriceMinor?: number;
  imageUrl?: string | null;
  sortOrder?: number;
}

/**
 * Explicit rather than `select *` minus the timestamps: a column added later
 * has to be named here before it can reach a response.
 */
const PUBLIC_COLUMNS = {
  id: menuItems.id,
  categoryId: menuItems.categoryId,
  name: menuItems.name,
  description: menuItems.description,
  basePriceMinor: menuItems.basePriceMinor,
  imageUrl: menuItems.imageUrl,
  isAvailable: menuItems.isAvailable,
  sortOrder: menuItems.sortOrder,
} as const;

/** Menu item management (§5.2). */
@Injectable()
export class ItemsService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async create(input: CreateItemInput): Promise<MenuItem> {
    try {
      const [created] = await this.db
        .insert(menuItems)
        .values(input)
        .returning(PUBLIC_COLUMNS);
      return created;
    } catch (error) {
      // `category_id` is the only FK on this table, so a violation can mean
      // nothing else.
      if (isForeignKeyViolation(error)) {
        throw new CategoryUnknownError(input.categoryId);
      }
      throw error;
    }
  }

  /**
   * Whole list, no pagination (§5.1: ≤ 200 rows). Flat and including 86'd rows
   * — the back office needs to see what is sold out in order to un-86 it, and
   * grouping into the category tree is `GET /menu`'s job, not this one's.
   *
   * Name breaks ties in the sort so items sharing a sort key come back in a
   * stable order rather than whatever the heap felt like.
   */
  list(): Promise<MenuItem[]> {
    return this.db
      .select(PUBLIC_COLUMNS)
      .from(menuItems)
      .orderBy(menuItems.sortOrder, menuItems.name);
  }

  async update(id: string, changes: UpdateItemInput): Promise<MenuItem> {
    let updated: MenuItem | undefined;

    try {
      [updated] = await this.db
        .update(menuItems)
        .set(changes)
        .where(eq(menuItems.id, id))
        .returning(PUBLIC_COLUMNS);
    } catch (error) {
      // Guarded on the field being present rather than assuming any FK
      // violation is this one, so a constraint added later surfaces as a 500
      // instead of a misleading "unknown category".
      if (isForeignKeyViolation(error) && changes.categoryId !== undefined) {
        throw new CategoryUnknownError(changes.categoryId);
      }
      throw error;
    }

    if (!updated) throw new ResourceNotFoundError('menu item', id);
    return updated;
  }

  /**
   * The 86 switch (FR-3), separate from `update` because it is separately
   * authorized: any staff member may mark the oat milk gone, but repricing is
   * manager work.
   */
  async setAvailability(id: string, isAvailable: boolean): Promise<MenuItem> {
    const [updated] = await this.db
      .update(menuItems)
      .set({ isAvailable })
      .where(eq(menuItems.id, id))
      .returning(PUBLIC_COLUMNS);

    if (!updated) throw new ResourceNotFoundError('menu item', id);
    return updated;
  }
}
