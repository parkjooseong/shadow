import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createApp } from './app.mjs';
import { createDatabase } from './database.mjs';

const origin = 'http://localhost:5173';
const credentials = (email = 'owner@example.test') => ({ email, name: 'Owner', password: 'original-password-123' });
const calendar = () => ({ schemaVersion: 1, preferences: { locale: 'ko-KR', timeZone: 'Asia/Seoul', currency: 'KRW', weekStartsOn: 1 }, eventTypes: [{ id: 'personal', name: 'Personal', color: '#123456', preparationMinutes: 0, travelMinutes: 0, recoveryMinutes: 0, transportCostWon: 0, mealCostWon: 0 }], events: [] });
const rawCookie = (cookie) => cookie.split('=')[1];
const emailToken = (message) => new URLSearchParams(new URL(message.text.match(/http[^\s]+/)[0]).hash.slice(1)).get('token');

async function start(t, options = {}) {
  const messages = [];
  const mailer = { available: true, mode: 'smtp', send: async (message) => { messages.push(message); } };
  const app = createApp({ dbPath: ':memory:', origin, encryptionKey: randomBytes(32).toString('base64'), mailer, ...options });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, { method = 'GET', body, cookie, requestOrigin = origin, headers = {} } = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { ...(requestOrigin ? { Origin: requestOrigin } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
  };
  const registered = async (email) => request('/api/auth/register', { method: 'POST', body: credentials(email) });
  return { ...app, request, registered, messages };
}

async function settleMail() {
  await nextTurn();
  await nextTurn();
}

test('mail capability is explicit and disabled mail does not break existing account/calendar access', async (t) => {
  const { request, registered } = await start(t, { mailer: { available: false, mode: 'disabled', send: () => assert.fail('Disabled mail must never send') } });
  const capabilities = await request('/api/auth/capabilities');
  assert.deepEqual(capabilities.body, { mail: { available: false, mode: 'disabled' }, passwordReset: { available: false }, emailVerification: { available: false } });
  const owner = await registered();
  assert.equal(owner.body.user.emailVerified, false);
  assert.equal((await request('/api/state', { cookie: owner.cookie })).status, 200);
  assert.equal((await request('/api/auth/password-reset/request', { method: 'POST', body: { email: credentials().email } })).status, 503);
  assert.equal((await request('/api/auth/password-reset/request', { method: 'POST', body: { email: 'missing@example.test' } })).status, 503);
  assert.equal((await request('/api/auth/email-verification/request', { method: 'POST', cookie: owner.cookie })).status, 503);
});

test('server listening starts optional synchronization and shutdown waits for it before closing the database', async (t) => {
  const calls = [];
  const app = await start(t, { integrationFactory: ({ store }) => ({
    start() { calls.push('start'); },
    async stop() { await nextTurn(); assert.deepEqual(store.listEnabledAutomations(), []); calls.push('stop'); },
  }) });
  assert.deepEqual(calls, ['start']);
  await app.close();
  assert.deepEqual(calls, ['start', 'stop']);
});

test('new registrations use the supported mail address format without rejecting legacy logins', async (t) => {
  const { request, registered, database } = await start(t);
  for (const email of ['사용자@example.test', '"quoted"@example.test', 'a..b@example.test', '.a@example.test', 'a.@example.test', `${'a'.repeat(65)}@example.test`, 'name@-example.test', 'name@ex_ample.test', 'bad\0name@example.test']) {
    const result = await registered(email);
    assert.equal(result.status, 400);
    assert.match(result.body.error, /메일을 받을 수 있는/);
  }
  const valid = await registered();
  assert.equal(valid.status, 201);
  const { passwordHash } = database.getUserByEmail(credentials().email);
  database.createUser({ email: '레거시@example.test', name: 'Legacy', passwordHash });
  const legacy = await request('/api/auth/login', { method: 'POST', body: credentials('레거시@example.test') });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.user.email, '레거시@example.test');
});

test('reset request is enumeration-safe, bounded per email, and never returns the mailed token', async (t) => {
  const { request, registered, messages } = await start(t);
  await registered();
  const known = await request('/api/auth/password-reset/request', { method: 'POST', body: { email: ' OWNER@EXAMPLE.TEST ' } });
  const unknown = await request('/api/auth/password-reset/request', { method: 'POST', body: { email: 'missing@example.test' } });
  assert.equal(known.status, 202);
  assert.deepEqual(known.body, unknown.body);
  await settleMail();
  assert.equal(messages.length, 1);
  const token = emailToken(messages[0]);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(JSON.stringify(known.body), new RegExp(token));
  assert.match(messages[0].text, /http:\/\/localhost:5173\/#account-action=reset-password&token=/);
  for (let index = 0; index < 4; index++) {
    assert.deepEqual((await request('/api/auth/password-reset/request', { method: 'POST', body: { email: credentials().email } })).body, known.body);
  }
  await settleMail();
  assert.equal(messages.length, 3);
  assert.equal((await request('/api/auth/password-reset/confirm', { method: 'POST', body: { token, password: 'replacement-password' } })).status, 400);
});

test('concurrent reset consumes a token once, revokes all sessions/OAuth states, and preserves calendars/connections', async (t) => {
  const { request, registered, database, messages } = await start(t);
  const owner = await registered();
  const ownerId = owner.body.user.id;
  const otherSession = await request('/api/auth/login', { method: 'POST', body: credentials() });
  await request('/api/state', { method: 'PUT', cookie: owner.cookie, body: { state: calendar(), revision: 0 } });
  database.saveConnection(ownerId, 'google', { credentials: { accessToken: 'test-provider-secret' } });
  const session = database.getSession(rawCookie(owner.cookie));
  database.saveOAuthState({ state: 'pending-oauth', userId: ownerId, sessionId: session.sessionId, expiresAt: Date.now() + 60_000 });
  await request('/api/auth/password-reset/request', { method: 'POST', body: { email: credentials().email } });
  await settleMail();
  const token = emailToken(messages[0]);
  const attempts = await Promise.all(['replacement-password-A', 'replacement-password-B'].map((password) => request('/api/auth/password-reset/confirm', { method: 'POST', body: { token, password } })));
  assert.deepEqual(attempts.map((result) => result.status).sort(), [200, 400]);
  const winner = attempts.findIndex((result) => result.status === 200);
  assert.deepEqual(attempts[winner].body, { ok: true, reauthenticate: true });
  assert.match(attempts[winner].headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await request('/api/auth/me', { cookie: owner.cookie })).body.user, null);
  assert.equal((await request('/api/auth/me', { cookie: otherSession.cookie })).body.user, null);
  assert.equal(database.consumeOAuthState('pending-oauth', ownerId, session.sessionId), null);
  assert.deepEqual(database.getState(ownerId), { state: calendar(), revision: 1 });
  assert.deepEqual(database.getConnection(ownerId, 'google'), { credentials: { accessToken: 'test-provider-secret' } });
  assert.equal((await request('/api/auth/login', { method: 'POST', body: credentials() })).status, 401);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { ...credentials(), password: ['replacement-password-A', 'replacement-password-B'][winner] } })).status, 200);
  await settleMail();
  assert.equal(messages.length, 2);
  assert.doesNotMatch(messages[1].text, /replacement-password|original-password|token=/);
});

test('verification is explicit, expiring, purpose-bound and single use without mandatory login', async (t) => {
  const { request, registered, database, messages } = await start(t);
  const owner = await registered();
  assert.equal((await request('/api/auth/email-verification/request', { method: 'POST' })).status, 401);
  await request('/api/auth/email-verification/request', { method: 'POST', cookie: owner.cookie });
  await settleMail();
  const token = emailToken(messages[0]);
  assert.match(messages[0].text, /#account-action=verify-email&token=/);
  assert.equal((await request('/api/auth/password-reset/confirm', { method: 'POST', body: { token, password: 'new-password-invalid-purpose' } })).status, 400);
  assert.equal((await request('/api/auth/me', { cookie: owner.cookie })).body.user.emailVerified, false);
  const results = await Promise.all([1, 2].map(() => request('/api/auth/email-verification/confirm', { method: 'POST', body: { token } })));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 400]);
  assert.equal((await request('/api/auth/me', { cookie: owner.cookie })).body.user.emailVerified, true);
  assert.equal(database.getUserByEmail(credentials().email).emailVerified, true);
  await request('/api/auth/email-verification/request', { method: 'POST', cookie: owner.cookie });
  await settleMail();
  assert.equal(messages.length, 1);
  const expired = database.createAccountToken(owner.body.user.id, 'email-verification', Date.now() - 1);
  assert.equal((await request('/api/auth/email-verification/confirm', { method: 'POST', body: { token: expired } })).status, 400);
});

test('expired/invalid reset tokens fail while invalid password does not consume a valid token', async (t) => {
  const { request, registered, database } = await start(t);
  const owner = await registered();
  const expired = database.createAccountToken(owner.body.user.id, 'password-reset', Date.now() - 1);
  assert.equal((await request('/api/auth/password-reset/confirm', { method: 'POST', body: { token: expired, password: 'replacement-password' } })).status, 400);
  const token = database.createAccountToken(owner.body.user.id, 'password-reset', Date.now() + 60_000);
  assert.equal((await request('/api/auth/password-reset/confirm', { method: 'POST', body: { token, password: 'short' } })).status, 400);
  assert.equal((await request('/api/auth/password-reset/confirm', { method: 'POST', body: { token: 'bad-token', password: 'replacement-password' } })).status, 400);
  assert.equal((await request('/api/auth/password-reset/confirm', { method: 'POST', body: { token, password: 'replacement-password' } })).status, 200);
});

test('password change requires current password and revokes pending reset/verification and OAuth tokens', async (t) => {
  const { request, registered, database } = await start(t);
  const owner = await registered();
  const second = await request('/api/auth/login', { method: 'POST', body: credentials() });
  const session = database.getSession(rawCookie(owner.cookie));
  const reset = database.createAccountToken(owner.body.user.id, 'password-reset', Date.now() + 60_000);
  const verify = database.createAccountToken(owner.body.user.id, 'email-verification', Date.now() + 60_000);
  database.saveOAuthState({ state: 'changing-password-oauth', userId: owner.body.user.id, sessionId: session.sessionId, expiresAt: Date.now() + 60_000 });
  const oldHash = database.getUserByEmail(credentials().email).passwordHash;
  assert.equal((await request('/api/auth/password/change', { method: 'POST', cookie: owner.cookie, body: { currentPassword: 'wrong-current-password', password: 'changed-password-123' } })).status, 401);
  assert.equal(database.getUserByEmail(credentials().email).passwordHash, oldHash);
  const result = await request('/api/auth/password/change', { method: 'POST', cookie: owner.cookie, body: { currentPassword: credentials().password, password: 'changed-password-123' } });
  assert.equal(result.status, 200);
  assert.equal(result.body.reauthenticate, true);
  assert.equal((await request('/api/state', { cookie: owner.cookie })).status, 401);
  assert.equal((await request('/api/state', { cookie: second.cookie })).status, 401);
  assert.equal(database.consumeOAuthState('changing-password-oauth', owner.body.user.id, session.sessionId), null);
  assert.equal(database.verifyEmail(verify), false);
  assert.equal(database.resetPassword(reset, 'unused-test-hash'), null);
  assert.equal(database.createSession(owner.body.user.id, Date.now() + 60_000, oldHash), null);
  assert.equal(database.changePassword(owner.body.user.id, session.sessionId, oldHash, 'stale-test-hash'), false);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { ...credentials(), password: 'changed-password-123' } })).status, 200);
});

test('revoking other sessions preserves the current session and its OAuth state only', async (t) => {
  const { request, registered, database } = await start(t);
  const owner = await registered();
  const second = await request('/api/auth/login', { method: 'POST', body: credentials() });
  const current = database.getSession(rawCookie(owner.cookie));
  const other = database.getSession(rawCookie(second.cookie));
  for (const [state, session] of [['current-oauth', current], ['other-oauth', other]]) database.saveOAuthState({ state, userId: owner.body.user.id, sessionId: session.sessionId, expiresAt: Date.now() + 60_000 });
  const result = await request('/api/auth/sessions/revoke-others', { method: 'POST', cookie: owner.cookie });
  assert.deepEqual(result.body, { ok: true, revokedSessions: 1 });
  assert.equal((await request('/api/state', { cookie: owner.cookie })).status, 200);
  assert.equal((await request('/api/state', { cookie: second.cookie })).status, 401);
  assert.ok(database.consumeOAuthState('current-oauth', owner.body.user.id, current.sessionId));
  assert.equal(database.consumeOAuthState('other-oauth', owner.body.user.id, other.sessionId), null);
});

test('failed delivery invalidates its token and does not expose provider diagnostics or account existence', async (t) => {
  const delivered = [];
  const { request, registered, database } = await start(t, { mailer: { available: true, mode: 'smtp', send: async (message) => { delivered.push(message); throw new Error('SMTP private secret example'); } } });
  await registered();
  const known = await request('/api/auth/password-reset/request', { method: 'POST', body: { email: credentials().email } });
  const unknown = await request('/api/auth/password-reset/request', { method: 'POST', body: { email: 'unknown@example.test' } });
  await settleMail();
  assert.deepEqual(known.body, unknown.body);
  assert.equal(delivered.length, 1);
  assert.doesNotMatch(JSON.stringify(known.body), /SMTP|private|secret/);
  assert.equal(database.resetPassword(emailToken(delivered[0]), 'must-not-change'), null);
});

test('mail delivery latency does not delay the public reset response', async (t) => {
  let release;
  const delivery = new Promise((resolve) => { release = resolve; });
  const { request, registered } = await start(t, { mailer: { available: true, mode: 'smtp', send: async () => delivery } });
  t.after(() => release());
  await registered();
  try {
    const known = await request('/api/auth/password-reset/request', { method: 'POST', body: { email: credentials().email } });
    const unknown = await request('/api/auth/password-reset/request', { method: 'POST', body: { email: 'unknown@example.test' } });
    assert.equal(known.status, 202);
    assert.deepEqual(known.body, unknown.body);
  } finally { release(); }
});

test('reset token guesses share the bounded authentication request limiter', async (t) => {
  const { request } = await start(t);
  for (let index = 0; index < 20; index++) {
    assert.equal((await request('/api/auth/password-reset/confirm', { method: 'POST', body: { token: `guess-${index}`, password: 'short' } })).status, 400);
  }
  const limited = await request('/api/auth/password-reset/confirm', { method: 'POST', body: { token: 'guess', password: 'replacement-password' } });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '900');
});

test('account-bound requests reject a changed session account without touching either calendar', async (t) => {
  const { request, registered, database } = await start(t);
  const owner = await registered();
  const other = await registered('other@example.test');
  const expected = { 'X-Shadow-Account': owner.body.user.id };
  assert.equal((await request('/api/state', { method: 'PUT', cookie: other.cookie, headers: expected, body: { state: calendar(), revision: 0 } })).status, 409);
  assert.equal((await request('/api/state', { cookie: other.cookie, headers: expected })).status, 409);
  assert.equal((await request('/api/auth/me', { cookie: other.cookie, headers: expected })).status, 409);
  assert.equal((await request('/api/state', { cookie: owner.cookie, headers: { 'X-Shadow-Account': 'invalid' } })).status, 400);
  assert.equal((await request('/api/state', { cookie: owner.cookie, headers: expected })).status, 200);
  assert.deepEqual(database.getState(owner.body.user.id), { state: null, revision: 0 });
  assert.deepEqual(database.getState(other.body.user.id), { state: null, revision: 0 });
});

test('account security mutations require a same-origin request', async (t) => {
  const { request, registered } = await start(t);
  const owner = await registered();
  for (const path of ['/api/auth/password-reset/request', '/api/auth/password-reset/confirm', '/api/auth/email-verification/request', '/api/auth/email-verification/confirm', '/api/auth/password/change', '/api/auth/sessions/revoke-others']) {
    assert.equal((await request(path, { method: 'POST', cookie: owner.cookie, requestOrigin: null, body: {} })).status, 403);
  }
});

test('additive migration preserves old accounts and tokens are only stored as hashes', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'shadow-account-security-'));
  const path = join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL); INSERT INTO users VALUES ('legacy-id', 'legacy@example.test', 'Legacy', 'existing-password-hash', '2026-09-07');");
  legacy.close();
  const database = createDatabase({ dbPath: path });
  const inspected = new DatabaseSync(path);
  t.after(() => { inspected.close(); database.close(); rmSync(directory, { recursive: true, force: true }); });
  const legacyUser = database.getUserByEmail('legacy@example.test');
  assert.equal(legacyUser.passwordHash, 'existing-password-hash');
  assert.equal(legacyUser.emailVerified, false);
  const token = database.createAccountToken(legacyUser.id, 'password-reset', Date.now() + 60_000);
  const stored = inspected.prepare('SELECT * FROM account_tokens').get();
  assert.equal(stored.id, createHash('sha256').update(token).digest('hex'));
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(token));
  const restarted = createDatabase({ dbPath: path });
  assert.equal(restarted.getUserByEmail('legacy@example.test').passwordHash, 'existing-password-hash');
  assert.ok(restarted.resetPassword(token, 'replacement-hash'));
  assert.equal(database.resetPassword(token, 'stale-overwrite'), null);
  assert.equal(database.getUserByEmail('legacy@example.test').passwordHash, 'replacement-hash');
  restarted.close();
});
