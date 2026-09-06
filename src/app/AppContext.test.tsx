import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarEvent } from '../domain/types';
import { createInitialState, STORAGE_KEY } from '../services/storage';
import { AppProvider, reducer, useApp } from './AppContext';

const event: CalendarEvent = {
  id: 'event-1', title: '병원', typeId: 'hospital', date: '2026-09-07', startMinute: 900, endMinute: 960,
  shadow: { preparationMinutes: 20, outboundTravelMinutes: 40, returnTravelMinutes: 40, recoveryMinutes: 30 },
  cost: { transportWon: 4000, mealWon: 12000 }, createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z',
};

function Probe() {
  const { state, dispatch, resetData, storageError, storageBlocked, clearStorageError, retrySave } = useApp();
  return <>
    <output aria-label="event count">{state.events.length}</output>
    <output aria-label="blocked">{String(storageBlocked)}</output>
    {storageError && <p role="alert">{storageError}</p>}
    <button onClick={() => dispatch({ type: 'event/save', event })}>Save event</button>
    <button onClick={() => dispatch({ type: 'event/save', event: { ...event, startMinute: NaN } })}>Save invalid event</button>
    <button onClick={() => dispatch({ type: 'event/delete', id: event.id })}>Delete event</button>
    <button onClick={resetData}>Reset</button>
    <button onClick={clearStorageError}>Dismiss</button>
    <button onClick={retrySave}>Retry</button>
  </>;
}

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('provider storage recovery', () => {
  it('never overwrites corrupt data on StrictMode mount, edits, or dismissal', () => {
    localStorage.setItem(STORAGE_KEY, '{broken');
    render(<StrictMode><AppProvider><Probe /></AppProvider></StrictMode>);
    expect(screen.getByLabelText('blocked')).toHaveTextContent('true');
    fireEvent.click(screen.getByText('Save event'));
    fireEvent.click(screen.getByText('Dismiss'));
    expect(screen.getByLabelText('event count')).toHaveTextContent('0');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('{broken');
  });

  it('allows editing after an explicit successful reset', () => {
    localStorage.setItem(STORAGE_KEY, '{broken');
    render(<AppProvider><Probe /></AppProvider>);
    fireEvent.click(screen.getByText('Reset'));
    expect(screen.getByLabelText('blocked')).toHaveTextContent('false');
    fireEvent.click(screen.getByText('Save event'));
    expect(screen.getByLabelText('event count')).toHaveTextContent('1');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).events).toHaveLength(1);
  });

  it('preserves existing state when reset is denied by the browser', () => {
    const initial = { ...createInitialState(), events: [event] };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
    render(<AppProvider><Probe /></AppProvider>);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new DOMException('Unavailable', 'SecurityError'); });
    fireEvent.click(screen.getByText('Reset'));
    expect(screen.getByLabelText('event count')).toHaveTextContent('1');
    expect(screen.getByRole('alert')).toHaveTextContent('초기화하지 못했습니다');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(initial);
  });

  it('keeps memory changes and reports failed persistence, then clears the error after a successful save', () => {
    render(<AppProvider><Probe /></AppProvider>);
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    fireEvent.click(screen.getByText('Save event'));
    expect(screen.getByLabelText('event count')).toHaveTextContent('1');
    expect(screen.getByRole('alert')).toHaveTextContent('저장하지 못했습니다');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).events).toHaveLength(0);
    fireEvent.click(screen.getByText('Dismiss'));
    expect(screen.getByRole('alert')).toHaveTextContent('저장하지 못했습니다');
    write.mockRestore();
    fireEvent.click(screen.getByText('Retry'));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).events).toHaveLength(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('rejects invalid events with an explicit message', () => {
    render(<AppProvider><Probe /></AppProvider>);
    fireEvent.click(screen.getByText('Save invalid event'));
    expect(screen.getByLabelText('event count')).toHaveTextContent('0');
    expect(screen.getByRole('alert')).toHaveTextContent('시작과 종료 시간을 확인');
  });
});

describe('reducer invariants', () => {
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
