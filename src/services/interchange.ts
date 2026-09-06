import { addDays, dateToDayNumber, dayNumberToDate, eventCoreRange } from '../domain/calendar.ts';
import { recurrenceDates } from '../domain/recurrence.ts';
import type { AppState, CalendarEvent, EventType } from '../domain/types';
import { getEventValidationError, isAppState, isValidCalendarDate, MAX_EXPANDED_EVENTS, MAX_RECURRENCE_DAYS } from '../domain/validation.ts';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const encoder = new TextEncoder();
const zeroShadow = { preparationMinutes: 0, outboundTravelMinutes: 0, returnTravelMinutes: 0, recoveryMinutes: 0 };

export function exportBackup(state: AppState): string {
  if (!isAppState(state)) throw new Error('올바르지 않은 데이터는 백업할 수 없습니다.');
  return JSON.stringify(state, null, 2);
}

function checkFileSize(text: string) {
  if (encoder.encode(text).length > MAX_FILE_BYTES) throw new Error('가져올 파일은 5MB 이하여야 합니다.');
}

export function importBackup(text: string): AppState {
  checkFileSize(text);
  let value: unknown;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('백업 파일의 JSON 형식이 올바르지 않습니다.'); }
  if (!isAppState(value)) throw new Error('지원하지 않는 백업 버전 또는 올바르지 않은 일정 데이터입니다.');
  return value;
}

function escapeText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}

function unescapeText(text: string): string {
  return text.replace(/\\([\\,;nN])/g, (_, escaped: string) => escaped === 'n' || escaped === 'N' ? '\n' : escaped);
}

/** RFC 5545 lines are folded at 75 UTF-8 octets, without splitting code points. */
function foldLine(line: string): string {
  let length = 0;
  let result = '';
  for (const character of line) {
    const bytes = encoder.encode(character).length;
    if (length + bytes > 75) { result += '\r\n '; length = 1; }
    result += character;
    length += bytes;
  }
  return result;
}

function compactDate(date: string): string { return date.replace(/-/g, ''); }

function wallDateTime(date: string, minute: number): string {
  const normalizedDate = minute === 1440 ? addDays(date, 1) : date;
  const normalizedMinute = minute === 1440 ? 0 : minute;
  return `${compactDate(normalizedDate)}T${String(Math.floor(normalizedMinute / 60)).padStart(2, '0')}${String(normalizedMinute % 60).padStart(2, '0')}00`;
}

function utcStamp(value: string | number): string {
  return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function instantToWall(instant: number, timeZone: string): { date: string; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, calendar: 'gregory', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant));
  const part = (name: string) => parts.find((item) => item.type === name)!.value;
  return { date: `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`, minute: Number(part('hour')) * 60 + Number(part('minute')) };
}

function wallToInstant(date: string, minute: number, timeZone: string): number {
  const wall = Date.parse(`${date}T00:00:00.000Z`) + minute * 60_000;
  const offsets = new Set<number>();
  // A transition can change the UTC offset near this wall time. Check both sides,
  // then choose the earliest matching instant for a repeated local clock time.
  for (const delta of [-48, 0, 48]) {
    const sample = wall + delta * 3_600_000;
    let displayed: { date: string; minute: number };
    try { displayed = instantToWall(sample, timeZone); } catch { throw new Error(`지원하지 않는 시간대입니다: ${timeZone}`); }
    offsets.add(Date.parse(`${displayed.date}T00:00:00.000Z`) + displayed.minute * 60_000 - sample);
  }
  const matches = [...offsets].map((offset) => wall - offset).filter((instant) => {
    const displayed = instantToWall(instant, timeZone);
    return displayed.date === date && displayed.minute === minute;
  }).sort((a, b) => a - b);
  if (!matches.length) throw new Error('일광 절약 시간 전환으로 존재하지 않는 시각입니다.');
  return matches[0];
}

export function exportIcs(state: AppState, options: { includeShadowMetadata?: boolean } = {}): string {
  if (!isAppState(state)) throw new Error('올바르지 않은 데이터는 내보낼 수 없습니다.');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SHADOW//Calendar//KO', 'CALSCALE:GREGORIAN',
    'BEGIN:VTIMEZONE', 'TZID:Asia/Seoul', 'BEGIN:STANDARD', 'DTSTART:19881009T030000', 'TZOFFSETFROM:+1000', 'TZOFFSETTO:+0900', 'TZNAME:KST', 'END:STANDARD', 'END:VTIMEZONE'];
  for (const event of state.events) {
    const master = event.sourceId ? state.events.find((item) => item.id === event.sourceId) : undefined;
    const uid = `${encodeURIComponent(master?.id ?? event.id)}@shadow.local`;
    lines.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${utcStamp(event.updatedAt)}`, `CREATED:${utcStamp(event.createdAt)}`, `LAST-MODIFIED:${utcStamp(event.updatedAt)}`, `SUMMARY:${escapeText(event.title)}`);
    if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
    if (event.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${compactDate(event.date)}`, `DTEND;VALUE=DATE:${compactDate(addDays(event.endDate ?? event.date, 1))}`);
    } else {
      lines.push(`DTSTART;TZID=Asia/Seoul:${wallDateTime(event.date, event.startMinute)}`, `DTEND;TZID=Asia/Seoul:${wallDateTime(event.endDate ?? event.date, event.endMinute)}`);
    }
    if (master && event.occurrenceDate) {
      lines.push(master.allDay ? `RECURRENCE-ID;VALUE=DATE:${compactDate(event.occurrenceDate)}` : `RECURRENCE-ID;TZID=Asia/Seoul:${wallDateTime(event.occurrenceDate, master.startMinute)}`);
    }
    if (event.recurrence) {
      const until = event.allDay ? compactDate(event.recurrence.until) : utcStamp(wallToInstant(event.recurrence.until, event.startMinute, 'Asia/Seoul'));
      lines.push(`RRULE:FREQ=${event.recurrence.frequency.toUpperCase()};INTERVAL=${event.recurrence.interval};UNTIL=${until}`);
      if (event.excludedDates?.length) {
        lines.push(event.allDay
          ? `EXDATE;VALUE=DATE:${event.excludedDates.map(compactDate).join(',')}`
          : `EXDATE;TZID=Asia/Seoul:${event.excludedDates.map((date) => wallDateTime(date, event.startMinute)).join(',')}`);
      }
    }
    if (options.includeShadowMetadata !== false) {
      const metadata = { version: 1, id: event.id, typeId: event.typeId, shadow: event.shadow, cost: event.cost, createdAt: event.createdAt, updatedAt: event.updatedAt, sourceId: event.sourceId, occurrenceDate: event.occurrenceDate };
      lines.push(`X-SHADOW-DATA:${escapeText(JSON.stringify(metadata))}`);
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

interface IcsProperty { name: string; params: Record<string, string>; value: string }
interface Temporal { date: string; minute: number; allDay: boolean; instant?: number; nativeDate: string; nativeMinute: number; zone: string }
interface ParsedEvent { event: CalendarEvent; uid: string; start: Temporal; startProperty: IcsProperty; endProperty?: IcsProperty; properties: IcsProperty[] }

function parseProperty(line: string): IcsProperty {
  let quoted = false;
  let colon = -1;
  for (let index = 0; index < line.length; index++) {
    if (line[index] === '"') quoted = !quoted;
    if (line[index] === ':' && !quoted) { colon = index; break; }
  }
  if (colon < 1 || quoted) throw new Error('잘못된 ICS 속성 형식입니다.');
  const head = line.slice(0, colon).match(/(?:[^;"\s]|"[^"]*")+/g);
  if (!head?.length || !/^[A-Z0-9-]+$/i.test(head[0])) throw new Error('잘못된 ICS 속성 이름입니다.');
  const params: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const token of head.slice(1)) {
    const equal = token.indexOf('=');
    if (equal < 1) throw new Error('잘못된 ICS 매개변수입니다.');
    const key = token.slice(0, equal).toUpperCase();
    if (key in params) throw new Error('중복된 ICS 매개변수입니다.');
    params[key] = token.slice(equal + 1).replace(/^"(.*)"$/, '$1');
  }
  return { name: head[0].toUpperCase(), params, value: line.slice(colon + 1) };
}

function parseComponents(text: string): IcsProperty[][] {
  checkFileSize(text);
  if (text.includes('\0')) throw new Error('ICS 파일에 허용되지 않는 문자가 있습니다.');
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n').filter((line) => line.length > 0);
  if (lines[0]?.toUpperCase() !== 'BEGIN:VCALENDAR' || lines.at(-1)?.toUpperCase() !== 'END:VCALENDAR') throw new Error('VCALENDAR 형식의 ICS 파일을 선택해 주세요.');
  const components: IcsProperty[][] = [];
  const stack: string[] = [];
  let current: IcsProperty[] | null = null;
  let version: string | undefined;
  for (const line of lines) {
    const property = parseProperty(line);
    if (property.name === 'BEGIN') {
      const component = property.value.toUpperCase();
      if (component === 'VCALENDAR' && stack.length) throw new Error('중첩된 VCALENDAR는 지원하지 않습니다.');
      if (component === 'VEVENT') {
        if (stack.length !== 1 || current) throw new Error('중첩된 VEVENT는 지원하지 않습니다.');
        current = [];
      }
      stack.push(component);
    } else if (property.name === 'END') {
      if (stack.pop() !== property.value.toUpperCase()) throw new Error('ICS 구성요소의 시작과 끝이 일치하지 않습니다.');
      if (property.value.toUpperCase() === 'VEVENT') {
        components.push(current!);
        current = null;
        if (components.length > MAX_EXPANDED_EVENTS) throw new Error('ICS 파일은 최대 5,000개 일정을 가져올 수 있습니다.');
      }
    } else if (current && stack.at(-1) === 'VEVENT') current.push(property);
    else if (stack.length === 1 && property.name === 'VERSION') {
      if (version !== undefined) throw new Error('중복된 ICS 버전입니다.');
      version = property.value;
    }
  }
  if (stack.length) throw new Error('ICS 구성요소가 닫히지 않았습니다.');
  if (version !== '2.0') throw new Error('iCalendar 2.0 파일만 지원합니다.');
  return components;
}

function single(properties: IcsProperty[], name: string): IcsProperty | undefined {
  const found = properties.filter((property) => property.name === name);
  if (found.length > 1) throw new Error(`${name} 속성은 한 번만 지정할 수 있습니다.`);
  return found[0];
}

function parseTemporal(property: IcsProperty, allowSeconds = false): Temporal {
  const value = property.value;
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
  if (!match) throw new Error(`${property.name} 날짜 형식이 올바르지 않습니다.`);
  const nativeDate = `${match[1]}-${match[2]}-${match[3]}`;
  if (!isValidCalendarDate(nativeDate)) throw new Error(`${property.name} 날짜가 존재하지 않습니다.`);
  const allDay = match[4] === undefined;
  if (property.params.VALUE && property.params.VALUE.toUpperCase() !== (allDay ? 'DATE' : 'DATE-TIME')) throw new Error('ICS 날짜의 VALUE 형식이 일치하지 않습니다.');
  if (allDay) return { date: nativeDate, minute: 0, allDay, nativeDate, nativeMinute: 0, zone: 'Asia/Seoul' };
  const nativeMinute = Number(match[4]) * 60 + Number(match[5]);
  if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59 || (!allowSeconds && match[6] !== '00')) throw new Error('유효한 분 단위 시각만 가져올 수 있습니다. 초 단위 일정은 지원하지 않습니다.');
  if (match[7] && property.params.TZID) throw new Error('UTC 날짜에는 TZID를 함께 지정할 수 없습니다.');
  const zone = match[7] ? 'UTC' : property.params.TZID ?? 'Asia/Seoul';
  const instant = (zone === 'UTC' ? Date.parse(`${nativeDate}T00:00:00.000Z`) + nativeMinute * 60_000 : wallToInstant(nativeDate, nativeMinute, zone)) + Number(match[6]) * 1000;
  const local = instantToWall(instant, 'Asia/Seoul');
  return { ...local, allDay, instant, nativeDate, nativeMinute, zone };
}

function durationMinutes(value: string): number {
  const match = /^P(?:(\d+)W|(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?)$/.exec(value);
  if (!match || !match.slice(1).some((part) => part !== undefined) || Number(match[5] ?? 0) !== 0) throw new Error('양수인 분·시간·일·주 단위 DURATION만 지원합니다.');
  const duration = Number(match[1] ?? 0) * 10080 + Number(match[2] ?? 0) * 1440 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0);
  if (!Number.isSafeInteger(duration) || duration <= 0 || duration > 1440 * MAX_RECURRENCE_DAYS) throw new Error('DURATION 기간이 올바르지 않습니다.');
  return duration;
}

function parseMetadata(properties: IcsProperty[]): Record<string, unknown> | undefined {
  const property = single(properties, 'X-SHADOW-DATA');
  if (!property) return undefined;
  let value: unknown;
  try { value = JSON.parse(unescapeText(property.value)); } catch { throw new Error('SHADOW 추가 정보의 JSON 형식이 올바르지 않습니다.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as Record<string, unknown>).version !== 1) throw new Error('지원하지 않는 SHADOW 추가 정보입니다.');
  return value as Record<string, unknown>;
}

function parseEvent(properties: IcsProperty[], eventTypes: EventType[]): ParsedEvent {
  const uid = unescapeText(single(properties, 'UID')?.value ?? '').trim();
  if (!uid || uid.length > 1000) throw new Error('일정 UID가 없거나 너무 깁니다.');
  const startProperty = single(properties, 'DTSTART');
  if (!startProperty) throw new Error('DTSTART가 없는 일정입니다.');
  const start = parseTemporal(startProperty);
  const endProperty = single(properties, 'DTEND');
  const duration = single(properties, 'DURATION');
  if (endProperty && duration) throw new Error('DTEND와 DURATION을 동시에 지정할 수 없습니다.');
  let end: Temporal;
  if (endProperty) end = parseTemporal(endProperty);
  else if (duration) {
    const minutes = durationMinutes(duration.value);
    if (start.allDay && minutes % 1440 !== 0) throw new Error('종일 일정의 DURATION은 일 또는 주 단위여야 합니다.');
    const nominalDays = Number(/^P(\d+)W$/.exec(duration.value)?.[1] ?? 0) * 7 + Number(/^P(\d+)D/.exec(duration.value)?.[1] ?? 0);
    const durationStart = !start.allDay && nominalDays
      ? wallToInstant(addDays(start.nativeDate, nominalDays), start.nativeMinute, start.zone)
      : start.instant ?? Date.parse(`${start.date}T00:00:00.000Z`);
    const instant = durationStart + (minutes - (!start.allDay ? nominalDays * 1440 : 0)) * 60_000;
    const local = start.allDay ? { date: dayNumberToDate(Math.floor(instant / 86_400_000)), minute: 0 } : instantToWall(instant, 'Asia/Seoul');
    end = { ...local, instant, allDay: start.allDay, nativeDate: local.date, nativeMinute: local.minute, zone: start.zone };
  } else if (start.allDay) end = { ...start, date: addDays(start.date, 1), nativeDate: addDays(start.nativeDate, 1) };
  else throw new Error('종료 시각 또는 기간이 없는 시간 일정은 가져올 수 없습니다.');
  if (start.allDay !== end.allDay) throw new Error('시작과 종료의 종일 여부가 일치하지 않습니다.');
  let endDate = start.allDay ? addDays(end.date, -1) : end.date;
  let endMinute = start.allDay ? 1440 : end.minute;
  if (!start.allDay && endMinute === 0) { endDate = addDays(endDate, -1); endMinute = 1440; }
  const metadata = parseMetadata(properties);
  const timestamp = new Date().toISOString();
  const readTimestamp = (name: string) => {
    const value = single(properties, name)?.value;
    if (!value) return timestamp;
    if (!/^\d{8}T\d{6}Z$/.test(value)) throw new Error(`${name}은 UTC 시각이어야 합니다.`);
    const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}.000Z`;
    if (!Number.isFinite(Date.parse(date))) throw new Error(`${name} 시각이 올바르지 않습니다.`);
    return date;
  };
  const event: CalendarEvent = {
    id: typeof metadata?.id === 'string' ? metadata.id : `ics:${uid}`,
    title: unescapeText(single(properties, 'SUMMARY')?.value ?? '제목 없는 일정'),
    typeId: typeof metadata?.typeId === 'string' && eventTypes.some((type) => type.id === metadata.typeId) ? metadata.typeId : eventTypes[0].id,
    location: single(properties, 'LOCATION') ? unescapeText(single(properties, 'LOCATION')!.value) : undefined,
    date: start.date,
    endDate: endDate !== start.date ? endDate : undefined,
    allDay: start.allDay || undefined,
    startMinute: start.allDay ? 0 : start.minute,
    endMinute,
    shadow: (metadata?.shadow ?? { ...zeroShadow }) as CalendarEvent['shadow'],
    cost: (metadata?.cost ?? { transportWon: 0, mealWon: 0 }) as CalendarEvent['cost'],
    createdAt: typeof metadata?.createdAt === 'string' ? metadata.createdAt : readTimestamp('CREATED'),
    updatedAt: typeof metadata?.updatedAt === 'string' ? metadata.updatedAt : readTimestamp('LAST-MODIFIED'),
    sourceId: typeof metadata?.sourceId === 'string' ? metadata.sourceId : undefined,
    occurrenceDate: typeof metadata?.occurrenceDate === 'string' ? metadata.occurrenceDate : undefined,
  };
  if (eventCoreRange(event).end <= eventCoreRange(event).start) throw new Error('종료는 시작 이후여야 합니다.');
  const validation = getEventValidationError(event, eventTypes);
  if (validation) throw new Error(validation);
  return { event, uid, start, startProperty, endProperty, properties };
}

function parseRule(parsed: ParsedEvent): CalendarEvent['recurrence'] {
  const property = single(parsed.properties, 'RRULE');
  if (!property) return undefined;
  const parts: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const item of property.value.toUpperCase().split(';')) {
    const [name, value, extra] = item.split('=');
    if (!name || !value || extra !== undefined || parts[name]) throw new Error('RRULE 형식이 올바르지 않습니다.');
    if (!['FREQ', 'INTERVAL', 'UNTIL', 'COUNT', 'WKST'].includes(name)) throw new Error(`지원하지 않는 반복 규칙 ${name}이 있습니다. 해당 일정을 건너뜁니다.`);
    parts[name] = value;
  }
  if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(parts.FREQ)) throw new Error('매일·매주·매월 반복만 지원합니다.');
  const interval = Number(parts.INTERVAL ?? 1);
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) throw new Error('반복 간격은 1~365 사이여야 합니다.');
  if ((!parts.UNTIL && !parts.COUNT) || (parts.UNTIL && parts.COUNT)) throw new Error('반복 일정에는 UNTIL 또는 COUNT 중 하나가 필요합니다. 무기한 반복은 지원하지 않습니다.');
  const frequency = parts.FREQ.toLowerCase() as NonNullable<CalendarEvent['recurrence']>['frequency'];
  let until: string;
  if (parts.UNTIL) {
    const parsedUntil = parseTemporal({ name: 'UNTIL', params: {}, value: parts.UNTIL }, true);
    const nativeUntil = parsedUntil.instant === undefined ? { date: parsedUntil.date, minute: 1440 } : instantToWall(parsedUntil.instant, parsed.start.zone);
    until = nativeUntil.minute < parsed.start.nativeMinute ? addDays(nativeUntil.date, -1) : nativeUntil.date;
  } else {
    const count = Number(parts.COUNT);
    if (!Number.isInteger(count) || count < 1 || count > MAX_EXPANDED_EVENTS) throw new Error('반복 횟수는 1~5,000 사이여야 합니다.');
    const limit = dayNumberToDate(Math.min(dateToDayNumber(parsed.start.nativeDate) + MAX_RECURRENCE_DAYS, dateToDayNumber('9999-12-31')));
    const dates = recurrenceDates({ date: parsed.start.nativeDate, recurrence: { frequency, interval, until: limit } });
    if (dates.length < count) throw new Error('반복 기간은 시작일부터 5년 이내여야 합니다.');
    until = dates[count - 1];
  }
  const recurrence = { frequency, interval, until };
  recurrenceDates({ date: parsed.start.nativeDate, recurrence });
  return recurrence;
}

function shiftTemporalProperty(property: IcsProperty, dayOffset: number): IcsProperty {
  const date = `${property.value.slice(0, 4)}-${property.value.slice(4, 6)}-${property.value.slice(6, 8)}`;
  return { ...property, value: compactDate(addDays(date, dayOffset)) + property.value.slice(8) };
}

export function importIcs(text: string, eventTypes: EventType[]): { events: CalendarEvent[]; warnings: string[] } {
  if (!eventTypes.length) throw new Error('가져온 일정을 저장할 유형이 필요합니다.');
  const components = parseComponents(text);
  const warnings: string[] = [];
  const events = new Map<string, CalendarEvent>();
  const masters = new Map<string, ParsedEvent>();
  const exceptions: { properties: IcsProperty[]; index: number }[] = [];
  const append = (event: CalendarEvent) => {
    const error = getEventValidationError(event, eventTypes);
    if (error) throw new Error(error);
    if (events.has(event.id)) warnings.push('중복 UID 일정은 파일의 마지막 값으로 합쳤습니다.');
    if (!events.has(event.id) && events.size >= MAX_EXPANDED_EVENTS) throw new Error('가져올 일정이 5,000개를 넘었습니다. 파일 범위를 줄여 주세요.');
    events.set(event.id, event);
  };
  components.forEach((properties, index) => {
    try {
      if (single(properties, 'RECURRENCE-ID')) { exceptions.push({ properties, index }); return; }
      if (single(properties, 'STATUS')?.value.toUpperCase() === 'CANCELLED') { warnings.push(`${index + 1}번: 취소된 일정을 건너뛰었습니다.`); return; }
      if (single(properties, 'RDATE') || single(properties, 'EXRULE')) throw new Error('RDATE 또는 EXRULE 반복은 지원하지 않습니다.');
      const parsed = parseEvent(properties, eventTypes);
      const recurrence = parseRule(parsed);
      const excluded = properties.filter((property) => property.name === 'EXDATE').flatMap((property) => property.value.split(',').map((value) => {
        const temporal = parseTemporal({ ...property, value });
        return temporal.instant === undefined ? temporal.nativeDate : instantToWall(temporal.instant, parsed.start.zone).date;
      }));
      if (excluded.length && !recurrence) throw new Error('EXDATE에 대응하는 반복 규칙이 없습니다.');
      masters.set(parsed.uid, parsed);
      if (recurrence && !parsed.start.allDay && parsed.start.zone !== 'Asia/Seoul') {
        if (parsed.endProperty && parseTemporal(parsed.endProperty).zone !== parsed.start.zone) throw new Error('시작과 종료의 시간대가 다른 반복 일정은 지원하지 않습니다.');
        const dates = recurrenceDates({ date: parsed.start.nativeDate, recurrence, excludedDates: excluded });
        const additions: CalendarEvent[] = [];
        for (const date of dates) {
          const offset = dateToDayNumber(date) - dateToDayNumber(parsed.start.nativeDate);
          const shifted = properties.filter((property) => !['X-SHADOW-DATA', 'RRULE', 'EXDATE'].includes(property.name)).map((property) => ['DTSTART', 'DTEND'].includes(property.name) ? shiftTemporalProperty(property, offset) : property);
          const occurrence = parseEvent(shifted, eventTypes).event;
          additions.push({ ...occurrence, id: `${parsed.event.id}@${date}` });
        }
        for (const event of additions) append(event);
        warnings.push(`${index + 1}번: ${parsed.start.zone} 반복은 시간대와 날짜 변화를 보존하도록 ${dates.length}개의 개별 일정으로 가져왔습니다.`);
      } else {
        const event = { ...parsed.event, recurrence, excludedDates: excluded.length ? [...new Set(excluded)] : undefined };
        append(event);
        parsed.event = event;
      }
    } catch (error) { warnings.push(`${index + 1}번 일정: ${error instanceof Error ? error.message : '가져오기 실패'}`); }
  });
  for (const { properties, index } of exceptions) {
    try {
      const uid = unescapeText(single(properties, 'UID')?.value ?? '').trim();
      const master = masters.get(uid);
      if (!master) throw new Error('예외 일정의 원본 반복 규칙을 찾지 못했습니다.');
      const original = parseTemporal(single(properties, 'RECURRENCE-ID')!);
      const originalNative = original.instant === undefined ? { date: original.nativeDate, minute: 0 } : instantToWall(original.instant, master.start.zone);
      if (original.allDay !== master.start.allDay || (!original.allDay && originalNative.minute !== master.start.nativeMinute)) throw new Error('예외 일정의 원래 시각이 원본 반복 일정과 일치하지 않습니다.');
      const masterEvent = events.get(master.event.id);
      if (masterEvent?.recurrence) {
        const excludedDates = [...new Set([...(masterEvent.excludedDates ?? []), original.date])];
        const updated = { ...masterEvent, excludedDates };
        const error = getEventValidationError(updated, eventTypes);
        if (error) throw new Error(error);
        const cancelled = single(properties, 'STATUS')?.value.toUpperCase() === 'CANCELLED';
        const changed = cancelled ? undefined : parseEvent(properties, eventTypes).event;
        if (changed) append({ ...changed, id: parseMetadata(properties)?.id as string ?? `${masterEvent.id}@${original.date}`, sourceId: masterEvent.id, occurrenceDate: original.date });
        events.set(masterEvent.id, updated);
      } else {
        const id = `${master.event.id}@${originalNative.date}`;
        if (single(properties, 'STATUS')?.value.toUpperCase() === 'CANCELLED') events.delete(id);
        else append({ ...parseEvent(properties, eventTypes).event, id });
      }
    } catch (error) { warnings.push(`${index + 1}번 예외 일정: ${error instanceof Error ? error.message : '가져오기 실패'}`); }
  }
  return { events: [...events.values()], warnings: [...new Set(warnings)] };
}
