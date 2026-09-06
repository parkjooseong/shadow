import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../domain/types';
import { api, ApiError } from './api';
import { createInitialState } from './storage';
import { acknowledgePull, CLOUD_SYNC_KEY, decideSync, readSyncSettings, stateDigest, synchronizeCloud, validateCloud, type CloudSyncSettings } from './cloudSync';

beforeEach(() => { localStorage.clear(); vi.stubGlobal('crypto', webcrypto); });
afterEach(() => vi.unstubAllGlobals());
const changed = (name: string) => { const state = createInitialState(); state.eventTypes[0].name = name; return state; };
async function settings(state = createInitialState()): Promise<CloudSyncSettings> { return { version: 1, userId: 'owner', baseline: await stateDigest(state), revision: 1, paused: false, lastSyncedAt: null }; }
function transport(remote: AppState | null, revision = 1) {
  return vi.fn(async (path: string, method = 'GET') => {
    if (path === '/api/auth/me') return { user: { id: 'owner' } };
    if (path === '/api/state') return method === 'PUT' ? { revision: revision + 1 } : { state: remote, revision };
    throw new Error('Unexpected request');
  });
}
describe('automatic cloud reconciliation', () => {
  it.each([
    ['base', 'base', 'equal'], ['local', 'local', 'equal'],
    ['local', 'base', 'push'], ['base', 'remote', 'pull'],
    ['local', 'remote', 'conflict'], ['base', null, 'conflict'],
  ] as const)('decides %s vs %s without overwriting concurrent edits', (local, remote, expected) => { expect(decideSync(local, remote, 'base')).toBe(expected); });

  it('is disabled by default and validates persisted opt-in metadata', async () => {
    expect(readSyncSettings()).toBeNull();
    const value = await settings();
    localStorage.setItem(CLOUD_SYNC_KEY, JSON.stringify(value));
    expect(readSyncSettings()).toEqual(value);
    localStorage.setItem(CLOUD_SYNC_KEY, '{broken');
    expect(() => readSyncSettings()).toThrow();
    expect(localStorage.getItem(CLOUD_SYNC_KEY)).toBe('{broken');
    localStorage.setItem(CLOUD_SYNC_KEY, JSON.stringify({ ...value, revision: -1 }));
    expect(() => readSyncSettings()).toThrow();
  });
  it('rejects malformed remote data before applying it', () => {
    expect(() => validateCloud({ state: {} as AppState, revision: 1 })).toThrow();
    expect(() => validateCloud({ state: createInitialState(), revision: NaN })).toThrow();
  });
  it('binds both reads and writes to the opted-in account and uses compare-and-swap revisions', async () => {
    const local = changed('Local change');
    const request = transport(createInitialState(), 4);
    const applyRemote = vi.fn();
    const result = await synchronizeCloud({ settings: await settings(), local, isCurrent: () => true, applyRemote, request: request as typeof api });
    expect(request).toHaveBeenCalledWith('/api/state', 'GET', undefined, { accountId: 'owner' });
    expect(request).toHaveBeenCalledWith('/api/state', 'PUT', { state: local, revision: 4 }, { accountId: 'owner' });
    expect(result.settings.revision).toBe(5);
    expect(result.settings.baseline).toBe(await stateDigest(local));
    expect(applyRemote).not.toHaveBeenCalled();
  });
  it('pulls with an exact local-state precondition and waits for confirmed persistence before changing the baseline', async () => {
    const local = createInitialState(), remote = changed('Remote change');
    const previous = await settings();
    const request = transport(remote, 2);
    const applyRemote = vi.fn().mockReturnValue(true);
    const first = await synchronizeCloud({ settings: previous, local, isCurrent: () => true, applyRemote, request: request as typeof api });
    expect(applyRemote).toHaveBeenCalledWith(remote, local);
    expect(first.settings.baseline).toBe(previous.baseline);
    expect(first.settings.pendingPull).toEqual({ digest: await stateDigest(remote), revision: 2 });
    const confirmed = await synchronizeCloud({ settings: first.settings, local: remote, isCurrent: () => true, applyRemote, request: request as typeof api });
    expect(confirmed.settings.baseline).toBe(await stateDigest(remote));
    expect(request.mock.calls.some(([, method]) => method === 'PUT')).toBe(false);
  });
  it('never uploads an old state when a remote apply was rejected or locally edited', async () => {
    const previous = await settings(), remote = changed('Remote'), local = changed('New local');
    const request = transport(remote, 2);
    const applyRemote = vi.fn().mockReturnValue(false);
    const rejected = await synchronizeCloud({ settings: previous, local: createInitialState(), isCurrent: () => true, applyRemote, request: request as typeof api });
    expect(rejected.settings.baseline).toBe(previous.baseline);
    const result = await synchronizeCloud({ settings: rejected.settings, local, isCurrent: () => true, applyRemote, request: request as typeof api });
    expect(result.settings.paused).toBe(true);
    expect(request.mock.calls.some(([, method]) => method === 'PUT')).toBe(false);
  });
  it('acknowledges only the exact persisted pull so subsequent local or remote edits reconcile normally', async () => {
    const first = changed('First remote'), next = changed('Next edit');
    const original = await settings();
    const pending = { ...original, pendingPull: { digest: await stateDigest(first), revision: 2 } };
    expect(acknowledgePull(pending, original.baseline)).toBe(pending);
    const acknowledged = acknowledgePull(pending, await stateDigest(first));
    expect(acknowledged.pendingPull).toBeUndefined();
    expect(acknowledged.revision).toBe(2);
    const request = transport(next, 3), applyRemote = vi.fn().mockReturnValue(true);
    const pulled = await synchronizeCloud({ settings: acknowledged, local: first, isCurrent: () => true, applyRemote, request: request as typeof api });
    expect(pulled.settings.paused).toBe(false);
    expect(applyRemote).toHaveBeenCalledWith(next, first);
    expect(decideSync(await stateDigest(next), await stateDigest(first), acknowledged.baseline)).toBe('push');
  });
  it('does not send calendar data after logout or a session account change', async () => {
    const request = vi.fn(async () => ({ user: { id: 'different-account' } }));
    const result = await synchronizeCloud({ settings: await settings(), local: changed('Sensitive local'), isCurrent: () => true, applyRemote: vi.fn(), request: request as typeof api });
    expect(result.settings.paused).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('ignores stale in-flight reads when the user edits, closes the app or disables sync', async () => {
    const request = transport(changed('Remote'));
    const applyRemote = vi.fn();
    await synchronizeCloud({ settings: await settings(), local: createInitialState(), isCurrent: () => false, applyRemote, request: request as typeof api });
    expect(applyRemote).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([, method]) => method === 'PUT')).toBe(false);
  });
  it('surfaces stale server writes without blind retries', async () => {
    const request = transport(createInitialState());
    request.mockImplementation(async (path, method = 'GET') => {
      if (path === '/api/auth/me') return { user: { id: 'owner' } };
      if (method === 'PUT') throw new ApiError('Changed revision', 409);
      return { state: createInitialState(), revision: 1 };
    });
    await expect(synchronizeCloud({ settings: await settings(), local: changed('Local'), isCurrent: () => true, applyRemote: vi.fn(), request: request as typeof api })).rejects.toMatchObject({ status: 409 });
    expect(request.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(1);
  });
});
