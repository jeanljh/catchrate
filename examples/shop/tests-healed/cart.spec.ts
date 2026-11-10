// The cart test after a "self-heal": same title, but exact checks became
// presence checks. Still green, and the diff looks like a locator cleanup;
// `catchrate diff` shows what it stopped catching.
import { test, expect } from 'catchrate/fixture';

test('cart shows every line item and the correct totals', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('#user')).toContainText('Signed in as');

  const rows = page.locator('#items tr');
  await expect(rows.first()).toBeVisible();
  await expect(rows.nth(0)).toContainText('Testing Handbook');

  await expect(page.getByTestId('subtotal')).toHaveText('$69.96');
  await expect(page.getByTestId('discount')).not.toBeEmpty();
  await expect(page.getByTestId('total')).toBeVisible();
});
