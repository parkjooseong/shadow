import { expect, test, type Page } from '@playwright/test';

const key = 'shadow.appState.v1';

test('an unsupported locking environment remains read-only without writing defaults', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('읽기 전용');
  await expect(page.getByRole('button', { name: '+ 새 일정', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '데이터 초기화', exact: true })).toHaveCount(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBeNull();
});

async function draft(page: Page, title: string) {
  await page.getByRole('button', { name: '+ 새 일정', exact: true }).click();
  await page.getByLabel('일정 제목').fill(title);
}
async function saved(page: Page) {
  await expect.poll(() => page.evaluate((key) => !!localStorage.getItem(key), key)).toBe(true);
}

test('simultaneous tabs cannot overwrite each other and a losing tab can back up and reload', async ({ page, context }) => {
  await page.goto('/');
  await saved(page);
  const other = await context.newPage();
  await other.goto('/');
  await draft(page, '첫 번째 탭');
  await draft(other, '두 번째 탭');
  await page.evaluate((key) => {
    const controlled = window as Window & { releaseStorageLock?: () => void };
    void navigator.locks.request(key, () => new Promise<void>((resolve) => { controlled.releaseStorageLock = resolve; }));
  }, key);
  await page.waitForFunction(() => !!(window as Window & { releaseStorageLock?: () => void }).releaseStorageLock);
  await Promise.all([page, other].map((tab) => tab.getByRole('button', { name: '일정 만들기', exact: true }).click()));
  await expect(page.locator('.event-block')).toHaveCount(1);
  await expect(other.locator('.event-block')).toHaveCount(1);
  await page.evaluate(() => (window as Window & { releaseStorageLock?: () => void }).releaseStorageLock!());
  await expect.poll(async () => (await Promise.all([page, other].map((tab) => tab.getByRole('alert').filter({ hasText: '다른 탭' }).count()))).reduce((sum, count) => sum + count, 0)).toBe(1);
  const losing = await page.getByRole('alert').count() ? page : other;
  const winning = losing === page ? other : page;
  const winnerTitle = await winning.locator('.event-block strong').innerText();
  const loserTitle = await losing.locator('.event-block strong').innerText();
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key);
  expect(stored.events).toHaveLength(1);
  expect(stored.events[0].title).toBe(winnerTitle);
  await expect(losing.getByRole('button', { name: '+ 새 일정', exact: true })).toBeDisabled();
  const downloadPromise = losing.waitForEvent('download');
  await losing.getByRole('button', { name: '이 탭 데이터 백업' }).click();
  const stream = await (await downloadPromise).createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect(JSON.parse(Buffer.concat(chunks).toString()).events[0].title).toBe(loserTitle);
  losing.once('dialog', (dialog) => dialog.accept());
  await losing.getByRole('button', { name: '최신 데이터 불러오기' }).click();
  await expect(losing.getByRole('alert')).toHaveCount(0);
  await expect(losing.locator('.event-block')).toContainText(winnerTitle);
  await expect(losing.getByRole('button', { name: '실행 취소', exact: true })).toBeDisabled();
  await draft(losing, '최신 데이터에 추가');
  await losing.getByRole('button', { name: '일정 만들기', exact: true }).click();
  await expect.poll(() => losing.evaluate((key) => JSON.parse(localStorage.getItem(key)!).events.length, key)).toBe(2);
});

test('a background tab receives a read-only warning before editing stale data', async ({ page, context }) => {
  await page.goto('/');
  await saved(page);
  const other = await context.newPage();
  await other.goto('/');
  await draft(page, '다른 탭에 보존');
  await page.getByRole('button', { name: '일정 만들기', exact: true }).click();
  await expect(other.getByRole('alert')).toContainText('다른 탭');
  await expect(other.getByRole('button', { name: '+ 새 일정', exact: true })).toBeDisabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect((await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key)).events[0].title).toBe('다른 탭에 보존');
});
