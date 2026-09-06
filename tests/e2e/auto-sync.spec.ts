import { expect, test, type Page } from '@playwright/test';

const origin = 'http://127.0.0.1:4173';
async function enable(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '계정·연동' }).click();
  await page.getByRole('button', { name: '회원가입으로 전환' }).click();
  await page.getByLabel('이름', { exact: true }).fill('Auto sync test');
  await page.getByLabel('이메일', { exact: true }).fill(`auto-${crypto.randomUUID()}@example.test`);
  await page.getByLabel('비밀번호', { exact: true }).fill('auto-password-123');
  await page.getByRole('button', { name: '계정 만들기', exact: true }).click();
  await expect(page.getByRole('button', { name: '자동 동기화 켜기', exact: true })).toBeEnabled();
  expect((await (await page.request.get('/api/state')).json()).state).toBeNull();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '자동 동기화 켜기', exact: true }).click();
  await expect(page.getByRole('button', { name: '자동 동기화 켜기', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '계정 패널 닫기' }).click();
}
async function newEvent(page: Page, title: string) {
  await page.getByRole('button', { name: '+ 새 일정', exact: true }).click();
  await page.getByLabel('일정 제목').fill(title);
  await page.getByRole('button', { name: '일정 만들기', exact: true }).click();
}
async function cloud(page: Page) { return (await page.request.get('/api/state')).json(); }
async function storeRemote(page: Page, title: string) {
  const remote = await cloud(page);
  remote.state.eventTypes[0].name = title;
  const result = await page.request.put('/api/state', { headers: { Origin: origin }, data: remote });
  expect(result.ok()).toBe(true);
}

test('opt-in auto sync uploads, pulls, survives reload, and stops when disabled', async ({ page }) => {
  await enable(page);
  await newEvent(page, '자동 업로드 일정');
  await expect.poll(async () => (await cloud(page)).state.events.map((event: { title: string }) => event.title)).toEqual(['자동 업로드 일정']);
  await storeRemote(page, '서버에서 바꾼 유형');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('유형 필터').getByRole('option', { name: '서버에서 바꾼 유형' })).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('shadow.appState.v1')!).eventTypes[0].name)).toBe('서버에서 바꾼 유형');
  await page.reload();
  await expect(page.locator('.notice').filter({ hasText: '자동 동기화' })).toBeVisible();
  await page.getByRole('button', { name: '계정·연동' }).click();
  await page.getByRole('button', { name: '자동 동기화 끄기', exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('shadow.cloudSync.v1'))).toBeNull();
  await page.getByRole('button', { name: '계정 패널 닫기' }).click();
  await newEvent(page, '로컬에만 남길 일정');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect((await cloud(page)).state.events).toHaveLength(1);
});

test('concurrent local and remote edits pause automatically without overwriting either side', async ({ page }) => {
  await enable(page);
  await page.getByRole('button', { name: '+ 새 일정', exact: true }).click();
  await page.getByLabel('일정 제목').fill('보존할 로컬 변경');
  await storeRemote(page, '보존할 원격 변경');
  await page.getByRole('button', { name: '일정 만들기', exact: true }).click();
  await expect(page.locator('.notice').filter({ hasText: '브라우저와 서버가 모두 변경' })).toBeVisible();
  expect((await cloud(page)).state.events).toEqual([]);
  expect((await cloud(page)).state.eventTypes[0].name).toBe('보존할 원격 변경');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('shadow.appState.v1')!).events[0].title)).toBe('보존할 로컬 변경');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('shadow.cloudSync.v1')!).paused)).toBe(true);
});

test('offline edits are retained and uploaded after connectivity returns', async ({ page, context }) => {
  await enable(page);
  await context.setOffline(true);
  await newEvent(page, '오프라인 일정');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.notice').filter({ hasText: '오프라인' })).toBeVisible();
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => (await cloud(page)).state.events.length).toBe(1);
  expect((await cloud(page)).state.events[0].title).toBe('오프라인 일정');
});

test('local reset disables browser synchronization without deleting the server calendar, including across tabs', async ({ page, context }) => {
  await enable(page);
  await newEvent(page, '서버에 보존할 일정');
  await expect.poll(async () => (await cloud(page)).state.events.length).toBe(1);
  const original = await cloud(page);
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.locator('.notice').filter({ hasText: '자동 동기화' })).toBeVisible();
  const writes: string[] = [];
  for (const tab of [page, other]) tab.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/state' && request.method() === 'PUT') writes.push(request.method());
  });
  await page.getByRole('button', { name: '일정 유형', exact: true }).click();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: '전체 초기화', exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem('shadow.cloudSync.v1'))).not.toBeNull();
  expect((await cloud(page)).state.events).toEqual(original.state.events);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '전체 초기화', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('자동 동기화를 끄고');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('shadow.cloudSync.v1'))).toBeNull();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('shadow.appState.v1')!).events)).toEqual([]);
  await page.getByRole('button', { name: '일정 유형 패널 닫기' }).click();
  await expect(other.getByRole('alert')).toContainText('다른 탭');
  for (const tab of [page, other]) {
    await tab.evaluate(async () => {
      window.dispatchEvent(new Event('focus'));
      await navigator.locks.request('shadow.cloudSync.v1', () => undefined);
    });
  }
  await page.reload();
  await page.getByRole('button', { name: '계정·연동' }).click();
  await expect(page.getByRole('button', { name: '자동 동기화 켜기', exact: true })).toBeEnabled();
  expect(writes).toEqual([]);
  expect(await cloud(page)).toEqual(original);
});
