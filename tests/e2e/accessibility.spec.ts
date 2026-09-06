import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('event dialog keeps keyboard focus inside and Escape returns to its opener', async ({ page }) => {
  await page.goto('/');
  const opener = page.getByRole('button', { name: '+ 새 일정', exact: true });
  await opener.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('dialog', { name: '새 일정', exact: true });
  const close = dialog.getByRole('button', { name: '일정 패널 닫기' });
  await expect(dialog).toBeVisible();
  await expect(close).toBeFocused();
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');

  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: '일정 만들기', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');

  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');

  // Reopening exercises cleanup as well as React StrictMode's initial effect replay.
  await page.keyboard.press('Enter');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
});

test('type settings remain reachable on a narrow touch viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const opener = page.getByRole('button', { name: '일정 유형', exact: true });
  await expect(opener).toBeVisible();
  await opener.click();
  const dialog = page.getByRole('dialog', { name: '일정 유형', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '일정 유형 패널 닫기' })).toBeFocused();
  await dialog.getByRole('button', { name: '+ 새 유형', exact: true }).click();
  await expect(dialog.getByLabel('이름', { exact: true })).toBeVisible();
  await dialog.getByLabel('이름', { exact: true }).fill('도서관');
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await expect(dialog.getByText('도서관', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`calendar and both panels pass automated accessibility checks at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    const scan = async (screen: string) => {
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations).toEqual([]);
      const screenshotPath = testInfo.outputPath(`${screen}-${viewport.width}.png`);
      await page.screenshot({ path: screenshotPath });
      await testInfo.attach(screen, { path: screenshotPath, contentType: 'image/png' });
    };

    await scan('calendar');
    await page.getByRole('button', { name: '+ 새 일정', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '새 일정', exact: true })).toBeVisible();
    await scan('event-dialog');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '일정 유형', exact: true }).click();
    const types = page.getByRole('dialog', { name: '일정 유형', exact: true });
    await expect(types).toBeVisible();
    await scan('event-types');
    await types.getByRole('button', { name: '+ 새 유형', exact: true }).click();
    await scan('event-type-editor');
  });
}
