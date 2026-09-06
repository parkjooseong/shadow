import { detectConflicts, getFootprint, toAbsoluteMinute } from '../../domain/calendar';
import type { CalendarEvent, Conflict, FootprintSegment } from '../../domain/types';

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

/** Count each event pair once, and only the overlap inside the dates on screen. */
export function visibleConflicts(events: CalendarEvent[], days: string[]): Conflict[] {
  const windows = days.map((date) => toAbsoluteMinute(date, 0));
  return events.flatMap((event, index) => detectConflicts(event, events.slice(index + 1)).flatMap((conflict) => {
    const other = events.find((item) => item.id === conflict.otherEventId)!;
    const segment = getFootprint(event).find((item) => item.kind === conflict.eventSegment)!;
    const otherSegment = getFootprint(other).find((item) => item.kind === conflict.otherSegment)!;
    const start = Math.max(segment.start, otherSegment.start);
    const end = Math.min(segment.end, otherSegment.end);
    const overlapMinutes = windows.reduce((total, dayStart) => total + Math.max(0, Math.min(end, dayStart + DAY_MINUTES) - Math.max(start, dayStart)), 0);
    return overlapMinutes > 0 ? [{ ...conflict, overlapMinutes }] : [];
  }));
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
