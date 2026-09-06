import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../../app/AppContext';
import { api, ApiError } from '../../services/api';
import { createInitialState, STORAGE_KEY } from '../../services/storage';
import { AccountPanel } from './AccountPanel';

vi.mock('../../services/api', async (original) => ({ ...await original<typeof import('../../services/api')>(), api: vi.fn() }));
vi.mock('../../app/SidePanel', () => ({ SidePanel: ({ children }: { children: ReactNode }) => <section role="dialog">{children}</section> }));

const user = { id: 'account-1', email: 'owner@example.test', name: 'Owner' };
const initial = () => ({ ...createInitialState(), events: [{
  id: 'event-1', title: 'Private appointment', typeId: 'hospital', date: '2026-09-07', startMinute: 900, endMinute: 960,
  shadow: { preparationMinutes: 20, outboundTravelMinutes: 40, returnTravelMinutes: 40, recoveryMinutes: 30 },
  cost: { transportWon: 4000, mealWon: 12000 }, createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z',
}] });

type Handler = (path: string, method?: string, body?: unknown) => Promise<unknown>;
let remote: { state: ReturnType<typeof createInitialState> | null; revision: number };
let providers: { id: string; configured: boolean; connected: boolean; recoveryRequired?: boolean; recoveryMessage?: string; configurationError?: string; conflicts?: { id: string; title: string; reason: string }[] }[];
const fallback: Handler = async (path, method = 'GET') => {
  if (path === '/api/auth/me') return { user };
  if (path === '/api/auth/capabilities') return { mail: { available: false, mode: 'disabled' }, passwordReset: { available: false }, emailVerification: { available: false } };
  if (path === '/api/state' && method === 'GET') return remote;
  if (path === '/api/state' && method === 'PUT') return { revision: remote.revision + 1 };
  if (path === '/api/shares') return { shares: [] };
  if (path === '/api/integrations') return { providers };
  throw new Error(`Unexpected test API call: ${method} ${path}`);
};

function respond(handler: Handler) {
  vi.mocked(api).mockImplementation(async (path, method, body) => await handler(path, method, body) as never);
}

function mount() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(initial()));
  return render(<AppProvider><AccountPanel onClose={() => undefined} /></AppProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  remote = { state: initial(), revision: 3 };
  providers = [];
  respond(fallback);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks();
});

describe('account workflows', () => {
  it('waits for session lookup and matches backend registration limits without uploading data', async () => {
    let resolveSession!: (value: unknown) => void;
    respond(async (path, method, body) => {
      if (path === '/api/auth/me') return await new Promise((resolve) => { resolveSession = resolve; });
      if (path === '/api/auth/register') return { user };
      return fallback(path, method, body);
    });
    mount();
    expect(screen.getByRole('button', { name: '로그인' })).toBeDisabled();
    await act(async () => resolveSession({ user: null }));
    const interaction = userEvent.setup();
    await interaction.click(screen.getByRole('button', { name: '회원가입으로 전환' }));
    expect(screen.getByLabelText('이름')).toHaveAttribute('maxlength', '50');
    expect(screen.getByLabelText('비밀번호')).toHaveAttribute('minlength', '10');
    await interaction.type(screen.getByLabelText('이름'), 'Owner');
    await interaction.type(screen.getByLabelText('이메일'), 'owner@example.test');
    await interaction.type(screen.getByLabelText('비밀번호'), 'abcdefghij');
    await interaction.click(screen.getByRole('button', { name: '계정 만들기' }));
    await screen.findByRole('button', { name: '로그아웃' });
    expect(api).toHaveBeenCalledWith('/api/auth/register', 'POST', { email: 'owner@example.test', password: 'abcdefghij', name: 'Owner' });
    expect(vi.mocked(api).mock.calls.some(([path, method]) => path === '/api/state' && method === 'PUT')).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).events[0].title).toBe('Private appointment');
  });

  it('retains local data and requires refreshing a stale cloud revision before another upload', async () => {
    respond(async (path, method, body) => {
      if (path === '/api/state' && method === 'PUT') throw new ApiError('Conflict', 409);
      return fallback(path, method, body);
    });
    mount();
    const upload = await screen.findByRole('button', { name: '이 브라우저 데이터를 서버에 저장' });
    await waitFor(() => expect(upload).toBeEnabled());
    fireEvent.click(upload);
    await expect(screen.findByRole('alert')).resolves.toHaveTextContent('다른 기기에서 서버 일정이 변경');
    expect(upload).toBeDisabled();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(initial());
    expect(vi.mocked(api).mock.calls.filter(([path, method]) => path === '/api/state' && method === 'PUT')).toHaveLength(1);
    remote = { state: initial(), revision: 4 };
    fireEvent.click(screen.getByRole('button', { name: '서버 상태 새로고침' }));
    await waitFor(() => expect(upload).toBeEnabled());
    expect(screen.getByText(/버전 4/)).toBeVisible();
  });

  it('keeps cloud operations available when only optional provider configuration fails', async () => {
    respond(async (path, method, body) => {
      if (path === '/api/integrations') throw new ApiError('Provider unavailable', 503);
      return fallback(path, method, body);
    });
    mount();
    await expect(screen.findByRole('alert')).resolves.toHaveTextContent('외부 캘린더: Provider unavailable');
    expect(screen.getByRole('button', { name: '이 브라우저 데이터를 서버에 저장' })).toBeEnabled();
    expect(screen.getByText(/버전 3/)).toBeVisible();
  });

  it('does not lose other provider conflicts after synchronizing one connection', async () => {
    providers = [
      { id: 'google', configured: true, connected: true, conflicts: [{ id: 'same-id', title: 'Google conflict', reason: 'Changed on both sides' }] },
      { id: 'microsoft', configured: true, connected: true, conflicts: [{ id: 'same-id', title: 'Outlook conflict', reason: 'Changed on both sides' }] },
    ];
    respond(async (path, method, body) => {
      if (path === '/api/integrations/google/sync') return { imported: 0, exported: 0, deleted: 0, conflicts: providers[0].conflicts, warnings: [] };
      return fallback(path, method, body);
    });
    mount();
    await screen.findByText('Google Calendar · Google conflict');
    await waitFor(() => expect(screen.queryByText('계정 상태 확인 중…')).not.toBeInTheDocument());
    const card = screen.getByText('Google Calendar', { exact: true }).closest('article')!;
    fireEvent.click(within(card).getByRole('button', { name: '양방향 동기화' }));
    await screen.findByText(/가져오기 0 · 내보내기 0/);
    expect(screen.getByText('Google Calendar · Google conflict')).toBeVisible();
    expect(screen.getByText('Outlook Calendar · Outlook conflict')).toBeVisible();
  });

  it('keeps an unreadable connection visible and requires consent before removal or reconnection', async () => {
    providers = [
      { id: 'google', configured: true, connected: true, recoveryRequired: true, recoveryMessage: '저장된 연결 정보를 읽을 수 없습니다. 기존 암호화 키 복구 또는 연결 정보 제거가 필요합니다.' },
      { id: 'microsoft', configured: true, connected: true },
    ];
    respond(async (path, method, body) => {
      if (path === '/api/integrations/google' && method === 'DELETE') {
        providers = providers.map((provider) => provider.id === 'google' ? { id: 'google', configured: true, connected: false } : provider);
        return { disconnected: true };
      }
      if (path === '/api/integrations/google/connect') throw new ApiError('테스트 연결 요청이 확인되었습니다.', 503);
      return fallback(path, method, body);
    });
    mount();
    const recovery = await screen.findByText('연결 정보 복구 필요');
    await waitFor(() => expect(screen.queryByText('계정 상태 확인 중…')).not.toBeInTheDocument());
    const googleCard = recovery.closest('article')!;
    const microsoftCard = screen.getByText('Outlook Calendar', { exact: true }).closest('article')!;
    expect(within(googleCard).getByRole('button', { name: '양방향 동기화' })).toBeDisabled();
    expect(within(microsoftCard).getByRole('button', { name: '양방향 동기화' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '이 브라우저 데이터를 서버에 저장' })).toBeEnabled();
    expect(vi.mocked(api).mock.calls.some(([, method]) => method === 'DELETE')).toBe(false);

    const remove = within(googleCard).getByRole('button', { name: '연결 정보 제거' });
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(remove);
    await waitFor(() => expect(remove).toBeEnabled());
    expect(vi.mocked(api).mock.calls.some(([, method]) => method === 'DELETE')).toBe(false);
    expect(screen.getByText('연결 정보 복구 필요')).toBeVisible();

    fireEvent.click(remove);
    const reconnect = await screen.findByRole('button', { name: 'Google Calendar 연결' });
    await waitFor(() => expect(reconnect).toBeEnabled());
    expect(api).toHaveBeenCalledWith('/api/integrations/google', 'DELETE', undefined, { accountId: user.id });
    expect(vi.mocked(api).mock.calls.some(([path]) => path === '/api/integrations/google/connect')).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(initial());

    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(reconnect);
    await waitFor(() => expect(reconnect).toBeEnabled());
    expect(vi.mocked(api).mock.calls.some(([path]) => path === '/api/integrations/google/connect')).toBe(false);
    fireEvent.click(reconnect);
    await expect(screen.findByRole('alert')).resolves.toHaveTextContent('테스트 연결 요청이 확인');
    expect(api).toHaveBeenCalledWith('/api/integrations/google/connect', 'POST', {}, { accountId: user.id });
  });

  it('permits removing unreadable credentials even when provider configuration is unavailable', async () => {
    providers = [{ id: 'google', configured: false, connected: true, recoveryRequired: true, configurationError: '서버 암호화 키가 필요합니다.' }];
    respond(async (path, method, body) => {
      if (path === '/api/integrations/google' && method === 'DELETE') {
        providers = [{ id: 'google', configured: false, connected: false }];
        return { disconnected: true };
      }
      return fallback(path, method, body);
    });
    mount();
    const remove = await screen.findByRole('button', { name: '연결 정보 제거' });
    await waitFor(() => expect(remove).toBeEnabled());
    expect(screen.getByRole('button', { name: '양방향 동기화' })).toBeDisabled();
    fireEvent.click(remove);
    await expect(screen.findByRole('button', { name: 'Google Calendar 연결' })).resolves.toBeDisabled();
    expect(api).toHaveBeenCalledWith('/api/integrations/google', 'DELETE', undefined, { accountId: user.id });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(initial());
  });

  it('publishes only the chosen trimmed share title after explicit consent', async () => {
    mount();
    const create = await screen.findByRole('button', { name: '공유 링크 만들기' });
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.change(screen.getByLabelText('공유 제목'), { target: { value: '  다음 주 일정  ' } });
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(create);
    await waitFor(() => expect(create).toBeEnabled());
    expect(vi.mocked(api).mock.calls.some(([path, method]) => path === '/api/shares' && method === 'POST')).toBe(false);
    fireEvent.click(create);
    await screen.findByText(/읽기 전용 공유 링크를 만들었습니다/);
    expect(api).toHaveBeenCalledWith('/api/shares', 'POST', { title: '다음 주 일정', state: initial() }, { accountId: user.id });
  });

  it('rejects authorization redirects to an unexpected HTTPS host', async () => {
    providers = [{ id: 'google', configured: true, connected: false }];
    respond(async (path, method, body) => path === '/api/integrations/google/connect' ? { url: 'https://attacker.invalid/login' } : fallback(path, method, body));
    mount();
    const connect = await screen.findByRole('button', { name: 'Google Calendar 연결' });
    await waitFor(() => expect(connect).toBeEnabled());
    fireEvent.click(connect);
    await expect(screen.findByRole('alert')).resolves.toHaveTextContent('올바르지 않은 인증 주소');
  });

  it('allows returning to login when the server session already expired', async () => {
    respond(async (path, method, body) => {
      if (path === '/api/auth/logout') throw new ApiError('로그인이 필요합니다.', 401);
      return fallback(path, method, body);
    });
    mount();
    const logout = await screen.findByRole('button', { name: '로그아웃' });
    await waitFor(() => expect(logout).toBeEnabled());
    fireEvent.click(logout);
    await screen.findByRole('button', { name: '로그인' });
    expect(screen.getByText(/로그아웃했습니다/)).toBeVisible();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(initial());
  });
});
