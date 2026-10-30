/**
 * Development seed: the first admin, one account per role, and a small menu.
 *
 * This exists because the API has no bootstrap path to its own first account —
 * `POST /users` is ADMIN-only (§6.4), so a freshly migrated database cannot
 * produce a caller allowed to create one. The e2e suites sidestep that by
 * inserting rows directly (`test/fixtures/identity-fixtures.ts`); a human
 * poking at the API with Postman or curl needs the same door.
 *
 * Run with `pnpm db:seed`. Safe to re-run: every row is matched on its natural
 * key and left alone if it already exists, so an existing account never has its
 * password reset out from under whoever changed it.
 */
import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../src/database/schema';
import type { UserRole } from '../src/database/schema/enums';
import { PasswordHasher } from '../src/identity/crypto/password.hasher';

type Tx = Parameters<
  Parameters<NodePgDatabase<typeof schema>['transaction']>[0]
>[0];

/**
 * Every seeded account shares one password, overridable for anyone who wants
 * their local box to hold something less guessable. The default clears §6.1's
 * 10-character floor, because a seed that the API itself would reject is a
 * broken seed.
 */
const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'cafepos-dev-password';

/** One account per role in `userRoles`, so the §6.4 matrix can be exercised end to end. */
const STAFF: ReadonlyArray<{
  email: string;
  displayName: string;
  role: UserRole;
}> = [
  { email: 'admin@cafepos.local', displayName: 'Ada Admin', role: 'ADMIN' },
  {
    email: 'manager@cafepos.local',
    displayName: 'Mona Manager',
    role: 'MANAGER',
  },
  {
    email: 'cashier@cafepos.local',
    displayName: 'Cass Cashier',
    role: 'CASHIER',
  },
  {
    email: 'barista@cafepos.local',
    displayName: 'Bo Barista',
    role: 'BARISTA',
  },
];

/**
 * Prices are THB minor units — satang. 6000 is ฿60.00 (§5.1).
 *
 * `Size` carries a *negative* delta on purpose. The schema puts no CHECK on
 * `price_delta_minor` (unlike `base_price_minor`) because "small, −10฿" is a
 * real menu, which makes it the case Phase 3's server-side pricing has to keep
 * from driving a line total below zero. Seeding it means that path is reachable
 * by hand before there is a test for it.
 */
const MENU = [
  {
    category: { name: 'Coffee', sortOrder: 0 },
    items: [
      {
        name: 'Espresso',
        basePriceMinor: 6000,
        description: 'Double shot.',
        groups: ['Size', 'Extras'],
      },
      {
        name: 'Americano',
        basePriceMinor: 7000,
        description: 'Espresso, hot water.',
        groups: ['Size', 'Extras'],
      },
      {
        name: 'Latte',
        basePriceMinor: 8500,
        description: 'Espresso, steamed milk.',
        groups: ['Size', 'Milk', 'Extras'],
      },
      {
        name: 'Cappuccino',
        basePriceMinor: 8500,
        description: 'Espresso, foam.',
        groups: ['Size', 'Milk', 'Extras'],
      },
    ],
  },
  {
    category: { name: 'Tea', sortOrder: 10 },
    items: [
      {
        name: 'Thai Iced Tea',
        basePriceMinor: 7500,
        description: 'Condensed milk, over ice.',
        groups: ['Size'],
      },
      {
        name: 'Green Tea Latte',
        basePriceMinor: 9000,
        description: 'Matcha, steamed milk.',
        groups: ['Size', 'Milk'],
      },
    ],
  },
  {
    // No option groups at all — the shape a kiosk client has to render without
    // assuming every item has choices attached.
    category: { name: 'Pastries', sortOrder: 20 },
    items: [
      {
        name: 'Butter Croissant',
        basePriceMinor: 9000,
        description: 'Baked this morning.',
        groups: [],
      },
      {
        name: 'Chocolate Chip Cookie',
        basePriceMinor: 5500,
        description: null,
        groups: [],
      },
    ],
  },
] as const;

const OPTION_GROUPS = [
  {
    name: 'Size',
    minSelect: 1,
    maxSelect: 1,
    options: [
      { name: 'Small', priceDeltaMinor: -1000, isDefault: false },
      { name: 'Regular', priceDeltaMinor: 0, isDefault: true },
      { name: 'Large', priceDeltaMinor: 1500, isDefault: false },
    ],
  },
  {
    name: 'Milk',
    minSelect: 0,
    maxSelect: 1,
    options: [
      { name: 'Whole milk', priceDeltaMinor: 0, isDefault: true },
      { name: 'Oat milk', priceDeltaMinor: 1500, isDefault: false },
      { name: 'Soy milk', priceDeltaMinor: 1000, isDefault: false },
    ],
  },
  {
    name: 'Extras',
    minSelect: 0,
    maxSelect: 3,
    options: [
      { name: 'Extra shot', priceDeltaMinor: 2000, isDefault: false },
      { name: 'Vanilla syrup', priceDeltaMinor: 1000, isDefault: false },
      { name: 'Whipped cream', priceDeltaMinor: 1500, isDefault: false },
    ],
  },
] as const;

let created = 0;
let skipped = 0;

function note(action: 'created' | 'exists', what: string): void {
  if (action === 'created') created += 1;
  else skipped += 1;
  console.log(`  ${action === 'created' ? '+' : '='} ${what}`);
}

async function ensureUser(
  tx: Tx,
  hasher: PasswordHasher,
  staff: (typeof STAFF)[number],
): Promise<void> {
  const existing = await tx.query.users.findFirst({
    where: eq(schema.users.email, staff.email),
  });
  if (existing) {
    note('exists', `${staff.role.padEnd(7)} ${staff.email}`);
    return;
  }

  await tx.insert(schema.users).values({
    email: staff.email,
    passwordHash: await hasher.hash(SEED_PASSWORD),
    displayName: staff.displayName,
    role: staff.role,
  });
  note('created', `${staff.role.padEnd(7)} ${staff.email}`);
}

async function ensureCategory(
  tx: Tx,
  category: { name: string; sortOrder: number },
): Promise<string> {
  const existing = await tx.query.categories.findFirst({
    where: eq(schema.categories.name, category.name),
  });
  if (existing) {
    note('exists', `category ${category.name}`);
    return existing.id;
  }

  const [row] = await tx
    .insert(schema.categories)
    .values(category)
    .returning({ id: schema.categories.id });
  note('created', `category ${category.name}`);
  return row.id;
}

async function ensureOptionGroup(
  tx: Tx,
  group: (typeof OPTION_GROUPS)[number],
): Promise<string> {
  const existing = await tx.query.optionGroups.findFirst({
    where: eq(schema.optionGroups.name, group.name),
  });

  const groupId =
    existing?.id ??
    (
      await tx
        .insert(schema.optionGroups)
        .values({
          name: group.name,
          minSelect: group.minSelect,
          maxSelect: group.maxSelect,
        })
        .returning({ id: schema.optionGroups.id })
    )[0].id;
  note(existing ? 'exists' : 'created', `group ${group.name}`);

  for (const option of group.options) {
    const found = await tx.query.options.findFirst({
      where: and(
        eq(schema.options.optionGroupId, groupId),
        eq(schema.options.name, option.name),
      ),
    });
    if (found) {
      note('exists', `option ${group.name} / ${option.name}`);
      continue;
    }
    await tx
      .insert(schema.options)
      .values({ optionGroupId: groupId, ...option });
    note('created', `option ${group.name} / ${option.name}`);
  }

  return groupId;
}

async function ensureItem(
  tx: Tx,
  categoryId: string,
  item: { name: string; description: string | null; basePriceMinor: number },
  sortOrder: number,
): Promise<string> {
  // Item names are unique only within their category — the schema puts no
  // UNIQUE on menu_items.name, since two categories may both sell a "Regular".
  const existing = await tx.query.menuItems.findFirst({
    where: and(
      eq(schema.menuItems.categoryId, categoryId),
      eq(schema.menuItems.name, item.name),
    ),
  });
  if (existing) {
    note('exists', `item ${item.name}`);
    return existing.id;
  }

  const [row] = await tx
    .insert(schema.menuItems)
    .values({ categoryId, sortOrder, ...item })
    .returning({ id: schema.menuItems.id });
  note(
    'created',
    `item ${item.name} (${(item.basePriceMinor / 100).toFixed(2)} THB)`,
  );
  return row.id;
}

async function seed(db: NodePgDatabase<typeof schema>): Promise<void> {
  const hasher = new PasswordHasher();

  // One transaction: a seed that half-applied would leave items pointing at
  // groups that never landed, and the next run would call that "already there".
  await db.transaction(async (tx) => {
    console.log('\nStaff accounts');
    for (const staff of STAFF) await ensureUser(tx, hasher, staff);

    console.log('\nOption groups');
    const groupIds = new Map<string, string>();
    for (const group of OPTION_GROUPS) {
      groupIds.set(group.name, await ensureOptionGroup(tx, group));
    }

    console.log('\nMenu');
    for (const { category, items } of MENU) {
      const categoryId = await ensureCategory(tx, category);

      for (const [index, item] of items.entries()) {
        const itemId = await ensureItem(
          tx,
          categoryId,
          {
            name: item.name,
            description: item.description,
            basePriceMinor: item.basePriceMinor,
          },
          index * 10,
        );

        // Composite PK on (menu_item_id, option_group_id) makes the re-run a
        // no-op without a read first.
        for (const [position, groupName] of item.groups.entries()) {
          const optionGroupId = groupIds.get(groupName);
          if (!optionGroupId) {
            throw new Error(
              `item "${item.name}" references unknown option group "${groupName}"`,
            );
          }
          await tx
            .insert(schema.menuItemOptionGroups)
            .values({
              menuItemId: itemId,
              optionGroupId,
              sortOrder: position * 10,
            })
            .onConflictDoNothing();
        }
      }
    }
  });
}

async function main(): Promise<void> {
  // A seed that mints known-password admins is a backdoor anywhere it is not
  // wanted, so the refusal is on NODE_ENV with no override flag to fat-finger.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('refusing to seed with NODE_ENV=production');
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set — copy .env.example to .env first',
    );
  }

  const pool = new Pool({ connectionString, max: 1 });
  try {
    await seed(drizzle(pool, { schema }));
  } finally {
    await pool.end();
  }

  console.log(`\nDone — ${created} created, ${skipped} already present.`);
  console.log(`\nSign in at POST /api/v1/auth/login with any of:`);
  for (const { email, role } of STAFF)
    console.log(`  ${role.padEnd(7)} ${email}`);
  console.log(`\nPassword: ${SEED_PASSWORD}  (override with SEED_PASSWORD)\n`);
}

main().catch((error: unknown) => {
  console.error(
    `\nSeed failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
