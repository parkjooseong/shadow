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
}

export function loadState(): LoadResult {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return { state: createInitialState(), blocked: true, error: '브라우저 저장소를 읽지 못했습니다. 저장된 데이터 보호를 위해 변경을 중지했습니다. 브라우저 설정을 확인한 뒤 새로고침해 주세요.' };
  }
  if (raw === null) return { state: createInitialState(), blocked: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isAppState(parsed)) return { state: createInitialState(), blocked: true, error: '저장된 데이터 형식 또는 버전을 읽을 수 없습니다. 기존 데이터는 보존되어 있으며, 전체 초기화 전에는 변경할 수 없습니다.' };
    return { state: parsed, blocked: false };
  } catch {
    return { state: createInitialState(), blocked: true, error: '저장된 데이터가 손상되어 읽을 수 없습니다. 기존 데이터는 보존되어 있으며, 전체 초기화 전에는 변경할 수 없습니다.' };
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
