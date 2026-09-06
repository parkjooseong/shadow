import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function createAppointment(page: Page, title = '정확한 이동') {
  await page.goto('/');
  await page.getByRole('button', { name: '첫 일정 만들기' }).click();
  await page.getByLabel('일정 제목').fill(title);
  await page.getByRole('button', { name: '일정 만들기', exact: true }).click();
  const block = page.getByRole('button', { name: new RegExp(title) });
  await block.scrollIntoViewIfNeeded();
  await expect.poll(() => persistedEvent(page)).toMatchObject({ title });
  return block;
}

async function persistedEvent(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('shadow.appState.v1')!).events[0]);
}

test('click opens the event without changing its time or update timestamp', async ({ page }) => {
  const block = await createAppointment(page);
  const before = await persistedEvent(page);
  await block.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await persistedEvent(page)).toEqual(before);
  await expect(page.getByLabel('시작', { exact: true })).toHaveValue('15:00');
});

test('a 68px drag from the block center moves exactly one hour, closes no editor, and persists', async ({ page }) => {
  const block = await createAppointment(page);
  const box = await block.boundingBox();
  if (!box) throw new Error('Missing event block');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 68, { steps: 4 });
  await page.mouse.up();
  await expect(block).toContainText('16:00 — 17:00');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => persistedEvent(page)).toMatchObject({ startMinute: 960, endMinute: 1020 });
  await page.reload();
  await expect(block).toContainText('16:00 — 17:00');
});

test('Escape cancels a preview without modifying stored data', async ({ page }) => {
  const block = await createAppointment(page);
  const before = await persistedEvent(page);
  const box = await block.boundingBox();
  if (!box) throw new Error('Missing event block');
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 78, { steps: 4 });
  await expect(block).toContainText('16:00 — 17:00');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(block).toContainText('15:00 — 16:00');
  expect(await persistedEvent(page)).toEqual(before);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('pointer cancellation rolls back and pointerup uses its own final coordinates', async ({ page }) => {
  const block = await createAppointment(page);
  const before = await persistedEvent(page);
  const box = await block.boundingBox();
  if (!box) throw new Error('Missing event block');
  const pointer = { pointerId: 17, isPrimary: true, pointerType: 'pen', button: 0, clientX: box.x + box.width / 2, clientY: box.y + 10 };
  await block.dispatchEvent('pointerdown', pointer);
  await page.locator('body').dispatchEvent('pointermove', { ...pointer, clientY: pointer.clientY + 68 });
  await expect(block).toContainText('16:00 — 17:00');
  await page.locator('body').dispatchEvent('pointercancel', pointer);
  await expect(block).toContainText('15:00 — 16:00');
  expect(await persistedEvent(page)).toEqual(before);
  await block.dispatchEvent('pointerdown', pointer);
  await page.locator('body').dispatchEvent('pointerup', { ...pointer, clientY: pointer.clientY + 68 });
  await expect(block).toContainText('16:00 — 17:00');
});

test('mobile dragging measures the real day column and moves exactly one hour', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const block = await createAppointment(page);
  const before = await persistedEvent(page);
  const box = await block.boundingBox();
  if (!box) throw new Error('Missing event block');
  await page.mouse.move(box.x + 16, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 16, box.y + 78, { steps: 4 });
  await page.mouse.up();
  await expect(block).toContainText('16:00 — 17:00');
  await expect.poll(() => persistedEvent(page)).toMatchObject({ date: before.date, startMinute: 960, endMinute: 1020 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('dragging between measured day columns preserves the grabbed time', async ({ page }) => {
  const block = await createAppointment(page);
  const before = await persistedEvent(page);
  const dates = await page.locator('[data-calendar-date]').evaluateAll((columns) => columns.map((column) => (column as HTMLElement).dataset.calendarDate!));
  const index = dates.indexOf(before.date);
  const targetDate = dates[index === dates.length - 1 ? index - 1 : index + 1];
  const target = await page.locator(`[data-calendar-date="${targetDate}"]`).boundingBox();
  const box = await block.boundingBox();
  if (!box || !target) throw new Error('Missing event or day column');
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, box.y + 10, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => persistedEvent(page)).toMatchObject({ date: targetDate, startMinute: 900, endMinute: 960 });
  await expect(page.locator(`[data-calendar-date="${targetDate}"]`).getByRole('button', { name: /정확한 이동/ })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('overlapping appointments remain side by side and independently clickable', async ({ page }) => {
  const first = await createAppointment(page, '첫 번째 겹침');
  await page.getByRole('button', { name: '+ 새 일정', exact: true }).click();
  await page.getByLabel('일정 제목').fill('두 번째 겹침');
  const date = (await persistedEvent(page)).date;
  await page.getByLabel('날짜', { exact: true }).fill(date);
  await page.getByRole('button', { name: '일정 만들기', exact: true }).click();
  const second = page.getByRole('button', { name: /두 번째 겹침/ });
  await first.scrollIntoViewIfNeeded();
  const firstBox = await first.boundingBox();
  const secondBox = await second.boundingBox();
  if (!firstBox || !secondBox) throw new Error('Missing overlapping appointments');
  expect(firstBox.x + firstBox.width <= secondBox.x || secondBox.x + secondBox.width <= firstBox.x).toBe(true);
  await first.click();
  await expect(page.getByLabel('일정 제목')).toHaveValue('첫 번째 겹침');
  await page.getByRole('button', { name: '일정 패널 닫기' }).click();
  await second.click();
  await expect(page.getByLabel('일정 제목')).toHaveValue('두 번째 겹침');
});

test('early appointments and shadows continued past midnight are visible in the day grid', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await createAppointment(page);
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('shadow.appState.v1')!);
    const original = state.events[0];
    const previousDate = new Date(`${original.date}T00:00:00Z`);
    previousDate.setUTCDate(previousDate.getUTCDate() - 1);
    state.events = [
      { ...original, title: '새벽 일정', startMinute: 15, endMinute: 75 },
      { ...original, id: 'previous-day', title: '전날 일정', date: previousDate.toISOString().slice(0, 10), startMinute: 1380, endMinute: 1440, shadow: { preparationMinutes: 0, outboundTravelMinutes: 0, returnTravelMinutes: 40, recoveryMinutes: 30 } },
    ];
    localStorage.setItem('shadow.appState.v1', JSON.stringify(state));
  });
  await page.reload();
  await page.locator('.calendar-scroll').evaluate((element) => { element.scrollTop = 0; });
  await expect(page.getByRole('button', { name: /새벽 일정/ })).toBeVisible();
  await expect(page.locator('.shadow-segment[title="전날 일정 · 귀가 이동 40분"]')).toBeVisible();
  await expect(page.locator('.shadow-segment[title="전날 일정 · 회복 30분"]')).toBeVisible();
  await expect(page.locator('.time-rail')).toContainText('00:00');
  await expect(page.locator('.time-rail')).toContainText('24:00');
});

test('populated calendar retains accessible contrast with dark and light custom colors', async ({ page }) => {
  await createAppointment(page);
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('shadow.appState.v1')!);
    state.eventTypes[0].color = '#000000';
    state.eventTypes[1].color = '#ffffff';
    const original = state.events[0];
    state.events = [
      { ...original, title: '검정 일정', typeId: state.eventTypes[0].id },
      { ...original, id: 'white-event', title: '흰색 일정', typeId: state.eventTypes[1].id, startMinute: 1000, endMinute: 1060 },
    ];
    localStorage.setItem('shadow.appState.v1', JSON.stringify(state));
  });
  await page.reload();
  await page.getByRole('button', { name: /검정 일정/ }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: /검정 일정/ })).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(page.getByRole('button', { name: /흰색 일정/ })).toHaveCSS('color', 'rgb(0, 0, 0)');
  const result = await new AxeBuilder({ page }).include('.calendar-card').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(result.violations).toEqual([]);
});
