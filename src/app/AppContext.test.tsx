import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarEvent } from '../domain/types';
import { createInitialState, STORAGE_KEY } from '../services/storage';
import { CLOUD_SYNC_KEY, CLOUD_SYNC_SETTINGS_EVENT } from '../services/cloudSync';
import { AppProvider, reducer, useApp } from './AppContext';
import { expandEvents } from '../domain/recurrence';
import { isAppState } from '../domain/validation';

const event: CalendarEvent = {
  id: 'event-1', title: '병원', typeId: 'hospital', date: '2026-09-07', startMinute: 900, endMinute: 960,
  shadow: { preparationMinutes: 20, outboundTravelMinutes: 40, returnTravelMinutes: 40, recoveryMinutes: 30 },
  cost: { transportWon: 4000, mealWon: 12000 }, createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z',
};

function Probe() {
  const { state, dispatch, resetData, storageError, storageBlocked, storagePending, reloadData, clearStorageError, retrySave, undo, redo, canUndo, canRedo } = useApp();
  return <>
    <output aria-label="event count">{state.events.length}</output>
    <output aria-label="blocked">{String(storageBlocked)}</output>
    <output aria-label="pending">{String(storagePending)}</output>
    <output aria-label="titles">{state.events.map((event) => event.title).join(',')}</output>
    {storageError && <p role="alert">{storageError}</p>}
    <button onClick={() => dispatch({ type: 'event/save', event })}>Save event</button>
    <button onClick={() => dispatch({ type: 'event/save', event: { ...event, startMinute: NaN } })}>Save invalid event</button>
    <button onClick={() => dispatch({ type: 'event/delete', id: event.id })}>Delete event</button>
    <button onClick={resetData}>Reset</button>
    <button onClick={clearStorageError}>Dismiss</button>
    <button onClick={retrySave}>Retry</button>
    <button onClick={reloadData}>Reload data</button>
    <button disabled={!canUndo} onClick={undo}>Undo</button>
    <button disabled={!canRedo} onClick={redo}>Redo</button>
  </>;
}

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function settled() {
  await waitFor(() => expect(screen.getByLabelText('pending')).toHaveTextContent('false'));
}

describe('provider storage recovery', () => {
  it('cancels a waiting save and clears pending when reloading corrupt external data', async () => {
    render(<AppProvider><Probe /></AppProvider>);
    await settled();
    let release!: () => void;
    const held = navigator.locks.request(STORAGE_KEY, { mode: 'exclusive' }, () => new Promise<void>((done) => { release = done; }));
    await Promise.resolve();
    try {
      fireEvent.click(screen.getByText('Save event'));
      expect(screen.getByLabelText('pending')).toHaveTextContent('true');
      localStorage.setItem(STORAGE_KEY, '{external corruption');
      fireEvent.click(screen.getByText('Reload data'));
      expect(screen.getByLabelText('pending')).toHaveTextContent('false');
      expect(screen.getByLabelText('blocked')).toHaveTextContent('true');
      expect(screen.getByLabelText('titles')).toHaveTextContent('병원');
    } finally { await act(async () => { release(); await held; }); }
    expect(localStorage.getItem(STORAGE_KEY)).toBe('{external corruption');
    expect(screen.getByLabelText('pending')).toHaveTextContent('false');
  });

  it('warns before unloading unsaved changes and stops warning after persistence', async () => {
    render(<AppProvider><Probe /></AppProvider>);
    await settled();
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full'); });
    fireEvent.click(screen.getByText('Save event'));
    await settled();
    const unsaved = new Event('beforeunload', { cancelable: true });
    fireEvent(window, unsaved);
    expect(unsaved.defaultPrevented).toBe(true);
    write.mockRestore();
    fireEvent.click(screen.getByText('Retry'));
    await settled();
    const saved = new Event('beforeunload', { cancelable: true });
    fireEvent(window, saved);
    expect(saved.defaultPrevented).toBe(false);
  });

  it('retains unsaved local changes and blocks stale writes even before a storage event arrives', async () => {
    render(<AppProvider><Probe /></AppProvider>);
    await settled();
    const remote = { ...createInitialState(), events: [{ ...event, id: 'other-tab', title: 'Other tab' }] };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(remote));
    fireEvent.click(screen.getByText('Save event'));
    await settled();
    expect(screen.getByRole('alert')).toHaveTextContent('다른 탭');
    expect(screen.getByLabelText('titles')).toHaveTextContent('병원');
    expect(screen.getByLabelText('blocked')).toHaveTextContent('true');
    expect(screen.getByText('Undo')).toBeDisabled();
    fireEvent.click(screen.getByText('Retry'));
    fireEvent.click(screen.getByText('Reset'));
    await settled();
    expect(loadStored()).toEqual(remote);
    fireEvent.click(screen.getByText('Reload data'));
    await settled();
    expect(screen.getByLabelText('titles')).toHaveTextContent('Other tab');
    expect(screen.getByLabelText('blocked')).toHaveTextContent('false');
    expect(screen.getByText('Undo')).toBeDisabled();
    fireEvent.click(screen.getByText('Save event'));
    await settled();
    expect(loadStored().events).toHaveLength(2);
  });

  it('detects external writes before editing and preserves memory when external data is corrupt', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...createInitialState(), events: [event] }));
    render(<AppProvider><Probe /></AppProvider>);
    await settled();
    localStorage.setItem(STORAGE_KEY, '{broken externally');
    fireEvent(window, new StorageEvent('storage', { key: STORAGE_KEY, newValue: '{broken externally' }));
    expect(screen.getByLabelText('blocked')).toHaveTextContent('true');
    fireEvent.click(screen.getByText('Reload data'));
    await settled();
    expect(screen.getByLabelText('titles')).toHaveTextContent('병원');
    expect(screen.getByRole('alert')).toHaveTextContent('손상');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('{broken externally');
  });
  it('never overwrites corrupt data on StrictMode mount, edits, or dismissal', () => {
    localStorage.setItem(STORAGE_KEY, '{broken');
    render(<StrictMode><AppProvider><Probe /></AppProvider></StrictMode>);
    expect(screen.getByLabelText('blocked')).toHaveTextContent('true');
    fireEvent.click(screen.getByText('Save event'));
    fireEvent.click(screen.getByText('Dismiss'));
    expect(screen.getByLabelText('event count')).toHaveTextContent('0');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('{broken');
    const unchanged = new Event('beforeunload', { cancelable: true });
    fireEvent(window, unchanged);
    expect(unchanged.defaultPrevented).toBe(false);
  });

  it('allows editing after an explicit successful reset', async () => {
    localStorage.setItem(STORAGE_KEY, '{broken');
    render(<AppProvider><Probe /></AppProvider>);
    fireEvent.click(screen.getByText('Reset'));
    await settled();
    expect(screen.getByLabelText('blocked')).toHaveTextContent('false');
    fireEvent.click(screen.getByText('Save event'));
    await settled();
    expect(screen.getByLabelText('event count')).toHaveTextContent('1');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).events).toHaveLength(1);
  });

  it('preserves existing state when reset is denied by the browser', async () => {
    const initial = { ...createInitialState(), events: [event] };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
    render(<AppProvider><Probe /></AppProvider>);
    await settled();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Unavailable', 'SecurityError'); });
    fireEvent.click(screen.getByText('Reset'));
    await settled();
    expect(screen.getByLabelText('event count')).toHaveTextContent('1');
    expect(screen.getByRole('alert')).toHaveTextContent('초기화하지 못했습니다');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(initial);
  });

  it('keeps memory changes and reports failed persistence, then clears the error after a successful save', async () => {
    render(<AppProvider><Probe /></AppProvider>);
    await settled();
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    fireEvent.click(screen.getByText('Save event'));
    await settled();
    expect(screen.getByLabelText('event count')).toHaveTextContent('1');
    expect(screen.getByRole('alert')).toHaveTextContent('저장하지 못했습니다');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).events).toHaveLength(0);
    fireEvent.click(screen.getByText('Dismiss'));
    expect(screen.getByRole('alert')).toHaveTextContent('저장하지 못했습니다');
    write.mockRestore();
    fireEvent.click(screen.getByText('Retry'));
    await settled();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).events).toHaveLength(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('rejects invalid events with an explicit message', async () => {
    render(<AppProvider><Probe /></AppProvider>);
    await settled();
    fireEvent.click(screen.getByText('Save invalid event'));
    expect(screen.getByLabelText('event count')).toHaveTextContent('0');
    expect(screen.getByRole('alert')).toHaveTextContent('시작과 종료 시간을 확인');
  });
});

function loadStored() { return JSON.parse(localStorage.getItem(STORAGE_KEY)!); }

describe('local-only reset stops automatic cloud synchronization', () => {
  const enabledSettings = JSON.stringify({ version: 1, userId: 'owner', baseline: 'a'.repeat(64), revision: 1, paused: false, lastSyncedAt: null });
  const initialState = () => ({ ...createInitialState(), events: [event] });
  async function mount(settings = enabledSettings) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(initialState()));
    localStorage.setItem(CLOUD_SYNC_KEY, settings);
    const result = render(<AppProvider><Probe /></AppProvider>);
    await settled();
    return result;
  }

  it('removes cloud opt-in and notifies the same tab before writing the empty calendar', async () => {
    await mount();
    const remove = vi.spyOn(Storage.prototype, 'removeItem');
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const notification = vi.spyOn(window, 'dispatchEvent');
    fireEvent.click(screen.getByText('Reset'));
    await settled();
    expect(remove).toHaveBeenCalledWith(CLOUD_SYNC_KEY);
    expect(notification).toHaveBeenCalledWith(expect.objectContaining({ type: CLOUD_SYNC_SETTINGS_EVENT }));
    expect(write).toHaveBeenCalledWith(STORAGE_KEY, JSON.stringify(createInitialState()));
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(notification.mock.invocationCallOrder[0]);
    expect(notification.mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0]);
    expect(localStorage.getItem(CLOUD_SYNC_KEY)).toBeNull();
    expect(loadStored().events).toEqual([]);
    expect(screen.getByLabelText('event count')).toHaveTextContent('0');
  });

  it('waits for the active cloud lock without removing settings or resetting local data early', async () => {
    await mount();
    let release!: () => void;
    const held = navigator.locks.request(CLOUD_SYNC_KEY, { mode: 'exclusive' }, () => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    try {
      fireEvent.click(screen.getByText('Reset'));
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByLabelText('pending')).toHaveTextContent('true');
      expect(screen.getByLabelText('event count')).toHaveTextContent('1');
      expect(loadStored()).toEqual(initialState());
      expect(localStorage.getItem(CLOUD_SYNC_KEY)).toBe(enabledSettings);
    } finally { await act(async () => { release(); await held; }); }
    await settled();
    expect(localStorage.getItem(CLOUD_SYNC_KEY)).toBeNull();
    expect(loadStored().events).toEqual([]);
  });

  it('preserves the calendar if removing cloud settings fails and permits a later retry', async () => {
    await mount();
    const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError'); });
    const write = vi.spyOn(Storage.prototype, 'setItem');
    fireEvent.click(screen.getByText('Reset'));
    await settled();
    expect(screen.getByRole('alert')).toHaveTextContent('자동 동기화를 안전하게 끄지 못해 초기화하지 않았습니다');
    expect(screen.getByLabelText('event count')).toHaveTextContent('1');
    expect(loadStored()).toEqual(initialState());
    expect(localStorage.getItem(CLOUD_SYNC_KEY)).toBe(enabledSettings);
    expect(write).not.toHaveBeenCalled();
    remove.mockRestore();
    fireEvent.click(screen.getByText('Reset'));
    await settled();
    expect(localStorage.getItem(CLOUD_SYNC_KEY)).toBeNull();
    expect(loadStored().events).toEqual([]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('preserves both values on cloud lock failure without poisoning the persistence queue', async () => {
    await mount();
    const lock = vi.spyOn(navigator.locks, 'request').mockRejectedValueOnce(new DOMException('Lock denied'));
    fireEvent.click(screen.getByText('Reset'));
    await settled();
    expect(screen.getByRole('alert')).toHaveTextContent('초기화하지 않았습니다');
    expect(loadStored()).toEqual(initialState());
    expect(localStorage.getItem(CLOUD_SYNC_KEY)).toBe(enabledSettings);
    lock.mockRestore();
    fireEvent.click(screen.getByText('Reset'));
    await settled();
    expect(loadStored().events).toEqual([]);
    expect(localStorage.getItem(CLOUD_SYNC_KEY)).toBeNull();
  });

  it('keeps automation disabled and preserves the calendar when the local reset write fails', async () => {
    await mount();
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Storage full'); });
    fireEvent.click(screen.getByText('Reset'));
    await settled();
    expect(localStorage.getItem(CLOUD_SYNC_KEY)).toBeNull();
    expect(loadStored()).toEqual(initialState());
    expect(screen.getByLabelText('event count')).toHaveTextContent('1');
    expect(screen.getByRole('alert')).toHaveTextContent('초기화하지 못했습니다');
    write.mockRestore();
  });

  it.each(['{broken settings', '{"version":99}'])('removes unreadable opt-in metadata only during explicit reset: %s', async (raw) => {
    await mount(raw);
    expect(localStorage.getItem(CLOUD_SYNC_KEY)).toBe(raw);
    fireEvent.click(screen.getByText('Reset'));
    await settled();
    expect(localStorage.getItem(CLOUD_SYNC_KEY)).toBeNull();
    expect(loadStored().events).toEqual([]);
  });

  it.each(['reload', 'unmount'])('does not change either stored value when waiting reset is cancelled by %s', async (cancel) => {
    const mounted = await mount();
    let release!: () => void;
    const held = navigator.locks.request(CLOUD_SYNC_KEY, { mode: 'exclusive' }, () => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    try {
      fireEvent.click(screen.getByText('Reset'));
      await act(async () => { await Promise.resolve(); });
      if (cancel === 'reload') fireEvent.click(screen.getByText('Reload data'));
      else mounted.unmount();
    } finally { await act(async () => { release(); await held; }); }
    if (cancel === 'reload') await settled();
    expect(localStorage.getItem(CLOUD_SYNC_KEY)).toBe(enabledSettings);
    expect(loadStored()).toEqual(initialState());
  });
});

describe('reducer invariants', () => {
  it('rejects a remote replacement whose expected local state has already changed', () => {
    const initial = createInitialState();
    const locallyChanged = reducer(initial, { type: 'event/save', event });
    const remote = createInitialState();
    expect(reducer(locallyChanged, { type: 'state/replace', state: remote, expectedState: initial })).toBe(locallyChanged);
    expect(reducer(initial, { type: 'state/replace', state: remote, expectedState: initial })).toBe(remote);
  });
  it('atomically detaches one occurrence, persists linkage and deletes the full series safely', () => {
    const master: CalendarEvent = { ...event, recurrence: { frequency: 'daily', interval: 1, until: '2026-09-09' } };
    const state = { ...createInitialState(), events: [master] };
    const occurrence = expandEvents([master], '2026-09-08', '2026-09-08')[0];
    const changed = reducer(state, { type: 'event/save', event: { ...occurrence, title: 'Changed occurrence' } });
    expect(isAppState(changed)).toBe(true);
    expect(changed.events[0].excludedDates).toEqual(['2026-09-08']);
    expect(expandEvents(changed.events, '2026-09-07', '2026-09-09')).toHaveLength(3);
    const deleted = reducer(changed, { type: 'event/delete', id: occurrence.id, sourceId: master.id, occurrenceDate: '2026-09-08' });
    expect(isAppState(deleted)).toBe(true);
    expect(expandEvents(deleted.events, '2026-09-07', '2026-09-09')).toHaveLength(2);
    expect(reducer(changed, { type: 'event/delete', id: master.id }).events).toEqual([]);
    const standalone = reducer(changed, { type: 'event/save', event: { ...master, recurrence: undefined, excludedDates: undefined } });
    expect(isAppState(standalone)).toBe(true);
    expect(standalone.events[1].sourceId).toBeUndefined();
  });

  it('persists undo/redo, clears redo after new edits and clears history on reset', async () => {
    render(<AppProvider><Probe /></AppProvider>);
    await settled();
    expect(screen.getByText('Undo')).toBeDisabled();
    fireEvent.click(screen.getByText('Save event'));
    await settled();
    fireEvent.click(screen.getByText('Undo'));
    await settled();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).events).toEqual([]);
    fireEvent.click(screen.getByText('Redo'));
    await settled();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).events).toHaveLength(1);
    fireEvent.click(screen.getByText('Undo'));
    fireEvent.click(screen.getByText('Save event'));
    await settled();
    expect(screen.getByText('Redo')).toBeDisabled();
    fireEvent.click(screen.getByText('Reset'));
    await settled();
    expect(screen.getByText('Undo')).toBeDisabled();
  });
  it('never deletes the last type or a type referenced by events', () => {
    const state = createInitialState();
    state.eventTypes = [state.eventTypes[1]];
    expect(reducer(state, { type: 'type/delete', id: 'hospital' })).toBe(state);
    const withEvents = { ...createInitialState(), events: [event] };
    expect(reducer(withEvents, { type: 'type/delete', id: 'hospital' })).toBe(withEvents);
  });

  it('rejects dangling event types and invalid type defaults', () => {
    const state = createInitialState();
    expect(reducer(state, { type: 'event/save', event: { ...event, typeId: 'missing' } })).toBe(state);
    expect(reducer(state, { type: 'type/save', eventType: { ...state.eventTypes[0], recoveryMinutes: -1 } })).toBe(state);
  });

  it('changes type defaults without modifying existing event snapshots', () => {
    const state = { ...createInitialState(), events: [event] };
    const changed = reducer(state, { type: 'type/save', eventType: { ...state.eventTypes[1], travelMinutes: 60 } });
    expect(changed.eventTypes[1].travelMinutes).toBe(60);
    expect(changed.events[0]).toEqual(event);
  });
});
