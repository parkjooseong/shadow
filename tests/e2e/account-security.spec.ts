import { expect, test, type Page } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const outbox = join(process.cwd(), 'data', 'mail-outbox');
async function mailNames() { return await readdir(outbox).catch(() => [] as string[]); }
async function mailLink(email: string, kind: string, previous: string[]) {
  let link = '';
  await expect.poll(async () => {
    for (const name of (await mailNames()).filter((name) => !previous.includes(name) && name.endsWith('.eml'))) {
      const message = await readFile(join(outbox, name), 'utf8');
      if (!message.includes(`To: ${email}\r\n`)) continue;
      const body = Buffer.from(message.split('\r\n\r\n').slice(1).join('\r\n\r\n'), 'base64').toString('utf8');
      const match = body.match(/https?:\/\/[^\s]+/);
      if (match && match[0].includes(`#account-action=${kind}&`)) { link = match[0]; return true; }
    }
    return false;
  }).toBe(true);
  return link;
}
async function register(page: Page, email: string) {
  await page.goto('/');
  await page.getByRole('button', { name: '계정·연동' }).click();
  await page.getByRole('button', { name: '회원가입으로 전환' }).click();
  await page.getByLabel('이름', { exact: true }).fill('Security test');
  await page.getByLabel('이메일', { exact: true }).fill(email);
  await page.getByLabel('비밀번호', { exact: true }).fill('original-password-123');
  await page.getByRole('button', { name: '계정 만들기', exact: true }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeEnabled();
}

test('email verification and password recovery work through real private development mail', async ({ page }) => {
  const email = `security-${crypto.randomUUID()}@example.test`;
  const previous = await mailNames();
  await register(page, email);
  await page.getByRole('button', { name: '이메일 확인 메일 요청' }).click();
  const verification = await mailLink(email, 'verify-email', previous);
  await page.goto(verification);
  await expect(page.getByRole('dialog', { name: '이메일 확인', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
  await page.getByRole('button', { name: '이메일 확인 완료' }).click();
  await expect(page.getByRole('status')).toContainText('이메일을 확인했습니다');
  await page.getByRole('button', { name: '캘린더로 돌아가기' }).click();
  await page.getByRole('button', { name: '계정·연동' }).click();
  await expect(page.getByText('이메일 확인 완료', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await page.getByRole('button', { name: '비밀번호를 잊으셨나요?' }).click();
  await page.getByLabel('복구 이메일').fill(email);
  await page.getByRole('button', { name: '재설정 메일 요청' }).click();
  const reset = await mailLink(email, 'reset-password', previous);
  await page.goto(reset);
  await page.getByLabel('재설정 비밀번호', { exact: true }).fill('replacement-password-456');
  await page.getByLabel('재설정 비밀번호 확인').fill('different-password-456');
  await page.getByRole('button', { name: '새 비밀번호 저장' }).click();
  await expect(page.getByRole('alert')).toContainText('일치하지 않습니다');
  await page.getByLabel('재설정 비밀번호 확인').fill('replacement-password-456');
  await page.getByRole('button', { name: '새 비밀번호 저장' }).click();
  await expect(page.getByRole('status')).toContainText('비밀번호를 재설정');
  await page.getByRole('button', { name: '캘린더로 돌아가기' }).click();
  await page.getByRole('button', { name: '계정·연동' }).click();
  await page.getByLabel('이메일', { exact: true }).fill(email);
  await page.getByLabel('비밀번호', { exact: true }).fill('replacement-password-456');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  await page.goto(reset);
  await page.getByLabel('재설정 비밀번호', { exact: true }).fill('cannot-reuse-password-123');
  await page.getByLabel('재설정 비밀번호 확인').fill('cannot-reuse-password-123');
  await page.getByRole('button', { name: '새 비밀번호 저장' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
});

test('password changes require confirmation and revoke other sessions without removing local data', async ({ page, browser }) => {
  const email = `change-${crypto.randomUUID()}@example.test`;
  await register(page, email);
  const other = await browser.newContext({ baseURL: 'http://127.0.0.1:4173' });
  try {
    const response = await other.request.post('/api/auth/login', { headers: { Origin: 'http://127.0.0.1:4173' }, data: { email, password: 'original-password-123' } });
    expect(response.ok()).toBe(true);
    await page.getByLabel('현재 비밀번호').fill('original-password-123');
    await page.getByLabel('새 비밀번호', { exact: true }).fill('changed-password-456');
    await page.getByLabel('새 비밀번호 확인').fill('changed-password-456');
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.getByRole('button', { name: '비밀번호 변경', exact: true }).click();
    await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '비밀번호 변경', exact: true }).click();
    await expect(page.getByRole('button', { name: '로그인', exact: true })).toBeVisible();
    expect((await (await other.request.get('/api/auth/me')).json()).user).toBeNull();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('shadow.appState.v1')!).eventTypes.length)).toBe(4);
  } finally { await other.close(); }
});
