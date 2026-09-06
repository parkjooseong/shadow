import { describe, expect, it } from 'vitest';
import { eventCoreRange, getFootprint, summarizeEvent } from './calendar.ts';
import { expandEvents, recurrenceDates } from './recurrence.ts';
import { getEventValidationError, isAppState } from './validation.ts';
import { createInitialState } from '../services/storage';
import type { CalendarEvent } from './types';

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id: 'series', title: '수업', typeId: 'school', date: '2026-09-07', startMinute: 900, endMinute: 960, shadow: { preparationMinutes: 20, outboundTravelMinutes: 40, returnTravelMinutes: 40, recoveryMinutes: 30 }, cost: { transportWon: 4000, mealWon: 12000 }, createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z', ...overrides };
}

describe('recurring and spanning events', () => {
  it('expands biweekly occurrences with stable source identity and exclusions', () => {
    const master = event({ recurrence: { frequency: 'weekly', interval: 2, until: '2026-10-19' }, excludedDates: ['2026-09-21'] });
    const occurrences = expandEvents([master], '2026-09-01', '2026-10-31');
    expect(occurrences.map((item) => item.date)).toEqual(['2026-09-07', '2026-10-05', '2026-10-19']);
    expect(occurrences[1]).toMatchObject({ id: 'series@2026-10-05', sourceId: 'series', occurrenceDate: '2026-10-05', recurrence: undefined, excludedDates: undefined });
    expect(master.recurrence).toBeDefined();
    expect(master.excludedDates).toEqual(['2026-09-21']);
  });

  it('skips nonexistent month days without drifting or moving to month end', () => {
    const master = event({ date: '2026-01-31', recurrence: { frequency: 'monthly', interval: 1, until: '2026-05-31' } });
    expect(recurrenceDates(master)).toEqual(['2026-01-31', '2026-03-31', '2026-05-31']);
    expect(recurrenceDates(event({ date: '2024-02-29', recurrence: { frequency: 'monthly', interval: 12, until: '2028-02-29' } }))).toEqual(['2024-02-29', '2028-02-29']);
  });

  it('includes an occurrence when only its overnight return shadow is visible', () => {
    const master = event({ date: '2026-09-06', startMinute: 1380, endMinute: 1440, recurrence: { frequency: 'daily', interval: 1, until: '2026-09-06' } });
    const occurrences = expandEvents([master], '2026-09-07', '2026-09-07');
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].date).toBe('2026-09-06');
  });

  it('measures all-day dates inclusively and timed multi-day appointments absolutely', () => {
    const allDay = event({ allDay: true, date: '2026-09-07', endDate: '2026-09-09', startMinute: 0, endMinute: 1440 });
    expect(summarizeEvent(allDay).coreMinutes).toBe(3 * 1440);
    const spanning = event({ endDate: '2026-09-08', startMinute: 1380, endMinute: 60 });
    expect(summarizeEvent(spanning).coreMinutes).toBe(120);
    expect(eventCoreRange(spanning).end - eventCoreRange(spanning).start).toBe(120);
    expect(getFootprint(spanning).find((segment) => segment.kind === 'event')).toEqual({ kind: 'event', ...eventCoreRange(spanning) });
  });

  it('preserves the duration of recurring multi-day occurrences', () => {
    const master = event({ endDate: '2026-09-09', recurrence: { frequency: 'weekly', interval: 1, until: '2026-09-21' } });
    const occurrences = expandEvents([master], '2026-09-14', '2026-09-16');
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].endDate).toBe('2026-09-16');
    expect(summarizeEvent(occurrences[0]).coreMinutes).toBe(2940);
  });

  it('validates all-day and overnight shapes and rejects unbounded recurrence or invalid exclusions', () => {
    const types = createInitialState().eventTypes;
    expect(getEventValidationError(event({ endDate: '2026-09-08', startMinute: 1380, endMinute: 0 }), types)).toBeUndefined();
    expect(getEventValidationError(event({ allDay: true }), types)).toBeDefined();
    expect(getEventValidationError(event({ recurrence: { frequency: 'daily', interval: 0, until: '2026-10-01' } }), types)).toBeDefined();
    expect(getEventValidationError(event({ recurrence: { frequency: 'daily', interval: 1, until: '2040-10-01' } }), types)).toBeDefined();
    expect(getEventValidationError(event({ excludedDates: ['2026-09-08'] }), types)).toBeDefined();
    expect(getEventValidationError(event({ endDate: '2026-09-06' }), types)).toBeDefined();
  });

  it('rejects impossible expansion windows and too many visible occurrences explicitly', () => {
    expect(() => expandEvents([], '2026-02-30', '2026-09-07')).toThrow();
    expect(() => expandEvents([], '2026-09-08', '2026-09-07')).toThrow();
    const events = Array.from({ length: 5001 }, (_, index) => event({ id: String(index) }));
    expect(() => expandEvents(events, '2026-09-07', '2026-09-07')).toThrow('5,000');
  });

  it('persists linked edited exceptions only alongside the excluded original occurrence', () => {
    const master = event({ recurrence: { frequency: 'weekly', interval: 1, until: '2026-10-05' }, excludedDates: ['2026-09-14'] });
    const detached = event({ id: 'series@2026-09-14', sourceId: 'series', occurrenceDate: '2026-09-14', date: '2026-09-15' });
    const initial = createInitialState();
    expect(isAppState({ ...initial, events: [master, detached] })).toBe(true);
    expect(isAppState({ ...initial, events: [detached] })).toBe(false);
    expect(isAppState({ ...initial, events: [{ ...master, excludedDates: [] }, detached] })).toBe(false);
    const transient = expandEvents([{ ...master, excludedDates: [] }], '2026-09-14', '2026-09-14')[0];
    expect(isAppState({ ...initial, events: [master, { ...transient, occurrenceDate: '2026-09-21' }] })).toBe(false);
  });
});
