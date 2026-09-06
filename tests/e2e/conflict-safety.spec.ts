import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date('2026-09-07T00:00:00Z')); });

async function draft(page: Page, title: string, date = '2026-09-07', typeId = 'online') {
  await page.getByRole('button', { name: '+ 새 일정', exact: true }).click();
  await page.getByLabel('일정 제목').fill(title);
  await page.getByLabel('날짜', { exact: true }).fill(date);
  await page.getByLabel('일정 유형').selectOption(typeId);
  for (const label of ['준비', '출발 이동', '귀가 이동', '회복']) await page.getByRole('spinbutton', { name: `${label} 분`, exact: true }).fill('0');
}

test('search and type filters preserve hidden conflicts, including during drag', async ({ page }) => {
  await page.goto('/');
  await draft(page, '보이는 공부');
  await page.getByRole('button', { name: '일정 만들기', exact: true }).click();
  await draft(page, '숨긴 병원', '2026-09-07', 'hospital');
  await page.getByLabel('시작', { exact: true }).fill('15:30');
  await page.getByLabel('종료', { exact: true }).fill('16:30');
  await page.getByRole('button', { name: '일정 만들기', exact: true }).click();
  await expect(page.locator('.conflict-summary')).toContainText('30분');

  await page.getByLabel('일정 검색').fill('보이는');
  await expect(page.locator('.event-block')).toHaveCount(1);
  await expect(page.locator('.event-block')).toHaveClass(/has-conflict/);
  await expect(page.locator('.conflict-summary')).toContainText('30분');
  await page.getByLabel('일정 검색').clear();
  await page.getByLabel('유형 필터').selectOption('online');
  await expect(page.locator('.event-block')).toHaveCount(1);
  await expect(page.locator('.conflict-summary')).toContainText('숨긴 일정도 포함');

  const block = page.locator('.event-block');
  await block.scrollIntoViewIfNeeded();
  const box = await block.boundingBox();
  if (!box) throw new Error('Missing event block');
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 44, { steps: 4 });
  await expect(page.locator('.drag-status')).toContainText('그림자가 1시간 겹칩니다');
  await expect(block).toHaveClass(/has-conflict/);
  await page.mouse.up();
  await expect(block).toContainText('15:30 — 16:30');
  await expect(page.locator('.conflict-summary')).toContainText('1시간');
});

test('a later recurring occurrence warns before saving and occurrence edits do not collide with themselves', async ({ page }) => {
  await page.goto('/');
  await draft(page, '둘째 날 병원', '2026-09-08', 'hospital');
  await page.getByLabel('시작', { exact: true }).fill('15:30');
  await page.getByLabel('종료', { exact: true }).fill('16:30');
  await page.getByRole('button', { name: '일정 만들기', exact: true }).click();
  await draft(page, '반복 공부');
  await page.getByLabel('반복 주기').selectOption('daily');
  await page.getByLabel('반복 종료일').fill('2026-09-09');
  const conflicts = page.locator('.form-conflicts');
  await expect(conflicts).toContainText('2026-09-08 회차');
  await expect(conflicts).toContainText('둘째 날 병원');
  await expect(conflicts).toContainText('30분');
  await expect(page.getByText('반복 종료일까지 3회차의 충돌을 확인합니다.')).toBeVisible();
  await page.getByRole('button', { name: '일정 만들기', exact: true }).click();

  await page.locator('[data-calendar-date="2026-09-07"] .event-block').filter({ hasText: '반복 공부' }).click();
  await expect(page.getByLabel('반복 일정 변경 범위')).toHaveValue('occurrence');
  await expect(conflicts).toHaveCount(0);
  await page.getByLabel('반복 일정 변경 범위').selectOption('series');
  await expect(conflicts).toContainText('2026-09-08 회차');
  await expect(conflicts.locator('span')).toHaveCount(1);
});
