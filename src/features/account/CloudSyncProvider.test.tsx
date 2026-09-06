import { webcrypto } from 'node:crypto';
import { StrictMode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApp } from '../../app/AppContext';
import { api } from '../../services/api';
import { CLOUD_SYNC_KEY, stateDigest, type CloudSyncSettings } from '../../services/cloudSync';
import { createInitialState, STORAGE_KEY } from '../../services/storage';
import { CloudSyncProvider, useCloudSync } from './CloudSyncProvider';

vi.mock('../../app/AppContext', () => ({ useApp: vi.fn() }));
vi.mock('../../services/api', async (original) => ({ ...await original<typeof import('../../services/api')>(), api: vi.fn() }));

function context(state = createInitialState()): ReturnType<typeof useApp> {
  return {
    state, dispatch: vi.fn(() => true), storageBlocked: false, storageConflict: false,
    storageSupported: true, storagePending: false, clearStorageError: vi.fn(),
    resetData: vi.fn(async () => true), reloadData: vi.fn(() => true), retrySave: vi.fn(),
    undo: vi.fn(), redo: vi.fn(), canUndo: false, canRedo: false,
    subscribeStorageSaved: vi.fn(() => () => undefined),
  };
}

function Probe() {
  const sync = useCloudSync();
  return <><output aria-label="sync status">{sync?.status}</output><p>{sync?.message}</p></>;
}

async function settings(baselineState = createInitialState()): Promise<CloudSyncSettings> {
  return { version: 1, userId: 'account-owner', baseline: await stateDigest(baselineState), revision: 7, paused: false, lastSyncedAt: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  history.replaceState(null, '', '/');
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('cloud sync guards against stale tab snapshots', () => {
  it('does not upload stale tab memory against another tab’s latest local data and baseline before storage events arrive', async () => {
    const staleTabState = createInitialState();
    const latestStoredState = createInitialState();
    latestStoredState.eventTypes[0].name = '다른 탭에서 저장한 최신 유형';
    const latestSettings = await settings(latestStoredState);
    const latestRaw = JSON.stringify(latestStoredState);
    localStorage.setItem(STORAGE_KEY, latestRaw);
    localStorage.setItem(CLOUD_SYNC_KEY, JSON.stringify(latestSettings));
    const app = context(staleTabState);
    vi.mocked(useApp).mockReturnValue(app);
    vi.mocked(api).mockImplementation(async (path, method = 'GET') => {
      if (path === '/api/auth/me') return { user: { id: 'account-owner' } } as never;
      if (path === '/api/state') return (method === 'PUT' ? { revision: 8 } : { state: latestStoredState, revision: 7 }) as never;
      throw new Error('Unexpected test request');
    });

    // Deliberately do not dispatch StorageEvent: the stale context still looks healthy.
    render(<StrictMode><CloudSyncProvider><Probe /></CloudSyncProvider></StrictMode>);
    await screen.findByText('다른 탭의 최신 로컬 데이터를 먼저 불러와 주세요. 오래된 데이터는 업로드하지 않습니다.');
    expect(screen.getByLabelText('sync status')).toHaveTextContent('paused');
    expect(api).not.toHaveBeenCalled();
    expect(app.dispatch).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEY)).toBe(latestRaw);
    expect(JSON.parse(localStorage.getItem(CLOUD_SYNC_KEY)!)).toEqual(latestSettings);
    expect(app.state).toEqual(staleTabState);
  });

  it('still uploads a genuine locally persisted change when the server matches the acknowledged baseline', async () => {
    const baselineState = createInitialState();
    const localState = createInitialState();
    localState.eventTypes[0].name = '이 탭에서 저장한 변경';
    localStorage.setItem(STORAGE_KEY, JSON.stringify(localState));
    localStorage.setItem(CLOUD_SYNC_KEY, JSON.stringify(await settings(baselineState)));
    vi.mocked(useApp).mockReturnValue(context(localState));
    vi.mocked(api).mockImplementation(async (path, method = 'GET') => {
      if (path === '/api/auth/me') return { user: { id: 'account-owner' } } as never;
      if (path === '/api/state') return (method === 'PUT' ? { revision: 8 } : { state: baselineState, revision: 7 }) as never;
      throw new Error('Unexpected test request');
    });
    render(<StrictMode><CloudSyncProvider><Probe /></CloudSyncProvider></StrictMode>);
    await screen.findByText('브라우저 변경을 서버에 저장했습니다.');
    expect(vi.mocked(api).mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(1);
    expect(api).toHaveBeenCalledWith('/api/state', 'PUT', { state: localState, revision: 7 }, { accountId: 'account-owner' });
    const acknowledged = await stateDigest(localState);
    await waitFor(() => expect(JSON.parse(localStorage.getItem(CLOUD_SYNC_KEY)!).baseline).toBe(acknowledged));
  });
});
