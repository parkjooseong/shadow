import { addDays, dateToDayNumber, dayNumberToDate, getFootprint } from './calendar.ts';
import { expandEvents } from './recurrence.ts';
import type { CalendarEvent, Conflict, FootprintSegment } from './types';
import { MAX_EXPANDED_EVENTS } from './validation.ts';

export const MAX_PREVIEW_CONFLICTS = 20;

export interface PreviewConflict extends Conflict {
  event: CalendarEvent;
  otherEvent: CalendarEvent;
  start: number;
  end: number;
}

export interface ConflictPreview {
  conflicts: PreviewConflict[];
  truncated: boolean;
  occurrenceCount: number;
  error?: string;
}

interface SegmentEntry {
  event: CalendarEvent;
  segment: FootprintSegment;
  candidate: boolean;
}

function supportedDate(absoluteMinute: number) {
  const day = Math.floor(absoluteMinute / 1440);
  return dayNumberToDate(Math.max(dateToDayNumber('0001-01-01'), Math.min(dateToDayNumber('9999-12-31'), day)));
}

/** Sweep only overlapping segments; stop after the bounded preview fills up. */
function collectConflicts(candidates: CalendarEvent[], surrounding: CalendarEvent[]): Pick<ConflictPreview, 'conflicts' | 'truncated'> {
  const entries: SegmentEntry[] = [
    ...candidates.flatMap((event) => getFootprint(event).map((segment) => ({ event, segment, candidate: true }))),
    ...surrounding.flatMap((event) => getFootprint(event).map((segment) => ({ event, segment, candidate: false }))),
  ];
  const boundaries = entries.flatMap((entry) => [
    { time: entry.segment.start, opening: true, entry },
    { time: entry.segment.end, opening: false, entry },
  ]).sort((a, b) => a.time - b.time || Number(a.opening) - Number(b.opening));
  const activeCandidates = new Set<SegmentEntry>();
  const activeOthers = new Set<SegmentEntry>();
  const conflicts: PreviewConflict[] = [];

  for (const boundary of boundaries) {
    const { entry } = boundary;
    const active = entry.candidate ? activeCandidates : activeOthers;
    if (!boundary.opening) { active.delete(entry); continue; }
    const peers = entry.candidate ? [activeCandidates, activeOthers] : [activeCandidates];
    for (const group of peers) {
      for (const peer of group) {
        if (peer.event.id === entry.event.id) continue;
        if (conflicts.length === MAX_PREVIEW_CONFLICTS) return { conflicts, truncated: true };
        const own = entry.candidate ? entry : peer;
        const other = entry.candidate ? peer : entry;
        const start = Math.max(own.segment.start, other.segment.start);
        const end = Math.min(own.segment.end, other.segment.end);
        conflicts.push({
          eventId: own.event.id, otherEventId: other.event.id,
          eventSegment: own.segment.kind, otherSegment: other.segment.kind,
          overlapMinutes: end - start,
          event: own.event, otherEvent: other.event, start, end,
        });
      }
    }
    active.add(entry);
  }
  return { conflicts, truncated: false };
}

/** Preview the full proposed series, preserving every other occurrence and edited exception. */
export function previewEventConflicts(candidate: CalendarEvent, events: CalendarEvent[]): ConflictPreview {
  try {
    const durationDays = dateToDayNumber(candidate.endDate ?? candidate.date) - dateToDayNumber(candidate.date);
    const lastDate = addDays(candidate.recurrence?.until ?? candidate.date, durationDays);
    const candidates = expandEvents([candidate], candidate.date, lastDate);
    if (!candidates.length) return { conflicts: [], truncated: false, occurrenceCount: 0 };
    const footprints = candidates.flatMap(getFootprint);
    const fromDate = supportedDate(Math.min(...footprints.map((segment) => segment.start)));
    const toDate = supportedDate(Math.max(...footprints.map((segment) => segment.end)) - 1);
    const remaining = events.filter((event) => event.id !== candidate.id).map((event) => {
      // Moving one generated occurrence replaces its original slot, not the entire series.
      if (event.id === candidate.sourceId && candidate.occurrenceDate) {
        return { ...event, excludedDates: [...new Set([...(event.excludedDates ?? []), candidate.occurrenceDate])] };
      }
      return event;
    });
    const surrounding = expandEvents(remaining, fromDate, toDate).filter((event) => event.id !== candidate.id);
    if (candidates.length + surrounding.length > MAX_EXPANDED_EVENTS) throw new Error('충돌 확인 대상이 5,000개를 넘었습니다. 반복 기간을 줄여 주세요.');
    return { ...collectConflicts(candidates, surrounding), occurrenceCount: candidates.length };
  } catch (cause) {
    return { conflicts: [], truncated: false, occurrenceCount: 0, error: cause instanceof Error ? cause.message : '충돌을 계산하지 못했습니다.' };
  }
}
