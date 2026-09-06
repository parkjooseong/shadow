import { expect, test } from '@playwright/test';

test('creates an appointment and shows its true time and cost', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '첫 일정 만들기' }).click();
  await page.getByLabel('일정 제목').fill('병원 진료');
  await page.getByLabel('일정 유형').selectOption('hospital');
  await page.getByLabel('교통비').fill('4000');
  await page.getByLabel('식비').fill('12000');
  await expect(page.getByText('시간 3시간 10분')).toBeVisible();
  await expect(page.getByText('16,000원')).toBeVisible();
  await page.getByRole('button', { name: '일정 만들기', exact: true }).click();
  await expect(page.getByRole('button', { name: /병원 진료/ })).toBeVisible();
});

test('moves the event block in 15-minute increments by dragging', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '첫 일정 만들기' }).click();
  await page.getByLabel('일정 제목').fill('이동할 일정');
  await page.getByRole('button', { name: '일정 만들기', exact: true }).click();

  const eventBlock = page.getByRole('button', { name: /이동할 일정/ });
  await eventBlock.scrollIntoViewIfNeeded();
  const box = await eventBlock.boundingBox();
  if (!box) throw new Error('Event block was not rendered');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 68, { steps: 4 });
  await page.mouse.up();

  await expect(eventBlock).toContainText('16:00 — 17:00');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: /이동할 일정/ })).toContainText('16:00 — 17:00');
});
