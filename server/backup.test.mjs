import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDatabaseSnapshot, parseSnapshotArguments } from '../scripts/backup.mjs';
import { createDatabase } from './database.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'shadow-snapshot-test-'));
  const source = join(directory, 'live.sqlite');
  const db = new DatabaseSync(source);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE sample(id INTEGER PRIMARY KEY, content TEXT NOT NULL);');
  db.prepare('INSERT INTO sample(content) VALUES (?)').run('synthetic-sensitive-value');
  t.after(() => db.close());
  return { directory, source, db, target: join(directory, 'backup.sqlite') };
}

function contents(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare('SELECT content FROM sample ORDER BY id').all().map((row) => row.content); }
  finally { db.close(); }
}

async function securityFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'shadow-restore-security-'));
  const source = join(directory, 'live.sqlite');
  const encryptionKey = randomBytes(32).toString('base64');
  const store = createDatabase({ dbPath: source, encryptionKey });
  t.after(() => store.close());
  const user = store.createUser({ email: 'owner@example.test', name: 'Owner', passwordHash: 'synthetic-password-hash' });
  const calendar = {
    schemaVersion: 1, preferences: { locale: 'ko-KR', timeZone: 'Asia/Seoul', currency: 'KRW', weekStartsOn: 1 },
    eventTypes: [{ id: 'personal', name: 'Personal', color: '#123456', preparationMinutes: 0, travelMinutes: 0, recoveryMinutes: 0, transportCostWon: 0, mealCostWon: 0 }],
    events: [{ id: 'appointment', title: 'Preserved appointment', typeId: 'personal', date: '2026-09-07', startMinute: 900, endMinute: 960, shadow: { preparationMinutes: 20, outboundTravelMinutes: 40, returnTravelMinutes: 40, recoveryMinutes: 30 }, cost: { transportWon: 4000, mealWon: 12000 }, createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z' }],
  };
  store.saveState(user.id, calendar, 0);
  const expiresAt = Date.now() + 3_600_000;
  const session = store.createSession(user.id, expiresAt);
  const accountToken = store.createAccountToken(user.id, 'password-reset', expiresAt);
  const verificationToken = store.createAccountToken(user.id, 'email-verification', expiresAt);
  const sessionId = store.getSession(session).sessionId;
  store.saveOAuthState({ state: 'synthetic-oauth-state', userId: user.id, sessionId, provider: 'google', verifier: 'synthetic-verifier', expiresAt });
  for (const provider of ['google', 'outlook']) {
    store.saveConnection(user.id, provider, { accessToken: `synthetic-${provider}-token`, mappings: { preserved: true } });
    store.saveAutomation(user.id, provider, { enabled: provider === 'google', intervalMinutes: 15, status: provider === 'google' ? 'scheduled' : 'idle', nextRunAt: provider === 'google' ? 1 : null, lastRunAt: null, lastError: null, failureCount: 0 });
  }
  store.createShare(user.id, 'Preserved share one', calendar);
  store.createShare(user.id, 'Preserved share two', calendar);
  return { directory, source, target: join(directory, 'backup.sqlite'), encryptionKey, store, user, calendar, session, accountToken, verificationToken, sessionId };
}

function storedRows(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const present = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name));
    return Object.fromEntries(['users', 'calendars', 'connections', 'shares', 'sessions', 'oauth_states', 'account_tokens', 'integration_automations'].filter((table) => present.has(table)).map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  } finally { db.close(); }
}

test('backs up a live WAL database to an integrity-checked standalone file without altering the source', async (t) => {
  const { directory, source, target, db } = await fixture(t);
  assert.ok((await stat(source + '-wal')).size > 0);
  const result = await createDatabaseSnapshot({ source, target });
  assert.equal(result.mode, 'backup');
  assert.ok(result.bytes > 0);
  assert.deepEqual(contents(target), ['synthetic-sensitive-value']);
  assert.deepEqual(db.prepare('SELECT content FROM sample').get().content, 'synthetic-sensitive-value');
  assert.ok(!(await readdir(directory)).some((name) => name.startsWith('.shadow-snapshot-') || name.startsWith('backup.sqlite-')));
  if (process.platform !== 'win32') assert.equal((await stat(target)).mode & 0o777, 0o600);
});

test('never includes uncommitted writes from another live connection', async (t) => {
  const { source, target, db } = await fixture(t);
  db.exec('BEGIN; INSERT INTO sample(content) VALUES (\'not committed\');');
  try {
    await createDatabaseSnapshot({ source, target });
    assert.deepEqual(contents(target), ['synthetic-sensitive-value']);
  } finally { db.exec('ROLLBACK'); }
});

test('refuses existing targets and stale target sidecars without changing their contents', async (t) => {
  const { directory, source, target } = await fixture(t);
  await writeFile(target, 'existing target stays');
  await assert.rejects(createDatabaseSnapshot({ source, target }), { code: 'TARGET_EXISTS' });
  assert.equal(await readFile(target, 'utf8'), 'existing target stays');
  const second = join(directory, 'restore.sqlite');
  await writeFile(second + '-wal', 'existing WAL stays');
  await assert.rejects(createDatabaseSnapshot({ source, target: second }), { code: 'TARGET_EXISTS' });
  assert.equal(await readFile(second + '-wal', 'utf8'), 'existing WAL stays');
  await assert.rejects(stat(second), { code: 'ENOENT' });
});

test('atomically publishes only one complete target when two backups race for its filename', async (t) => {
  const { source, target, directory } = await fixture(t);
  const results = await Promise.allSettled([createDatabaseSnapshot({ source, target }), createDatabaseSnapshot({ source, target })]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(results.find((item) => item.status === 'rejected').reason.code, 'TARGET_EXISTS');
  assert.deepEqual(contents(target), ['synthetic-sensitive-value']);
  assert.ok(!(await readdir(directory)).some((name) => name.startsWith('.shadow-snapshot-')));
});

test('refuses source replacement, source sidecars, missing source, and corrupt databases', async (t) => {
  const { source, target, directory } = await fixture(t);
  for (const destination of [source, source + '-wal', source + '-shm', source + '-journal']) await assert.rejects(createDatabaseSnapshot({ source, target: destination }), { code: 'SNAPSHOT_ARGUMENTS' });
  await assert.rejects(createDatabaseSnapshot({ source: join(directory, 'missing.sqlite'), target }), { code: 'SNAPSHOT_FAILED' });
  const corrupt = join(directory, 'corrupt.sqlite');
  await writeFile(corrupt, 'not a SQLite database');
  await assert.rejects(createDatabaseSnapshot({ source: corrupt, target }), { code: 'SNAPSHOT_FAILED' });
  await assert.rejects(stat(target), { code: 'ENOENT' });
});

test('restores only into a new file after an explicit server-stopped acknowledgement', async (t) => {
  const { source, target, directory } = await fixture(t);
  await createDatabaseSnapshot({ source, target });
  const restored = join(directory, 'restored.sqlite');
  await assert.rejects(createDatabaseSnapshot({ source: target, target: restored, restore: true }), { code: 'RESTORE_CONFIRMATION' });
  const result = await createDatabaseSnapshot({ source: target, target: restored, restore: true, serverStopped: true });
  assert.equal(result.mode, 'restore');
  assert.deepEqual(contents(restored), contents(source));
  await assert.rejects(createDatabaseSnapshot({ source: target, target: source, restore: true, serverStopped: true }), { code: 'TARGET_EXISTS' });
});

test('restoration alone invalidates historical access and pauses automation while preserving real SHADOW data', async (t) => {
  const fixture = await securityFixture(t);
  const { source, target, directory, encryptionKey, store, user, calendar, session, accountToken, verificationToken, sessionId } = fixture;
  const original = storedRows(source);
  await createDatabaseSnapshot({ source, target });
  assert.deepEqual(storedRows(source), original);
  assert.deepEqual(storedRows(target), original);
  const originalBytes = await readFile(source);
  const backupBytes = await readFile(target);
  const restored = join(directory, 'restored.sqlite');
  await createDatabaseSnapshot({ source: target, target: restored, restore: true, serverStopped: true });
  assert.deepEqual(await readFile(source), originalBytes);
  assert.deepEqual(await readFile(target), backupBytes);
  assert.deepEqual(storedRows(source), original);
  assert.deepEqual(storedRows(target), original);
  const result = storedRows(restored);
  for (const table of ['users', 'calendars', 'connections']) assert.deepEqual(result[table], original[table]);
  for (const table of ['sessions', 'oauth_states', 'account_tokens']) assert.deepEqual(result[table], []);
  const withoutToken = ({ token, ...row }) => { assert.equal(typeof token, 'string'); return row; };
  assert.deepEqual(result.shares.map(withoutToken), original.shares.map(withoutToken));
  const previousTokens = new Set(original.shares.map((share) => share.token));
  assert.equal(new Set(result.shares.map((share) => share.token)).size, original.shares.length);
  for (const share of result.shares) { assert.match(share.token, /^[A-Za-z0-9_-]{43}$/); assert.ok(!previousTokens.has(share.token)); }
  for (let index = 0; index < result.integration_automations.length; index++) {
    const record = JSON.parse(result.integration_automations[index].record);
    assert.deepEqual(record, { ...JSON.parse(original.integration_automations[index].record), enabled: false, status: 'paused', nextRunAt: null, lastError: record.lastError });
    assert.match(record.lastError, /복원.*직접 다시 켜/);
  }
  const recovered = createDatabase({ dbPath: restored, encryptionKey });
  try {
    assert.equal(recovered.getSession(session), null);
    assert.equal(recovered.resetPassword(accountToken, 'must-not-apply'), null);
    assert.equal(recovered.verifyEmail(verificationToken), false);
    assert.equal(recovered.consumeOAuthState('synthetic-oauth-state', user.id, sessionId), null);
    assert.deepEqual(recovered.listEnabledAutomations(), []);
    assert.deepEqual(recovered.listDueAutomations(Date.now()), []);
    assert.deepEqual(recovered.getState(user.id), store.getState(user.id));
    assert.deepEqual(recovered.getConnection(user.id, 'google'), store.getConnection(user.id, 'google'));
    for (const token of previousTokens) assert.equal(recovered.getPublicShare(token), null);
    for (const share of recovered.listShares(user.id)) assert.deepEqual(recovered.getPublicShare(share.token), { title: share.title, state: calendar });
  } finally { recovered.close(); }
});

test('restores older schemas without newer tables while invalidating security records that do exist', async (t) => {
  const { source, target, directory } = await securityFixture(t);
  const editor = new DatabaseSync(source);
  try { editor.exec('DROP TABLE integration_automations; DROP TABLE account_tokens; DROP TABLE oauth_states;'); }
  finally { editor.close(); }
  const original = storedRows(source);
  await createDatabaseSnapshot({ source, target });
  const restored = join(directory, 'legacy-restored.sqlite');
  await createDatabaseSnapshot({ source: target, target: restored, restore: true, serverStopped: true });
  const result = storedRows(restored);
  assert.deepEqual(result.sessions, []);
  assert.deepEqual(result.users, original.users);
  assert.deepEqual(result.calendars, original.calendars);
  assert.equal(result.account_tokens, undefined);
  assert.equal(result.integration_automations, undefined);
  assert.equal(result.shares.length, original.shares.length);
  assert.ok(result.shares.every((share) => !original.shares.some((old) => old.token === share.token)));
  assert.deepEqual(storedRows(source), original);
});

test('malformed automation records fail restoration explicitly without publishing or altering the original backup', async (t) => {
  const { source, directory } = await securityFixture(t);
  for (const [index, malformed] of ['{', 'null', '{}', '{"enabled":"yes"}'].entries()) {
    const editor = new DatabaseSync(source);
    try { editor.prepare('UPDATE integration_automations SET record = ? WHERE provider = ?').run(malformed, 'outlook'); }
    finally { editor.close(); }
    const original = storedRows(source);
    const target = join(directory, `backup-${index}.sqlite`);
    const restored = join(directory, `rejected-${index}.sqlite`);
    await createDatabaseSnapshot({ source, target });
    const backupBytes = await readFile(target);
    await assert.rejects(createDatabaseSnapshot({ source: target, target: restored, restore: true, serverStopped: true }), (error) => error.code === 'RESTORE_AUTOMATION' && error.message.includes('invalid JSON or an unsupported schema'));
    await assert.rejects(stat(restored), { code: 'ENOENT' });
    assert.deepEqual(await readFile(target), backupBytes);
    assert.deepEqual(storedRows(target), original);
    assert.deepEqual(storedRows(source), original);
    assert.ok(!(await readdir(directory)).some((name) => name.startsWith('.shadow-snapshot-')));
  }
});

test('CLI requires explicit paths and reports only safe status, never database contents or secrets', async (t) => {
  const { source, target } = await fixture(t);
  const args = [resolve('scripts/backup.mjs'), '--source', source, '--target', target];
  const { stdout } = await promisify(execFile)(process.execPath, args, { env: { ...process.env, SHADOW_ENCRYPTION_KEY: 'synthetic-key-not-in-backup' } });
  assert.match(stdout, /integrity check passed/);
  assert.doesNotMatch(stdout, /synthetic-sensitive|synthetic-key/);
  assert.ok(!(await readFile(target)).includes(Buffer.from('synthetic-key-not-in-backup')));
  const restored = target + '.restored';
  const output = await promisify(execFile)(process.execPath, [resolve('scripts/backup.mjs'), '--restore', '--server-stopped', '--source', target, '--target', restored]);
  assert.match(output.stdout, /Historical access tokens invalidated; external automation disabled/);
  assert.doesNotMatch(output.stdout, /synthetic-sensitive|synthetic-key/);
  assert.deepEqual(parseSnapshotArguments(['--restore', '--server-stopped', '--source', 'a', '--target', 'b']), { restore: true, serverStopped: true, source: 'a', target: 'b' });
  for (const invalid of [[], ['--source', 'a'], ['--source', 'a', '--target', 'b', '--target', 'c'], ['--source', 'a', '--target', 'b', '--server-stopped'], ['--overwrite']]) assert.throws(() => parseSnapshotArguments(invalid), { code: 'SNAPSHOT_ARGUMENTS' });
});
