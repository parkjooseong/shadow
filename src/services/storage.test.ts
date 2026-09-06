import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, CalendarEvent } from '../domain/types';
import { createInitialState, loadState, resetStoredState, saveState, STORAGE_KEY } from './storage';

function makeState(): AppState {
  const event: CalendarEvent = {
    id: 'event-1', title: '병원', typeId: 'hospital', date: '2026-09-07', startMinute: 900, endMinute: 960,
    shadow: { preparationMinutes: 20, outboundTravelMinutes: 40, returnTravelMinutes: 40, recoveryMinutes: 30 },
    cost: { transportWon: 4000, mealWon: 12000 }, createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z',
  };
  return { ...createInitialState(), events: [event] };
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('storage data validation', () => {
  it('loads a fresh state only when no stored value exists', () => {
    expect(loadState()).toMatchObject({ blocked: false, state: { events: [], eventTypes: expect.any(Array) } });
    localStorage.setItem(STORAGE_KEY, '');
    expect(loadState().blocked).toBe(true);
  });

  it('round-trips valid events without changing saved snapshots', () => {
    const state = makeState();
    expect(saveState(state)).toBeUndefined();
    expect(loadState()).toEqual({ state, snapshot: JSON.stringify(state), blocked: false });
  });

  it.each(['{broken', 'null', '{"schemaVersion":2,"events":[],"eventTypes":[]}'])('preserves unreadable data: %s', (raw) => {
    localStorage.setItem(STORAGE_KEY, raw);
    expect(loadState()).toMatchObject({ blocked: true, error: expect.any(String) });
    expect(localStorage.getItem(STORAGE_KEY)).toBe(raw);
  });

  it.each([
    ['missing nested fields', (state: AppState) => { Reflect.deleteProperty(state.events[0], 'shadow'); }],
    ['invalid actual date', (state: AppState) => { state.events[0].date = '2026-02-30'; }],
    ['missing date', (state: AppState) => { state.events[0].date = ''; }],
    ['end before start', (state: AppState) => { state.events[0].endMinute = 899; }],
    ['fractional minutes', (state: AppState) => { state.events[0].startMinute = 900.5; }],
    ['negative cost', (state: AppState) => { state.events[0].cost.transportWon = -1; }],
    ['excessive shadow', (state: AppState) => { state.events[0].shadow.preparationMinutes = 721; }],
    ['dangling type reference', (state: AppState) => { state.events[0].typeId = 'deleted'; }],
    ['duplicate event ids', (state: AppState) => { state.events.push({ ...state.events[0] }); }],
    ['duplicate type ids', (state: AppState) => { state.eventTypes.push({ ...state.eventTypes[0] }); }],
    ['invalid type color', (state: AppState) => { state.eventTypes[0].color = 'not-a-color'; }],
    ['no event types', (state: AppState) => { state.eventTypes = []; }],
    ['missing preferences', (state: AppState) => { Reflect.deleteProperty(state, 'preferences'); }],
  ])('rejects %s and leaves raw storage intact', (_, mutate) => {
    const state = makeState();
    mutate(state);
    const raw = JSON.stringify(state);
    localStorage.setItem(STORAGE_KEY, raw);
    expect(loadState().blocked).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(raw);
  });

  it('rejects non-finite runtime values before overwriting a valid stored state', () => {
    const state = makeState();
    saveState(state);
    const raw = localStorage.getItem(STORAGE_KEY);
    state.events[0].shadow.recoveryMinutes = Infinity;
    expect(saveState(state)).toBeDefined();
    expect(localStorage.getItem(STORAGE_KEY)).toBe(raw);
  });

  it('handles storage read, write, and reset exceptions without throwing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Unavailable', 'SecurityError'); });
    expect(loadState().blocked).toBe(true);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    expect(saveState(makeState())).toBeDefined();
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new DOMException('Unavailable', 'SecurityError'); });
    expect(resetStoredState()).toBeDefined();
  });

  it('resets only SHADOW data and isolates default objects between initializations', () => {
    localStorage.setItem('unrelated-app', 'keep');
    saveState(makeState());
    expect(resetStoredState()).toBeUndefined();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem('unrelated-app')).toBe('keep');
    const initial = createInitialState();
    initial.eventTypes[0].name = 'changed';
    expect(createInitialState().eventTypes[0].name).toBe('학교 수업');
  });
});
