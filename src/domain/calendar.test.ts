import { describe, expect, it } from 'vitest';
import { addDays, detectConflicts, formatDateLabel, formatTime, getFootprint, summarizeEvent } from './calendar';
import type { CalendarEvent } from './types';

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'hospital',
    title: '병원 진료',
    typeId: 'hospital',
    date: '2026-08-10',
    startMinute: 15 * 60,
    endMinute: 16 * 60,
    shadow: { preparationMinutes: 20, outboundTravelMinutes: 40, returnTravelMinutes: 40, recoveryMinutes: 30 },
    cost: { transportWon: 4000, mealWon: 12000 },
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  };
}

describe('calendar domain', () => {
  it('preserves calendar dates across month, leap-day, and early-year boundaries', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('0099-12-31', 1)).toBe('0100-01-01');
    expect(formatDateLabel('2026-09-07', true)).toContain('월');
    expect(formatTime(1440)).toBe('24:00');
  });
  it('calculates a hospital appointment as 3 hours and 10 minutes', () => {
    const summary = summarizeEvent(makeEvent());
    expect(summary.totalMinutes).toBe(190);
    expect(summary.totalCostWon).toBe(16000);
  });

  it('orders preparation, outbound, event, return, and recovery as one footprint', () => {
    const segments = getFootprint(makeEvent());
    expect(segments.map((segment) => segment.kind)).toEqual(['preparation', 'outbound', 'event', 'return', 'recovery']);
    expect(segments[0].end).toBe(segments[1].start);
    expect(segments[3].end).toBe(segments[4].start);
  });

  it('does not flag segments that only touch at their boundary', () => {
    const first = makeEvent({ shadow: { preparationMinutes: 0, outboundTravelMinutes: 0, returnTravelMinutes: 0, recoveryMinutes: 0 } });
    const second = makeEvent({ id: 'second', title: '다음 일정', startMinute: 16 * 60, endMinute: 17 * 60, shadow: { preparationMinutes: 0, outboundTravelMinutes: 0, returnTravelMinutes: 0, recoveryMinutes: 0 } });
    expect(detectConflicts(first, [first, second])).toHaveLength(0);
  });

  it('reports shadow collisions with their segment kinds and overlap minutes', () => {
    const first = makeEvent();
    const second = makeEvent({ id: 'class', title: '수업', startMinute: 16 * 60 + 30, endMinute: 17 * 60 + 30, shadow: { preparationMinutes: 0, outboundTravelMinutes: 0, returnTravelMinutes: 0, recoveryMinutes: 0 } });
    const conflicts = detectConflicts(first, [first, second]);
    expect(conflicts).toContainEqual(expect.objectContaining({ eventSegment: 'recovery', otherSegment: 'event', overlapMinutes: 30 }));
  });
});
