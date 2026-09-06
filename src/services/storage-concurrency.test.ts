import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commitStoredState, createInitialState, loadState, STORAGE_KEY } from './storage';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());
const changedState = (name: string) => {
  const state = createInitialState();
  state.eventTypes[0].name = name;
  return state;
};

describe('cross-tab guarded storage', () => {
  it('serializes simultaneous writes and rejects the stale second snapshot', async () => {
    const first = changedState('Tab A'), second = changedState('Tab B');
    const results = await Promise.all([commitStoredState(first, null), commitStoredState(second, null)]);
    expect(results.map((result) => result.status)).toEqual(['saved', 'conflict']);
    expect(loadState().state).toEqual(first);
    expect((await commitStoredState(second, loadState().snapshot)).status).toBe('saved');
    expect(loadState().state).toEqual(second);
  });

  it('does not overwrite externally corrupted or cleared data', async () => {
    const state = createInitialState();
    const raw = JSON.stringify(state);
    localStorage.setItem(STORAGE_KEY, '{corrupt');
    expect((await commitStoredState(state, raw)).status).toBe('conflict');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('{corrupt');
    localStorage.removeItem(STORAGE_KEY);
    expect((await commitStoredState(state, raw)).status).toBe('conflict');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('accepts identical initial states without rewriting them', async () => {
    const state = createInitialState();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    const write = vi.spyOn(Storage.prototype, 'setItem');
    expect((await commitStoredState(state, null)).status).toBe('saved');
    expect(write).not.toHaveBeenCalled();
  });

  it('rechecks cancellation inside the acquired lock before touching storage', async () => {
    let resolve!: () => void;
    const held = navigator.locks.request(STORAGE_KEY, { mode: 'exclusive' }, () => new Promise<void>((done) => { resolve = done; }));
    await Promise.resolve();
    let current = true;
    const write = commitStoredState(changedState('Cancelled'), null, () => current);
    current = false;
    resolve();
    await held;
    expect((await write).status).toBe('cancelled');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('surfaces lock errors without falling back to an unlocked write', async () => {
    vi.spyOn(navigator.locks, 'request').mockRejectedValue(new DOMException('Denied'));
    expect((await commitStoredState(createInitialState(), null)).status).toBe('error');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('is read-only when Web Locks are unavailable', async () => {
    const locks = navigator.locks;
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    try {
      expect((await commitStoredState(createInitialState(), null)).status).toBe('unsupported');
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    } finally { Object.defineProperty(navigator, 'locks', { configurable: true, value: locks }); }
  });
});
