import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CalendarEvent } from '../../domain/types';
import { createInitialState } from '../../services/storage';
import { Statistics } from './Statistics';

const types = createInitialState().eventTypes;
function appointment(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id: 'event', title: '병원', typeId: 'hospital', date: '2026-09-07', startMinute: 30, endMinute: 90, shadow: { preparationMinutes: 20, outboundTravelMinutes: 40, returnTravelMinutes: 40, recoveryMinutes: 30 }, cost: { transportWon: 4000, mealWon: 12000 }, createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z', ...overrides };
}

afterEach(cleanup);

describe('period statistics', () => {
  it('clips bodies and shadows to visible days and charges money only on each starting day', () => {
    const events = [
      appointment({ id: 'previous', date: '2026-09-06', startMinute: 1380, endMinute: 1440 }),
      appointment({ id: 'current' }),
      appointment({ id: 'following', typeId: 'online', date: '2026-09-08' }),
      appointment({ id: 'spanning', typeId: 'friend', date: '2026-09-06', endDate: '2026-09-08', startMinute: 1380, endMinute: 60 }),
    ];
    render(<Statistics days={['2026-09-07']} events={events} types={types} />);
    expect(screen.getByText('일정 본체')).toHaveTextContent('25시간');
    expect(screen.getByText('숨은 시간')).toHaveTextContent('3시간 20분');
    expect(screen.getByText('총 예상 비용')).toHaveTextContent('16,000원');
    const hospital = screen.getByRole('row', { name: /^병원 / });
    expect(within(hospital).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['2', '3시간 50분', '16,000원']);
    const online = screen.getByRole('row', { name: /^온라인 회의 / });
    expect(within(online).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['1', '30분', '0원']);
    expect(screen.queryByRole('row', { name: /^학교 수업 / })).not.toBeInTheDocument();
  });

  it('counts a multi-day all-day event once and does not charge its cost for every occupied date', () => {
    const event = appointment({ allDay: true, startMinute: 0, endMinute: 1440, endDate: '2026-09-08', shadow: { preparationMinutes: 0, outboundTravelMinutes: 0, returnTravelMinutes: 0, recoveryMinutes: 0 } });
    render(<Statistics days={['2026-09-07', '2026-09-08']} events={[event]} types={types} />);
    expect(screen.getByText('일정 본체')).toHaveTextContent('48시간');
    expect(screen.getByText('숨은 시간')).toHaveTextContent('0분');
    expect(screen.getByText('총 예상 비용')).toHaveTextContent('16,000원');
    expect(within(screen.getByRole('row', { name: /^병원 / })).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['1', '48시간', '16,000원']);
  });

  it('adds overlapping appointments independently and leaves an empty period at zero', () => {
    const { rerender } = render(<Statistics days={['2026-09-07']} events={[appointment(), appointment({ id: 'second' })]} types={types} />);
    expect(screen.getByText('일정 본체')).toHaveTextContent('2시간');
    expect(screen.getByText('총 예상 비용')).toHaveTextContent('32,000원');
    rerender(<Statistics days={['2026-09-15']} events={[appointment()]} types={types} />);
    expect(screen.getByText('일정 본체')).toHaveTextContent('0분');
    expect(screen.getByText('총 예상 비용')).toHaveTextContent('0원');
    expect(screen.getAllByRole('row')).toHaveLength(1);
  });
});
