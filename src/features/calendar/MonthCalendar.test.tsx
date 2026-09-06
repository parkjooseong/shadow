import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../../services/storage';
import type { CalendarEvent } from '../../domain/types';
import { monthDates, MonthCalendar, shiftMonth } from './MonthCalendar';

const eventTypes = createInitialState().eventTypes;
function appointment(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id: 'event', title: '병원', typeId: 'hospital', date: '2026-09-07', startMinute: 900, endMinute: 960, shadow: { preparationMinutes: 0, outboundTravelMinutes: 0, returnTravelMinutes: 0, recoveryMinutes: 0 }, cost: { transportWon: 0, mealWon: 0 }, createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z', ...overrides };
}

afterEach(cleanup);

describe('month calendar', () => {
  it('shows six complete Monday-first weeks, including neighboring months', () => {
    const days = monthDates('2026-09-17');
    expect(days).toHaveLength(42);
    expect(new Set(days).size).toBe(42);
    expect(days[0]).toBe('2026-08-31');
    expect(days.at(-1)).toBe('2026-10-11');
    render(<MonthCalendar date="2026-09-17" events={[]} eventTypes={eventTypes} onSelect={vi.fn()} onDay={vi.fn()} />);
    expect(screen.getAllByRole('button')).toHaveLength(42);
    expect(screen.getByRole('button', { name: '8. 31. 월요일' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '10. 11. 일요일' })).toBeInTheDocument();
  });

  it('navigates by whole months without overflowing a month-end date', () => {
    expect(shiftMonth('2026-01-31', 1)).toBe('2026-02-01');
    expect(shiftMonth('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftMonth('2026-01-31', -1)).toBe('2025-12-01');
  });

  it('sends the exact clicked date and event to their separate handlers', () => {
    const event = appointment();
    const onDay = vi.fn();
    const onSelect = vi.fn();
    render(<MonthCalendar date="2026-09-17" events={[event]} eventTypes={eventTypes} onSelect={onSelect} onDay={onDay} />);
    fireEvent.click(screen.getByRole('button', { name: '9. 7. 월요일' }));
    expect(onDay).toHaveBeenCalledExactlyOnceWith('2026-09-07');
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '병원' }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(event);
    expect(onDay).toHaveBeenCalledTimes(1);
  });

  it('renders all occupied dates and previous-day shadows without hiding the actual day navigation', () => {
    const trip = appointment({ title: '여행', allDay: true, startMinute: 0, endMinute: 1440, endDate: '2026-09-09' });
    const late = appointment({ id: 'late', title: '늦은 일정', date: '2026-09-06', startMinute: 1380, endMinute: 1440, shadow: { preparationMinutes: 0, outboundTravelMinutes: 0, returnTravelMinutes: 40, recoveryMinutes: 30 } });
    render(<MonthCalendar date="2026-09-17" events={[trip, late]} eventTypes={eventTypes} onSelect={vi.fn()} onDay={vi.fn()} />);
    expect(screen.getAllByRole('button', { name: '종일 · 여행' })).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: /늦은 일정/ })).toHaveLength(2);
    const day = screen.getByRole('button', { name: '9. 7. 월요일' }).closest('section')!;
    expect(within(day).getByRole('button', { name: '그림자 · 늦은 일정' })).toHaveClass('shadow-only');
    expect(within(day).getByRole('button', { name: '종일 · 여행' })).toBeInTheDocument();
  });

  it('prevents event mutations in read-only mode while allowing date navigation', () => {
    const onDay = vi.fn();
    const onSelect = vi.fn();
    render(<MonthCalendar date="2026-09-17" events={[appointment()]} eventTypes={eventTypes} readOnly onSelect={onSelect} onDay={onDay} />);
    const event = screen.getByRole('button', { name: '병원' });
    expect(event).toBeDisabled();
    fireEvent.click(event);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '9. 7. 월요일' }));
    expect(onDay).toHaveBeenCalledExactlyOnceWith('2026-09-07');
  });
});
