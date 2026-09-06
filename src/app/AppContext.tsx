import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState } from 'react';
import type { AppState, CalendarEvent, EventType } from '../domain/types';
import { getEventTypeValidationError, getEventValidationError } from '../domain/validation';
import { createInitialState, loadState, resetStoredState, saveState } from '../services/storage';

type Action =
  | { type: 'event/save'; event: CalendarEvent }
  | { type: 'event/delete'; id: string }
  | { type: 'type/save'; eventType: EventType }
  | { type: 'type/delete'; id: string }
  | { type: 'data/reset' };

function getActionError(state: AppState, action: Action): string | undefined {
  if (action.type === 'event/save') return getEventValidationError(action.event, state.eventTypes);
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
      const exists = state.events.some((event) => event.id === action.event.id);
      return { ...state, events: exists ? state.events.map((event) => event.id === action.event.id ? action.event : event) : [...state.events, action.event] };
    }
    case 'event/delete':
      return { ...state, events: state.events.filter((event) => event.id !== action.id) };
    case 'type/save': {
      const exists = state.eventTypes.some((eventType) => eventType.id === action.eventType.id);
      return { ...state, eventTypes: exists ? state.eventTypes.map((eventType) => eventType.id === action.eventType.id ? action.eventType : eventType) : [...state.eventTypes, action.eventType] };
    }
    case 'type/delete':
      return { ...state, eventTypes: state.eventTypes.filter((eventType) => eventType.id !== action.id) };
    case 'data/reset':
      return createInitialState();
  }
}

interface AppContextValue {
  state: AppState;
  dispatch: (action: Exclude<Action, { type: 'data/reset' }>) => boolean;
  storageError?: string;
  storageBlocked: boolean;
  clearStorageError: () => void;
  resetData: () => boolean;
  retrySave: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [loaded] = useState(loadState);
  const [state, rawDispatch] = useReducer(reducer, loaded.state);
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
  }), [state, dispatch, actionError, storageError, storageBlocked]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used within AppProvider');
  return value;
}
