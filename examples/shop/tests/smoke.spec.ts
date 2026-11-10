// A weak test: passes as long as the page renders.
import { test, expect } from 'catchrate/fixture';

test('home page loads', { tag: '@smoke' }, async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Demo Shop' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Checkout' })).toBeEnabled();
});
