import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import {
  isCheckViolation,
  isForeignKeyViolation,
} from '../../common/database/postgres-errors';
import { ResourceNotFoundError } from '../../common/errors/resource-not-found.error';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import { optionGroups, options } from '../../database/schema';
import { OptionGroupMinMaxInvalidError } from '../errors/catalog.errors';

/** A single choice within a group, as the API returns it. */
export interface Option {
  id: string;
  optionGroupId: string;
  name: string;
  priceDeltaMinor: number;
  isDefault: boolean;
  isAvailable: boolean;
}

export interface OptionGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
}

/** A group with its choices — the shape the back office manages them in. */
export interface OptionGroupWithOptions extends OptionGroup {
  options: Option[];
}

export interface CreateOptionGroupInput {
  name: string;
  minSelect?: number;
  maxSelect?: number;
}

export interface UpdateOptionGroupInput {
  name?: string;
  minSelect?: number;
  maxSelect?: number;
}

export interface CreateOptionInput {
  name: string;
  priceDeltaMinor?: number;
  isDefault?: boolean;
  isAvailable?: boolean;
}

export interface UpdateOptionInput {
  name?: string;
  priceDeltaMinor?: number;
  isDefault?: boolean;
}

const GROUP_COLUMNS = {
  id: optionGroups.id,
  name: optionGroups.name,
  minSelect: optionGroups.minSelect,
  maxSelect: optionGroups.maxSelect,
} as const;

const OPTION_COLUMNS = {
  id: options.id,
  optionGroupId: options.optionGroupId,
  name: options.name,
  priceDeltaMinor: options.priceDeltaMinor,
  isDefault: options.isDefault,
  isAvailable: options.isAvailable,
} as const;

/**
 * Option groups and the choices inside them (§5.2).
 *
 * Groups and options share a service because they are one aggregate: an option
 * has no meaning outside its group, and `options.option_group_id` cascades on
 * delete for that reason.
 */
@Injectable()
export class OptionGroupsService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async createGroup(input: CreateOptionGroupInput): Promise<OptionGroup> {
    try {
      const [created] = await this.db
        .insert(optionGroups)
        .values(input)
        .returning(GROUP_COLUMNS);
      return created;
    } catch (error) {
      // `option_groups_minmax_check` is the only CHECK on this table, so a
      // violation cannot mean anything else.
      if (isCheckViolation(error)) throw new OptionGroupMinMaxInvalidError();
      throw error;
    }
  }

  /**
   * Groups with their choices nested, whole and unfiltered (§5.1: ≤ 200 rows
   * in the entire catalog).
   *
   * Nested rather than flat because there is no route that lists options on
   * their own: a back office editing "Milk" needs to see the milks, and making
   * that a second round trip per group would be worse than the single join
   * this costs.
   */
  listGroups(): Promise<OptionGroupWithOptions[]> {
    return this.db.query.optionGroups.findMany({
      columns: { id: true, name: true, minSelect: true, maxSelect: true },
      with: {
        options: {
          columns: {
            id: true,
            optionGroupId: true,
            name: true,
            priceDeltaMinor: true,
            isDefault: true,
            isAvailable: true,
          },
          orderBy: (option) => [asc(option.name)],
        },
      },
      orderBy: (group) => [asc(group.name)],
    });
  }

  async updateGroup(
    id: string,
    changes: UpdateOptionGroupInput,
  ): Promise<OptionGroup> {
    let updated: OptionGroup | undefined;

    try {
      [updated] = await this.db
        .update(optionGroups)
        .set(changes)
        .where(eq(optionGroups.id, id))
        .returning(GROUP_COLUMNS);
    } catch (error) {
      if (isCheckViolation(error)) throw new OptionGroupMinMaxInvalidError();
      throw error;
    }

    if (!updated) throw new ResourceNotFoundError('option group', id);
    return updated;
  }

  /**
   * Adds a choice to a group.
   *
   * An unknown group is a 404, not the 422 an unknown *category* gets on an
   * item: here the missing thing is the resource the URL addresses, not a
   * value inside the body.
   */
  async createOption(
    optionGroupId: string,
    input: CreateOptionInput,
  ): Promise<Option> {
    try {
      const [created] = await this.db
        .insert(options)
        .values({ ...input, optionGroupId })
        .returning(OPTION_COLUMNS);
      return created;
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new ResourceNotFoundError('option group', optionGroupId);
      }
      throw error;
    }
  }

  async updateOption(id: string, changes: UpdateOptionInput): Promise<Option> {
    const [updated] = await this.db
      .update(options)
      .set(changes)
      .where(eq(options.id, id))
      .returning(OPTION_COLUMNS);

    if (!updated) throw new ResourceNotFoundError('option', id);
    return updated;
  }

  /** The 86 switch one level down from an item (FR-3): "no oat milk today". */
  async setOptionAvailability(
    id: string,
    isAvailable: boolean,
  ): Promise<Option> {
    const [updated] = await this.db
      .update(options)
      .set({ isAvailable })
      .where(eq(options.id, id))
      .returning(OPTION_COLUMNS);

    if (!updated) throw new ResourceNotFoundError('option', id);
    return updated;
  }
}
