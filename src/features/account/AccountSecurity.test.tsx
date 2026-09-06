import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../services/api';
import { AccountActionPanel, AccountSecurity, PasswordRecovery, readAccountAction } from './AccountSecurity';

vi.mock('../../services/api', async (original) => ({ ...await original<typeof import('../../services/api')>(), api: vi.fn() }));
vi.mock('../../app/SidePanel', () => ({ SidePanel: ({ children, titleId }: { children: ReactNode; titleId: string }) => <section role="dialog" aria-labelledby={titleId}>{children}</section> }));

const token = 'A'.repeat(43);
const account = { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', emailVerified: false };
const capabilities = (available = true) => ({ mail: { available, mode: available ? 'smtp' : 'disabled' }, passwordReset: { available }, emailVerification: { available } });
const mutations = () => vi.mocked(api).mock.calls.filter(([, method]) => method === 'POST');

beforeEach(() => {
  vi.clearAllMocks();
  history.replaceState(null, '', '/');
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === '/api/auth/capabilities') return capabilities() as never;
    throw new Error(`Unexpected test API call: ${path}`);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  history.replaceState(null, '', '/');
});

describe('account security confirmation and recovery', () => {
  it('rejects missing or malformed action tokens without offering a submit action', () => {
    for (const action of [{ kind: 'reset-password', token: '' }, { kind: 'verify-email', token: '<invalid-token>' }] as const) {
      const view = render(<AccountActionPanel action={action} onClose={vi.fn()} />);
      expect(screen.getByRole('alert')).toHaveTextContent('링크가 올바르지 않습니다. 새 메일을 요청해 주세요.');
      expect(screen.queryByRole('button', { name: '새 비밀번호 저장' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '이메일 확인 완료' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '계정 확인 패널 닫기' })).toBeEnabled();
      expect(mutations()).toHaveLength(0);
      view.unmount();
    }
  });

  it('removes a valid token from the URL without submitting it merely by opening either panel', () => {
    for (const kind of ['reset-password', 'verify-email'] as const) {
      history.replaceState(null, '', `/?view=week#account-action=${kind}&token=${token}`);
      const action = readAccountAction();
      expect(action).toEqual({ kind, token });
      const view = render(<AccountActionPanel action={action!} onClose={vi.fn()} />);
      expect(window.location.hash).toBe('');
      expect(window.location.pathname + window.location.search).toBe('/?view=week');
      expect(screen.getByRole('dialog', { name: kind === 'reset-password' ? '비밀번호 재설정' : '이메일 확인' })).toBeVisible();
      expect(mutations()).toHaveLength(0);
      view.unmount();
    }
    history.replaceState(null, '', `/#share=public-share&account-action=verify-email&token=${token}`);
    expect(readAccountAction()).toBeNull();
  });

  it('links accessible password labels and blocks mismatched reset confirmation', async () => {
    const interaction = userEvent.setup();
    render(<AccountActionPanel action={{ kind: 'reset-password', token }} onClose={vi.fn()} />);
    const password = screen.getByLabelText('재설정 비밀번호', { exact: true });
    const confirmation = screen.getByLabelText('재설정 비밀번호 확인');
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('minlength', '10');
    expect(password).toHaveAttribute('maxlength', '128');
    expect(confirmation).toHaveAttribute('autocomplete', 'new-password');
    await interaction.type(password, 'new-password-123');
    await interaction.type(confirmation, 'different-password');
    await interaction.click(screen.getByRole('button', { name: '새 비밀번호 저장' }));
    expect(screen.getByRole('alert')).toHaveTextContent('비밀번호 확인이 일치하지 않습니다.');
    expect(mutations()).toHaveLength(0);
    expect(password).toHaveValue('new-password-123');
  });

  it('announces an expired reset link without reporting success or signing out the current session', async () => {
    vi.mocked(api).mockRejectedValue(new ApiError('재설정 링크가 만료되었습니다.', 400));
    const changed = vi.fn();
    window.addEventListener('shadow:session-changed', changed);
    try {
      render(<AccountActionPanel action={{ kind: 'reset-password', token }} onClose={vi.fn()} />);
      fireEvent.change(screen.getByLabelText('재설정 비밀번호', { exact: true }), { target: { value: 'new-password-123' } });
      fireEvent.change(screen.getByLabelText('재설정 비밀번호 확인'), { target: { value: 'new-password-123' } });
      fireEvent.click(screen.getByRole('button', { name: '새 비밀번호 저장' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('재설정 링크가 만료되었습니다.');
      expect(screen.getByRole('alert')).toHaveTextContent('새 메일을 요청해 주세요.');
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '새 비밀번호 저장' })).toBeEnabled();
      expect(changed).not.toHaveBeenCalled();
      expect(api).toHaveBeenCalledWith('/api/auth/password-reset/confirm', 'POST', { token, password: 'new-password-123' });
    } finally { window.removeEventListener('shadow:session-changed', changed); }
  });

  it('makes unavailable mail capability explicit and disables mail actions in both signed-in and recovery views', async () => {
    vi.mocked(api).mockResolvedValue(capabilities(false));
    const interaction = userEvent.setup();
    render(<><PasswordRecovery /><AccountSecurity user={account} onSignedOut={vi.fn()} /></>);
    const toggle = screen.getByRole('button', { name: '비밀번호를 잊으셨나요?' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    toggle.focus();
    await interaction.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText(/서버 메일 전송이 설정되지 않았습니다/)).toBeVisible();
    expect(screen.getByText(/메일 미설정: 이메일 확인·분실 복구/)).toBeVisible();
    expect(screen.getByRole('button', { name: '재설정 메일 요청' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '이메일 확인 메일 요청' })).toBeDisabled();
    expect(screen.getByLabelText('복구 이메일')).toHaveAttribute('type', 'email');
    expect(screen.getByRole('button', { name: '비밀번호 변경' })).toBeEnabled();
    expect(mutations()).toHaveLength(0);
  });

  it('requires consent for password changes and signs out only once after the server accepts the change', async () => {
    let finish!: () => void;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === '/api/auth/capabilities') return capabilities() as never;
      if (path === '/api/auth/password/change') return await new Promise<void>((resolve) => { finish = resolve; }) as never;
      throw new Error(`Unexpected test API call: ${path}`);
    });
    const changed = vi.fn();
    const onSignedOut = vi.fn();
    window.addEventListener('shadow:session-changed', changed);
    try {
      render(<AccountSecurity user={account} onSignedOut={onSignedOut} />);
      await waitFor(() => expect(screen.getByRole('button', { name: '이메일 확인 메일 요청' })).toBeEnabled());
      fireEvent.change(screen.getByLabelText('현재 비밀번호'), { target: { value: 'current-password-123' } });
      fireEvent.change(screen.getByLabelText('새 비밀번호', { exact: true }), { target: { value: 'new-password-123' } });
      fireEvent.change(screen.getByLabelText('새 비밀번호 확인'), { target: { value: 'new-password-123' } });
      vi.mocked(window.confirm).mockReturnValueOnce(false);
      fireEvent.click(screen.getByRole('button', { name: '비밀번호 변경' }));
      await waitFor(() => expect(screen.getByRole('button', { name: '비밀번호 변경' })).toBeEnabled());
      expect(mutations()).toHaveLength(0);
      expect(onSignedOut).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: '비밀번호 변경' }));
      fireEvent.submit(screen.getByLabelText('현재 비밀번호').closest('form')!);
      expect(api).toHaveBeenCalledWith('/api/auth/password/change', 'POST', { currentPassword: 'current-password-123', password: 'new-password-123' }, { accountId: account.id });
      expect(mutations()).toHaveLength(1);
      expect(screen.getByRole('button', { name: '비밀번호 변경' })).toBeDisabled();
      expect(onSignedOut).not.toHaveBeenCalled();
      await act(async () => finish());
      expect(onSignedOut).toHaveBeenCalledTimes(1);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText('현재 비밀번호')).toHaveValue('');
      expect(screen.getByLabelText('새 비밀번호', { exact: true })).toHaveValue('');
    } finally { window.removeEventListener('shadow:session-changed', changed); }
  });

  it('binds revoking other sessions to the current account and preserves the current signed-in view', async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === '/api/auth/capabilities') return capabilities() as never;
      if (path === '/api/auth/sessions/revoke-others') return { revokedSessions: 2 } as never;
      throw new Error(`Unexpected test API call: ${path}`);
    });
    const onSignedOut = vi.fn();
    render(<AccountSecurity user={account} onSignedOut={onSignedOut} />);
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: '다른 기기 로그아웃' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '다른 기기 로그아웃' })).toBeEnabled());
    expect(mutations()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '다른 기기 로그아웃' }));
    expect(await screen.findByRole('status')).toHaveTextContent('다른 로그인 세션 2개를 종료했습니다.');
    expect(api).toHaveBeenCalledWith('/api/auth/sessions/revoke-others', 'POST', {}, { accountId: account.id });
    expect(mutations()).toHaveLength(1);
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it('verifies email only after explicit confirmation and prevents concurrent duplicate submissions', async () => {
    let finish!: () => void;
    vi.mocked(api).mockImplementation(async () => await new Promise<void>((resolve) => { finish = resolve; }) as never);
    const onClose = vi.fn();
    render(<AccountActionPanel action={{ kind: 'verify-email', token }} onClose={onClose} />);
    expect(api).not.toHaveBeenCalled();
    const button = screen.getByRole('button', { name: '이메일 확인 완료' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(mutations()).toHaveLength(1);
    expect(api).toHaveBeenCalledWith('/api/auth/email-verification/confirm', 'POST', { token });
    await act(async () => finish());
    expect(screen.getByRole('status')).toHaveTextContent('이메일을 확인했습니다.');
    fireEvent.click(screen.getByRole('button', { name: '캘린더로 돌아가기' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
