import type { AppState, CalendarEvent, EventType } from './types';
import { dateToDayNumber } from './calendar.ts';

export const MAX_SHADOW_MINUTES = 720;
export const MAX_COST_WON = 10_000_000;
export const MAX_RECURRENCE_DAYS = 366 * 5;
export const MAX_EXPANDED_EVENTS = 5000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown, maxLength?: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && (maxLength === undefined || value.length <= maxLength);
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

export function isValidCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
}

export function getEventTypeValidationError(value: unknown): string | undefined {
  if (!isRecord(value) || !isText(value.id)) return '일정 유형 정보를 확인해 주세요.';
  if (!isText(value.name, 30)) return '유형 이름은 1~30자로 입력해 주세요.';
  if (typeof value.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.color)) return '올바른 유형 색상을 선택해 주세요.';
  if (![value.preparationMinutes, value.travelMinutes, value.recoveryMinutes].every((minutes) => isIntegerInRange(minutes, 0, MAX_SHADOW_MINUTES))) {
    return `그림자 시간은 0~${MAX_SHADOW_MINUTES}분 사이의 정수로 입력해 주세요.`;
  }
  if (![value.transportCostWon, value.mealCostWon].every((cost) => isIntegerInRange(cost, 0, MAX_COST_WON))) {
    return '비용은 0~10,000,000원 사이의 정수로 입력해 주세요.';
  }
}

export function getEventValidationError(value: unknown, eventTypes: EventType[]): string | undefined {
  if (!isRecord(value) || !isText(value.id)) return '일정 정보를 확인해 주세요.';
  if (!isText(value.title, 80)) return '일정 제목은 1~80자로 입력해 주세요.';
  if (!eventTypes.some((type) => type.id === value.typeId)) return '사용할 수 있는 일정 유형을 선택해 주세요.';
  if (value.location !== undefined && typeof value.location !== 'string') return '장소는 문자로 입력해 주세요.';
  if (!isValidCalendarDate(value.date)) return '올바른 날짜를 입력해 주세요.';
  if (value.endDate !== undefined && (!isValidCalendarDate(value.endDate) || value.endDate < value.date)) return '종료 날짜는 시작 날짜와 같거나 이후여야 합니다.';
  const endDate = (value.endDate ?? value.date) as string;
  if (value.allDay !== undefined && typeof value.allDay !== 'boolean') return '종일 여부가 올바르지 않습니다.';
  if (!isIntegerInRange(value.startMinute, 0, 1439) || !isIntegerInRange(value.endMinute, 0, 1440) || (endDate === value.date && value.endMinute <= value.startMinute)) {
    return '시작과 종료 시간을 확인해 주세요. 종료는 시작 이후여야 합니다.';
  }
  if (value.allDay && (value.startMinute !== 0 || value.endMinute !== 1440)) return '종일 일정의 시간은 00:00부터 24:00까지여야 합니다.';
  if (value.recurrence !== undefined) {
    if (!isRecord(value.recurrence) || !['daily', 'weekly', 'monthly'].includes(String(value.recurrence.frequency)) || !isIntegerInRange(value.recurrence.interval, 1, 365) || !isValidCalendarDate(value.recurrence.until)) return '반복 주기와 종료 날짜를 확인해 주세요.';
    const repeatDays = dateToDayNumber(value.recurrence.until) - dateToDayNumber(value.date);
    if (repeatDays < 0 || repeatDays > MAX_RECURRENCE_DAYS) return '반복 종료일은 시작일부터 5년 이내로 지정해 주세요.';
    if (dateToDayNumber(endDate) + repeatDays > dateToDayNumber('9999-12-31')) return '반복 일정의 마지막 종료 날짜는 9999년을 넘을 수 없습니다.';
  }
  if (value.excludedDates !== undefined) {
    if (!Array.isArray(value.excludedDates) || value.excludedDates.length > MAX_EXPANDED_EVENTS || !value.excludedDates.every(isValidCalendarDate) || new Set(value.excludedDates).size !== value.excludedDates.length) return '반복 제외 날짜가 올바르지 않습니다.';
    if (value.excludedDates.length && (!isRecord(value.recurrence) || value.excludedDates.some((date) => date < (value.date as string) || date > (value.recurrence as Record<string, string>).until))) return '반복 제외 날짜는 반복 일정 기간 안에 있어야 합니다.';
  }
  if (value.sourceId !== undefined && (!isText(value.sourceId) || value.sourceId === value.id || !isValidCalendarDate(value.occurrenceDate))) return '반복 일정의 원본 연결이 올바르지 않습니다.';
  if (value.occurrenceDate !== undefined && (!isValidCalendarDate(value.occurrenceDate) || !isText(value.sourceId))) return '반복 일정의 발생 날짜가 올바르지 않습니다.';
  if (!isRecord(value.shadow) || ![value.shadow.preparationMinutes, value.shadow.outboundTravelMinutes, value.shadow.returnTravelMinutes, value.shadow.recoveryMinutes].every((minutes) => isIntegerInRange(minutes, 0, MAX_SHADOW_MINUTES))) {
    return `그림자 시간은 0~${MAX_SHADOW_MINUTES}분 사이의 정수로 입력해 주세요.`;
  }
  if (!isRecord(value.cost) || ![value.cost.transportWon, value.cost.mealWon].every((cost) => isIntegerInRange(cost, 0, MAX_COST_WON))) {
    return '비용은 0~10,000,000원 사이의 정수로 입력해 주세요.';
  }
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) return '일정의 생성 또는 수정 날짜가 올바르지 않습니다.';
}

export function isAppState(value: unknown): value is AppState {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.preferences)) return false;
  const preferences = value.preferences;
  if (preferences.locale !== 'ko-KR' || preferences.timeZone !== 'Asia/Seoul' || preferences.currency !== 'KRW' || preferences.weekStartsOn !== 1) return false;
  if (!Array.isArray(value.eventTypes) || !value.eventTypes.length || !Array.isArray(value.events)) return false;
  if (!value.eventTypes.every((type: unknown) => getEventTypeValidationError(type) === undefined)) return false;
  const eventTypes = value.eventTypes as EventType[];
  if (new Set(eventTypes.map((type) => type.id)).size !== eventTypes.length) return false;
  if (!value.events.every((event: unknown) => getEventValidationError(event, eventTypes) === undefined)) return false;
  const events = value.events as CalendarEvent[];
  if (new Set(events.map((event) => event.id)).size !== events.length) return false;
  const byId = new Map(events.map((event) => [event.id, event]));
  return events.every((event) => {
    if (!event.sourceId) return true;
    const master = byId.get(event.sourceId);
    // Expanded view copies are not persisted. A stored linked event is an edited
    // exception whose original occurrence was excluded atomically on its master.
    return !event.recurrence && !event.excludedDates?.length && Boolean(master?.recurrence && master.excludedDates?.includes(event.occurrenceDate!));
  });
}
