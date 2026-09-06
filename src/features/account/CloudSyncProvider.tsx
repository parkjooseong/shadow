import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../app/AppContext';
import { api, ApiError } from '../../services/api';
import { acknowledgePull, CLOUD_SYNC_KEY, CLOUD_SYNC_SETTINGS_EVENT, readSyncSettings, snapshotDigest, stateDigest, synchronizeCloud, validateCloud, type CloudState, type CloudSyncSettings, type SyncStatus } from '../../services/cloudSync';
import { STORAGE_KEY } from '../../services/storage';

interface CloudSyncContextValue {
  settings: CloudSyncSettings | null;
  status: SyncStatus;
  message: string;
  enable: (userId: string) => Promise<void>;
  disable: () => Promise<void>;
  checkNow: () => void;
}
const Context = createContext<CloudSyncContextValue | null>(null);
export const useCloudSync = () => useContext(Context);
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : '자동 동기화를 실행하지 못했습니다.';

export function CloudSyncProvider({ children }: { children: React.ReactNode }) {
  const app = useApp();
  const { subscribeStorageSaved } = app;
  const local = useRef(app);
  local.current = app;
  const [settings, setSettings] = useState<CloudSyncSettings | null>(null);
  const [status, setStatus] = useState<SyncStatus>('disabled');
  const [message, setMessage] = useState('자동 동기화 꺼짐');
  const active = useRef(false);
  const stopped = useRef(false);
  const alive = useRef(false);
  const retryAt = useRef(0);
  const failures = useRef(0);
  const acknowledging = useRef(0);
  const saveSettings = useCallback((next: CloudSyncSettings | null) => {
    if (next) localStorage.setItem(CLOUD_SYNC_KEY, JSON.stringify(next));
    else localStorage.removeItem(CLOUD_SYNC_KEY);
    if (alive.current) setSettings(next);
  }, []);
  const refreshSettings = useCallback(() => {
    try {
      const next = readSyncSettings();
      setSettings(next);
      if (!next) { setStatus('disabled'); setMessage('자동 동기화 꺼짐'); }
      else if (next.paused) { setStatus('paused'); setMessage('자동 동기화가 일시 정지되었습니다. 로그인과 양쪽 캘린더를 확인한 뒤 다시 켜 주세요.'); }
    } catch (cause) { setStatus('error'); setMessage(errorText(cause)); }
  }, []);

  const checkNow = useCallback(() => {
    if (active.current || acknowledging.current || stopped.current || !alive.current || Date.now() < retryAt.current || new URLSearchParams(location.hash.slice(1)).has('share')) return;
    if (!navigator.locks?.request) return;
    if (!navigator.onLine) { setStatus('offline'); setMessage('오프라인입니다. 인터넷 연결 후 다시 시도합니다.'); return; }
    active.current = true;
    void navigator.locks.request(CLOUD_SYNC_KEY, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      if (!lock || stopped.current || !alive.current) return;
      // Holding the app storage lock also closes the cross-tab gap before a remote PUT.
      await navigator.locks.request(STORAGE_KEY, { mode: 'exclusive', ifAvailable: true }, async (storageLock) => {
      if (!storageLock || stopped.current || !alive.current) return;
      const current = readSyncSettings();
      if (!current || current.paused) { refreshSettings(); return; }
      if (local.current.storageBlocked || local.current.storagePending || local.current.storageError) {
        setStatus('paused'); setMessage('로컬 저장 문제를 먼저 해결해 주세요. 서버 데이터는 변경하지 않습니다.'); return;
      }
      if (document.querySelector('dialog[open]')) { setStatus('idle'); setMessage('편집 패널을 닫으면 자동 동기화를 계속합니다.'); return; }
      const source = local.current.state;
      if (localStorage.getItem(STORAGE_KEY) !== JSON.stringify(source)) {
        setStatus('paused'); setMessage('다른 탭의 최신 로컬 데이터를 먼저 불러와 주세요. 오래된 데이터는 업로드하지 않습니다.'); return;
      }
      setStatus('syncing');
      const isCurrent = () => alive.current && !stopped.current && local.current.state === source && !local.current.storagePending && !local.current.storageBlocked && localStorage.getItem(STORAGE_KEY) === JSON.stringify(source) && !document.querySelector('dialog[open]');
      const result = await synchronizeCloud({ settings: current, local: source, isCurrent, applyRemote: (state, expectedState) => local.current.dispatch({ type: 'state/replace', state, expectedState }) });
      if (stopped.current || !alive.current) return;
      saveSettings(result.settings);
      failures.current = 0; retryAt.current = 0;
      setStatus(result.settings.paused ? 'paused' : 'idle'); setMessage(result.message);
      });
    }).catch((cause: unknown) => {
      if (!alive.current || stopped.current) return;
      if (cause instanceof ApiError && [401, 403, 409].includes(cause.status)) {
        try { const current = readSyncSettings(); if (current) saveSettings({ ...current, paused: true }); } catch { /* Keep the visible failure; never rewrite unreadable settings. */ }
        setStatus('paused'); setMessage(`${errorText(cause)} 자동 동기화를 멈췄습니다. 수동 확인 후 다시 켜 주세요.`);
      } else {
        failures.current++;
        const seconds = Math.min(300, 15 * 2 ** Math.min(failures.current - 1, 5));
        retryAt.current = Date.now() + seconds * 1000;
        setStatus('error'); setMessage(`${errorText(cause)} ${seconds}초 뒤 다시 시도합니다.`);
      }
    }).finally(() => { active.current = false; });
  }, [refreshSettings, saveSettings]);

  useEffect(() => {
    alive.current = true;
    refreshSettings();
    const onStorage = (event: StorageEvent) => { if (event.key === CLOUD_SYNC_KEY || event.key === null) refreshSettings(); };
    const wake = () => { retryAt.current = 0; checkNow(); };
    const interval = window.setInterval(checkNow, 15_000);
    const sessionChanged = () => {
      // Stop locally immediately; the server also binds each request to its intended account.
      stopped.current = true;
      void navigator.locks?.request(CLOUD_SYNC_KEY, { mode: 'exclusive' }, () => {
        const current = readSyncSettings();
        if (current) saveSettings({ ...current, paused: true });
      }).then(() => { if (alive.current) refreshSettings(); }).catch((cause: unknown) => { if (alive.current) { setStatus('error'); setMessage(errorText(cause)); } });
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('shadow:session-changed', sessionChanged);
    window.addEventListener(CLOUD_SYNC_SETTINGS_EVENT, refreshSettings);
    checkNow();
    return () => { alive.current = false; window.clearInterval(interval); window.removeEventListener('storage', onStorage); window.removeEventListener('online', wake); window.removeEventListener('focus', wake); window.removeEventListener('shadow:session-changed', sessionChanged); window.removeEventListener(CLOUD_SYNC_SETTINGS_EVENT, refreshSettings); };
  }, [checkNow, refreshSettings, saveSettings]);
  useEffect(() => subscribeStorageSaved((snapshot) => {
    // Observe the exact successful write, even if the user immediately edits again.
    acknowledging.current++;
    void snapshotDigest(snapshot).then((digest) => navigator.locks?.request(CLOUD_SYNC_KEY, { mode: 'exclusive' }, () => {
      if (!alive.current || stopped.current) return;
      const current = readSyncSettings();
      if (!current) return;
      const next = acknowledgePull(current, digest);
      if (next !== current) saveSettings(next);
    })).catch((cause: unknown) => { if (alive.current) { setStatus('error'); setMessage(errorText(cause)); } }).finally(() => { acknowledging.current--; });
  }), [subscribeStorageSaved, saveSettings]);
  useEffect(() => {
    const timer = window.setTimeout(checkNow, 1000);
    return () => window.clearTimeout(timer);
  }, [app.state, app.storagePending, settings?.userId, settings?.paused, checkNow]);

  const value = useMemo<CloudSyncContextValue>(() => ({ settings, status, message, checkNow,
    enable: async (userId) => {
      if (!navigator.locks?.request || local.current.storageBlocked || local.current.storagePending || local.current.storageError) throw new Error('먼저 브라우저 저장을 완료하고 저장 오류를 해결해 주세요.');
      await navigator.locks.request(CLOUD_SYNC_KEY, { mode: 'exclusive' }, async () => {
        await navigator.locks.request(STORAGE_KEY, { mode: 'exclusive' }, async () => {
        const source = local.current.state;
        if (localStorage.getItem(STORAGE_KEY) !== JSON.stringify(source)) throw new Error('다른 탭의 최신 로컬 데이터를 먼저 불러와 주세요.');
        const session = await api<{ user: { id: string } | null }>('/api/auth/me');
        if (session.user?.id !== userId) throw new Error('로그인 계정이 변경되었습니다. 계정 패널을 다시 열어 주세요.');
        const remote = validateCloud(await api<CloudState>('/api/state', 'GET', undefined, { accountId: userId }));
        const baseline = await stateDigest(source);
        if (remote.state && await stateDigest(remote.state) !== baseline) throw new Error('브라우저와 서버 내용이 다릅니다. 아래 수동 저장 또는 가져오기로 사용할 버전을 선택한 뒤 다시 켜 주세요.');
        if (source !== local.current.state || local.current.storagePending || local.current.storageBlocked) throw new Error('로컬 변경을 먼저 저장한 뒤 다시 켜 주세요.');
        let revision = remote.revision;
        if (!remote.state) {
          const saved = await api<{ revision: number }>('/api/state', 'PUT', { state: source, revision }, { accountId: userId });
          if (!Number.isSafeInteger(saved.revision) || saved.revision <= revision) throw new Error('서버 저장 결과를 확인하지 못했습니다.');
          revision = saved.revision;
        }
        saveSettings({ version: 1, userId, baseline, revision, paused: false, lastSyncedAt: new Date().toISOString() });
        stopped.current = false; failures.current = 0; retryAt.current = 0;
        setStatus('idle'); setMessage('자동 동기화를 켰습니다. 편집 패널을 닫으면 변경사항을 자동으로 주고받습니다.');
        });
      });
    },
    disable: async () => {
      stopped.current = true;
      if (!navigator.locks?.request) saveSettings(null);
      else await navigator.locks.request(CLOUD_SYNC_KEY, { mode: 'exclusive' }, () => saveSettings(null));
      setStatus('disabled'); setMessage('자동 동기화를 껐습니다. 이미 시작된 요청은 완료될 수 있습니다.');
    },
  }), [settings, status, message, checkNow, saveSettings]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function CloudSyncNotice() {
  const sync = useCloudSync();
  if (!sync || (!sync.settings && sync.status !== 'error')) return null;
  return <p className={`notice ${['error', 'paused'].includes(sync.status) ? 'warning' : ''}`} role="status">자동 동기화 · {sync.message}</p>;
}
