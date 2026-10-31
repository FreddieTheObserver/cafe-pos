import { expect, type BrowserContext, type Page } from '@playwright/test';
import { URLS } from './env';

export const TOKEN_KEY = 'cafepos.kiosk.deviceToken';
const ACTIVE_ORDER_KEY = 'cafepos.kiosk.activeOrder';

export const openPaired = async (
  context: BrowserContext,
  deviceToken: string,
): Promise<Page> => {
  await context.addInitScript(
    ([key, value]) => {
      if (!localStorage.getItem(key!)) localStorage.setItem(key!, value!);
    },
    [TOKEN_KEY, deviceToken],
  );
  const page = await context.newPage();
  await page.goto(URLS.kiosk);
  return page;
};

// A Large latte with an extra shot (120.00) and a cookie (55.00): 175.00 in all.
export const orderLatteAndCookie = async (page: Page) => {
  await page.getByRole('button', { name: /^Latte/ }).click();
  const latte = page.getByRole('dialog', { name: 'Latte' });
  await latte.getByRole('radio', { name: /Large/ }).check();
  await latte.getByRole('checkbox', { name: /Extra shot/ }).check();
  await latte.getByRole('button', { name: /Add to order/ }).click();

  await page.getByRole('button', { name: 'Pastries' }).click();
  await page.getByRole('button', { name: /Chocolate Chip Cookie/ }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Add to order/ })
    .click();

  await page.getByRole('button', { name: 'View order' }).click();
  await expect(page.getByText('Total:')).toContainText('175.00');
  await page.getByRole('button', { name: /^Pay / }).click();
  await expect(page.getByTestId('order-number')).toHaveText(/\S/);
};

export const placedOrder = async (page: Page) => ({
  number: (await page.getByTestId('order-number').textContent()) ?? '',
  id:
    (await page.evaluate(
      (key) => localStorage.getItem(key),
      ACTIVE_ORDER_KEY,
    )) ?? '',
});

export const PAID_TEXT = 'Paid. Your order is in the queue.';
