import type { CalendarEvent, Conflict, EventSummary, EventType, FootprintSegment, SegmentKind } from './types';

const DAY_MINUTES = 24 * 60;

export const segmentLabels: Record<SegmentKind, string> = {
  preparation: '준비',
  outbound: '출발 이동',
  event: '일정',
  return: '귀가 이동',
  recovery: '회복',
};

export function dateToDayNumber(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00.000Z`) / 86_400_000);
}

export function dayNumberToDate(dayNumber: number): string {
  return new Date(dayNumber * 86_400_000).toISOString().slice(0, 10);
}

export function toAbsoluteMinute(date: string, minute: number): number {
  return dateToDayNumber(date) * DAY_MINUTES + minute;
}

export function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return hours > 0 ? `${hours}시간${remaining ? ` ${remaining}분` : ''}` : `${remaining}분`;
}

export function formatTime(minute: number): string {
  if (minute === DAY_MINUTES) return '24:00';
  const normalized = ((minute % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

export function getFootprint(event: CalendarEvent): FootprintSegment[] {
  const start = toAbsoluteMinute(event.date, event.startMinute);
  const end = toAbsoluteMinute(event.date, event.endMinute);
  const prepStart = start - event.shadow.outboundTravelMinutes - event.shadow.preparationMinutes;
  const outboundStart = start - event.shadow.outboundTravelMinutes;
  const returnEnd = end + event.shadow.returnTravelMinutes;

  const segments: FootprintSegment[] = [
    { kind: 'preparation', start: prepStart, end: outboundStart },
    { kind: 'outbound', start: outboundStart, end: start },
    { kind: 'event', start, end },
    { kind: 'return', start: end, end: returnEnd },
    { kind: 'recovery', start: returnEnd, end: returnEnd + event.shadow.recoveryMinutes },
  ];
  return segments.filter((segment) => segment.end > segment.start);
}

export function summarizeEvent(event: CalendarEvent): EventSummary {
  const coreMinutes = event.endMinute - event.startMinute;
  const shadowMinutes =
    event.shadow.preparationMinutes +
    event.shadow.outboundTravelMinutes +
    event.shadow.returnTravelMinutes +
    event.shadow.recoveryMinutes;
  return {
    coreMinutes,
    shadowMinutes,
    totalMinutes: coreMinutes + shadowMinutes,
    totalCostWon: event.cost.transportWon + event.cost.mealWon,
  };
}

export function detectConflicts(candidate: CalendarEvent, events: CalendarEvent[]): Conflict[] {
  const candidateSegments = getFootprint(candidate);
  const conflicts: Conflict[] = [];
  for (const other of events) {
    if (other.id === candidate.id) continue;
    for (const candidateSegment of candidateSegments) {
      for (const otherSegment of getFootprint(other)) {
        const overlap = Math.min(candidateSegment.end, otherSegment.end) - Math.max(candidateSegment.start, otherSegment.start);
        if (overlap > 0) {
          conflicts.push({
            eventId: candidate.id,
            otherEventId: other.id,
            eventSegment: candidateSegment.kind,
            otherSegment: otherSegment.kind,
            overlapMinutes: overlap,
          });
        }
      }
    }
  }
  return conflicts;
}

export function defaultsFromType(eventType: EventType): CalendarEvent['shadow'] & CalendarEvent['cost'] {
  return {
    preparationMinutes: eventType.preparationMinutes,
    outboundTravelMinutes: eventType.travelMinutes,
    returnTravelMinutes: eventType.travelMinutes,
    recoveryMinutes: eventType.recoveryMinutes,
    transportWon: eventType.transportCostWon,
    mealWon: eventType.mealCostWon,
  };
}

export function startOfWeek(date: string): string {
  const day = dateToDayNumber(date);
  const weekday = new Date(day * 86_400_000).getUTCDay();
  const mondayOffset = weekday === 0 ? 6 : weekday - 1;
  return dayNumberToDate(day - mondayOffset);
}

export function addDays(date: string, amount: number): string {
  return dayNumberToDate(dateToDayNumber(date) + amount);
}

export function formatDateLabel(date: string, short = false): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'UTC',
    month: 'numeric',
    day: 'numeric',
    weekday: short ? 'short' : 'long',
  }).format(value);
}
