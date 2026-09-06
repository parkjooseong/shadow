import { createHash, randomUUID } from 'node:crypto';

export class IntegrationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function fail(code, message, status) {
  throw new IntegrationError(code, message, status);
}

export function assertRemoteUrl(value, hosts) {
  let url;
  try { url = new URL(value); } catch { fail('unsafe_remote_url', '캘린더 서버 주소가 올바르지 않습니다.'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !hosts(url.hostname)) {
    fail('unsafe_remote_url', '허용되지 않은 캘린더 서버 주소입니다.');
  }
  return url;
}

export async function request(fetchImpl, url, options = {}, allowedHost) {
  assertRemoteUrl(url, allowedHost);
  let response;
  try {
    response = await fetchImpl(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  } catch {
    fail('provider_unavailable', '캘린더 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.', 502);
  }
  return response;
}

export async function boundedText(response) {
  if (Number(response.headers.get('content-length')) > 5_000_000) fail('response_too_large', '캘린더 응답이 너무 큽니다.', 502);
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 5_000_000) {
        await reader.cancel();
        fail('response_too_large', '캘린더 응답이 너무 큽니다.', 502);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

export async function jsonResponse(response) {
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) fail('provider_auth', '캘린더 접근 권한을 확인하고 다시 연결해 주세요.', 401);
    if (response.status === 412 || response.status === 409) fail('remote_changed', '외부 일정이 변경되었습니다. 다시 동기화해 주세요.', 409);
    if (response.status === 429) fail('provider_rate_limit', '캘린더 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.', 429);
    fail('provider_error', `캘린더 요청에 실패했습니다 (HTTP ${response.status}).`, 502);
  }
  if (response.status === 204) return null;
  try { return JSON.parse(await boundedText(response)); } catch (error) {
    if (error instanceof IntegrationError) throw error;
    fail('invalid_provider_response', '캘린더 응답 형식을 확인할 수 없습니다.', 502);
  }
}

export function addDays(date, amount) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + amount * 86400000).toISOString().slice(0, 10);
}

export function localDateTime(date, minute) {
  const day = minute === 1440 ? addDays(date, 1) : date;
  const time = minute === 1440 ? 0 : minute;
  return `${day}T${String(Math.floor(time / 60)).padStart(2, '0')}:${String(time % 60).padStart(2, '0')}:00`;
}

export function eventProjection(event) {
  if (!event) return null;
  return {
    title: event.title, location: event.location || '', date: event.date,
    startMinute: event.startMinute, endMinute: event.endMinute,
    endDate: event.endDate || event.date, allDay: !!event.allDay,
    recurrence: event.recurrence || null, excludedDates: [...(event.excludedDates || [])].sort(),
  };
}

export function fingerprint(event) {
  return createHash('sha256').update(JSON.stringify(eventProjection(event))).digest('hex');
}

export function remoteToLocal(fields, previous, eventTypes, now) {
  const empty = {
    id: randomUUID(), typeId: eventTypes[0]?.id, createdAt: new Date(now).toISOString(),
    shadow: { preparationMinutes: 0, outboundTravelMinutes: 0, returnTravelMinutes: 0, recoveryMinutes: 0 },
    cost: { transportWon: 0, mealWon: 0 },
  };
  if (!previous && !empty.typeId) fail('missing_event_type', '일정 유형을 먼저 만들어 주세요.');
  const base = previous || empty;
  // Only shared calendar fields are replaced; SHADOW costs, shadows and local metadata survive.
  const retained = { ...base };
  for (const key of ['endDate', 'allDay', 'recurrence', 'excludedDates']) delete retained[key];
  const clean = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null && value !== undefined));
  return { ...retained, ...clean, updatedAt: new Date(now).toISOString() };
}

export function fromRemoteTimes(start, end, allDay = false) {
  if (allDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end <= start) fail('unsupported_event', '올바르지 않은 종일 일정입니다.');
    return { date: start, endDate: addDays(end, -1), startMinute: 0, endMinute: 1440, allDay: true };
  }
  const parts = (value) => {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) fail('unsupported_event', '일정 시간대를 해석할 수 없습니다.');
    const korean = new Date(parsed.getTime() + 9 * 3600000).toISOString();
    return { date: korean.slice(0, 10), minute: Number(korean.slice(11, 13)) * 60 + Number(korean.slice(14, 16)) };
  };
  if (new Date(end) <= new Date(start)) fail('unsupported_event', '외부 일정의 종료 시간이 올바르지 않습니다.');
  const first = parts(start), last = parts(end);
  if (last.minute === 0) return { date: first.date, startMinute: first.minute, endDate: addDays(last.date, -1), endMinute: 1440 };
  return { date: first.date, startMinute: first.minute, endDate: last.date, endMinute: last.minute };
}

export function googleRecurrence(event) {
  if (!event.recurrence) return undefined;
  const rule = event.recurrence;
  const until = rule.until.replaceAll('-', '') + (event.allDay ? '' : 'T145959Z');
  const lines = [`RRULE:FREQ=${rule.frequency.toUpperCase()};INTERVAL=${rule.interval};UNTIL=${until}`];
  if (event.excludedDates?.length) {
    const time = localDateTime(event.date, event.startMinute).slice(11).replaceAll(':', '');
    lines.push(event.allDay ? `EXDATE;VALUE=DATE:${event.excludedDates.map((date) => date.replaceAll('-', '')).join(',')}` : `EXDATE;TZID=Asia/Seoul:${event.excludedDates.map((date) => date.replaceAll('-', '') + 'T' + time).join(',')}`);
  }
  return lines;
}
