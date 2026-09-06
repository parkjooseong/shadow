import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from './database.mjs';
import { createIntegrationService } from './integrations/index.mjs';
import { IntegrationError } from './integrations/common.mjs';
import { createAutoSyncScheduler, defaultAutomation } from './auto-sync.mjs';

const MINUTE = 60_000;
const ENV = { SHADOW_PUBLIC_URL: 'http://localhost:5173', GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret', MICROSOFT_CLIENT_ID: 'test-client', MICROSOFT_CLIENT_SECRET: 'test-secret' };
const state = () => ({ schemaVersion: 1, preferences: { locale: 'ko-KR', timeZone: 'Asia/Seoul', currency: 'KRW', weekStartsOn: 1 }, eventTypes: [{ id: 'online', name: '온라인', color: '#4cbba5', preparationMinutes: 0, travelMinutes: 0, recoveryMinutes: 0, transportCostWon: 0, mealCostWon: 0 }], events: [] });

function setup(t, { adapterFactory, startAt = 2_000_000_000_000 } = {}) {
  const store = createDatabase({ dbPath: ':memory:', encryptionKey: Buffer.alloc(32, 5).toString('base64') });
  let time = startAt;
  const now = () => time;
  const user = store.createUser({ email: `${randomUUID()}@example.test`, name: 'Automation test', passwordHash: 'test-only' });
  store.saveState(user.id, state(), 0);
  const calls = [];
  const fallbackAdapter = ({ provider }) => ({
    async ensureCalendar() { calls.push(provider); },
    async list() { return { full: true, items: [] }; },
    async put() { assert.fail('Empty calendars must not export events'); },
    async remove() { assert.fail('Empty calendars must not delete events'); },
  });
  const options = { store, env: ENV, now, adapterFactory: adapterFactory ?? fallbackAdapter, fetchImpl: async () => assert.fail('Tests must never contact a provider') };
  const service = createIntegrationService(options);
  t.after(async () => { await service.stop(); store.close(); });
  const connect = (provider = 'google', userId = user.id) => store.saveConnection(userId, provider, { credentials: { accessToken: 'secret-not-for-status', refreshToken: 'secret-refresh', expiresAt: startAt + 1000 * MINUTE }, calendarId: 'test-calendar', cursor: null, mappings: {}, remoteCache: {}, conflicts: [] });
  const request = (method, path, body = {}, userId = user.id) => service.route({ method, path, body, userId, sessionId: 'test-session' });
  const enable = (provider = 'google', intervalMinutes = 5) => request('PUT', `/api/integrations/${provider}/automation`, { enabled: true, intervalMinutes });
  const get = (provider = 'google') => store.getAutomation(user.id, provider);
  return { store, service, options, calls, connect, request, enable, get, userId: user.id, now, advance: (ms) => { time += ms; } };
}

function memoryStore(initial = []) {
  const rows = new Map(initial.map((row) => [`${row.userId}:${row.provider}`, structuredClone(row)]));
  return {
    getAutomation(userId, provider) {
      const row = rows.get(`${userId}:${provider}`);
      if (!row) return null;
      const value = structuredClone(row); delete value.userId; delete value.provider; return value;
    },
    saveAutomation(userId, provider, record) { rows.set(`${userId}:${provider}`, { ...structuredClone(record), userId, provider }); },
    listEnabledAutomations() { return [...rows.values()].filter((row) => row.enabled).map((row) => structuredClone(row)); },
    listDueAutomations(now) { return this.listEnabledAutomations().filter((row) => ['scheduled', 'backoff'].includes(row.status) && row.nextRunAt !== null && row.nextRunAt <= now); },
  };
}

const enabled = (overrides = {}) => ({ ...defaultAutomation(), userId: 'user', provider: 'google', enabled: true, status: 'scheduled', nextRunAt: 0, ...overrides });

test('automation defaults off and status never exposes provider credentials', async (t) => {
  const ctx = setup(t); ctx.connect();
  assert.deepEqual((await ctx.request('GET', '/api/integrations/google/automation')).body.automation, defaultAutomation());
  ctx.advance(120 * MINUTE);
  assert.deepEqual(await ctx.service.tick(), { runs: 0 });
  assert.equal(ctx.calls.length, 0);
  const listed = await ctx.request('GET', '/api/integrations');
  assert.equal(listed.body.providers[0].automation.enabled, false);
  assert.ok(!JSON.stringify(listed).includes('secret-not-for-status'));
});

test('settings require an owned connection, authentication and an allowed interval', async (t) => {
  const ctx = setup(t);
  assert.equal((await ctx.enable()).status, 409);
  ctx.connect();
  for (const intervalMinutes of [0, 1, 4, 6, 61, '5']) assert.equal((await ctx.request('PUT', '/api/integrations/google/automation', { enabled: true, intervalMinutes })).status, 400);
  assert.equal((await ctx.request('PUT', '/api/integrations/google/automation', { enabled: 'true', intervalMinutes: 5 })).status, 400);
  assert.equal((await ctx.service.route({ method: 'GET', path: '/api/integrations/google/automation' })).status, 401);
  assert.equal((await ctx.enable()).status, 200);
  const other = ctx.store.createUser({ email: `${randomUUID()}@example.test`, name: 'Other', passwordHash: 'test-only' });
  const read = await ctx.request('GET', '/api/integrations/google/automation', {}, other.id);
  assert.equal(read.body.automation.enabled, false);
  assert.equal((await ctx.request('PUT', '/api/integrations/google/automation', { enabled: false, intervalMinutes: 5 }, other.id)).status, 409);
  assert.equal(ctx.get().enabled, true);
});

test('opt-in schedules durable runs at the chosen interval and performs one overdue catch-up', async (t) => {
  const ctx = setup(t); ctx.connect();
  const startedAt = ctx.now();
  assert.equal((await ctx.enable('google', 15)).body.automation.nextRunAt, startedAt + 15 * MINUTE);
  await ctx.service.tick(); assert.equal(ctx.calls.length, 0);
  ctx.advance(15 * MINUTE);
  assert.deepEqual(await ctx.service.tick(), { runs: 1 });
  assert.equal(ctx.calls.length, 1);
  assert.deepEqual(ctx.get(), { enabled: true, intervalMinutes: 15, status: 'scheduled', nextRunAt: ctx.now() + 15 * MINUTE, lastRunAt: ctx.now(), lastError: null, failureCount: 0 });
  const restarted = createIntegrationService(ctx.options);
  t.after(() => restarted.stop());
  ctx.advance(90 * MINUTE);
  assert.deepEqual(await restarted.tick(), { runs: 1 });
  assert.deepEqual(await restarted.tick(), { runs: 0 });
  assert.equal(ctx.calls.length, 2);
  assert.equal((await ctx.request('DELETE', '/api/integrations/google')).status, 200);
  assert.equal(ctx.get(), null, 'Disconnect must cascade to the automation row');
});

test('disabling a running automation remains disabled after the authorized request finishes', async (t) => {
  let release, began;
  const started = new Promise((resolve) => { began = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const ctx = setup(t, { adapterFactory: () => ({ async ensureCalendar() { began(); await held; }, async list() { return { full: true, items: [] }; } }) });
  ctx.connect(); await ctx.enable(); ctx.advance(5 * MINUTE);
  const running = ctx.service.tick(); await started;
  assert.equal(ctx.get().status, 'running');
  const disabled = await ctx.request('PUT', '/api/integrations/google/automation', { enabled: false, intervalMinutes: 5 });
  assert.equal(disabled.status, 200); assert.equal(disabled.body.automation.enabled, false);
  release(); await running;
  assert.equal(ctx.get().enabled, false); assert.equal(ctx.get().nextRunAt, null);
  ctx.advance(60 * MINUTE); assert.deepEqual(await ctx.service.tick(), { runs: 0 });
});

test('scheduled providers and manual routes share the same per-user exclusion', async (t) => {
  let release, began, active = 0, maxActive = 0;
  const started = new Promise((resolve) => { began = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const ctx = setup(t, { adapterFactory: ({ provider }) => ({
    async ensureCalendar() { active++; maxActive = Math.max(maxActive, active); calls.push(provider); if (provider === 'google') { began(); await held; } },
    async list() { active--; return { full: true, items: [] }; },
  }) });
  ctx.connect(); ctx.connect('microsoft'); await ctx.enable(); await ctx.enable('microsoft'); ctx.advance(5 * MINUTE);
  const running = ctx.service.tick(); await started;
  const duplicateTick = ctx.service.tick();
  assert.equal((await ctx.request('POST', '/api/integrations/microsoft/sync')).body.code, 'sync_in_progress');
  release(); await Promise.all([running, duplicateTick]);
  assert.deepEqual(calls, ['google', 'microsoft']); assert.equal(maxActive, 1);
});

test('a manual run defers due automation without backoff or parallel provider requests', async (t) => {
  let release, began, calls = 0;
  const started = new Promise((resolve) => { began = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const ctx = setup(t, { adapterFactory: () => ({ async ensureCalendar() { calls++; began(); await held; }, async list() { return { full: true, items: [] }; } }) });
  ctx.connect(); await ctx.enable(); ctx.advance(5 * MINUTE);
  const manual = ctx.request('POST', '/api/integrations/google/sync'); await started;
  assert.deepEqual(await ctx.service.tick(), { runs: 0 });
  assert.equal(ctx.get().failureCount, 0); assert.equal(ctx.get().status, 'scheduled');
  release(); assert.equal((await manual).status, 200);
  assert.equal(calls, 1); assert.equal(ctx.get().nextRunAt, ctx.now() + 5 * MINUTE);
});

test('authentication failure pauses automatic requests until the user explicitly resumes', async (t) => {
  let calls = 0;
  const ctx = setup(t, { adapterFactory: () => ({ async ensureCalendar() { calls++; throw new IntegrationError('provider_auth', 'secret-provider-payload', 401); } }) });
  ctx.connect(); await ctx.enable(); ctx.advance(5 * MINUTE); await ctx.service.tick();
  assert.equal(ctx.get().status, 'paused'); assert.equal(ctx.get().nextRunAt, null);
  assert.ok(ctx.get().lastError.includes('인증')); assert.ok(!JSON.stringify(ctx.get()).includes('secret-provider-payload'));
  ctx.advance(120 * MINUTE); await ctx.service.tick(); assert.equal(calls, 1);
  assert.equal((await ctx.enable()).status, 200); assert.equal(ctx.get().status, 'scheduled');
});

test('existing conflicts pause before provider calls and cannot be re-enabled until resolved', async (t) => {
  const ctx = setup(t); ctx.connect(); await ctx.enable();
  const connection = ctx.store.getConnection(ctx.userId, 'google');
  connection.conflicts = [{ id: 'conflict', eventId: 'event', title: 'Private title', reason: 'Both changed' }];
  ctx.store.saveConnection(ctx.userId, 'google', connection);
  ctx.advance(5 * MINUTE); await ctx.service.tick();
  assert.equal(ctx.calls.length, 0); assert.equal(ctx.get().status, 'paused');
  assert.equal((await ctx.enable()).body.code, 'automation_conflict');
  assert.ok(!JSON.stringify(ctx.get()).includes('Private title'));
});

test('unsupported provider items retain original data and surface a safe warning', async (t) => {
  const remote = { id: 'unsupported', unsupported: true, warning: 'Unsupported recurrence', etag: 'version' };
  const ctx = setup(t, { adapterFactory: () => ({ async ensureCalendar() {}, async list() { return { full: true, items: [remote] }; } }) });
  ctx.connect(); await ctx.enable(); ctx.advance(5 * MINUTE); await ctx.service.tick();
  assert.equal(ctx.get().status, 'scheduled'); assert.ok(ctx.get().lastError.includes('원본을 보존'));
  assert.deepEqual(ctx.store.getState(ctx.userId).state, state());
  assert.deepEqual(ctx.store.getConnection(ctx.userId, 'google').remoteCache.unsupported, remote);
});

test('encrypted connection recovery does not hide automation metadata or prevent disabling', async (t) => {
  const ctx = setup(t); ctx.connect(); await ctx.enable();
  const damaged = createIntegrationService({ ...ctx.options, store: { ...ctx.store, getConnection() { throw new Error('encrypted-sensitive-content'); } } });
  t.after(() => damaged.stop());
  const request = (method, body) => damaged.route({ method, path: '/api/integrations/google/automation', body, userId: ctx.userId, sessionId: 'test-session' });
  assert.equal((await request('GET')).body.automation.enabled, true);
  ctx.advance(5 * MINUTE); await damaged.tick();
  assert.equal(ctx.get().status, 'paused'); assert.ok(ctx.get().lastError.includes('연결 정보를 읽지 못해'));
  assert.ok(!JSON.stringify(ctx.get()).includes('encrypted-sensitive-content'));
  assert.equal((await request('PUT', { enabled: false, intervalMinutes: 15 })).status, 200);
  assert.equal(ctx.get().enabled, false);
});

test('temporary errors back off exponentially up to one hour and successful runs recover', async () => {
  let time = 0, fail = true;
  const store = memoryStore([enabled({ intervalMinutes: 5 })]);
  const scheduler = createAutoSyncScheduler({ store, now: () => time, run: async () => {
    if (fail) throw new IntegrationError('provider_rate_limit', 'private-provider-body', 429);
    return { conflicts: [], warnings: [] };
  } });
  for (const delay of [10, 20, 40, 60, 60]) {
    await scheduler.tick();
    const row = scheduler.get('user', 'google');
    assert.equal(row.status, 'backoff'); assert.equal(row.nextRunAt, time + delay * MINUTE);
    assert.ok(!row.lastError.includes('private-provider-body'));
    time = row.nextRunAt;
  }
  fail = false; await scheduler.tick();
  assert.equal(scheduler.get('user', 'google').status, 'scheduled');
  assert.equal(scheduler.get('user', 'google').failureCount, 0);
  await scheduler.stop();
});

test('new conflicts pause automation and a manual success does not implicitly resume it', async () => {
  const store = memoryStore([enabled()]);
  const scheduler = createAutoSyncScheduler({ store, now: () => 0, run: async () => ({ conflicts: [{ id: 'conflict', title: 'private-calendar-title' }] }) });
  await scheduler.tick();
  assert.equal(scheduler.get('user', 'google').status, 'paused');
  assert.ok(!scheduler.get('user', 'google').lastError.includes('private-calendar-title'));
  scheduler.record('user', 'google', { result: { conflicts: [] }, manual: true });
  assert.equal(scheduler.get('user', 'google').status, 'paused');
  scheduler.configure('user', 'google', { enabled: true, intervalMinutes: 60 });
  assert.equal(scheduler.get('user', 'google').status, 'scheduled');
  await scheduler.stop();
});

test('startup preserves opt-outs and pauses, recovers interrupted runs, and unreferences its timer', async () => {
  const store = memoryStore([
    enabled({ status: 'running', nextRunAt: null }),
    enabled({ provider: 'microsoft', status: 'paused', nextRunAt: null }),
    { ...defaultAutomation(), userId: 'user', provider: 'apple' },
  ]);
  let unref = 0, cleared = 0, calls = 0;
  const timer = { unref() { unref++; } };
  const scheduler = createAutoSyncScheduler({ store, now: () => 100, run: async () => { calls++; }, setIntervalImpl: () => timer, clearIntervalImpl: (value) => { assert.equal(value, timer); cleared++; } });
  scheduler.start(); scheduler.start(); await scheduler.tick();
  assert.equal(unref, 1); assert.equal(scheduler.status().running, true); assert.equal(calls, 0);
  assert.equal(scheduler.get('user', 'google').status, 'backoff'); assert.equal(scheduler.get('user', 'google').nextRunAt, 100 + 5 * MINUTE);
  assert.equal(scheduler.get('user', 'microsoft').status, 'paused'); assert.equal(scheduler.get('user', 'apple').enabled, false);
  await scheduler.stop(); assert.equal(cleared, 1); assert.equal(scheduler.status().running, false);
});

test('shutdown waits for the active run and does not start remaining due providers', async () => {
  const store = memoryStore([enabled(), enabled({ provider: 'microsoft' })]);
  let release, began, calls = 0, finishedStop = false;
  const started = new Promise((resolve) => { began = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const scheduler = createAutoSyncScheduler({ store, now: () => 0, run: async () => { calls++; began(); await held; return { conflicts: [] }; } });
  const ticking = scheduler.tick(); await started;
  const stopping = scheduler.stop().then(() => { finishedStop = true; });
  await Promise.resolve(); assert.equal(finishedStop, false);
  release(); await Promise.all([ticking, stopping]);
  assert.equal(calls, 1); assert.equal(finishedStop, true);
  assert.deepEqual(await scheduler.tick(), { runs: 0 });
});

test('a failed outcome write is retried without repeating successful provider mutations', async () => {
  const store = memoryStore([enabled()]);
  const originalSave = store.saveAutomation;
  let failWrite = false, calls = 0;
  store.saveAutomation = (...args) => { if (failWrite) throw new Error('private-database-failure'); return originalSave(...args); };
  const scheduler = createAutoSyncScheduler({ store, now: () => 0, run: async () => { calls++; failWrite = true; return { conflicts: [] }; } });
  assert.ok((await scheduler.tick()).error.includes('저장하지 못했습니다'));
  assert.equal(scheduler.get('user', 'google').status, 'running');
  failWrite = false;
  assert.deepEqual(await scheduler.tick(), { runs: 0 });
  assert.equal(calls, 1); assert.equal(scheduler.get('user', 'google').status, 'scheduled');
  assert.equal(scheduler.status().error, null);
  await scheduler.stop();
});

test('polling batches are bounded and oldest due records run first', async () => {
  const rows = Array.from({ length: 21 }, (_, index) => enabled({ userId: `user-${index}`, nextRunAt: 20 - index }));
  const store = memoryStore(rows), calls = [];
  const scheduler = createAutoSyncScheduler({ store, now: () => 100, run: async (userId) => { calls.push(userId); return { conflicts: [] }; } });
  assert.deepEqual(await scheduler.tick(), { runs: 20 });
  assert.equal(calls[0], 'user-20');
  assert.deepEqual(await scheduler.tick(), { runs: 1 });
  assert.equal(calls.at(-1), 'user-0');
  await scheduler.stop();
});
