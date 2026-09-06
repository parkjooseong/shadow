import { getFootprint, toAbsoluteMinute } from '../../domain/calendar';
import type { CalendarEvent, FootprintSegment } from '../../domain/types';

export const HOUR_HEIGHT = 68;
export const MINUTE_HEIGHT = HOUR_HEIGHT / 60;
export const DAY_MINUTES = 1440;
export const MIN_EVENT_HEIGHT = 24;

export interface DayPlacement {
  event: CalendarEvent;
  segments: FootprintSegment[];
  lane: number;
  laneCount: number;
}

/** All segments of an event share a lane, including shadows continued from another day. */
export function layoutDay(events: CalendarEvent[], date: string): DayPlacement[] {
  const dayStart = toAbsoluteMinute(date, 0);
  const intervals = events.map((event) => {
    const segments = getFootprint(event).filter((segment) => segment.end > dayStart && segment.start < dayStart + DAY_MINUTES);
    const core = segments.find((segment) => segment.kind === 'event');
    return {
      event,
      segments,
      start: Math.max(dayStart, segments[0]?.start ?? Infinity),
      end: Math.min(dayStart + DAY_MINUTES, Math.max(segments.at(-1)?.end ?? -Infinity, core ? core.start + MIN_EVENT_HEIGHT / MINUTE_HEIGHT : -Infinity)),
      lane: 0,
      laneCount: 1,
    };
  }).filter((entry) => entry.segments.length > 0)
    .sort((a, b) => a.start - b.start || b.end - a.end || a.event.id.localeCompare(b.event.id));

  let group: typeof intervals = [];
  let groupEnd = -Infinity;
  let laneEnds: number[] = [];
  const finishGroup = () => {
    for (const item of group) item.laneCount = laneEnds.length;
  };

  for (const interval of intervals) {
    if (interval.start >= groupEnd) {
      finishGroup();
      group = [];
      laneEnds = [];
    }
    let lane = laneEnds.findIndex((end) => end <= interval.start);
    if (lane < 0) lane = laneEnds.length;
    interval.lane = lane;
    laneEnds[lane] = interval.end;
    group.push(interval);
    groupEnd = Math.max(groupEnd, interval.end);
  }
  finishGroup();
  return intervals;
}

export interface VisibleConflictSummary {
  overlapMinutes: number;
  conflictIds: Set<string>;
}

/** Sum every visible event-pair overlap without materializing a quadratic pair list. */
export function summarizeVisibleConflicts(events: CalendarEvent[], days: string[]): VisibleConflictSummary {
  const windows = [...new Set(days)].map((date) => toAbsoluteMinute(date, 0));
  const boundaries: { minute: number; opening: boolean; eventId: string }[] = [];
  for (const event of events) {
    for (const segment of getFootprint(event)) {
      for (const dayStart of windows) {
        const start = Math.max(segment.start, dayStart);
        const end = Math.min(segment.end, dayStart + DAY_MINUTES);
        if (end <= start) continue;
        boundaries.push({ minute: start, opening: true, eventId: event.id }, { minute: end, opening: false, eventId: event.id });
      }
    }
  }
  // Closing before opening excludes adjacent segments and adjacent events.
  boundaries.sort((a, b) => a.minute - b.minute || Number(a.opening) - Number(b.opening));
  const active = new Set<string>();
  const conflictIds = new Set<string>();
  let previousMinute = boundaries[0]?.minute ?? 0;
  let overlapMinutes = 0;
  for (const boundary of boundaries) {
    const pairCount = active.size * (active.size - 1) / 2;
    overlapMinutes += (boundary.minute - previousMinute) * pairCount;
    previousMinute = boundary.minute;
    if (!boundary.opening) {
      active.delete(boundary.eventId);
      continue;
    }
    // When there are already two active events, both were marked on opening.
    if (active.size === 1) conflictIds.add(active.values().next().value!);
    if (active.size > 0) conflictIds.add(boundary.eventId);
    active.add(boundary.eventId);
  }
  return { overlapMinutes, conflictIds };
}

export function snapStartMinute(rawMinute: number, duration: number): number {
  return Math.max(0, Math.min(DAY_MINUTES - duration, Math.round(rawMinute / 15) * 15));
}

/** Choose the higher WCAG contrast against an opaque, six-digit event color. */
export function eventForeground(color: string): '#000000' | '#ffffff' {
  const channels = [1, 3, 5].map((start) => parseInt(color.slice(start, start + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? '#000000' : '#ffffff';
}
