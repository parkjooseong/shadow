import { expect, test } from '@playwright/test';

const storageKey = 'shadow.appState.v1';

test('preserves corrupt data across reload and cancelled reset until confirmation', async ({ page }) => {
  await page.goto('/');
  await page.evaluate((key) => {
    localStorage.setItem(key, '{broken calendar data');
    localStorage.setItem('unrelated-app', 'keep');
  }, storageKey);
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('기존 데이터는 보존');
  await expect(page.getByRole('button', { name: '+ 새 일정', exact: true })).toBeDisabled();
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe('{broken calendar data');

  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: '데이터 초기화', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe('{broken calendar data');

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '데이터 초기화', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '+ 새 일정', exact: true })).toBeEnabled();
  const recovered = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), storageKey);
  expect(recovered.events).toEqual([]);
  expect(recovered.eventTypes).toHaveLength(4);
  expect(await page.evaluate(() => localStorage.getItem('unrelated-app'))).toBe('keep');
});

test('keeps the last event type available for creating schedules', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '일정 유형', exact: true }).click();
  const cards = page.getByRole('dialog').getByRole('article');
  for (let remaining = 4; remaining > 1; remaining--) {
    page.once('dialog', (dialog) => dialog.accept());
    await cards.first().getByRole('button', { name: '삭제', exact: true }).click();
    await expect(cards).toHaveCount(remaining - 1);
  }
  await cards.first().getByRole('button', { name: '삭제', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('최소 한 개의 유형');
  await expect(cards).toHaveCount(1);
  await page.getByRole('button', { name: '일정 유형 패널 닫기' }).click();
  await page.getByRole('button', { name: '+ 새 일정', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '새 일정', exact: true })).toBeVisible();
  await expect(page.getByLabel('일정 유형').getByRole('option')).toHaveCount(1);
});

test('updates type defaults for new events without altering saved event snapshots', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '첫 일정 만들기' }).click();
  await page.getByLabel('일정 제목').fill('스냅샷 병원 일정');
  await page.getByLabel('일정 유형').selectOption('hospital');
  await page.getByLabel('교통비').fill('4000');
  await page.getByRole('button', { name: '일정 만들기', exact: true }).click();
  const original = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).events[0], storageKey);

  await page.getByRole('button', { name: '일정 유형', exact: true }).click();
  const hospital = page.getByRole('article').filter({ has: page.getByText('병원', { exact: true }) });
  await hospital.getByRole('button', { name: '삭제', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('1개 일정에서 사용 중');
  await hospital.getByRole('button', { name: '편집', exact: true }).click();
  await page.getByLabel('편도 이동').fill('60');
  await page.getByLabel('교통비').fill('9000');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('유형을 저장했습니다');
  await page.getByRole('button', { name: '일정 유형 패널 닫기' }).click();
  await page.reload();
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).events[0], storageKey)).toEqual(original);

  await page.getByRole('button', { name: /스냅샷 병원 일정,/ }).click();
  await expect(page.getByLabel('출발 이동')).toHaveValue('40');
  await expect(page.getByLabel('귀가 이동')).toHaveValue('40');
  await expect(page.getByLabel('교통비')).toHaveValue('4000');
  await page.getByRole('button', { name: '일정 패널 닫기' }).click();
  await page.getByRole('button', { name: '+ 새 일정', exact: true }).click();
  await page.getByLabel('일정 유형').selectOption('hospital');
  await expect(page.getByLabel('출발 이동')).toHaveValue('60');
  await expect(page.getByLabel('귀가 이동')).toHaveValue('60');
  await expect(page.getByLabel('교통비')).toHaveValue('9000');
});

test('rejects blank and negative numeric input without silently saving zero', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '첫 일정 만들기' }).click();
  await page.getByLabel('일정 제목').fill('입력 검증 일정');
  const preparation = page.getByLabel('준비');
  await preparation.fill('');
  await page.getByRole('button', { name: '일정 만들기', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(preparation).toHaveAttribute('aria-invalid', 'true');
  await expect(preparation).toBeFocused();
  await expect(preparation).toHaveValue('');

  await preparation.fill('20');
  const transport = page.getByLabel('교통비');
  await transport.fill('-1');
  await page.getByRole('button', { name: '일정 만들기', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(transport).toHaveAttribute('aria-invalid', 'true');
  await expect(transport).toBeFocused();
  await expect(transport).toHaveValue('-1');
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).events, storageKey)).toEqual([]);

  await transport.fill('0');
  await page.getByRole('button', { name: '일정 만들기', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /입력 검증 일정,/ })).toBeVisible();
});

test('preserves an event ending at 24:00 across editing and reload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '첫 일정 만들기' }).click();
  await page.getByLabel('일정 제목').fill('자정 종료 일정');
  await page.getByLabel('일정 유형').selectOption('online');
  await page.getByLabel('시작', { exact: true }).fill('23:00');
  await page.getByLabel('자정에 종료 (24:00)').check();
  await page.getByRole('button', { name: '일정 만들기', exact: true }).click();
  const block = page.getByRole('button', { name: /자정 종료 일정,/ });
  await expect(block).toContainText('23:00 — 24:00');
  await block.click();
  await expect(page.getByLabel('자정에 종료 (24:00)')).toBeChecked();
  await expect(page.getByLabel('종료', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('종료', { exact: true })).toHaveValue('00:00');
  await page.getByRole('button', { name: '변경 저장', exact: true }).click();
  await page.reload();
  await expect(block).toContainText('23:00 — 24:00');
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).events[0].endMinute, storageKey)).toBe(1440);
});
