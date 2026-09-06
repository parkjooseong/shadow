import { createHash } from 'node:crypto';
import { addDays, fail, fromRemoteTimes, googleRecurrence, jsonResponse, localDateTime, request } from './common.mjs';

export const OAUTH = {
  google: {
    authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/calendar.app.created',
    clientId: 'GOOGLE_CLIENT_ID', clientSecret: 'GOOGLE_CLIENT_SECRET',
  },
  microsoft: {
    authorization: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'offline_access https://graph.microsoft.com/Calendars.ReadWrite',
    clientId: 'MICROSOFT_CLIENT_ID', clientSecret: 'MICROSOFT_CLIENT_SECRET',
  },
};

export function oauthConfig(provider, env) {
  const base = OAUTH[provider];
  if (!base) fail('unknown_provider', '지원하지 않는 캘린더입니다.');
  const tenant = env.MICROSOFT_TENANT || 'common';
  if (provider === 'microsoft' && !/^[a-zA-Z0-9.-]+$/.test(tenant)) fail('invalid_configuration', 'Microsoft 테넌트 설정을 확인해 주세요.', 503);
  return { ...base, authorization: base.authorization.replace('/common/', `/${tenant}/`), token: base.token.replace('/common/', `/${tenant}/`), clientId: env[base.clientId], clientSecret: env[base.clientSecret] };
}

export async function exchangeToken(fetchImpl, config, values) {
  const response = await request(fetchImpl, config.token, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...values }).toString(),
  }, (host) => host === 'oauth2.googleapis.com' || host === 'login.microsoftonline.com');
  const data = await jsonResponse(response);
  if (typeof data?.access_token !== 'string' || !Number.isFinite(Number(data.expires_in))) fail('invalid_token', '인증 응답이 올바르지 않습니다. 다시 연결해 주세요.', 502);
  return data;
}

function googleRuleDate(value, timeZone, startMinute, until = false) {
  if (/^\d{8}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!match || (!match[7] && !['Asia/Seoul', 'Etc/UTC', 'UTC'].includes(timeZone))) fail('unsupported_event', '반복 예외의 시간대를 안전하게 해석할 수 없습니다.');
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${match[7] || ['Etc/UTC', 'UTC'].includes(timeZone) ? 'Z' : '+09:00'}`;
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime())) fail('unsupported_event', '반복 종료 또는 제외 시간이 올바르지 않습니다.');
  const korean = new Date(parsed.getTime() + 9 * 3600000).toISOString();
  const minute = Number(korean.slice(11, 13)) * 60 + Number(korean.slice(14, 16));
  if (!until && minute !== startMinute) fail('unsupported_event', '반복 제외 시각이 일정 시작 시각과 다릅니다. 원본을 확인해 주세요.');
  return until && minute < startMinute ? addDays(korean.slice(0, 10), -1) : korean.slice(0, 10);
}

function googleFields(event) {
  const times = fromRemoteTimes(event.start?.date || event.start?.dateTime, event.end?.date || event.end?.dateTime, !!event.start?.date);
  const fields = { title: event.summary || '(제목 없음)', location: event.location || '', ...times };
  if (event.recurringEventId) fail('unsupported_event', '개별 수정된 반복 일정은 ICS 가져오기로 확인해 주세요.');
  if (event.recurrence?.length) {
    if (!event.start?.date && event.start?.timeZone !== 'Asia/Seoul' && !(event.start?.timeZone === undefined && event.start?.dateTime?.endsWith('+09:00'))) fail('unsupported_event', '한국 시간대가 아닌 반복 일정은 ICS 가져오기로 확인해 주세요.');
    if (event.recurrence.some((line) => !line.startsWith('RRULE:') && !line.startsWith('EXDATE'))) fail('unsupported_event', '지원하지 않는 반복 규칙입니다. 원본 일정은 유지됩니다.');
    const rule = event.recurrence.find((value) => value.startsWith('RRULE:'));
    const fieldsByKey = Object.fromEntries((rule?.slice(6) || '').split(';').map((part) => part.split('=')));
    if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(fieldsByKey.FREQ) || !fieldsByKey.UNTIL || Object.keys(fieldsByKey).some((key) => !['FREQ', 'INTERVAL', 'UNTIL'].includes(key))) {
      fail('unsupported_event', '지원하지 않는 반복 규칙입니다. 원본 일정은 유지됩니다.');
    }
    fields.recurrence = { frequency: fieldsByKey.FREQ.toLowerCase(), interval: Number(fieldsByKey.INTERVAL || 1), until: googleRuleDate(fieldsByKey.UNTIL, event.start?.timeZone || 'Asia/Seoul', times.startMinute, true) };
    fields.excludedDates = event.recurrence.filter((value) => value.startsWith('EXDATE')).flatMap((value) => {
      const parameter = value.slice(0, value.indexOf(':'));
      const timeZone = parameter.match(/TZID=([^;]+)/)?.[1] || event.start?.timeZone || 'Asia/Seoul';
      return value.slice(value.indexOf(':') + 1).split(',').map((date) => googleRuleDate(date, timeZone, times.startMinute));
    });
  }
  return fields;
}

function googleBody(event) {
  const start = event.allDay ? { date: event.date } : { dateTime: localDateTime(event.date, event.startMinute) + '+09:00', timeZone: 'Asia/Seoul' };
  const end = event.allDay ? { date: addDays(event.endDate || event.date, 1) } : { dateTime: localDateTime(event.endDate || event.date, event.endMinute) + '+09:00', timeZone: 'Asia/Seoul' };
  return { summary: event.title, location: event.location || '', start, end, recurrence: googleRecurrence(event) || [], extendedProperties: { private: { shadowId: event.id } } };
}

function microsoftFields(event) {
  const withOffset = ({ dateTime: value, timeZone }) => {
    if (/[zZ]$|[+-]\d\d:\d\d$/.test(value)) return value;
    if (timeZone === 'Korea Standard Time' || timeZone === 'Asia/Seoul') return value + '+09:00';
    if (timeZone === 'UTC' || timeZone === 'Etc/UTC') return value + 'Z';
    fail('unsupported_event', 'Outlook 일정 시간대를 해석할 수 없습니다.');
  };
  const times = event.isAllDay ? fromRemoteTimes(event.start.dateTime.slice(0, 10), event.end.dateTime.slice(0, 10), true) : fromRemoteTimes(withOffset(event.start), withOffset(event.end));
  const fields = { title: event.subject || '(제목 없음)', location: event.location?.displayName || '', ...times };
  if (event.recurrence) {
    if (event.cancelledOccurrences?.length || event.exceptionOccurrences?.length || event['exceptionOccurrences@odata.nextLink']) fail('unsupported_event', '개별 취소·수정된 Outlook 반복 일정은 원본을 보존합니다. ICS로 확인해 주세요.');
    const timeZone = event.recurrence.range.recurrenceTimeZone || event.originalStartTimeZone;
    if (timeZone && !['Korea Standard Time', 'Asia/Seoul'].includes(timeZone)) fail('unsupported_event', '한국 시간대가 아닌 Outlook 반복 일정은 ICS로 확인해 주세요.');
    const { pattern, range } = event.recurrence;
    const frequency = { daily: 'daily', weekly: 'weekly', absoluteMonthly: 'monthly' }[pattern.type];
    if (!frequency || range.type !== 'endDate' || (pattern.daysOfWeek?.length > 1)) fail('unsupported_event', '지원하지 않는 Outlook 반복 규칙입니다. 원본 일정은 유지됩니다.');
    fields.recurrence = { frequency, interval: pattern.interval, until: range.endDate };
  }
  return fields;
}

function microsoftBody(event, creating) {
  if (event.excludedDates?.length) fail('unsupported_event', 'Outlook 반복 제외일은 아직 직접 동기화할 수 없습니다. ICS를 이용해 주세요.');
  const result = {
    subject: event.title, location: { displayName: event.location || '' }, isAllDay: !!event.allDay,
    start: { dateTime: localDateTime(event.date, event.allDay ? 0 : event.startMinute), timeZone: 'Korea Standard Time' },
    end: { dateTime: event.allDay ? localDateTime(addDays(event.endDate || event.date, 1), 0) : localDateTime(event.endDate || event.date, event.endMinute), timeZone: 'Korea Standard Time' },
    recurrence: null,
  };
  if (event.recurrence) {
    const rule = event.recurrence;
    const pattern = { type: { daily: 'daily', weekly: 'weekly', monthly: 'absoluteMonthly' }[rule.frequency], interval: rule.interval };
    if (rule.frequency === 'weekly') { pattern.daysOfWeek = [['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][new Date(event.date + 'T00:00:00Z').getUTCDay()]]; pattern.firstDayOfWeek = 'monday'; }
    if (rule.frequency === 'monthly') pattern.dayOfMonth = Number(event.date.slice(8));
    result.recurrence = { pattern, range: { type: 'endDate', startDate: event.date, endDate: rule.until, recurrenceTimeZone: 'Korea Standard Time' } };
  }
  if (creating) {
    result.transactionId = event.id;
    result.extensions = [{ '@odata.type': 'microsoft.graph.openTypeExtension', extensionName: 'com.shadow.calendar', shadowId: event.id }];
  }
  return result;
}

export function createOAuthAdapter({ provider, connection, fetchImpl, accessToken }) {
  const google = provider === 'google';
  const base = google ? 'https://www.googleapis.com/calendar/v3' : 'https://graph.microsoft.com/v1.0';
  const allowed = (host) => host === (google ? 'www.googleapis.com' : 'graph.microsoft.com');
  const headers = { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', ...(google ? {} : { Prefer: 'outlook.timezone="Korea Standard Time", IdType="ImmutableId"' }) };
  const send = (url, options = {}) => request(fetchImpl, url, { ...options, headers: { ...headers, ...options.headers } }, allowed);
  const path = () => google ? `${base}/calendars/${encodeURIComponent(connection.calendarId)}/events` : `${base}/me/calendars/${encodeURIComponent(connection.calendarId)}/events`;
  const normalize = (data) => {
    if (google && data.recurringEventId) return { id: data.id, masterId: data.recurringEventId, unsupported: true, etag: data.etag || createHash('sha256').update(JSON.stringify(data)).digest('hex'), warning: '개별 취소·수정된 Google 반복 일정은 전체 원본을 보존합니다. ICS로 확인해 주세요.' };
    if (data.status === 'cancelled' || data['@removed']) return { id: data.id, deleted: true, etag: data.etag || data['@odata.etag'] || 'deleted' };
    try {
      return { id: data.id, etag: data.etag || data['@odata.etag'] || data.changeKey, fields: google ? googleFields(data) : microsoftFields(data), shadowId: google ? data.extendedProperties?.private?.shadowId : data.extensions?.find((item) => item.extensionName === 'com.shadow.calendar')?.shadowId };
    } catch (error) {
      if (error.code !== 'unsupported_event') throw error;
      return { id: data.id, etag: data.etag || data['@odata.etag'] || data.changeKey, unsupported: true, warning: error.message };
    }
  };
  return {
    async ensureCalendar() {
      if (connection.calendarId) return;
      const response = await send(google ? `${base}/calendars` : `${base}/me/calendars`, { method: 'POST', body: JSON.stringify(google ? { summary: 'SHADOW', timeZone: 'Asia/Seoul', description: 'SHADOW에서 관리하는 전용 캘린더' } : { name: 'SHADOW' }) });
      const data = await jsonResponse(response);
      if (typeof data?.id !== 'string') fail('invalid_calendar', '캘린더를 만들지 못했습니다.', 502);
      connection.calendarId = data.id;
    },
    async list() {
      const items = [];
      const initial = () => {
        const url = new URL(path());
        if (google) { url.searchParams.set('showDeleted', 'true'); url.searchParams.set('maxResults', '250'); if (connection.cursor) url.searchParams.set('syncToken', connection.cursor); }
        else { url.searchParams.set('$top', '250'); url.searchParams.set('$expand', 'extensions'); }
        return url;
      };
      let url = initial(), cursor = connection.cursor, full = !google || !connection.cursor;
      for (let page = 0; page < 100; page++) {
        const response = await send(url);
        if (google && response.status === 410 && connection.cursor) { connection.cursor = null; cursor = null; full = true; items.length = 0; url = initial(); continue; }
        const data = await jsonResponse(response);
        const raw = google ? data.items : data.value;
        if (!Array.isArray(raw)) fail('invalid_provider_response', '일정 목록을 읽을 수 없습니다.', 502);
        for (const item of raw) {
          if (!google && item.recurrence) {
            const detailsUrl = new URL(`${path()}/${encodeURIComponent(item.id)}`);
            detailsUrl.searchParams.set('$select', 'id,subject,start,end,location,isAllDay,recurrence,originalStartTimeZone,exceptionOccurrences,cancelledOccurrences');
            detailsUrl.searchParams.set('$expand', 'exceptionOccurrences');
            const detailsResponse = await send(detailsUrl);
            if (detailsResponse.status === 404) items.push({ id: item.id, deleted: true, etag: 'deleted' });
            else items.push(normalize({ ...item, ...await jsonResponse(detailsResponse) }));
          } else items.push(normalize(item));
        }
        if (items.length > 5000) fail('too_many_events', '전용 캘린더는 최대 5,000개 일정까지 동기화합니다.');
        if (google && data.nextPageToken) { url.searchParams.set('pageToken', data.nextPageToken); continue; }
        if (!google && data['@odata.nextLink']) { url = new URL(data['@odata.nextLink']); continue; }
        cursor = google ? data.nextSyncToken : null;
        return { items, cursor, full };
      }
      fail('too_many_pages', '일정 페이지가 너무 많습니다.', 502);
    },
    async put(event, remote) {
      const creating = !remote || remote.deleted;
      const createKey = remote?.deleted ? `${event.id}:restore:${remote.id}` : event.id;
      const id = !creating ? remote.id : (google ? createHash('sha256').update(createKey).digest('hex') : null);
      const body = google ? googleBody(event) : microsoftBody(event, creating);
      if (google && creating) body.id = id;
      if (!google && creating && remote?.deleted) body.transactionId = createHash('sha256').update(createKey).digest('hex').slice(0, 32).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
      const response = await send(creating ? path() : `${path()}/${encodeURIComponent(id)}`, {
        method: creating ? 'POST' : 'PATCH', body: JSON.stringify(body),
        headers: !creating && remote.etag ? { 'If-Match': remote.etag } : {},
      });
      if (creating && google && response.status === 409) return normalize(await jsonResponse(await send(`${path()}/${encodeURIComponent(id)}`)));
      return normalize(await jsonResponse(response));
    },
    async remove(remote) {
      const response = await send(`${path()}/${encodeURIComponent(remote.id)}`, { method: 'DELETE', headers: remote.etag ? { 'If-Match': remote.etag } : {} });
      if (response.status !== 404 && response.status !== 410) await jsonResponse(response);
    },
  };
}
