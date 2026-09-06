import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.mjs';
import { createDatabase } from './database.mjs';

const origin = 'http://localhost:5173';
const credentials = (email = 'owner@example.test') => ({ email, name: 'Test User', password: 'correct-horse-battery' });
const state = () => ({
  schemaVersion: 1,
  preferences: { locale: 'ko-KR', timeZone: 'Asia/Seoul', currency: 'KRW', weekStartsOn: 1 },
  eventTypes: [{ id: 'hospital', name: '병원', color: '#ff7a66', preparationMinutes: 20, travelMinutes: 40, recoveryMinutes: 30, transportCostWon: 0, mealCostWon: 0 }],
  events: [{ id: 'event', title: 'Private appointment', typeId: 'hospital', location: 'Example clinic', date: '2026-09-07', startMinute: 900, endMinute: 960, shadow: { preparationMinutes: 20, outboundTravelMinutes: 40, returnTravelMinutes: 40, recoveryMinutes: 30 }, cost: { transportWon: 4000, mealWon: 12000 }, createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z' }],
});

async function start(t, options = {}) {
  const app = createApp({ dbPath: ':memory:', origin, ...options });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, { method = 'GET', body, cookie, requestOrigin = origin, headers = {} } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(requestOrigin ? { Origin: requestOrigin } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
  };
  return { ...app, base, request };
}

test('register/login/logout use hashed passwords and revocable HttpOnly sessions', async (t) => {
  const { request, database } = await start(t);
  assert.deepEqual((await request('/api/auth/me')).body, { user: null });
  assert.equal((await request('/api/state')).status, 401);
  const registered = await request('/api/auth/register', { method: 'POST', body: credentials(' Owner@Example.Test ') });
  assert.equal(registered.status, 201);
  assert.deepEqual(Object.keys(registered.body.user).sort(), ['email', 'id', 'name']);
  assert.equal(registered.body.user.email, 'owner@example.test');
  assert.match(registered.headers.get('set-cookie'), /HttpOnly; SameSite=Lax; Path=\//);
  assert.doesNotMatch(registered.headers.get('set-cookie'), /Secure/);
  assert.match(database.getUserByEmail('owner@example.test').passwordHash, /^scrypt-v1:/);
  assert.notEqual(database.getUserByEmail('owner@example.test').passwordHash, credentials().password);
  const me = await request('/api/auth/me', { cookie: registered.cookie });
  assert.deepEqual(me.body, registered.body);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { ...credentials(), password: 'incorrect-password' } })).status, 401);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: credentials('unknown@example.test') })).status, 401);
  const loggedIn = await request('/api/auth/login', { method: 'POST', body: credentials(), cookie: registered.cookie });
  assert.equal(loggedIn.status, 200);
  assert.notEqual(loggedIn.cookie, registered.cookie);
  assert.equal((await request('/api/state', { cookie: registered.cookie })).status, 401);
  assert.equal((await request('/api/auth/logout', { method: 'POST', cookie: loggedIn.cookie })).status, 200);
  assert.equal((await request('/api/state', { cookie: loggedIn.cookie })).status, 401);
});

test('rejects missing/cross-site Origin writes and malformed auth data', async (t) => {
  const { request } = await start(t);
  const register = { method: 'POST', body: credentials() };
  assert.equal((await request('/api/auth/register', { ...register, requestOrigin: null })).status, 403);
  assert.equal((await request('/api/auth/register', { ...register, requestOrigin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await request('/api/auth/register', { ...register, body: { ...credentials(), password: 'short' } })).status, 400);
  assert.equal((await request('/api/auth/register', { ...register, body: { ...credentials(), email: 'invalid' } })).status, 400);
  assert.equal((await request('/api/auth/register', { ...register, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  const health = await request('/api/health', { requestOrigin: null });
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { status: 'ok', version: 1 });
});

test('keeps calendars isolated and rejects stale or invalid replacements without overwriting', async (t) => {
  const { request } = await start(t);
  const owner = await request('/api/auth/register', { method: 'POST', body: credentials() });
  const other = await request('/api/auth/register', { method: 'POST', body: credentials('other@example.test') });
  assert.deepEqual((await request('/api/state', { cookie: owner.cookie })).body, { state: null, revision: 0 });
  const original = state();
  assert.deepEqual((await request('/api/state', { method: 'PUT', cookie: owner.cookie, body: { state: original, revision: 0 } })).body, { revision: 1 });
  const changed = state();
  changed.events[0].title = 'Changed elsewhere';
  assert.equal((await request('/api/state', { method: 'PUT', cookie: owner.cookie, body: { state: changed, revision: 0 } })).status, 409);
  changed.events[0].typeId = 'missing';
  assert.equal((await request('/api/state', { method: 'PUT', cookie: owner.cookie, body: { state: changed, revision: 1 } })).status, 400);
  assert.deepEqual((await request('/api/state', { cookie: owner.cookie })).body, { state: original, revision: 1 });
  assert.deepEqual((await request('/api/state', { cookie: other.cookie })).body, { state: null, revision: 0 });
  const concurrent = await Promise.all([1, 2].map(() => request('/api/state', { method: 'PUT', cookie: owner.cookie, body: { state: original, revision: 1 } })));
  assert.deepEqual(concurrent.map((result) => result.status).sort(), [200, 409]);
});

test('shares are immutable bearer snapshots, private listings and owner-only revocation', async (t) => {
  const { request } = await start(t);
  const owner = await request('/api/auth/register', { method: 'POST', body: credentials() });
  const other = await request('/api/auth/register', { method: 'POST', body: credentials('other@example.test') });
  const original = state();
  const created = await request('/api/shares', { method: 'POST', cookie: owner.cookie, body: { title: 'Shared snapshot', state: original } });
  assert.equal(created.status, 201);
  const { share } = created.body;
  assert.equal(share.token.length, 43);
  assert.deepEqual((await request('/api/shares', { cookie: owner.cookie })).body.shares, [share]);
  assert.deepEqual((await request('/api/shares', { cookie: other.cookie })).body.shares, []);
  const changed = state();
  changed.events = [];
  await request('/api/state', { method: 'PUT', cookie: owner.cookie, body: { state: changed, revision: 0 } });
  assert.deepEqual((await request(`/api/public/${share.token}`, { requestOrigin: null })).body, { title: 'Shared snapshot', state: original });
  assert.equal((await request(`/api/shares/${share.id}`, { method: 'DELETE', cookie: other.cookie })).status, 404);
  assert.equal((await request(`/api/public/${share.token}`, { method: 'PUT', cookie: owner.cookie, body: {} })).status, 404);
  assert.equal((await request(`/api/shares/${share.id}`, { method: 'DELETE', cookie: owner.cookie })).status, 200);
  assert.equal((await request(`/api/public/${share.token}`)).status, 404);
});

test('enforces payload size and credential attempt limits', async (t) => {
  const { request, base } = await start(t);
  const large = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x'.repeat(2_000_001) }) });
  assert.equal(large.status, 413);
  await large.text();
  for (let index = 0; index < 19; index++) {
    const result = await request('/api/auth/login', { method: 'POST', body: {} });
    assert.equal(result.status, 400);
  }
  const limited = await request('/api/auth/login', { method: 'POST', body: {} });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '900');
});

test('sets Secure cookies for an HTTPS origin and gates integration handlers', async (t) => {
  let calls = 0;
  const secureOrigin = 'https://shadow.example';
  const { request } = await start(t, { origin: secureOrigin, integrationFactory: () => ({ route: () => { calls++; return { status: 200, body: { providers: [] } }; } }) });
  const owner = await request('/api/auth/register', { method: 'POST', requestOrigin: secureOrigin, body: credentials() });
  assert.match(owner.headers.get('set-cookie'), /; Secure/);
  assert.equal((await request('/api/integrations', { requestOrigin: null })).status, 401);
  assert.equal(calls, 0);
  assert.equal((await request('/api/integrations/google/sync', { method: 'POST', requestOrigin: null, cookie: owner.cookie })).status, 403);
  assert.equal(calls, 0);
  assert.equal((await request('/api/integrations', { requestOrigin: null, cookie: owner.cookie })).status, 200);
  assert.equal(calls, 1);
});

test('database persists encrypted credentials, user binding and single-use OAuth state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadow-server-test-'));
  const dbPath = join(directory, 'test.sqlite');
  const encryptionKey = randomBytes(32).toString('base64');
  const database = createDatabase({ dbPath, encryptionKey });
  const user = database.createUser({ email: 'test@example.test', name: 'Test', passwordHash: 'test-hash' });
  const other = database.createUser({ email: 'other@example.test', name: 'Other', passwordHash: 'other-hash' });
  const secret = { credentials: { accessToken: 'private-provider-token', refreshToken: 'private-refresh-token' }, calendarId: 'primary' };
  database.saveConnection(user.id, 'google', secret);
  assert.deepEqual(database.getConnection(user.id, 'google'), secret);
  assert.equal(database.getConnection(other.id, 'google'), null);
  assert.deepEqual(Object.keys(database.listConnections(user.id)[0]).sort(), ['provider', 'updatedAt']);
  const oauth = { state: 'random-oauth-state', userId: user.id, sessionId: 'session-hash', provider: 'google', verifier: 'private-code-verifier', expiresAt: Date.now() + 60_000 };
  database.saveOAuthState(oauth);
  assert.equal(database.consumeOAuthState(oauth.state, other.id, oauth.sessionId), null);
  assert.equal(database.consumeOAuthState(oauth.state, user.id, 'wrong-session'), null);
  assert.deepEqual(database.consumeOAuthState(oauth.state, user.id, oauth.sessionId), oauth);
  assert.equal(database.consumeOAuthState(oauth.state, user.id, oauth.sessionId), null);
  assert.deepEqual(database.saveState(user.id, state(), 0), { ok: true, revision: 1 });
  database.close();
  const bytes = await readFile(dbPath);
  assert.equal(bytes.includes(Buffer.from('private-provider-token')), false);
  assert.equal(bytes.includes(Buffer.from('private-refresh-token')), false);
  const reopened = createDatabase({ dbPath, encryptionKey });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.getConnection(user.id, 'google'), secret);
  assert.equal(reopened.getState(user.id).revision, 1);
});

test('connections cannot store plaintext when encryption is unavailable', () => {
  const database = createDatabase({ dbPath: ':memory:', encryptionKey: '' });
  try {
    assert.equal(database.encryptionAvailable, false);
    assert.throws(() => database.saveConnection('any-user', 'google', { accessToken: 'secret' }), /SHADOW_ENCRYPTION_KEY/);
  } finally {
    database.close();
  }
});
