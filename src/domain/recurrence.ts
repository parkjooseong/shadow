import { addDays, dateToDayNumber, getFootprint, toAbsoluteMinute } from './calendar.ts';
import type { CalendarEvent } from './types';
import { isValidCalendarDate, MAX_EXPANDED_EVENTS, MAX_RECURRENCE_DAYS } from './validation.ts';

/** Invalid month days are skipped rather than moved to the final day of a month. */
export function recurrenceDates(event: Pick<CalendarEvent, 'date' | 'recurrence' | 'excludedDates'>): string[] {
  if (!isValidCalendarDate(event.date)) throw new Error('반복 일정의 시작 날짜가 올바르지 않습니다.');
  if (!event.recurrence) return [event.date];
  const { frequency, interval, until } = event.recurrence;
  if (!['daily', 'weekly', 'monthly'].includes(frequency) || !Number.isInteger(interval) || interval < 1 || interval > 365 || !isValidCalendarDate(until) || until < event.date || dateToDayNumber(until) - dateToDayNumber(event.date) > MAX_RECURRENCE_DAYS) throw new Error('반복 규칙은 시작일부터 5년 이내의 유효한 종료일이 필요합니다.');
  const excluded = new Set(event.excludedDates ?? []);
  const dates: string[] = [];
  const [year, month, day] = event.date.split('-').map(Number);
  for (let index = 0; index <= MAX_RECURRENCE_DAYS; index++) {
    let next: string;
    if (frequency === 'monthly') {
      const targetMonth = year * 12 + month - 1 + index * interval;
      const targetYear = Math.floor(targetMonth / 12);
      if (targetYear > 9999) break;
      const prefix = `${String(targetYear).padStart(4, '0')}-${String(targetMonth % 12 + 1).padStart(2, '0')}`;
      if (`${prefix}-01` > until) break;
      next = `${prefix}-${String(day).padStart(2, '0')}`;
      if (!isValidCalendarDate(next)) continue;
    } else {
      const offset = index * interval * (frequency === 'weekly' ? 7 : 1);
      if (offset > MAX_RECURRENCE_DAYS || dateToDayNumber(event.date) + offset > dateToDayNumber(until)) break;
      next = addDays(event.date, offset);
    }
    if (next > until) break;
    if (!excluded.has(next)) dates.push(next);
  }
  return dates;
}

/** Materialize only occurrences whose body or shadows intersect the inclusive requested days. */
export function expandEvents(events: CalendarEvent[], fromDate: string, toDate: string): CalendarEvent[] {
  if (!isValidCalendarDate(fromDate) || !isValidCalendarDate(toDate) || toDate < fromDate) throw new Error('일정을 펼칠 날짜 범위가 올바르지 않습니다.');
  const from = toAbsoluteMinute(fromDate, 0);
  const to = toAbsoluteMinute(toDate, 1440);
  const result: CalendarEvent[] = [];
  for (const event of events) {
    for (const date of recurrenceDates(event)) {
      const offset = dateToDayNumber(date) - dateToDayNumber(event.date);
      const occurrence: CalendarEvent = event.recurrence ? {
        ...event,
        id: `${event.id}@${date}`,
        date,
        endDate: event.endDate ? addDays(event.endDate, offset) : undefined,
        recurrence: undefined,
        excludedDates: undefined,
        sourceId: event.id,
        occurrenceDate: date,
      } : event;
      const footprint = getFootprint(occurrence);
      if (footprint.some((segment) => segment.start < to && segment.end > from)) result.push(occurrence);
      if (result.length > MAX_EXPANDED_EVENTS) throw new Error('표시할 일정이 5,000개를 넘었습니다. 날짜 범위를 줄여 주세요.');
    }
  }
  return result.sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute || a.id.localeCompare(b.id));
}
