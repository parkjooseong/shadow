import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CalendarEvent } from '../../domain/types';
import { createInitialState } from '../../services/storage';
import { Calendar } from './Calendar';

const dispatch = vi.hoisted(() => vi.fn());
vi.mock('../../app/AppContext', () => ({ useApp: () => ({ dispatch }) }));

function appointment(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id: 'visible', title: '표시 일정', typeId: 'online', date: '2026-09-07', startMinute: 900, endMinute: 960, shadow: { preparationMinutes: 0, outboundTravelMinutes: 0, returnTravelMinutes: 0, recoveryMinutes: 0 }, cost: { transportWon: 0, mealWon: 0 }, createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z', ...overrides };
}

function draw(events: CalendarEvent[], conflictEvents: CalendarEvent[]) {
  return render(<Calendar days={['2026-09-07']} events={events} conflictEvents={conflictEvents} eventTypes={createInitialState().eventTypes} onSelect={vi.fn()} onCreate={vi.fn()} />);
}

function pointer(target: Element | Window, type: string, y: number) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: 100, clientY: y });
  Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } });
  fireEvent(target, event);
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); dispatch.mockClear(); });

describe('calendar conflict safety with filtered rendering', () => {
  it('keeps hidden events in collision detection without rendering their blocks', () => {
    const visible = appointment();
    const hidden = appointment({ id: 'hidden', title: '숨겨진 병원', typeId: 'hospital', startMinute: 930, endMinute: 990 });
    draw([visible], [visible, hidden]);
    expect(screen.getByRole('button', { name: /표시 일정/ })).toHaveClass('has-conflict');
    expect(screen.queryByRole('button', { name: /숨겨진 병원/ })).not.toBeInTheDocument();
    expect(screen.getByText(/선택한 날짜에서 일정 쌍 기준 30분/)).toHaveTextContent('숨긴 일정도 포함');
  });

  it('checks the unfiltered stored series and reports hidden conflicts during a drag', () => {
    const visible = appointment();
    const hidden = appointment({ id: 'hidden-series', title: '숨겨진 반복', date: '2026-09-06', startMinute: 960, endMinute: 1020, recurrence: { frequency: 'daily', interval: 1, until: '2026-09-08' } });
    const { container } = draw([visible], [visible, hidden]);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 500, bottom: 1700, width: 500, height: 1700, toJSON: () => ({}) });
    const block = screen.getByRole('button', { name: /표시 일정/ });
    expect(block).not.toHaveClass('has-conflict');
    pointer(block, 'pointerdown', 1025);
    pointer(window, 'pointermove', 1093);
    expect(container.querySelector('.drag-status')).toHaveTextContent('그림자가 1시간 겹칩니다');
    expect(block).toHaveClass('has-conflict');
    pointer(window, 'pointerup', 1093);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'event/save', event: expect.objectContaining({ startMinute: 960, endMinute: 1020 }) }));
  });

  it('reports an expansion failure instead of implying that conflicts were checked', () => {
    const invalidSeries = appointment({ recurrence: { frequency: 'daily', interval: 0, until: '2026-09-08' } });
    draw([], [invalidSeries]);
    expect(screen.getByText(/충돌 확인을 완료하지 못했습니다/)).toBeInTheDocument();
  });
});
