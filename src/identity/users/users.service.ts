import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import { ResourceNotFoundError } from '../../common/errors/resource-not-found.error';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import { users } from '../../database/schema';
import type { UserRole } from '../../database/schema/enums';
import { PasswordHasher } from '../crypto/password.hasher';
import {
  LastAdminError,
  UserEmailExistsError,
} from '../errors/identity.errors';

/** A staff account as the API returns it — the password hash never appears. */
export interface StaffAccount {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  isActive: boolean;
}

export interface CreateUserInput {
  email: string;
  displayName: string;
  role: UserRole;
  password: string;
}

export interface UpdateUserInput {
  displayName?: string;
  role?: UserRole;
  isActive?: boolean;
}

/**
 * Selected explicitly rather than by excluding `passwordHash` from a `select *`.
 * A column added to the table in a later phase then has to be named here before
 * it can reach a response, which is the safer direction for that mistake to run.
 */
const PUBLIC_COLUMNS = {
  id: users.id,
  email: users.email,
  displayName: users.displayName,
  role: users.role,
  isActive: users.isActive,
} as const;

const UNIQUE_VIOLATION = '23505';

/** Staff account management (§5.2). */
@Injectable()
export class UsersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly passwords: PasswordHasher,
  ) {}

  async create(input: CreateUserInput): Promise<StaffAccount> {
    const passwordHash = await this.passwords.hash(input.password);

    try {
      const [created] = await this.db
        .insert(users)
        .values({
          email: input.email,
          displayName: input.displayName,
          role: input.role,
          passwordHash,
        })
        .returning(PUBLIC_COLUMNS);
      return created;
    } catch (error) {
      // Let the unique index decide, rather than checking first and inserting
      // second: between those two statements another request can take the
      // email, and only the index is actually authoritative.
      if (isUniqueViolation(error)) throw new UserEmailExistsError(input.email);
      throw error;
    }
  }

  list(): Promise<StaffAccount[]> {
    // Deactivated accounts are included on purpose: the back office needs to
    // see them to reactivate them, and `isActive` says which is which.
    return this.db.select(PUBLIC_COLUMNS).from(users).orderBy(users.email);
  }

  /**
   * Updates a staff account, refusing any change that would leave the system
   * with no active ADMIN (§5.2, §8).
   *
   * The whole operation runs in one transaction that first locks the active
   * admin rows. Without that lock two concurrent demotions each see the other
   * admin as cover, both commit, and nobody can administer the system —
   * a lockout that needs database access to undo.
   */
  async update(id: string, changes: UpdateUserInput): Promise<StaffAccount> {
    return this.db.transaction(async (tx) => {
      // Locked in a deterministic order so two concurrent demotions queue
      // rather than deadlock. Whichever waits re-evaluates the predicate after
      // the lock is released and sees the other's demotion.
      await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, 'ADMIN'), eq(users.isActive, true)))
        .orderBy(users.id)
        .for('update');

      const current = await tx.query.users.findFirst({
        where: eq(users.id, id),
        columns: { role: true, isActive: true },
      });
      if (!current) throw new ResourceNotFoundError('user', id);

      await this.guardLastAdmin(tx, id, current, changes);

      const [updated] = await tx
        .update(users)
        .set(changes)
        .where(eq(users.id, id))
        .returning(PUBLIC_COLUMNS);

      return updated;
    });
  }

  /**
   * Refuses a change that takes the *last* active ADMIN out of that role
   * (§5.2, §8).
   *
   * Scoped to changes that actually remove an admin, rather than asserting
   * "an admin exists" globally after every write: the latter would make every
   * unrelated edit fail on a system that somehow already has none, turning one
   * problem into a total outage. Renaming the sole admin stays allowed —
   * only losing the role or the account matters.
   */
  private async guardLastAdmin(
    tx: Database,
    id: string,
    current: { role: UserRole; isActive: boolean },
    changes: UpdateUserInput,
  ): Promise<void> {
    const wasAdmin = current.role === 'ADMIN' && current.isActive;
    if (!wasAdmin) return;

    const willBeAdmin =
      (changes.role ?? current.role) === 'ADMIN' &&
      (changes.isActive ?? current.isActive);
    if (willBeAdmin) return;

    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(
        and(
          eq(users.role, 'ADMIN'),
          eq(users.isActive, true),
          ne(users.id, id),
        ),
      );

    // A deactivated admin cannot sign in, so it cannot undo this — it is not
    // cover, and does not count.
    if (count === 0) throw new LastAdminError();
  }
}

function isUniqueViolation(error: unknown): boolean {
  // Drizzle wraps driver errors, so the SQLSTATE can be one level down.
  const cause = (error as { cause?: unknown }).cause ?? error;
  return (cause as { code?: string }).code === UNIQUE_VIOLATION;
}
