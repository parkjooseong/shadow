import { createHash, randomUUID } from 'node:crypto';
import { assertRemoteUrl, boundedText, eventProjection, fail, request } from './common.mjs';

const CALDAV_HOST = (host) => host === 'caldav.icloud.com' || /^p\d{1,3}-caldav\.icloud\.com$/.test(host);
const XML_HEADER = '<?xml version="1.0" encoding="utf-8"?>';
const escapeXml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function decodeXml(value) {
  return value.replace(/&([^;]+);/g, (_all, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity];
    if (named) return named;
    if (/^#(?:x[0-9a-f]+|\d+)$/i.test(entity)) {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) return String.fromCodePoint(code);
    }
    fail('invalid_xml', 'CalDAV 응답에 허용되지 않은 XML 엔터티가 있습니다.', 502);
  });
}

export function parseDavXml(xml) {
  if (xml.length > 5_000_000 || /<!\s*(?:DOCTYPE|ENTITY)/i.test(xml)) fail('invalid_xml', '안전하지 않은 CalDAV 응답입니다.', 502);
  const root = { name: '#document', children: [], text: '' };
  const stack = [root];
  let index = 0, count = 0;
  while (index < xml.length) {
    if (xml[index] !== '<') {
      const next = xml.indexOf('<', index);
      const end = next < 0 ? xml.length : next;
      stack.at(-1).text += decodeXml(xml.slice(index, end));
      index = end;
      continue;
    }
    if (xml.startsWith('<![CDATA[', index)) {
      const end = xml.indexOf(']]>', index + 9);
      if (end < 0) fail('invalid_xml', 'CalDAV XML이 올바르지 않습니다.', 502);
      stack.at(-1).text += xml.slice(index + 9, end); index = end + 3; continue;
    }
    if (xml.startsWith('<!--', index) || xml.startsWith('<?', index)) {
      const marker = xml.startsWith('<!--', index) ? '-->' : '?>';
      const end = xml.indexOf(marker, index + 2);
      if (end < 0) fail('invalid_xml', 'CalDAV XML이 올바르지 않습니다.', 502);
      index = end + marker.length; continue;
    }
    let end = index + 1, quote = '';
    for (; end < xml.length; end++) {
      const char = xml[end];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    const tag = xml.slice(index + 1, end);
    const match = tag.match(/^(\/?)([A-Za-z_][\w.:-]*)(?:\s[^<>]*)?\/?$/);
    if (end === xml.length || !match) fail('invalid_xml', 'CalDAV XML이 올바르지 않습니다.', 502);
    const [, closing, name] = match;
    if (closing) {
      if (stack.length < 2 || stack.at(-1).qualifiedName !== name) fail('invalid_xml', 'CalDAV XML 태그가 일치하지 않습니다.', 502);
      stack.pop();
    } else {
      const node = { qualifiedName: name, name: name.split(':').at(-1), children: [], text: '' };
      stack.at(-1).children.push(node);
      if (!tag.endsWith('/')) stack.push(node);
      if (++count > 25000 || stack.length > 64) fail('invalid_xml', 'CalDAV XML 구조가 너무 큽니다.', 502);
    }
    index = end + 1;
  }
  if (stack.length !== 1) fail('invalid_xml', 'CalDAV XML이 끝나지 않았습니다.', 502);
  return root;
}

function descendants(node, name) {
  return node.children.flatMap((child) => [...(child.name === name ? [child] : []), ...descendants(child, name)]);
}
const firstText = (node, name) => descendants(node, name)[0]?.text || '';

export function createCalDavAdapter({ connection, fetchImpl, eventTypes, importIcs, exportIcs }) {
  const credentials = connection.credentials;
  const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
  const send = async (value, options = {}) => {
    let url = assertRemoteUrl(value, CALDAV_HOST);
    for (let redirects = 0; redirects < 4; redirects++) {
      const response = await request(fetchImpl, url, { ...options, headers: { Authorization: authorization, 'content-type': 'application/xml; charset=utf-8', ...options.headers } }, CALDAV_HOST);
      if ([301, 302, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) fail('invalid_redirect', 'CalDAV 주소 이동 응답이 올바르지 않습니다.', 502);
        const target = assertRemoteUrl(new URL(location, url), CALDAV_HOST);
        if (['PUT', 'DELETE'].includes(options.method) && connection.calendarId) {
          const calendar = new URL(connection.calendarId);
          if (target.origin !== calendar.origin || !target.pathname.startsWith(calendar.pathname)) fail('unsafe_remote_url', '전용 캘린더 밖으로 일정 변경을 전달할 수 없습니다.');
        }
        url = target; continue;
      }
      if (response.status === 401 || response.status === 403) fail('provider_auth', 'Apple 계정과 앱 전용 암호를 확인해 주세요.', 401);
      if (response.status === 412) fail('remote_changed', 'iCloud 일정이 변경되었습니다. 다시 동기화해 주세요.', 409);
      if (!response.ok && response.status !== 404) fail('provider_error', `iCloud 요청에 실패했습니다 (HTTP ${response.status}).`, 502);
      return { response, url };
    }
    fail('invalid_redirect', 'CalDAV 주소 이동 횟수가 너무 많습니다.', 502);
  };
  const safeItemUrl = (value) => {
    const calendar = assertRemoteUrl(connection.calendarId, CALDAV_HOST);
    const item = assertRemoteUrl(new URL(value, calendar), CALDAV_HOST);
    if (item.origin !== calendar.origin || !item.pathname.startsWith(calendar.pathname) || item.pathname === calendar.pathname || /%(?:2f|5c)/i.test(item.pathname) || item.search || item.hash) fail('unsafe_remote_url', '전용 캘린더 밖의 일정은 변경할 수 없습니다.');
    return item.toString();
  };
  const propfind = async (url, property) => {
    const result = await send(url, { method: 'PROPFIND', headers: { Depth: '0' }, body: `${XML_HEADER}<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>${property}</d:prop></d:propfind>` });
    if (result.response.status === 404) fail('provider_error', 'iCloud 캘린더를 찾지 못했습니다.', 502);
    return { tree: parseDavXml(await boundedText(result.response)), url: result.url };
  };
  return {
    async discover() {
      const principal = await propfind('https://caldav.icloud.com/', '<d:current-user-principal/>');
      const principalNode = descendants(principal.tree, 'current-user-principal')[0];
      const principalHref = principalNode && firstText(principalNode, 'href');
      if (!principalHref) fail('invalid_caldav', 'iCloud 계정의 캘린더 주소를 찾지 못했습니다.', 502);
      const home = await propfind(new URL(principalHref, principal.url), '<c:calendar-home-set/>');
      const homeNode = descendants(home.tree, 'calendar-home-set')[0];
      const homeHref = homeNode && firstText(homeNode, 'href');
      if (!homeHref) fail('invalid_caldav', 'iCloud 캘린더 홈을 찾지 못했습니다.', 502);
      connection.homeUrl = assertRemoteUrl(new URL(homeHref, home.url), CALDAV_HOST).toString();
      if (!connection.homeUrl.endsWith('/')) connection.homeUrl += '/';
    },
    async ensureCalendar() {
      if (connection.calendarId) return;
      if (!connection.homeUrl) await this.discover();
      const url = new URL(`shadow-${randomUUID()}/`, connection.homeUrl);
      const result = await send(url, { method: 'MKCALENDAR', body: `${XML_HEADER}<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop><d:displayname>SHADOW</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>` });
      if (!result.response.ok) fail('calendar_create_failed', 'iCloud 전용 캘린더를 만들지 못했습니다.', 502);
      connection.calendarId = result.url.toString();
    },
    async list() {
      const { response } = await send(connection.calendarId, { method: 'REPORT', headers: { Depth: '1' }, body: `${XML_HEADER}<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter></c:calendar-query>` });
      if (response.status === 404) fail('calendar_missing', '전용 iCloud 캘린더가 삭제되었습니다. 연결을 해제하고 다시 연결해 주세요.', 409);
      const tree = parseDavXml(await boundedText(response));
      if (response.status !== 207 || tree.children.length !== 1 || tree.children[0].name !== 'multistatus') fail('invalid_caldav', 'iCloud 일정 목록 응답을 확인할 수 없습니다.', 502);
      const items = descendants(tree, 'response').map((item) => {
        const id = safeItemUrl(firstText(item, 'href'));
        const status = item.children.find((child) => child.name === 'status')?.text || '';
        const etag = firstText(item, 'getetag');
        if (/\s404\s/.test(status)) return { id, deleted: true, etag: 'deleted' };
        const data = firstText(item, 'calendar-data');
        if (!etag || !data) return { id, unsupported: true, etag, warning: 'iCloud 일정 데이터가 불완전합니다.' };
        let parsed;
        try { parsed = importIcs(data, eventTypes); } catch { return { id, unsupported: true, etag, warning: '해석할 수 없는 iCloud 일정을 보존했습니다.' }; }
        if (parsed.events.length !== 1 || parsed.warnings.length) return { id, unsupported: true, etag, warning: parsed.warnings[0] || '여러 구성요소가 있는 iCloud 일정은 자동 변경하지 않습니다.' };
        const uid = data.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).find((line) => line.startsWith('UID:'))?.slice(4);
        let shadowId;
        if (uid?.endsWith('@shadow.local')) {
          try { shadowId = decodeURIComponent(uid.slice(0, -13)); } catch { /* Invalid foreign UIDs remain unlinked. */ }
        }
        return { id, etag, fields: eventProjection(parsed.events[0]), shadowId };
      });
      if (items.length > 5000) fail('too_many_events', '전용 캘린더는 최대 5,000개 일정까지 동기화합니다.');
      return { items, full: true, cursor: null };
    },
    async put(event, remote) {
      if (remote?.deleted) remote = null;
      const id = remote?.id || new URL(`${createHash('sha256').update(event.id).digest('hex')}.ics`, connection.calendarId).toString();
      const url = safeItemUrl(id);
      const state = { schemaVersion: 1, preferences: { locale: 'ko-KR', timeZone: 'Asia/Seoul', currency: 'KRW', weekStartsOn: 1 }, eventTypes, events: [event] };
      const body = exportIcs(state, { includeShadowMetadata: false });
      const { response } = await send(url, { method: 'PUT', body, headers: { 'content-type': 'text/calendar; charset=utf-8', ...(remote ? { 'If-Match': remote.etag } : { 'If-None-Match': '*' }) } });
      if (!response.ok) fail('provider_error', 'iCloud 일정을 저장하지 못했습니다.', 502);
      let etag = response.headers.get('etag');
      if (!etag) { const current = await propfind(url, '<d:getetag/>'); etag = firstText(current.tree, 'getetag'); }
      if (!etag) fail('invalid_caldav', '저장된 iCloud 일정 버전을 확인할 수 없습니다.', 502);
      return { id: url, etag, fields: eventProjection(event) };
    },
    async remove(remote) {
      await send(safeItemUrl(remote.id), { method: 'DELETE', headers: { 'If-Match': remote.etag } });
    },
  };
}

export { escapeXml };
