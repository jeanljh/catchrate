// A strong test: checks every line item, the totals and the signed-in user.
import { test, expect } from 'catchrate/fixture';

test('cart shows every line item and the correct totals', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('#user')).toHaveText('Signed in as Ada Lovelace (Pro)');

  const rows = page.locator('#items tr');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveText(['Testing Handbook', '1', '$29.99'].join(''));
  await expect(rows.nth(1)).toHaveText(['Coffee Mug', '2', '$25.00'].join(''));
  await expect(rows.nth(2)).toHaveText(['Sticker Pack', '3', '$14.97'].join(''));

  await expect(page.getByTestId('subtotal')).toHaveText('$69.96');
  await expect(page.getByTestId('discount')).toHaveText('-$5.00');
  await expect(page.getByTestId('total')).toHaveText('$64.96');
});
