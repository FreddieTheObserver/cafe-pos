import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { isUniqueViolation } from '../../common/database/postgres-errors';
import { ResourceNotFoundError } from '../../common/errors/resource-not-found.error';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import { categories } from '../../database/schema';
import { CategoryNameExistsError } from '../errors/catalog.errors';

/** A category as the API returns it. */
export interface Category {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

export interface CreateCategoryInput {
  name: string;
  sortOrder?: number;
  isActive?: boolean;
}

export interface UpdateCategoryInput {
  name?: string;
  sortOrder?: number;
  isActive?: boolean;
}

/**
 * Selected explicitly rather than `select *` minus the timestamps. A column
 * added to the table in a later phase then has to be named here before it can
 * reach a response, which is the safer direction for that mistake to run.
 */
const PUBLIC_COLUMNS = {
  id: categories.id,
  name: categories.name,
  sortOrder: categories.sortOrder,
  isActive: categories.isActive,
} as const;

/** Category management (§5.2). */
@Injectable()
export class CategoriesService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async create(input: CreateCategoryInput): Promise<Category> {
    try {
      const [created] = await this.db
        .insert(categories)
        .values(input)
        .returning(PUBLIC_COLUMNS);
      return created;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new CategoryNameExistsError(input.name);
      }
      throw error;
    }
  }

  /**
   * Whole list, no pagination — §5.1 is explicit that paginating a ≤ 200-row
   * catalog would be theater. Inactive categories are included on purpose: the
   * back office needs to see them to reactivate them, and `isActive` says which
   * is which. `GET /menu` is the kiosk-shaped read, and it will filter.
   *
   * Name breaks ties in the sort so two categories sharing a sort key still
   * come back in a stable order rather than whatever the heap felt like.
   */
  list(): Promise<Category[]> {
    return this.db
      .select(PUBLIC_COLUMNS)
      .from(categories)
      .orderBy(categories.sortOrder, categories.name);
  }

  async update(id: string, changes: UpdateCategoryInput): Promise<Category> {
    let updated: Category | undefined;

    try {
      [updated] = await this.db
        .update(categories)
        .set(changes)
        .where(eq(categories.id, id))
        .returning(PUBLIC_COLUMNS);
    } catch (error) {
      // Guarded on `name` being present rather than assuming any unique
      // violation here is the name index. If some future unique constraint
      // fires, it propagates as a 500 instead of being mislabelled as a name
      // collision the caller cannot act on.
      if (isUniqueViolation(error) && changes.name !== undefined) {
        throw new CategoryNameExistsError(changes.name);
      }
      throw error;
    }

    if (!updated) throw new ResourceNotFoundError('category', id);
    return updated;
  }
}
