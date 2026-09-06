import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '../../domain/types';
import { eventForeground, layoutDay, snapStartMinute, summarizeVisibleConflicts } from './layout';

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
    const summary = summarizeVisibleConflicts([appointment('a', 900, 960), appointment('b', 937, 1000)], ['2026-09-07']);
    expect(summary).toEqual({ overlapMinutes: 23, conflictIds: new Set(['a', 'b']) });
  });

  it('excludes offscreen overlaps and clips midnight overlaps to the visible day', () => {
    const events = [appointment('a', 1380, 1440, { shadow: { preparationMinutes: 0, outboundTravelMinutes: 0, returnTravelMinutes: 60, recoveryMinutes: 0 } }), appointment('b', 1380, 1440, { shadow: { preparationMinutes: 0, outboundTravelMinutes: 0, returnTravelMinutes: 30, recoveryMinutes: 0 } })];
    expect(summarizeVisibleConflicts(events, ['2026-09-06'])).toEqual({ overlapMinutes: 0, conflictIds: new Set() });
    expect(summarizeVisibleConflicts(events, ['2026-09-08'])).toEqual({ overlapMinutes: 30, conflictIds: new Set(['a', 'b']) });
    expect(summarizeVisibleConflicts(events, ['2026-09-07', '2026-09-08'])).toEqual({ overlapMinutes: 90, conflictIds: new Set(['a', 'b']) });
  });

  it('excludes adjacent event and shadow boundaries from conflict identities', () => {
    const events = [
      appointment('a', 900, 930, { shadow: { preparationMinutes: 0, outboundTravelMinutes: 0, returnTravelMinutes: 15, recoveryMinutes: 15 } }),
      appointment('b', 990, 1020, { shadow: { preparationMinutes: 15, outboundTravelMinutes: 15, returnTravelMinutes: 0, recoveryMinutes: 0 } }),
    ];
    expect(summarizeVisibleConflicts(events, ['2026-09-07'])).toEqual({ overlapMinutes: 0, conflictIds: new Set() });
  });

  it('counts three simultaneous events by pairs and marks every overlapping event only', () => {
    const events = [appointment('a', 900, 960), appointment('b', 930, 990), appointment('c', 945, 975), appointment('adjacent', 990, 1020)];
    expect(summarizeVisibleConflicts(events, ['2026-09-07'])).toEqual({ overlapMinutes: 75, conflictIds: new Set(['a', 'b', 'c']) });
    expect(summarizeVisibleConflicts([...events].reverse(), ['2026-09-07'])).toEqual(summarizeVisibleConflicts(events, ['2026-09-07']));
  });

  it('clips multiday events to distinct requested days without filling gaps or counting duplicate days', () => {
    const events = [
      appointment('a', 1380, 60, { endDate: '2026-09-10' }),
      appointment('b', 1410, 30, { endDate: '2026-09-10' }),
      appointment('offscreen', 900, 960, { date: '2026-09-08' }),
    ];
    expect(summarizeVisibleConflicts(events, ['2026-09-09', '2026-09-07', '2026-09-07'])).toEqual({ overlapMinutes: 1470, conflictIds: new Set(['a', 'b']) });
  });

  it('does not mark the removed drag source or its previously overlapping neighbor', () => {
    const events = [appointment('moving', 900, 960), appointment('neighbor', 930, 990), appointment('a', 1100, 1160), appointment('b', 1130, 1190)];
    const stationary = events.filter((event) => event.id !== 'moving');
    expect(summarizeVisibleConflicts(stationary, ['2026-09-07'])).toEqual({ overlapMinutes: 30, conflictIds: new Set(['a', 'b']) });
  });

  it('summarizes all 5,000 dense events exactly without dropping conflict identities', () => {
    const count = 5000;
    const events = Array.from({ length: count }, (_, index) => appointment(`dense-${index}`, 900, 960, {
      shadow: { preparationMinutes: 10, outboundTravelMinutes: 10, returnTravelMinutes: 10, recoveryMinutes: 10 },
    }));
    const summary = summarizeVisibleConflicts(events, ['2026-09-07']);
    expect(summary.overlapMinutes).toBe(count * (count - 1) / 2 * 100);
    expect(summary.conflictIds).toEqual(new Set(events.map((event) => event.id)));
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
