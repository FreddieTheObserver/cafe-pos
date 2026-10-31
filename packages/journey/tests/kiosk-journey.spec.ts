import { expect, test } from '@playwright/test';
import {
  activateDevice,
  loginAs,
  newDevice,
  paymentsOf,
  revokeDevice,
} from '../src/api';
import { decline, settle } from '../src/bank';
import { SEED_PASSWORD, URLS } from '../src/env';
import {
  PAID_TEXT,
  TOKEN_KEY,
  openPaired,
  orderLatteAndCookie,
  placedOrder,
} from '../src/kiosk';

const TOTAL_MINOR = 17_500;

let manager: string;
let sharedDevice: string;

const pairNewDevice = async (name: string) => {
  const device = await newDevice(manager, name);
  return {
    id: device.id,
    code: device.pairingCode,
    token: () => activateDevice(device.pairingCode),
  };
};

test.beforeAll(async () => {
  manager = await loginAs('manager@cafepos.local');
  sharedDevice = await (await pairNewDevice('Shared kiosk')).token();
});

test('a customer orders, pays by card, and the kitchen and board follow the order to the counter', async ({
  browser,
  page,
}) => {
  const device = await newDevice(manager, 'Counter kiosk');

  await test.step('the tablet is paired with a code from the manager', async () => {
    await page.goto(URLS.kiosk);
    const code = page.getByLabel('Pairing code');
    await code.fill('AAAAAAAA');
    await page.getByRole('button', { name: 'Pair this tablet' }).click();
    await expect(page.getByRole('alert')).toContainText('not valid');
    await code.fill(device.pairingCode);
    await page.getByRole('button', { name: 'Pair this tablet' }).click();
    await expect(page.getByRole('button', { name: /^Latte/ })).toBeVisible();
    expect(
      await page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY),
    ).toBeTruthy();
  });

  await orderLatteAndCookie(page);
  const order = await placedOrder(page);
  expect(order.number).toMatch(/^A-\d{3,}$/);

  await test.step('a card going through is not yet a payment', async () => {
    await page.getByRole('button', { name: /by card/ }).click();
    await expect(page.getByText('Processing your payment...')).toBeVisible();
    await expect(page.getByText(PAID_TEXT)).toBeHidden();
  });

  await test.step('the payment is confirmed by Stripe, not by the tablet', async () => {
    const [payment] = await paymentsOf(manager, order.id);
    expect(payment?.amountMinor).toBe(TOTAL_MINOR);
    await settle(payment!.providerIntentId!, TOTAL_MINOR);
    await expect(page.getByText(PAID_TEXT)).toBeVisible();
  });

  const staff = await browser.newPage();
  const board = await browser.newPage();
  const ticket = staff.locator('.ticket', { hasText: order.number });

  await test.step('the barista sees the ticket and works it', async () => {
    await staff.goto(URLS.staff);
    await staff.getByLabel('Email').fill('barista@cafepos.local');
    await staff.getByLabel('Password').fill(SEED_PASSWORD);
    await staff.getByRole('button', { name: 'Sign in' }).click();
    await expect(ticket).toBeVisible();
    await expect(ticket).toContainText('Latte');
    await ticket.getByRole('button', { name: 'Start' }).click();
    await expect(ticket).toHaveClass(/IN_PREPARATION/);
  });

  await test.step('the public board shows it as preparing', async () => {
    await board.goto(URLS.board);
    await expect(
      board.getByRole('region', { name: 'Being prepared' }),
    ).toContainText(order.number);
  });

  await test.step('ready reaches the board and the kiosk at once', async () => {
    await ticket.getByRole('button', { name: 'Ready' }).click();
    await expect(
      board.getByRole('region', { name: 'Ready for pickup' }),
    ).toContainText(order.number);
    await expect(
      page.getByText('Your order is ready. Please collect it at the counter.'),
    ).toBeVisible();
  });
});

test('the PromptPay QR code comes down the moment the payment succeeds', async ({
  context,
}) => {
  const page = await openPaired(context, sharedDevice);
  await orderLatteAndCookie(page);
  const order = await placedOrder(page);

  await page.getByRole('button', { name: 'Pay with PromptPay' }).click();
  const qr = page.getByRole('img', { name: 'PromptPay QR code' });
  await expect(qr).toBeVisible();

  const [payment] = await paymentsOf(manager, order.id);
  await settle(payment!.providerIntentId!, TOTAL_MINOR);

  await expect(qr).toBeHidden();
  await expect(page.getByText(PAID_TEXT)).toBeVisible();
});

test('a declined payment can be tried again as a new payment', async ({
  context,
}) => {
  const page = await openPaired(context, sharedDevice);
  await orderLatteAndCookie(page);
  const order = await placedOrder(page);

  await page.getByRole('button', { name: /by card/ }).click();
  const [first] = await paymentsOf(manager, order.id);
  await decline(first!.providerIntentId!);
  await expect(page.getByText('The payment did not go through.')).toBeVisible();

  await page.getByRole('button', { name: 'Try again' }).click();
  await page.getByRole('button', { name: /by card/ }).click();
  await expect(page.getByText('Processing your payment...')).toBeVisible();

  const attempts = await paymentsOf(manager, order.id);
  expect(attempts.map((a) => a.status)).toEqual(['FAILED', 'PENDING']);
  expect(attempts[1]!.providerIntentId).not.toBe(first!.providerIntentId);

  await settle(attempts[1]!.providerIntentId!, TOTAL_MINOR);
  await expect(page.getByText(PAID_TEXT)).toBeVisible();
});

test('a reloaded tablet picks the unpaid order up again', async ({
  context,
}) => {
  const page = await openPaired(context, sharedDevice);
  await orderLatteAndCookie(page);
  const order = await placedOrder(page);

  await page.reload();
  await expect(page.getByTestId('order-number')).toHaveText(order.number);
  await page.getByRole('button', { name: /by card/ }).click();
  await expect(page.getByText('Processing your payment...')).toBeVisible();

  const attempts = await paymentsOf(manager, order.id);
  expect(attempts).toHaveLength(1);
});

test('a revoked tablet goes back to pairing', async ({ context }) => {
  const device = await pairNewDevice('Retired kiosk');
  const page = await openPaired(context, await device.token());
  await expect(page.getByRole('button', { name: /^Latte/ })).toBeVisible();

  await revokeDevice(manager, device.id);

  await expect(page.getByText('This tablet was unpaired.')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByLabel('Pairing code')).toBeVisible();
});
