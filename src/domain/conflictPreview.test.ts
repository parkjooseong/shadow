import { describe, expect, it } from 'vitest';
import { addDays } from './calendar.ts';
import { MAX_PREVIEW_CONFLICTS, previewEventConflicts } from './conflictPreview.ts';
import { expandEvents } from './recurrence.ts';
import type { CalendarEvent } from './types';

function appointment(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id: 'candidate', title: '반복 공부', typeId: 'online', date: '2026-09-07', startMinute: 900, endMinute: 960, shadow: { preparationMinutes: 0, outboundTravelMinutes: 0, returnTravelMinutes: 0, recoveryMinutes: 0 }, cost: { transportWon: 0, mealWon: 0 }, createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z', ...overrides };
}

const daily = { frequency: 'daily', interval: 1, until: '2026-09-09' } as const;

describe('bounded full-series conflict preview', () => {
  it('finds a conflict on a later occurrence with its exact date and overlap', () => {
    const candidate = appointment({ recurrence: daily });
    const other = appointment({ id: 'other', title: '다음 날 병원', date: '2026-09-08', startMinute: 930, endMinute: 990 });
    const result = previewEventConflicts(candidate, [other]);
    expect(result).toMatchObject({ occurrenceCount: 3, truncated: false });
    expect(result.error).toBeUndefined();
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ eventId: 'candidate@2026-09-08', otherEventId: 'other', overlapMinutes: 30, event: { date: '2026-09-08' }, otherEvent: { title: '다음 날 병원' } });
  });

  it('replaces the original master when previewing a whole-series edit', () => {
    const original = appointment({ recurrence: daily });
    expect(previewEventConflicts({ ...original, startMinute: 915 }, [original]).conflicts).toEqual([]);
  });

  it('replaces only the selected generated occurrence without colliding with itself', () => {
    const master = appointment({ recurrence: daily });
    const occurrence = expandEvents([master], '2026-09-08', '2026-09-08')[0];
    const before = structuredClone(master);
    expect(previewEventConflicts({ ...occurrence, startMinute: 915 }, [master]).conflicts).toEqual([]);
    expect(master).toEqual(before);
    const moved = previewEventConflicts({ ...occurrence, date: '2026-09-09' }, [master]);
    expect(moved.conflicts).toHaveLength(1);
    expect(moved.conflicts[0].otherEventId).toBe('candidate@2026-09-09');
  });

  it('does not hide a preserved edited exception when editing the master', () => {
    const original = appointment({ recurrence: daily, excludedDates: ['2026-09-08'] });
    const exception = appointment({ id: 'candidate@2026-09-08', sourceId: 'candidate', occurrenceDate: '2026-09-08', date: '2026-09-09' });
    const result = previewEventConflicts(original, [original, exception]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].otherEventId).toBe(exception.id);
    expect(previewEventConflicts(exception, [original, exception]).conflicts).toHaveLength(1);
    expect(previewEventConflicts({ ...exception, date: '2026-09-08' }, [original, exception]).conflicts).toEqual([]);
  });

  it('finds overlap between different occurrences of the proposed series itself', () => {
    const result = previewEventConflicts(appointment({ endDate: '2026-09-08', recurrence: { ...daily, until: '2026-09-08' } }), []);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].overlapMinutes).toBe(60);
    expect(result.conflicts[0].eventId).not.toBe(result.conflicts[0].otherEventId);
  });

  it('includes a next-day neighbor touched only by a return shadow', () => {
    const candidate = appointment({ startMinute: 1380, endMinute: 1440, shadow: { preparationMinutes: 0, outboundTravelMinutes: 0, returnTravelMinutes: 40, recoveryMinutes: 30 } });
    const other = appointment({ id: 'next', date: '2026-09-08', startMinute: 20, endMinute: 50 });
    const result = previewEventConflicts(candidate, [other]);
    expect(result.conflicts.map((conflict) => [conflict.eventSegment, conflict.overlapMinutes])).toEqual([['return', 20], ['recovery', 10]]);
  });

  it('treats touching boundaries as adjacent, and respects excluded dates', () => {
    const candidate = appointment({ recurrence: daily, excludedDates: ['2026-09-08'] });
    const others = [appointment({ id: 'adjacent', startMinute: 960, endMinute: 1020 }), appointment({ id: 'excluded', date: '2026-09-08' })];
    expect(previewEventConflicts(candidate, others).conflicts).toEqual([]);
    expect(previewEventConflicts({ ...candidate, excludedDates: ['2026-09-07', '2026-09-08', '2026-09-09'] }, others)).toMatchObject({ occurrenceCount: 0, conflicts: [], truncated: false });
  });

  it('caps dense conflict details without claiming the check is exhaustive', () => {
    const others = Array.from({ length: 4999 }, (_, index) => appointment({ id: `other-${index}` }));
    const result = previewEventConflicts(appointment(), others);
    expect(result.conflicts).toHaveLength(MAX_PREVIEW_CONFLICTS);
    expect(result.truncated).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('reports limits explicitly instead of treating an unfinished calculation as no conflicts', () => {
    const others = Array.from({ length: 5000 }, (_, index) => appointment({ id: `other-${index}` }));
    expect(previewEventConflicts(appointment(), others).error).toContain('5,000');
    expect(previewEventConflicts(appointment({ recurrence: { ...daily, until: '2035-09-07' } }), []).error).toContain('5년');
  });

  it('checks a sparse five-year series without pairwise comparisons across unrelated dates', () => {
    const recurrence = { ...daily, until: addDays('2026-09-07', 1830) };
    const candidate = appointment({ recurrence });
    const other = appointment({ id: 'morning', startMinute: 540, endMinute: 600, recurrence });
    expect(previewEventConflicts(candidate, [other])).toMatchObject({ occurrenceCount: 1831, conflicts: [], truncated: false });
  });

  it('clamps neighbor queries at the supported calendar date boundaries', () => {
    const shadow = { preparationMinutes: 720, outboundTravelMinutes: 720, returnTravelMinutes: 720, recoveryMinutes: 720 };
    expect(previewEventConflicts(appointment({ date: '0001-01-01', startMinute: 0, shadow }), []).error).toBeUndefined();
    expect(previewEventConflicts(appointment({ date: '9999-12-31', endMinute: 1440, shadow }), []).error).toBeUndefined();
  });
});
