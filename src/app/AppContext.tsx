import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { AppState, CalendarEvent, EventType } from '../domain/types';
import { getEventTypeValidationError, getEventValidationError, isAppState } from '../domain/validation';
import { commitStoredState, createInitialState, loadState, STORAGE_CONFLICT_MESSAGE, STORAGE_KEY, STORAGE_LOCK_MESSAGE, supportsStorageLock } from '../services/storage';
import { CLOUD_SYNC_KEY, CLOUD_SYNC_SETTINGS_EVENT } from '../services/cloudSync';

type Action =
  | { type: 'event/save'; event: CalendarEvent }
  | { type: 'event/delete'; id: string; sourceId?: string; occurrenceDate?: string; updatedAt?: string }
  | { type: 'type/save'; eventType: EventType }
  | { type: 'type/delete'; id: string }
  | { type: 'data/reset' }
  | { type: 'state/replace'; state: AppState; expectedState?: AppState };

function getActionError(state: AppState, action: Action): string | undefined {
  if (action.type === 'state/replace') return isAppState(action.state) ? undefined : '가져올 캘린더 데이터가 올바르지 않습니다.';
  if (action.type === 'event/save') {
    const invalid = getEventValidationError(action.event, state.eventTypes);
    if (invalid) return invalid;
    if (action.event.sourceId) {
      const source = state.events.find((event) => event.id === action.event.sourceId);
      if (!source?.recurrence || !action.event.occurrenceDate || action.event.occurrenceDate < source.date || action.event.occurrenceDate > source.recurrence.until) return '반복 일정의 원본을 찾지 못했습니다. 캘린더를 다시 확인해 주세요.';
    }
  }
  if (action.type === 'type/save') return getEventTypeValidationError(action.eventType);
  if (action.type === 'type/delete') {
    if (!state.eventTypes.some((type) => type.id === action.id)) return '삭제할 일정 유형을 찾지 못했습니다.';
    const count = state.events.filter((event) => event.typeId === action.id).length;
    if (count > 0) return `${count}개 일정에서 사용 중인 유형은 삭제할 수 없습니다.`;
    if (state.eventTypes.length === 1) return '일정을 만들 수 있도록 유형을 하나 이상 남겨 주세요.';
  }
}

export function reducer(state: AppState, action: Action): AppState {
  // Validate again inside the reducer to protect batched actions as well.
  if (getActionError(state, action)) return state;
  switch (action.type) {
    case 'event/save': {
      if (action.event.sourceId && action.event.occurrenceDate) {
        const { sourceId, occurrenceDate, ...occurrence } = action.event;
        if (!state.events.some((event) => event.id === sourceId)) return state;
        return { ...state, events: [
          ...state.events.map((event) => event.id === sourceId ? { ...event, excludedDates: [...new Set([...(event.excludedDates ?? []), occurrenceDate])], updatedAt: occurrence.updatedAt } : event)
            .filter((event) => event.id !== occurrence.id),
          { ...occurrence, sourceId, occurrenceDate, recurrence: undefined, excludedDates: undefined },
        ] };
      }
      const exists = state.events.some((event) => event.id === action.event.id);
      return { ...state, events: exists ? state.events.map((event) => {
        if (event.id === action.event.id) return action.event;
        if (event.sourceId === action.event.id && !action.event.excludedDates?.includes(event.occurrenceDate!)) return { ...event, sourceId: undefined, occurrenceDate: undefined };
        return event;
      }) : [...state.events, action.event] };
    }
    case 'event/delete':
      if (action.sourceId && action.occurrenceDate) return { ...state, events: state.events.filter((event) => event.id !== action.id).map((event) => event.id === action.sourceId ? { ...event, excludedDates: [...new Set([...(event.excludedDates ?? []), action.occurrenceDate!])], updatedAt: action.updatedAt ?? event.updatedAt } : event) };
      return { ...state, events: state.events.filter((event) => event.id !== action.id && event.sourceId !== action.id) };
    case 'type/save': {
      const exists = state.eventTypes.some((eventType) => eventType.id === action.eventType.id);
      return { ...state, eventTypes: exists ? state.eventTypes.map((eventType) => eventType.id === action.eventType.id ? action.eventType : eventType) : [...state.eventTypes, action.eventType] };
    }
    case 'type/delete':
      return { ...state, eventTypes: state.eventTypes.filter((eventType) => eventType.id !== action.id) };
    case 'data/reset':
      return createInitialState();
    case 'state/replace':
      if (action.expectedState && state !== action.expectedState) return state;
      return action.state;
  }
}

interface History { present: AppState; past: AppState[]; future: AppState[] }
type HistoryAction = Action | { type: 'history/undo' } | { type: 'history/redo' } | { type: 'history/reload'; state: AppState };
function historyReducer(history: History, action: HistoryAction): History {
  if (action.type === 'history/reload') return { present: action.state, past: [], future: [] };
  if (action.type === 'history/undo') {
    const previous = history.past.at(-1);
    return previous ? { present: previous, past: history.past.slice(0, -1), future: [history.present, ...history.future] } : history;
  }
  if (action.type === 'history/redo') {
    const next = history.future[0];
    return next ? { present: next, past: [...history.past, history.present], future: history.future.slice(1) } : history;
  }
  const present = reducer(history.present, action);
  if (action.type === 'data/reset') return { present, past: [], future: [] };
  return present === history.present ? history : { present, past: [...history.past, history.present].slice(-50), future: [] };
}

interface AppContextValue {
  state: AppState;
  dispatch: (action: Exclude<Action, { type: 'data/reset' }>) => boolean;
  storageError?: string;
  storageBlocked: boolean;
  storageConflict: boolean;
  storageSupported: boolean;
  storagePending: boolean;
  subscribeStorageSaved: (listener: (snapshot: string) => void) => () => void;
  clearStorageError: () => void;
  resetData: () => Promise<boolean>;
  reloadData: () => boolean;
  retrySave: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [loaded] = useState(loadState);
  const [history, rawDispatch] = useReducer(historyReducer, { present: loaded.state, past: [], future: [] });
  const state = history.present;
  const [storageError, setStorageError] = useState(loaded.error);
  const [actionError, setActionError] = useState<string>();
  const [storageBlocked, setStorageBlocked] = useState(loaded.blocked);
  const [storageConflict, setStorageConflict] = useState(false);
  const [storagePending, setStoragePending] = useState(false);
  const storageSupported = supportsStorageLock();
  const snapshot = useRef(loaded.snapshot);
  const savedMemory = useRef(loaded.state);
  const savedListeners = useRef(new Set<(snapshot: string) => void>());
  const blocked = useRef(loaded.blocked || !storageSupported);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const generation = useRef(0);
  const mounted = useRef(false);
  const currentState = useRef(state);
  currentState.current = state;

  const recordFailure = useCallback((result: { status: 'conflict' | 'unsupported' | 'error'; error: string }) => {
    setStorageError(result.error);
    if (result.status !== 'error') {
      blocked.current = true;
      setStorageBlocked(true);
      setStorageConflict(result.status === 'conflict');
    }
  }, []);

  const persist = useCallback((next: AppState) => {
    const version = ++generation.current;
    setStoragePending(true);
    queue.current = queue.current.then(async () => {
      if (!mounted.current || blocked.current || version !== generation.current) return;
      const result = await commitStoredState(next, snapshot.current, () => mounted.current && !blocked.current && version === generation.current);
      if (result.status === 'cancelled') return;
      if (result.status === 'saved') {
        snapshot.current = result.snapshot; savedMemory.current = next;
        for (const listener of savedListeners.current) listener(result.snapshot);
      }
      if (!mounted.current || version !== generation.current) return;
      if (result.status === 'saved') setStorageError(undefined);
      else recordFailure(result);
    }).finally(() => { if (mounted.current && version === generation.current) setStoragePending(false); });
  }, [recordFailure]);

  useEffect(() => {
    mounted.current = true;
    const checkExternal = () => {
      try {
        const latest = window.localStorage.getItem(STORAGE_KEY);
        if (latest === snapshot.current) return;
        if (latest === JSON.stringify(currentState.current)) { snapshot.current = latest; savedMemory.current = currentState.current; return; }
        recordFailure({ status: 'conflict', error: STORAGE_CONFLICT_MESSAGE });
      } catch { recordFailure({ status: 'conflict', error: '저장소 변경을 확인하지 못해 저장을 중지했습니다. 이 탭을 백업한 뒤 최신 데이터를 다시 불러와 주세요.' }); }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) checkExternal();
    };
    const warnUnsaved = (event: BeforeUnloadEvent) => {
      if (JSON.stringify(currentState.current) !== JSON.stringify(savedMemory.current)) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', checkExternal);
    window.addEventListener('beforeunload', warnUnsaved);
    return () => { mounted.current = false; window.removeEventListener('storage', onStorage); window.removeEventListener('focus', checkExternal); window.removeEventListener('beforeunload', warnUnsaved); };
  }, [recordFailure]);

  useEffect(() => {
    if (!blocked.current && storageSupported) persist(state);
  }, [state, persist, storageSupported]);

  const dispatch = useCallback<AppContextValue['dispatch']>((action) => {
    if (blocked.current) return false;
    const error = getActionError(state, action);
    setActionError(error);
    if (error) return false;
    rawDispatch(action);
    return true;
  }, [state]);

  const value = useMemo<AppContextValue>(() => ({
    state,
    dispatch,
    storageError: actionError ?? (!storageSupported ? STORAGE_LOCK_MESSAGE : storageError),
    storageBlocked: storageBlocked || !storageSupported,
    storageConflict,
    storageSupported,
    storagePending,
    subscribeStorageSaved: (listener) => { savedListeners.current.add(listener); return () => { savedListeners.current.delete(listener); }; },
    canUndo: !storageBlocked && storageSupported && history.past.length > 0,
    canRedo: !storageBlocked && storageSupported && history.future.length > 0,
    undo: () => { if (!blocked.current) rawDispatch({ type: 'history/undo' }); },
    redo: () => { if (!blocked.current) rawDispatch({ type: 'history/redo' }); },
    clearStorageError: () => {
      setActionError(undefined);
    },
    retrySave: () => {
      if (!blocked.current) persist(state);
    },
    resetData: async () => {
      if (!storageSupported || storageConflict) return false;
      const version = ++generation.current;
      const next = createInitialState();
      let success = false;
      setActionError(undefined);
      setStoragePending(true);
      queue.current = queue.current.then(async () => {
        if (!mounted.current || version !== generation.current) return;
        try {
          // Match cloud synchronization's lock order and wait for its active request.
          await navigator.locks.request(CLOUD_SYNC_KEY, { mode: 'exclusive' }, async () => {
            if (!mounted.current || version !== generation.current) return;
            // Local-only reset must never become an automatic server-wide deletion.
            // Removing corrupt settings is safe here because reset was explicitly confirmed.
            window.localStorage.removeItem(CLOUD_SYNC_KEY);
            window.dispatchEvent(new Event(CLOUD_SYNC_SETTINGS_EVENT));
            const result = await commitStoredState(next, snapshot.current, () => mounted.current && version === generation.current);
            if (result.status === 'cancelled') return;
            if (result.status !== 'saved') { if (mounted.current) recordFailure(result.status === 'error' ? { ...result, error: `초기화하지 못했습니다. ${result.error}` } : result); return; }
            snapshot.current = result.snapshot;
            savedMemory.current = next;
            blocked.current = false;
            success = true;
            if (!mounted.current) return;
            rawDispatch({ type: 'history/reload', state: next });
            setActionError(undefined); setStorageError(undefined); setStorageBlocked(false); setStorageConflict(false);
          });
        } catch {
          if (mounted.current && version === generation.current) recordFailure({ status: 'error', error: '자동 동기화를 안전하게 끄지 못해 초기화하지 않았습니다. 기존 일정은 유지됩니다. 브라우저 저장소와 잠금 권한을 확인한 뒤 다시 시도해 주세요.' });
        }
      }).finally(() => { if (mounted.current && version === generation.current) setStoragePending(false); });
      await queue.current;
      return success;
    },
    reloadData: () => {
      ++generation.current;
      setStoragePending(false);
      const latest = loadState();
      snapshot.current = latest.snapshot;
      blocked.current = latest.blocked || !storageSupported;
      setStorageBlocked(latest.blocked); setStorageConflict(false); setActionError(undefined); setStorageError(latest.error);
      // Preserve the current tab's in-memory data if the external value is corrupt.
      if (latest.blocked) return false;
      savedMemory.current = latest.state;
      rawDispatch({ type: 'history/reload', state: latest.state });
      return true;
    },
  }), [state, dispatch, actionError, storageError, storageBlocked, storageConflict, storageSupported, storagePending, persist, recordFailure, history.past.length, history.future.length]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used within AppProvider');
  return value;
}
