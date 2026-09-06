import { describe, expect, it } from 'vitest';
import { exportBackup, exportIcs, importBackup, importIcs } from './interchange.ts';
import { createInitialState } from './storage';
import { expandEvents } from '../domain/recurrence.ts';
import { getFootprint, summarizeEvent } from '../domain/calendar.ts';
import type { CalendarEvent } from '../domain/types';

function appointment(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id: 'hospital-event', title: '병원; 진료, 상담\\계획\n새 줄', typeId: 'hospital', location: '서울, 2층; 진료실', date: '2026-09-07', startMinute: 900, endMinute: 960, shadow: { preparationMinutes: 20, outboundTravelMinutes: 40, returnTravelMinutes: 40, recoveryMinutes: 30 }, cost: { transportWon: 4000, mealWon: 12000 }, createdAt: '2026-09-01T10:23:45.123Z', updatedAt: '2026-09-05T11:45:32.789Z', ...overrides };
}

const types = createInitialState().eventTypes;
const document = (...lines: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join('\r\n');
const component = (...lines: string[]) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];

describe('backup interchange', () => {
  it('round-trips all data and rejects malformed data without a partial fallback', () => {
    const state = { ...createInitialState(), events: [appointment({ recurrence: { frequency: 'weekly', interval: 1, until: '2026-10-05' } })] };
    expect(importBackup(exportBackup(state))).toEqual(state);
    expect(() => importBackup('{broken')).toThrow('JSON');
    expect(() => importBackup(JSON.stringify({ ...state, schemaVersion: 10 }))).toThrow('버전');
    expect(() => importBackup(JSON.stringify({ ...state, events: [{ ...state.events[0], title: '' }] }))).toThrow('데이터');
  });
});

describe('iCalendar interoperability', () => {
  it('round-trips Unicode, escaped text, shadows, costs, dates and stable identity', () => {
    const event = appointment({ title: '긴 한글 일정 이름 '.repeat(5).trim() });
    const state = { ...createInitialState(), events: [event] };
    const text = exportIcs(state);
    for (const line of text.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(text).toContain('\r\n ');
    const result = importIcs(text, types);
    expect(result.warnings).toEqual([]);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject(event);
    expect(importIcs(exportIcs({ ...state, events: [appointment()] }), types).events[0]).toMatchObject(appointment());
    expect(getFootprint(result.events[0])).toEqual(getFootprint(event));
  });

  it('exports provider core without local shadow/cost metadata', () => {
    const text = exportIcs({ ...createInitialState(), events: [appointment()] }, { includeShadowMetadata: false });
    expect(text).not.toContain('X-SHADOW');
    const result = importIcs(text, types);
    expect(result.events[0].id).toBe('ics:hospital-event@shadow.local');
    expect(result.events[0].shadow.preparationMinutes).toBe(0);
    expect(result.events[0].cost.transportWon).toBe(0);
  });

  it('treats all-day DTEND as exclusive and defaults an undated end to one day', () => {
    const text = document(...component('UID:trip', 'SUMMARY:여행', 'DTSTART;VALUE=DATE:20260907', 'DTEND;VALUE=DATE:20260910'), ...component('UID:holiday', 'SUMMARY:휴일', 'DTSTART;VALUE=DATE:20260908'));
    const result = importIcs(text, types);
    expect(result.warnings).toEqual([]);
    expect(result.events[0]).toMatchObject({ date: '2026-09-07', endDate: '2026-09-09', allDay: true, startMinute: 0, endMinute: 1440 });
    expect(summarizeEvent(result.events[0]).coreMinutes).toBe(4320);
    expect(summarizeEvent(result.events[1]).coreMinutes).toBe(1440);
    const roundTrip = importIcs(exportIcs({ ...createInitialState(), events: result.events }), types);
    expect(roundTrip.events.map(summarizeEvent)).toEqual(result.events.map(summarizeEvent));
  });

  it('converts UTC, floating local times, and IANA times to Seoul including day boundaries', () => {
    const text = document(
      ...component('UID:utc', 'DTSTART:20260907T160000Z', 'DTEND:20260907T170000Z'),
      ...component('UID:floating', 'DTSTART:20260907T150000', 'DTEND:20260907T160000'),
      ...component('UID:new-york', 'DTSTART;TZID="America/New_York":20260907T150000', 'DTEND;TZID="America/New_York":20260907T160000'),
    );
    const result = importIcs(text, types);
    expect(result.warnings).toEqual([]);
    expect(result.events.map(({ date, startMinute, endMinute }) => ({ date, startMinute, endMinute }))).toEqual([
      { date: '2026-09-08', startMinute: 60, endMinute: 120 },
      { date: '2026-09-07', startMinute: 900, endMinute: 960 },
      { date: '2026-09-08', startMinute: 240, endMinute: 300 },
    ]);
  });

  it('round-trips bounded recurrence and EXDATE with unchanged occurrences', () => {
    const recurring = appointment({ date: '2026-01-31', recurrence: { frequency: 'monthly', interval: 1, until: '2026-07-31' }, excludedDates: ['2026-03-31'] });
    const result = importIcs(exportIcs({ ...createInitialState(), events: [recurring] }), types);
    expect(result.warnings).toEqual([]);
    expect(result.events[0].recurrence).toEqual(recurring.recurrence);
    expect(result.events[0].excludedDates).toEqual(['2026-03-31']);
    expect(expandEvents(result.events, '2026-01-01', '2026-08-01').map((event) => event.date)).toEqual(['2026-01-31', '2026-05-31', '2026-07-31']);
  });

  it('supports COUNT and excludes a final occurrence later than UNTIL', () => {
    const result = importIcs(document(
      ...component('UID:count', 'DTSTART;TZID=Asia/Seoul:20260131T150000', 'DTEND;TZID=Asia/Seoul:20260131T160000', 'RRULE:FREQ=MONTHLY;COUNT=3'),
      ...component('UID:until', 'DTSTART;TZID=Asia/Seoul:20260907T150000', 'DTEND;TZID=Asia/Seoul:20260907T160000', 'RRULE:FREQ=DAILY;UNTIL=20260908T055959Z'),
    ), types);
    expect(result.warnings).toEqual([]);
    expect(result.events[0].recurrence?.until).toBe('2026-05-31');
    expect(result.events[1].recurrence?.until).toBe('2026-09-07');
  });

  it('materializes foreign recurrence across DST without shifting source wall times', () => {
    const result = importIcs(document(...component('UID:dst', 'DTSTART;TZID=America/New_York:20261031T090000', 'DTEND;TZID=America/New_York:20261031T100000', 'RRULE:FREQ=DAILY;COUNT=3')), types);
    expect(result.events.map(({ date, startMinute, recurrence }) => ({ date, startMinute, recurrence }))).toEqual([
      { date: '2026-10-31', startMinute: 1320, recurrence: undefined },
      { date: '2026-11-01', startMinute: 1380, recurrence: undefined },
      { date: '2026-11-02', startMinute: 1380, recurrence: undefined },
    ]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('시간대');
  });

  it('preserves nominal day duration across a daylight-saving transition', () => {
    const result = importIcs(document(...component('UID:day-duration', 'DTSTART;TZID=America/New_York:20260307T090000', 'DURATION:P1D')), types);
    expect(result.warnings).toEqual([]);
    expect(summarizeEvent(result.events[0]).coreMinutes).toBe(23 * 60);
  });

  it('preserves detached overrides and cancelled occurrences without duplicate series dates', () => {
    const text = document(
      ...component('UID:series', 'SUMMARY:회의', 'DTSTART;TZID=Asia/Seoul:20260907T150000', 'DTEND;TZID=Asia/Seoul:20260907T160000', 'RRULE:FREQ=DAILY;COUNT=3'),
      ...component('UID:series', 'RECURRENCE-ID;TZID=Asia/Seoul:20260908T150000', 'SUMMARY:바뀐 회의', 'DTSTART;TZID=Asia/Seoul:20260908T170000', 'DTEND;TZID=Asia/Seoul:20260908T180000'),
      ...component('UID:series', 'RECURRENCE-ID;TZID=Asia/Seoul:20260909T150000', 'STATUS:CANCELLED'),
    );
    const result = importIcs(text, types);
    expect(result.warnings).toEqual([]);
    expect(result.events).toHaveLength(2);
    const occurrences = expandEvents(result.events, '2026-09-07', '2026-09-09');
    expect(occurrences.map(({ date, startMinute }) => ({ date, startMinute }))).toEqual([{ date: '2026-09-07', startMinute: 900 }, { date: '2026-09-08', startMinute: 1020 }]);
    const exported = exportIcs({ ...createInitialState(), events: result.events });
    const importedAgain = importIcs(exported, types);
    expect(importedAgain.warnings).toEqual([]);
    expect(expandEvents(importedAgain.events, '2026-09-07', '2026-09-09').map(({ date, startMinute }) => ({ date, startMinute }))).toEqual(occurrences.map(({ date, startMinute }) => ({ date, startMinute })));
  });

  it('reports unsupported or malformed entries explicitly while preserving valid entries', () => {
    const text = document(
      ...component('UID:unsupported', 'DTSTART:20260907T150000', 'DTEND:20260907T160000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=3'),
      ...component('UID:infinite', 'DTSTART:20260907T150000', 'DTEND:20260907T160000', 'RRULE:FREQ=DAILY'),
      ...component('UID:invalid-date', 'DTSTART:20260230T150000', 'DTEND:20260230T160000'),
      ...component('UID:valid', 'SUMMARY:정상 일정', 'DTSTART:20260907T150000', 'DURATION:PT1H'),
    );
    const result = importIcs(text, types);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('정상 일정');
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings[0]).toContain('BYDAY');
    expect(result.warnings[1]).toContain('무기한');
    expect(result.warnings[2]).toContain('날짜');
    expect(() => importIcs('not an ICS file', types)).toThrow('VCALENDAR');
    expect(() => importIcs('BEGIN:VCALENDAR\r\nVERSION:1.0\r\nEND:VCALENDAR', types)).toThrow('2.0');
  });

  it('deduplicates repeated UID and rejects a non-existent DST start time', () => {
    const result = importIcs(document(
      ...component('UID:same', 'SUMMARY:처음', 'DTSTART:20260907T150000', 'DTEND:20260907T160000'),
      ...component('UID:same', 'SUMMARY:수정', 'DTSTART:20260907T160000', 'DTEND:20260907T170000'),
      ...component('UID:gap', 'DTSTART;TZID=America/New_York:20260308T023000', 'DTEND;TZID=America/New_York:20260308T033000'),
    ), types);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('수정');
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[1]).toContain('존재하지 않는 시각');
  });
});
