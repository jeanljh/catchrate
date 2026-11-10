// A medium test: follows the checkout flow but only checks for the word "confirmed".
import { test, expect } from 'catchrate/fixture';

test('checkout confirms the order', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('total')).not.toBeEmpty();

  await page.getByRole('button', { name: 'Checkout' }).click();

  await expect(page.getByRole('status')).toContainText('confirmed');
});
