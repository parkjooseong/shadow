import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '../../domain/types';
import { eventForeground, layoutDay, snapStartMinute, visibleConflicts } from './layout';

function appointment(id: string, startMinute: number, endMinute: number, overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id, title: id, typeId: 'hospital', date: '2026-09-07', startMinute, endMinute,
    shadow: { preparationMinutes: 0, outboundTravelMinutes: 0, returnTravelMinutes: 0, recoveryMinutes: 0 },
    cost: { transportWon: 0, mealWon: 0 },
    createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z',
    ...overrides,
  };
}

describe('calendar layout', () => {
  it('keeps coinciding events in distinct lanes regardless of insertion order', () => {
    const events = [appointment('b', 900, 960), appointment('a', 900, 960)];
    const result = layoutDay(events, '2026-09-07');
    expect(result.map(({ event, lane, laneCount }) => [event.id, lane, laneCount])).toEqual([['a', 0, 2], ['b', 1, 2]]);
    expect(layoutDay([...events].reverse(), '2026-09-07')).toEqual(result);
  });

  it('reuses lanes for adjacent events and restores full width after an overlapping group', () => {
    const result = layoutDay([appointment('a', 900, 960), appointment('b', 930, 990), appointment('c', 960, 1020), appointment('d', 1020, 1080)], '2026-09-07');
    expect(result.map(({ event, lane, laneCount }) => [event.id, lane, laneCount])).toEqual([['a', 0, 2], ['b', 1, 2], ['c', 0, 2], ['d', 0, 1]]);
  });

  it('separates short event buttons that would cover each other visually', () => {
    const result = layoutDay([appointment('a', 900, 901), appointment('b', 902, 903)], '2026-09-07');
    expect(result.map(({ laneCount }) => laneCount)).toEqual([2, 2]);
  });

  it('includes after-midnight shadows even if their main event is on the preceding day', () => {
    const late = appointment('late', 1380, 1440, { shadow: { preparationMinutes: 0, outboundTravelMinutes: 0, returnTravelMinutes: 40, recoveryMinutes: 30 } });
    expect(layoutDay([late], '2026-09-08')[0].segments.map((segment) => segment.kind)).toEqual(['return', 'recovery']);
    expect(layoutDay([late], '2026-09-06')).toEqual([]);
  });

  it('counts a 23-minute overlap once, not once for each event', () => {
    const conflicts = visibleConflicts([appointment('a', 900, 960), appointment('b', 937, 1000)], ['2026-09-07']);
    expect(conflicts.reduce((total, conflict) => total + conflict.overlapMinutes, 0)).toBe(23);
  });

  it('excludes offscreen overlaps and clips midnight overlaps to the visible day', () => {
    const events = [appointment('a', 1380, 1440, { shadow: { preparationMinutes: 0, outboundTravelMinutes: 0, returnTravelMinutes: 60, recoveryMinutes: 0 } }), appointment('b', 1380, 1440, { shadow: { preparationMinutes: 0, outboundTravelMinutes: 0, returnTravelMinutes: 30, recoveryMinutes: 0 } })];
    expect(visibleConflicts(events, ['2026-09-06'])).toEqual([]);
    expect(visibleConflicts(events, ['2026-09-08']).reduce((sum, conflict) => sum + conflict.overlapMinutes, 0)).toBe(30);
  });

  it('snaps minutes and clamps the entire event within its day', () => {
    expect(snapStartMinute(961, 60)).toBe(960);
    expect(snapStartMinute(-30, 60)).toBe(0);
    expect(snapStartMinute(1430, 60)).toBe(1380);
    expect(snapStartMinute(1430, 62)).toBe(1378);
  });

  it('chooses legible text for black, white, and middle-luminance custom colors', () => {
    expect(eventForeground('#000000')).toBe('#ffffff');
    expect(eventForeground('#ffffff')).toBe('#000000');
    expect(eventForeground('#777777')).toBe('#000000');
    expect(eventForeground('#8674ee')).toBe('#000000');
  });
});
