import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createDatabase } from './database.mjs';
import { createIntegrationService } from './integrations/index.mjs';
import { createOAuthAdapter } from './integrations/providers.mjs';
import { createCalDavAdapter, parseDavXml } from './integrations/caldav.mjs';
import { assertRemoteUrl, boundedText } from './integrations/common.mjs';
import { importIcs, exportIcs } from '../src/services/interchange.ts';

const ENV = {
  SHADOW_PUBLIC_URL: 'http://localhost:5173', GOOGLE_CLIENT_ID: 'test-google-client', GOOGLE_CLIENT_SECRET: 'test-google-secret',
  MICROSOFT_CLIENT_ID: 'test-ms-client', MICROSOFT_CLIENT_SECRET: 'test-ms-secret',
};
const TYPE = { id: 'hospital', name: '병원', color: '#7c6cff', preparationMinutes: 20, travelMinutes: 40, recoveryMinutes: 30, transportCostWon: 0, mealCostWon: 0 };
const event = (overrides = {}) => ({
  id: randomUUID(), title: '병원 진료', typeId: TYPE.id, date: '2026-09-07', startMinute: 900, endMinute: 960,
  shadow: { preparationMinutes: 20, outboundTravelMinutes: 40, returnTravelMinutes: 40, recoveryMinutes: 30 },
  cost: { transportWon: 4000, mealWon: 12000 }, createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z', ...overrides,
});
const appState = (events) => ({ schemaVersion: 1, preferences: { locale: 'ko-KR', timeZone: 'Asia/Seoul', currency: 'KRW', weekStartsOn: 1 }, eventTypes: [TYPE], events });
const json = (body, status = 200, headers = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function setup(t, fetchImpl, events = [event()], options = {}) {
  const store = createDatabase({ dbPath: ':memory:', encryptionKey: Buffer.alloc(32, 7).toString('base64') });
  t.after(() => store.close());
  const user = store.createUser({ email: `${randomUUID()}@example.test`, name: 'Test', passwordHash: 'test-only' });
  const token = store.createSession(user.id, Date.now() + 3600000);
  const sessionId = store.getSession(token).sessionId;
  store.saveState(user.id, appState(events), 0);
  const service = createIntegrationService({ store, env: ENV, fetchImpl, ...options });
  const route = (method, path, body = {}) => service.route({ method, path: path.split('?')[0], url: new URL(path, ENV.SHADOW_PUBLIC_URL), body, userId: user.id, sessionId });
  const connect = (provider = 'google', credentials = {}) => store.saveConnection(user.id, provider, { credentials: { accessToken: 'test-access', refreshToken: 'test-refresh', expiresAt: Date.now() + 3600000, ...credentials }, calendarId: null, cursor: null, mappings: {}, remoteCache: {}, conflicts: [] });
  return { store, userId: user.id, sessionId, route, service, connect };
}

function googleServer() {
  const items = new Map(), calls = [];
  let version = 0;
  const edit = (id, fields) => {
    const item = { ...items.get(id), id, ...fields, etag: `"version-${++version}"` };
    items.set(id, item); return item;
  };
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    const body = options.body && options.headers?.['content-type'] !== 'application/x-www-form-urlencoded' ? JSON.parse(options.body) : options.body;
    calls.push({ url: url.toString(), method, body, headers: options.headers });
    if (url.hostname === 'oauth2.googleapis.com') return json({ access_token: 'test-new-access', refresh_token: 'test-new-refresh', expires_in: 3600 });
    assert.equal(url.origin, 'https://www.googleapis.com');
    if (url.pathname === '/calendar/v3/calendars' && method === 'POST') return json({ id: 'shadow-calendar' }, 201);
    const prefix = '/calendar/v3/calendars/shadow-calendar/events';
    assert.ok(url.pathname.startsWith(prefix));
    const id = decodeURIComponent(url.pathname.slice(prefix.length + 1));
    if (method === 'GET') return id ? json(items.get(id), items.has(id) ? 200 : 404) : json({ items: [...items.values()], nextSyncToken: `cursor-${version}` });
    if (method === 'POST') {
      if (items.has(body.id)) return json({}, 409);
      return json(edit(body.id, body), 201);
    }
    assert.equal(options.headers['If-Match'], items.get(id)?.etag);
    if (method === 'PATCH') return json(edit(id, body));
    if (method === 'DELETE') { edit(id, { status: 'cancelled' }); return json(null, 204); }
    assert.fail('Unexpected provider request');
  };
  return { items, calls, fetchImpl, edit };
}

test('OAuth uses PKCE and single-use state bound to the authenticated session', async (t) => {
  const server = googleServer();
  const ctx = setup(t, server.fetchImpl);
  const initiated = await ctx.route('POST', '/api/integrations/google/connect');
  assert.equal(initiated.status, 200);
  const authorization = new URL(initiated.body.url);
  assert.equal(authorization.origin, 'https://accounts.google.com');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(server.calls.length, 0, 'connecting must not create a remote calendar');
  const callback = `/api/integrations/google/callback?code=test-code&state=${authorization.searchParams.get('state')}`;
  const wrongSession = await ctx.service.route({ method: 'GET', path: '/api/integrations/google/callback', url: new URL(callback, ENV.SHADOW_PUBLIC_URL), userId: ctx.userId, sessionId: 'different-session' });
  assert.equal(wrongSession.status, 400);
  const result = await ctx.route('GET', callback);
  assert.equal(result.redirect, '/?integration=connected&provider=google');
  const form = new URLSearchParams(server.calls[0].body);
  assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'));
  assert.equal((await ctx.route('GET', callback)).status, 400);
  const listed = await ctx.route('GET', '/api/integrations');
  assert.equal(listed.body.providers[0].connected, true);
  assert.ok(!JSON.stringify(listed).includes('test-new-access'));
});

test('missing encryption/client configuration remains disconnected with an actionable error', async () => {
  let networkCalls = 0;
  const service = createIntegrationService({ store: { encryptionAvailable: false }, env: {}, fetchImpl: async () => { networkCalls++; } });
  const result = await service.route({ method: 'GET', path: '/api/integrations', userId: 'user', sessionId: 'session' });
  assert.equal(result.status, 200);
  assert.ok(result.body.providers.every((provider) => !provider.connected && !provider.configured));
  assert.equal(networkCalls, 0);
});

test('expired OAuth state and attacker-selected callback origins are rejected', async (t) => {
  const ctx = setup(t, async () => assert.fail('No network call expected'));
  ctx.store.saveOAuthState({ state: 'expired', userId: ctx.userId, sessionId: ctx.sessionId, provider: 'google', verifier: 'unused', redirectUri: 'http://localhost:5173/callback', expiresAt: Date.now() - 1 });
  assert.equal((await ctx.route('GET', '/api/integrations/google/callback?code=code&state=expired')).status, 400);
  const service = createIntegrationService({ store: ctx.store, env: { ...ENV, SHADOW_PUBLIC_URL: 'http://example.test' } });
  assert.equal((await service.route({ method: 'POST', path: '/api/integrations/google/connect', userId: ctx.userId, sessionId: ctx.sessionId })).status, 503);
});

test('Google sync creates a dedicated calendar, refreshes tokens and sends only shared event fields', async (t) => {
  const server = googleServer(), original = event();
  const ctx = setup(t, server.fetchImpl, [original]);
  ctx.connect('google', { expiresAt: 1 });
  const result = await ctx.route('POST', '/api/integrations/google/sync');
  assert.equal(result.status, 200);
  assert.equal(result.body.exported, 1);
  assert.equal(server.calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(server.calls[1].body.summary, 'SHADOW');
  const exported = [...server.items.values()][0];
  assert.equal(exported.start.dateTime, '2026-09-07T15:00:00+09:00');
  assert.equal(exported.extendedProperties.private.shadowId, original.id);
  assert.ok(!JSON.stringify(exported).includes('12000'));
  assert.ok(!JSON.stringify(exported).includes('preparationMinutes'));
  assert.equal(ctx.store.getConnection(ctx.userId, 'google').credentials.refreshToken, 'test-new-refresh');
});

test('Google creates, updates and deletes in both directions while preserving SHADOW metadata', async (t) => {
  const server = googleServer(), original = event();
  const ctx = setup(t, server.fetchImpl, [original]); ctx.connect();
  assert.equal((await ctx.route('POST', '/api/integrations/google/sync')).status, 200);
  const id = [...server.items.keys()][0];
  server.edit(id, { summary: '외부에서 변경' });
  let result = await ctx.route('POST', '/api/integrations/google/sync');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.imported, 1);
  let current = ctx.store.getState(ctx.userId);
  assert.equal(current.state.events[0].title, '외부에서 변경');
  assert.deepEqual(current.state.events[0].shadow, original.shadow);
  assert.deepEqual(current.state.events[0].cost, original.cost);
  ctx.store.saveState(ctx.userId, { ...current.state, events: [{ ...current.state.events[0], title: '내 캘린더에서 변경' }] }, current.revision);
  result = await ctx.route('POST', '/api/integrations/google/sync');
  assert.equal(result.body.exported, 1); assert.equal(server.items.get(id).summary, '내 캘린더에서 변경');
  server.edit('new-remote', { summary: '외부 신규', start: { dateTime: '2026-09-08T10:00:00+09:00' }, end: { dateTime: '2026-09-08T11:00:00+09:00' } });
  result = await ctx.route('POST', '/api/integrations/google/sync');
  assert.equal(result.body.imported, 1);
  assert.equal(ctx.store.getState(ctx.userId).state.events.length, 2);
  server.edit('new-remote', { status: 'cancelled' });
  result = await ctx.route('POST', '/api/integrations/google/sync');
  assert.equal(result.body.deleted, 1);
  current = ctx.store.getState(ctx.userId);
  ctx.store.saveState(ctx.userId, { ...current.state, events: [] }, current.revision);
  result = await ctx.route('POST', '/api/integrations/google/sync');
  assert.equal(result.body.deleted, 1); assert.equal(server.items.get(id).status, 'cancelled');
});

for (const choice of ['local', 'remote']) {
  test(`concurrent local/remote edits stay intact until explicit ${choice} resolution`, async (t) => {
    const server = googleServer(), ctx = setup(t, server.fetchImpl); ctx.connect();
    await ctx.route('POST', '/api/integrations/google/sync');
    const id = [...server.items.keys()][0];
    server.edit(id, { summary: '원격 수정' });
    const current = ctx.store.getState(ctx.userId);
    ctx.store.saveState(ctx.userId, { ...current.state, events: [{ ...current.state.events[0], title: '내 수정' }] }, current.revision);
    const result = await ctx.route('POST', '/api/integrations/google/sync');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.conflicts.length, 1); assert.equal(result.body.exported, 0);
    assert.equal(server.items.get(id).summary, '원격 수정');
    assert.equal(ctx.store.getState(ctx.userId).state.events[0].title, '내 수정');
    const resolved = await ctx.route('POST', '/api/integrations/google/resolve', { conflictId: result.body.conflicts[0].id, choice });
    assert.equal(resolved.status, 200); assert.equal(resolved.body.conflicts.length, 0);
    assert.equal(ctx.store.getState(ctx.userId).state.events[0].title, choice === 'local' ? '내 수정' : '원격 수정');
    assert.equal(server.items.get(id).summary, choice === 'local' ? '내 수정' : '원격 수정');
  });
}

test('remote deletion concurrent with local edit can explicitly restore the local event', async (t) => {
  const server = googleServer(), ctx = setup(t, server.fetchImpl); ctx.connect();
  await ctx.route('POST', '/api/integrations/google/sync');
  const id = [...server.items.keys()][0]; server.edit(id, { status: 'cancelled' });
  const current = ctx.store.getState(ctx.userId);
  ctx.store.saveState(ctx.userId, { ...current.state, events: [{ ...current.state.events[0], title: '보존할 일정' }] }, current.revision);
  const pending = await ctx.route('POST', '/api/integrations/google/sync');
  assert.equal(pending.status, 200, JSON.stringify(pending.body));
  assert.equal(pending.body.conflicts.length, 1);
  const resolved = await ctx.route('POST', '/api/integrations/google/resolve', { conflictId: pending.body.conflicts[0].id, choice: 'local' });
  assert.equal(resolved.status, 200); assert.equal(resolved.body.conflicts.length, 0);
  assert.equal([...server.items.values()].filter((item) => item.status !== 'cancelled').length, 1);
});

test('invalid Google sync cursor falls back to a full snapshot', async () => {
  const calls = [];
  const connection = { calendarId: 'shadow-calendar', cursor: 'expired' };
  const adapter = createOAuthAdapter({ provider: 'google', connection, accessToken: 'test', fetchImpl: async (input) => {
    const url = new URL(input); calls.push(url);
    return url.searchParams.has('syncToken') ? json({}, 410) : json({ items: [], nextSyncToken: 'new' });
  } });
  const result = await adapter.list();
  assert.equal(result.full, true); assert.equal(result.cursor, 'new'); assert.equal(calls.length, 2);
});

test('Google UTC UNTIL and EXDATE are converted to the correct Korean occurrence date', async () => {
  const adapter = createOAuthAdapter({ provider: 'google', connection: { calendarId: 'dedicated' }, accessToken: 'test', fetchImpl: async () => json({ items: [{
    id: 'series', etag: '"series-1"', summary: '새벽 일정',
    start: { dateTime: '2026-09-07T02:00:00+09:00', timeZone: 'Asia/Seoul' }, end: { dateTime: '2026-09-07T03:00:00+09:00', timeZone: 'Asia/Seoul' },
    recurrence: ['RRULE:FREQ=DAILY;UNTIL=20260907T180000Z', 'EXDATE:20260907T170000Z'],
  }], nextSyncToken: 'token' }) });
  const result = await adapter.list();
  assert.equal(result.items[0].fields.recurrence.until, '2026-09-08');
  assert.deepEqual(result.items[0].fields.excludedDates, ['2026-09-08']);
});

test('a cancelled Google recurrence instance blocks lossy updates to its master with a warning', async (t) => {
  const server = googleServer(), series = event({ recurrence: { frequency: 'daily', interval: 1, until: '2026-09-20' } });
  const ctx = setup(t, server.fetchImpl, [series]); ctx.connect();
  await ctx.route('POST', '/api/integrations/google/sync');
  const masterId = [...server.items.keys()][0];
  server.edit('cancelled-instance', { status: 'cancelled', recurringEventId: masterId, originalStartTime: { dateTime: '2026-09-08T15:00:00+09:00' } });
  const current = ctx.store.getState(ctx.userId);
  ctx.store.saveState(ctx.userId, { ...current.state, events: [{ ...series, title: '로컬 이름 수정' }] }, current.revision);
  const result = await ctx.route('POST', '/api/integrations/google/sync');
  assert.equal(result.status, 200); assert.equal(result.body.exported, 0);
  assert.ok(result.body.warnings.some((warning) => warning.includes('개별 취소')));
  assert.equal(server.items.get(masterId).summary, series.title);
});

for (const operation of ['delete', 'remove-recurrence']) {
  test(`remote master ${operation} keeps stored exception relationships valid`, async (t) => {
    const series = event({ recurrence: { frequency: 'daily', interval: 1, until: '2026-09-20' }, excludedDates: ['2026-09-08'] });
    const exception = event({ date: '2026-09-08', sourceId: series.id, occurrenceDate: '2026-09-08', title: '수정된 한 번' });
    const server = googleServer(), ctx = setup(t, server.fetchImpl, [series, exception]); ctx.connect();
    assert.equal((await ctx.route('POST', '/api/integrations/google/sync')).status, 200);
    const masterId = [...server.items.values()].find((item) => item.extendedProperties.private.shadowId === series.id).id;
    server.edit(masterId, operation === 'delete' ? { status: 'cancelled' } : { recurrence: [] });
    const result = await ctx.route('POST', '/api/integrations/google/sync');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const events = ctx.store.getState(ctx.userId).state.events;
    if (operation === 'delete') assert.equal(events.length, 0);
    else {
      assert.equal(events.length, 2);
      const standalone = events.find((item) => item.id === exception.id);
      assert.equal(standalone.sourceId, undefined); assert.equal(standalone.occurrenceDate, undefined);
      assert.equal(standalone.title, exception.title);
    }
  });
}

test('a changed local exception prevents an external master deletion from silently removing it', async (t) => {
  const series = event({ recurrence: { frequency: 'daily', interval: 1, until: '2026-09-20' }, excludedDates: ['2026-09-08'] });
  const exception = event({ date: '2026-09-08', sourceId: series.id, occurrenceDate: '2026-09-08' });
  const server = googleServer(), ctx = setup(t, server.fetchImpl, [series, exception]); ctx.connect();
  await ctx.route('POST', '/api/integrations/google/sync');
  const masterId = [...server.items.values()].find((item) => item.extendedProperties.private.shadowId === series.id).id;
  server.edit(masterId, { status: 'cancelled' });
  const current = ctx.store.getState(ctx.userId);
  ctx.store.saveState(ctx.userId, { ...current.state, events: current.state.events.map((item) => item.id === exception.id ? { ...item, title: '예외 일정의 새 변경' } : item) }, current.revision);
  const result = await ctx.route('POST', '/api/integrations/google/sync');
  assert.equal(result.status, 200); assert.equal(result.body.conflicts.length, 1);
  assert.equal(ctx.store.getState(ctx.userId).state.events.length, 2);
});

for (const edit of ['title', 'cost']) {
  test(`a series deletion choice expires when a linked exception ${edit} changes after the conflict`, async (t) => {
    const series = event({ recurrence: { frequency: 'daily', interval: 1, until: '2026-09-20' }, excludedDates: ['2026-09-08'] });
    const exception = event({ date: '2026-09-08', sourceId: series.id, occurrenceDate: '2026-09-08' });
    const server = googleServer(), ctx = setup(t, server.fetchImpl, [series, exception]); ctx.connect();
    await ctx.route('POST', '/api/integrations/google/sync');
    const masterId = [...server.items.values()].find((item) => item.extendedProperties.private.shadowId === series.id).id;
    server.edit(masterId, { status: 'cancelled' });
    const first = ctx.store.getState(ctx.userId);
    ctx.store.saveState(ctx.userId, { ...first.state, events: first.state.events.map((item) => item.id === exception.id ? { ...item, title: '충돌이 발생한 예외' } : item) }, first.revision);
    const pending = await ctx.route('POST', '/api/integrations/google/sync');
    assert.equal(pending.body.conflicts.length, 1);
    const latest = ctx.store.getState(ctx.userId);
    const changed = edit === 'title' ? { title: '충돌 확인 후 새 제목' } : { cost: { ...exception.cost, mealWon: 24000 } };
    ctx.store.saveState(ctx.userId, { ...latest.state, events: latest.state.events.map((item) => item.id === exception.id ? { ...item, ...changed } : item) }, latest.revision);
    const resolved = await ctx.route('POST', '/api/integrations/google/resolve', { conflictId: pending.body.conflicts[0].id, choice: 'remote' });
    assert.equal(resolved.status, 200); assert.equal(resolved.body.conflicts.length, 1);
    assert.equal(ctx.store.getState(ctx.userId).state.events.length, 2);
    const preserved = ctx.store.getState(ctx.userId).state.events.find((item) => item.id === exception.id);
    if (edit === 'title') assert.equal(preserved.title, changed.title);
    else assert.equal(preserved.cost.mealWon, 24000);
    const synced = await ctx.route('POST', '/api/integrations/google/sync');
    assert.equal(synced.body.conflicts.length, 1, 'ordinary sync must not apply an unresolved deletion after a child was exported');
    assert.equal(ctx.store.getState(ctx.userId).state.events.length, 2);
    const confirmed = await ctx.route('POST', '/api/integrations/google/resolve', { conflictId: synced.body.conflicts[0].id, choice: 'remote' });
    assert.equal(confirmed.status, 200); assert.equal(confirmed.body.conflicts.length, 0);
    assert.equal(ctx.store.getState(ctx.userId).state.events.length, 0);
  });
}

test('provider pagination cannot redirect bearer tokens to an arbitrary hostname', async () => {
  let calls = 0;
  const adapter = createOAuthAdapter({ provider: 'microsoft', connection: { calendarId: 'dedicated' }, accessToken: 'test', fetchImpl: async () => { calls++; return json({ value: [], '@odata.nextLink': 'https://attacker.example/collect' }); } });
  await assert.rejects(() => adapter.list(), { code: 'unsafe_remote_url' });
  assert.equal(calls, 1);
});

test('Microsoft uses Graph v1.0 dedicated calendars, timezone-safe fields and conditional writes', async () => {
  const calls = [], connection = {};
  const microsoftEvent = { id: 'ms-event', '@odata.etag': '"ms-1"', subject: 'Outlook 일정', start: { dateTime: '2026-09-07T15:00:00.0000000', timeZone: 'Korea Standard Time' }, end: { dateTime: '2026-09-07T16:00:00.0000000', timeZone: 'Korea Standard Time' } };
  const adapter = createOAuthAdapter({ provider: 'microsoft', connection, accessToken: 'test', fetchImpl: async (input, options = {}) => {
    const url = new URL(input); calls.push({ url, ...options });
    if (url.pathname === '/v1.0/me/calendars') return json({ id: 'dedicated' }, 201);
    if (!options.method) return json({ value: [microsoftEvent] });
    return json(microsoftEvent);
  } });
  await adapter.ensureCalendar(); assert.equal(connection.calendarId, 'dedicated');
  const listed = await adapter.list(); assert.equal(listed.full, true); assert.equal(listed.items[0].fields.startMinute, 900);
  await adapter.put(event(), listed.items[0]);
  assert.equal(calls[2].method, 'PATCH'); assert.equal(calls[2].headers['If-Match'], '"ms-1"');
  assert.ok(calls.every((call) => call.url.pathname.startsWith('/v1.0/')));
});

test('Microsoft checks master exception details before allowing recurrence synchronization', async () => {
  const queries = [];
  const master = { id: 'series', '@odata.etag': '"series-1"', subject: 'Daily', start: { dateTime: '2026-09-07T15:00:00', timeZone: 'Korea Standard Time' }, end: { dateTime: '2026-09-07T16:00:00', timeZone: 'Korea Standard Time' }, recurrence: { pattern: { type: 'daily', interval: 1 }, range: { type: 'endDate', startDate: '2026-09-07', endDate: '2026-09-20', recurrenceTimeZone: 'Korea Standard Time' } } };
  const api = createOAuthAdapter({ provider: 'microsoft', connection: { calendarId: 'dedicated' }, accessToken: 'test', fetchImpl: async (input) => {
    const url = new URL(input); queries.push(url);
    return url.pathname.endsWith('/series') ? json({ ...master, cancelledOccurrences: ['OID.series.2026-09-08'], exceptionOccurrences: [] }) : json({ value: [master] });
  } });
  const result = await api.list();
  assert.equal(result.items[0].unsupported, true);
  assert.ok(queries[1].searchParams.get('$select').includes('cancelledOccurrences'));
  assert.equal(queries[1].searchParams.get('$expand'), 'exceptionOccurrences');
});

test('Apple discovery follows allowlisted TLS endpoints and rejects credential forwarding to other hosts', async () => {
  let calls = 0;
  const connection = { credentials: { username: 'test@example.test', password: 'abcd-efgh-ijkl-mnop' } };
  const api = createCalDavAdapter({ connection, eventTypes: [TYPE], importIcs, exportIcs, fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://attacker.example/' } }); } });
  await assert.rejects(() => api.discover(), { code: 'unsafe_remote_url' });
  assert.equal(calls, 1);
  assert.throws(() => assertRemoteUrl('http://caldav.icloud.com/', () => true), { code: 'unsafe_remote_url' });
});

test('Apple connection discovers the principal and home without creating a calendar', async () => {
  const calls = [], connection = { credentials: { username: 'test@example.test', password: 'abcd-efgh-ijkl-mnop' } };
  const api = createCalDavAdapter({ connection, eventTypes: [TYPE], importIcs, exportIcs, fetchImpl: async (input, options) => {
    calls.push({ input: String(input), method: options.method });
    return new Response(calls.length === 1
      ? '<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:current-user-principal><d:href>https://p01-caldav.icloud.com/user/principal/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>'
      : '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:propstat><d:prop><c:calendar-home-set><d:href>/user/calendars/</d:href></c:calendar-home-set></d:prop></d:propstat></d:response></d:multistatus>', { status: 207 });
  } });
  await api.discover();
  assert.equal(connection.homeUrl, 'https://p01-caldav.icloud.com/user/calendars/');
  assert.equal(connection.calendarId, undefined);
  assert.deepEqual(calls.map((call) => call.method), ['PROPFIND', 'PROPFIND']);
});

test('a concurrent local save during a remote import is retained and surfaced as a conflict', async (t) => {
  const server = googleServer(), ctx = setup(t, server.fetchImpl); ctx.connect();
  await ctx.route('POST', '/api/integrations/google/sync');
  const id = [...server.items.keys()][0]; server.edit(id, { summary: '원격 수정' });
  const originalSave = ctx.store.saveState.bind(ctx.store);
  let interrupted = false;
  ctx.store.saveState = (userId, state, revision) => {
    if (!interrupted) {
      interrupted = true;
      const current = ctx.store.getState(userId);
      originalSave(userId, { ...current.state, events: [{ ...current.state.events[0], title: '동시에 저장된 내 일정' }] }, current.revision);
    }
    return originalSave(userId, state, revision);
  };
  const result = await ctx.route('POST', '/api/integrations/google/sync');
  assert.equal(result.status, 200); assert.equal(result.body.conflicts.length, 1);
  assert.equal(ctx.store.getState(ctx.userId).state.events[0].title, '동시에 저장된 내 일정');
  assert.equal(server.items.get(id).summary, '원격 수정');
});

test('a stale conflict decision does not overwrite a newer remote change', async (t) => {
  const server = googleServer(), ctx = setup(t, server.fetchImpl); ctx.connect();
  await ctx.route('POST', '/api/integrations/google/sync');
  const id = [...server.items.keys()][0]; server.edit(id, { summary: '원격 수정' });
  const current = ctx.store.getState(ctx.userId);
  ctx.store.saveState(ctx.userId, { ...current.state, events: [{ ...current.state.events[0], title: '내 수정' }] }, current.revision);
  const pending = await ctx.route('POST', '/api/integrations/google/sync');
  server.edit(id, { summary: '선택 전 다시 수정' });
  const result = await ctx.route('POST', '/api/integrations/google/resolve', { conflictId: pending.body.conflicts[0].id, choice: 'local' });
  assert.equal(result.status, 200); assert.equal(result.body.conflicts.length, 1);
  assert.equal(server.items.get(id).summary, '선택 전 다시 수정');
});

test('CalDAV reads and writes actual ICS and never exports SHADOW cost or shadow metadata', async () => {
  const original = event(), calls = [];
  const connection = { calendarId: 'https://p01-caldav.icloud.com/user/calendars/shadow/', credentials: { username: 'test@example.test', password: 'abcd-efgh-ijkl-mnop' } };
  const api = createCalDavAdapter({ connection, eventTypes: [TYPE], importIcs, exportIcs, fetchImpl: async (input, options) => {
    calls.push({ input: String(input), ...options });
    if (options.method === 'PUT') return new Response(null, { status: 201, headers: { etag: '"dav-1"' } });
    const ics = exportIcs(appState([original]), { includeShadowMetadata: false });
    return new Response(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/user/calendars/shadow/appointment.ics</d:href><d:propstat><d:prop><d:getetag>"dav-1"</d:getetag><c:calendar-data><![CDATA[${ics}]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`, { status: 207 });
  } });
  const created = await api.put(original, null); assert.equal(created.etag, '"dav-1"');
  assert.equal(calls[0].headers['If-None-Match'], '*'); assert.ok(calls[0].body.includes('BEGIN:VEVENT'));
  assert.ok(!calls[0].body.includes('X-SHADOW-')); assert.ok(!calls[0].body.includes('12000'));
  const listed = await api.list(); assert.equal(listed.items[0].fields.title, original.title); assert.equal(listed.items[0].fields.startMinute, 900);
  await assert.rejects(() => api.remove({ id: 'https://p01-caldav.icloud.com/user/calendars/private/event.ics', etag: 'x' }), { code: 'unsafe_remote_url' });
});

test('CalDAV rejects DTD, external entities, malformed tags and excessive response size', async () => {
  assert.throws(() => parseDavXml('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>'), { code: 'invalid_xml' });
  assert.throws(() => parseDavXml('<d:x xmlns:d="DAV:">&unknown;</d:x>'), { code: 'invalid_xml' });
  assert.throws(() => parseDavXml('<a><b></a>'), { code: 'invalid_xml' });
  assert.throws(() => parseDavXml('<a>'.repeat(65) + '</a>'.repeat(65)), { code: 'invalid_xml' });
  await assert.rejects(() => boundedText(new Response('small', { headers: { 'content-length': '6000000' } })), { code: 'response_too_large' });
});

test('a CalDAV missing property is not treated as a deleted resource', async () => {
  const connection = { calendarId: 'https://p01-caldav.icloud.com/user/calendars/shadow/', credentials: { username: 'test@example.test', password: 'abcd-efgh-ijkl-mnop' } };
  const api = createCalDavAdapter({ connection, eventTypes: [TYPE], importIcs, exportIcs, fetchImpl: async () => new Response('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/user/calendars/shadow/event.ics</d:href><d:propstat><d:prop/><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response></d:multistatus>', { status: 207 }) });
  const listed = await api.list();
  assert.equal(listed.items[0].unsupported, true); assert.equal(listed.items[0].deleted, undefined);
});

test('disconnect removes stored credentials without deleting the remote or local calendar', async (t) => {
  const server = googleServer(), ctx = setup(t, server.fetchImpl); ctx.connect();
  await ctx.route('POST', '/api/integrations/google/sync');
  const calls = server.calls.length;
  assert.equal((await ctx.route('DELETE', '/api/integrations/google')).status, 200);
  assert.equal(ctx.store.getConnection(ctx.userId, 'google'), null);
  assert.equal(ctx.store.getState(ctx.userId).state.events.length, 1);
  assert.equal(server.items.size, 1); assert.equal(server.calls.length, calls);
});
