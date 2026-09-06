import type { AppState, EventType } from '../domain/types';
import { isAppState } from '../domain/validation';

export const STORAGE_KEY = 'shadow.appState.v1';

export const defaultEventTypes: EventType[] = [
  { id: 'school', name: '학교 수업', color: '#7c6cff', preparationMinutes: 30, travelMinutes: 40, recoveryMinutes: 10, transportCostWon: 0, mealCostWon: 0 },
  { id: 'hospital', name: '병원', color: '#ff7a66', preparationMinutes: 20, travelMinutes: 40, recoveryMinutes: 30, transportCostWon: 0, mealCostWon: 0 },
  { id: 'friend', name: '친구 약속', color: '#f2aa3d', preparationMinutes: 30, travelMinutes: 50, recoveryMinutes: 20, transportCostWon: 0, mealCostWon: 0 },
  { id: 'online', name: '온라인 회의', color: '#4cbba5', preparationMinutes: 5, travelMinutes: 0, recoveryMinutes: 10, transportCostWon: 0, mealCostWon: 0 },
];

export function createInitialState(): AppState {
  return {
    schemaVersion: 1,
    preferences: { locale: 'ko-KR', timeZone: 'Asia/Seoul', currency: 'KRW', weekStartsOn: 1 },
    eventTypes: defaultEventTypes.map((type) => ({ ...type })),
    events: [],
  };
}

export interface LoadResult {
  state: AppState;
  error?: string;
  blocked: boolean;
  snapshot: string | null;
}

export function loadState(): LoadResult {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return { state: createInitialState(), snapshot: null, blocked: true, error: '브라우저 저장소를 읽지 못했습니다. 저장된 데이터 보호를 위해 변경을 중지했습니다. 브라우저 설정을 확인한 뒤 새로고침해 주세요.' };
  }
  if (raw === null) return { state: createInitialState(), snapshot: null, blocked: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isAppState(parsed)) return { state: createInitialState(), snapshot: raw, blocked: true, error: '저장된 데이터 형식 또는 버전을 읽을 수 없습니다. 기존 데이터는 보존되어 있으며, 전체 초기화 전에는 변경할 수 없습니다.' };
    return { state: parsed, snapshot: raw, blocked: false };
  } catch {
    return { state: createInitialState(), snapshot: raw, blocked: true, error: '저장된 데이터가 손상되어 읽을 수 없습니다. 기존 데이터는 보존되어 있으며, 전체 초기화 전에는 변경할 수 없습니다.' };
  }
}

export function saveState(state: AppState): string | undefined {
  if (!isAppState(state)) return '올바르지 않은 일정 데이터는 저장할 수 없습니다.';
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return undefined;
  } catch {
    return '변경사항을 이 브라우저에 저장하지 못했습니다. 저장 공간 또는 개인정보 보호 설정을 확인해 주세요.';
  }
}

export function resetStoredState(): string | undefined {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    return undefined;
  } catch {
    return '브라우저 저장소를 초기화하지 못했습니다. 기존 데이터는 유지됩니다. 브라우저 설정을 확인해 주세요.';
  }
}

export type CommitResult =
  | { status: 'saved'; snapshot: string }
  | { status: 'cancelled' }
  | { status: 'conflict' | 'unsupported' | 'error'; error: string };

export function supportsStorageLock(): boolean {
  return typeof navigator.locks?.request === 'function';
}

export const STORAGE_CONFLICT_MESSAGE = '다른 탭에서 저장 데이터가 변경되어 이 탭의 저장을 중지했습니다. 이 탭의 변경사항은 화면에 남아 있습니다. 백업한 뒤 최신 데이터를 불러와 주세요.';
export const STORAGE_LOCK_MESSAGE = '이 브라우저 환경은 안전한 동시 저장을 지원하지 않아 읽기 전용입니다. HTTPS 또는 localhost에서 지원 브라우저로 열어 주세요.';

/** Serialize cooperating tabs and compare the exact snapshot read before editing. */
export async function commitStoredState(state: AppState, expectedSnapshot: string | null, isCurrent: () => boolean = () => true): Promise<CommitResult> {
  if (!isAppState(state)) return { status: 'error', error: '올바르지 않은 일정 데이터는 저장할 수 없습니다.' };
  if (!supportsStorageLock()) return { status: 'unsupported', error: STORAGE_LOCK_MESSAGE };
  try {
    return await navigator.locks.request(STORAGE_KEY, { mode: 'exclusive' }, () => {
      if (!isCurrent()) return { status: 'cancelled' } as const;
      const current = window.localStorage.getItem(STORAGE_KEY);
      const snapshot = JSON.stringify(state);
      if (current === snapshot) return { status: 'saved', snapshot } as const;
      if (current !== expectedSnapshot) return { status: 'conflict', error: STORAGE_CONFLICT_MESSAGE } as const;
      // No await between comparison and write: every SHADOW tab holds this same lock.
      const error = saveState(state);
      return error ? { status: 'error', error } as const : { status: 'saved', snapshot } as const;
    });
  } catch {
    return { status: 'error', error: '브라우저 저장 잠금 또는 데이터에 접근하지 못했습니다. 변경사항을 이 브라우저에 저장하지 못했습니다. 백업 후 저장을 재시도해 주세요.' };
  }
}
