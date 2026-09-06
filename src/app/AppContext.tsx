import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState } from 'react';
import type { AppState, CalendarEvent, EventType } from '../domain/types';
import { getEventTypeValidationError, getEventValidationError, isAppState } from '../domain/validation';
import { createInitialState, loadState, resetStoredState, saveState } from '../services/storage';

type Action =
  | { type: 'event/save'; event: CalendarEvent }
  | { type: 'event/delete'; id: string; sourceId?: string; occurrenceDate?: string; updatedAt?: string }
  | { type: 'type/save'; eventType: EventType }
  | { type: 'type/delete'; id: string }
  | { type: 'data/reset' }
  | { type: 'state/replace'; state: AppState };

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
      return action.state;
  }
}

interface History { present: AppState; past: AppState[]; future: AppState[] }
type HistoryAction = Action | { type: 'history/undo' } | { type: 'history/redo' };
function historyReducer(history: History, action: HistoryAction): History {
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
  clearStorageError: () => void;
  resetData: () => boolean;
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

  useEffect(() => {
    if (storageBlocked) return;
    const error = saveState(state);
    setStorageError(error);
  }, [state, storageBlocked]);

  const dispatch = useCallback<AppContextValue['dispatch']>((action) => {
    if (storageBlocked) return false;
    const error = getActionError(state, action);
    setActionError(error);
    if (error) return false;
    rawDispatch(action);
    return true;
  }, [state, storageBlocked]);

  const value = useMemo<AppContextValue>(() => ({
    state,
    dispatch,
    storageError: actionError ?? storageError,
    storageBlocked,
    canUndo: !storageBlocked && history.past.length > 0,
    canRedo: !storageBlocked && history.future.length > 0,
    undo: () => { if (!storageBlocked) rawDispatch({ type: 'history/undo' }); },
    redo: () => { if (!storageBlocked) rawDispatch({ type: 'history/redo' }); },
    clearStorageError: () => {
      setActionError(undefined);
    },
    retrySave: () => {
      if (!storageBlocked) setStorageError(saveState(state));
    },
    resetData: () => {
      const error = resetStoredState();
      if (error) {
        setStorageError(error);
        return false;
      }
      rawDispatch({ type: 'data/reset' });
      setActionError(undefined);
      setStorageError(undefined);
      setStorageBlocked(false);
      return true;
    },
  }), [state, dispatch, actionError, storageError, storageBlocked, history.past.length, history.future.length]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used within AppProvider');
  return value;
}
