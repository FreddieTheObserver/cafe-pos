import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, inArray } from 'drizzle-orm';
import { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';
import * as schema from '../src/database/schema';
import { PasswordHasher } from '../src/identity/crypto/password.hasher';
import {
  LastAdminError,
  UserEmailExistsError,
} from '../src/identity/errors/identity.errors';
import { UsersService } from '../src/identity/users/users.service';
import { ResourceNotFoundError } from '../src/common/errors/resource-not-found.error';
import type { UserRole } from '../src/database/schema/enums';

const PASSWORD = 'a-perfectly-fine-password';

/**
 * "Cannot demote or deactivate the last active ADMIN" (§5.2, §8) is an
 * invariant over the whole users table, not a property of one row — so it can
 * only be tested where the table is, and its concurrency behaviour cannot be
 * tested anywhere else at all.
 */
describe('UsersService (integration)', () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let service: UsersService;
  const hasher = new PasswordHasher();

  const createdUserIds: string[] = [];

  /** Unique per run, so a suite never collides with leftovers from a failed one. */
  const emailFor = (label: string) => `users-${label}-${uuidv7()}@cafepos.test`;

  async function seed(
    role: UserRole,
    { isActive = true } = {},
  ): Promise<string> {
    const id = uuidv7();
    await db.insert(schema.users).values({
      id,
      email: emailFor(role.toLowerCase()),
      passwordHash: await hasher.hash(PASSWORD),
      displayName: `Seeded ${role}`,
      role,
      isActive,
    });
    createdUserIds.push(id);
    return id;
  }

  /** Admins this suite demoted but did not create; restored on the way out. */
  const parkedAdminIds = new Set<string>();

  /**
   * The last-admin rule counts every active ADMIN in the table, so these tests
   * only mean anything if no other admin exists. Parking any stragglers keeps
   * the suite honest without deleting rows another suite may own.
   *
   * The demotion has to be undone, which it previously was not: this runs
   * against the developer's own database, where the straggler is
   * `admin@cafepos.local` from `pnpm db:seed`. A single green run left that
   * account a MANAGER, with no ADMIN remaining anywhere — and `db:seed` is
   * idempotent by email, so re-seeding did not put it back. The only tell was
   * an ADMIN-only route answering 403 for reasons nothing explained.
   */
  async function parkExistingAdmins(): Promise<void> {
    const parked = await db
      .update(schema.users)
      .set({ role: 'MANAGER' })
      .where(eq(schema.users.role, 'ADMIN'))
      .returning({ id: schema.users.id });

    // Rows this suite created are deleted wholesale below; restoring them would
    // resurrect a role on a user that is about to stop existing.
    for (const { id } of parked) {
      if (!createdUserIds.includes(id)) parkedAdminIds.add(id);
    }
  }

  async function restoreParkedAdmins(): Promise<void> {
    const ids = [...parkedAdminIds];
    if (ids.length === 0) return;

    await db
      .update(schema.users)
      .set({ role: 'ADMIN' })
      .where(inArray(schema.users.id, ids));
    parkedAdminIds.clear();
  }

  const readUser = (id: string) =>
    db.query.users.findFirst({ where: eq(schema.users.id, id) });

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    db = drizzle(pool, { schema });
    service = new UsersService(db, hasher);
    await parkExistingAdmins();
  });

  afterAll(async () => {
    // Nested rather than sequential, so each guarantee actually holds: a failed
    // delete must not strand the seeded admin as a MANAGER, and neither of
    // those must leave the pool open and hang the run. Written flat, the
    // restore sits on the delete's happy path and the promise in the comment is
    // one the code does not keep.
    try {
      try {
        if (createdUserIds.length > 0) {
          await db
            .delete(schema.users)
            .where(inArray(schema.users.id, createdUserIds));
        }
      } finally {
        await restoreParkedAdmins();
      }
    } finally {
      await pool.end();
    }
  });

  describe('create', () => {
    it('returns the created account without its password hash', async () => {
      const email = emailFor('created');

      const user = await service.create({
        email,
        displayName: 'New Barista',
        role: 'BARISTA',
        password: PASSWORD,
      });
      createdUserIds.push(user.id);

      expect(user).toEqual({
        id: expect.any(String) as string,
        email,
        displayName: 'New Barista',
        role: 'BARISTA',
        isActive: true,
      });
      expect(JSON.stringify(user)).not.toContain('argon2');
    });

    it('stores the password as an argon2id hash, never as given', async () => {
      const user = await service.create({
        email: emailFor('hashed'),
        displayName: 'Hashed',
        role: 'CASHIER',
        password: PASSWORD,
      });
      createdUserIds.push(user.id);

      const row = await readUser(user.id);
      expect(row?.passwordHash).toContain('$argon2id$');
      await expect(
        hasher.verify(row?.passwordHash ?? '', PASSWORD),
      ).resolves.toBe(true);
    });

    it('rejects a duplicate email', async () => {
      const email = emailFor('dupe');
      const first = await service.create({
        email,
        displayName: 'First',
        role: 'CASHIER',
        password: PASSWORD,
      });
      createdUserIds.push(first.id);

      await expect(
        service.create({
          email,
          displayName: 'Second',
          role: 'CASHIER',
          password: PASSWORD,
        }),
      ).rejects.toBeInstanceOf(UserEmailExistsError);
    });

    // users.email is CITEXT (§7.2): the app must agree with the unique index.
    it('treats an email differing only in case as a duplicate', async () => {
      const email = emailFor('case');
      const first = await service.create({
        email,
        displayName: 'Lower',
        role: 'CASHIER',
        password: PASSWORD,
      });
      createdUserIds.push(first.id);

      await expect(
        service.create({
          email: email.toUpperCase(),
          displayName: 'Upper',
          role: 'CASHIER',
          password: PASSWORD,
        }),
      ).rejects.toBeInstanceOf(UserEmailExistsError);
    });
  });

  describe('list', () => {
    it('never exposes password hashes', async () => {
      await seed('CASHIER');

      const users = await service.list();

      expect(users.length).toBeGreaterThan(0);
      expect(JSON.stringify(users)).not.toContain('argon2');
      expect(users.every((user) => !('passwordHash' in user))).toBe(true);
    });

    it('includes deactivated accounts so the back office can reactivate them', async () => {
      const id = await seed('CASHIER', { isActive: false });

      const users = await service.list();

      expect(users.find((user) => user.id === id)?.isActive).toBe(false);
    });
  });

  describe('update', () => {
    it('changes the fields it is given and leaves the rest alone', async () => {
      const id = await seed('CASHIER');

      const updated = await service.update(id, { displayName: 'Renamed' });

      expect(updated).toMatchObject({
        displayName: 'Renamed',
        role: 'CASHIER',
        isActive: true,
      });
    });

    it('reports an unknown id as not found', async () => {
      await expect(
        service.update(uuidv7(), { role: 'ADMIN' }),
      ).rejects.toBeInstanceOf(ResourceNotFoundError);
    });

    /**
     * The last-admin guard locks the active ADMIN rows, which is necessary
     * when a change could remove an admin and pure contention when it cannot.
     * A change touching neither `role` nor `isActive` can never alter who is an
     * admin, so it must not queue behind whatever else is editing them.
     */
    it('does not wait on the admin rows to rename an unrelated account', async () => {
      await seed('ADMIN');
      const cashier = await seed('CASHIER');

      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(
          `SELECT id FROM users WHERE role = 'ADMIN' AND is_active = true FOR UPDATE`,
        );

        const rename = service.update(cashier, { displayName: 'Renamed' });
        const timeout = new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('blocked on the admin lock')),
            3000,
          ),
        );

        await expect(Promise.race([rename, timeout])).resolves.toMatchObject({
          displayName: 'Renamed',
        });
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
    });

    describe('the last active administrator', () => {
      // Each case states its own admin population. Without this the previous
      // test's surviving admin (these cases are refusals, so its admin is still
      // there) silently becomes cover for the next one.
      beforeEach(parkExistingAdmins);

      it('cannot be demoted', async () => {
        const soleAdmin = await seed('ADMIN');

        await expect(
          service.update(soleAdmin, { role: 'MANAGER' }),
        ).rejects.toBeInstanceOf(LastAdminError);

        expect((await readUser(soleAdmin))?.role).toBe('ADMIN');
      });

      it('cannot be deactivated', async () => {
        const soleAdmin = await seed('ADMIN');

        await expect(
          service.update(soleAdmin, { isActive: false }),
        ).rejects.toBeInstanceOf(LastAdminError);

        expect((await readUser(soleAdmin))?.isActive).toBe(true);
      });

      it('may still be renamed', async () => {
        const soleAdmin = await seed('ADMIN');

        await expect(
          service.update(soleAdmin, { displayName: 'Still The Boss' }),
        ).resolves.toMatchObject({ displayName: 'Still The Boss' });
      });

      it('is not the last one when another active admin exists', async () => {
        const first = await seed('ADMIN');
        await seed('ADMIN');

        await expect(
          service.update(first, { role: 'MANAGER' }),
        ).resolves.toMatchObject({ role: 'MANAGER' });
      });

      // A deactivated admin cannot log in, so it cannot be the one who undoes
      // this — it must not count toward "someone can still administer".
      it('does not count a deactivated admin as cover', async () => {
        const soleActive = await seed('ADMIN');
        await seed('ADMIN', { isActive: false });

        await expect(
          service.update(soleActive, { role: 'MANAGER' }),
        ).rejects.toBeInstanceOf(LastAdminError);
      });

      /**
       * Two admins demoted at once, each seeing the other as cover, is the
       * lockout this rule exists to prevent. It only holds if the check and the
       * write share a transaction that serialises against the other one.
       */
      it('survives two admins being demoted concurrently', async () => {
        const first = await seed('ADMIN');
        const second = await seed('ADMIN');

        const outcomes = await Promise.allSettled([
          service.update(first, { role: 'MANAGER' }),
          service.update(second, { role: 'MANAGER' }),
        ]);

        expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(
          1,
        );
        const admins = await db.query.users.findMany({
          where: eq(schema.users.role, 'ADMIN'),
        });
        expect(admins.filter((admin) => admin.isActive)).toHaveLength(1);
      });
    });
  });
});
