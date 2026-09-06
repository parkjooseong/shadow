import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarEvent } from '../domain/types';
import { createInitialState, STORAGE_KEY } from '../services/storage';
import { AppProvider, reducer, useApp } from './AppContext';
import { expandEvents } from '../domain/recurrence';
import { isAppState } from '../domain/validation';

const event: CalendarEvent = {
  id: 'event-1', title: '병원', typeId: 'hospital', date: '2026-09-07', startMinute: 900, endMinute: 960,
  shadow: { preparationMinutes: 20, outboundTravelMinutes: 40, returnTravelMinutes: 40, recoveryMinutes: 30 },
  cost: { transportWon: 4000, mealWon: 12000 }, createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z',
};

function Probe() {
  const { state, dispatch, resetData, storageError, storageBlocked, clearStorageError, retrySave, undo, redo, canUndo, canRedo } = useApp();
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
    <button disabled={!canUndo} onClick={undo}>Undo</button>
    <button disabled={!canRedo} onClick={redo}>Redo</button>
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

  it('persists undo/redo, clears redo after new edits and clears history on reset', () => {
    render(<AppProvider><Probe /></AppProvider>);
    expect(screen.getByText('Undo')).toBeDisabled();
    fireEvent.click(screen.getByText('Save event'));
    fireEvent.click(screen.getByText('Undo'));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).events).toEqual([]);
    fireEvent.click(screen.getByText('Redo'));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).events).toHaveLength(1);
    fireEvent.click(screen.getByText('Undo'));
    fireEvent.click(screen.getByText('Save event'));
    expect(screen.getByText('Redo')).toBeDisabled();
    fireEvent.click(screen.getByText('Reset'));
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
