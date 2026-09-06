import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarEvent } from '../../domain/types';
import { NotificationSettings } from './NotificationSettings';

function appointment(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id: 'notification-event', title: '병원 진료', typeId: 'hospital', date: '2026-09-07', startMinute: 900, endMinute: 960, shadow: { preparationMinutes: 0, outboundTravelMinutes: 0, returnTravelMinutes: 0, recoveryMinutes: 0 }, cost: { transportWon: 0, mealWon: 0 }, createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z', ...overrides };
}

const permission = vi.fn<() => Promise<NotificationPermission>>();
const display = vi.fn<(title: string, options?: NotificationOptions) => void>();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-07T06:00:00.000Z'));
  permission.mockReset().mockResolvedValue('granted');
  display.mockReset();
  class BrowserNotification {
    static requestPermission = permission;
    constructor(title: string, options?: NotificationOptions) { display(title, options); }
  }
  vi.stubGlobal('Notification', BrowserNotification);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function enableNotifications() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '브라우저 알림 켜기' })); });
}

describe('browser notifications', () => {
  it('never requests permission or displays notifications until the user enables them', () => {
    render(<StrictMode><NotificationSettings events={[appointment()]} /></StrictMode>);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(permission).not.toHaveBeenCalled();
    expect(display).not.toHaveBeenCalled();
    expect(screen.getByText('이 탭이 열린 동안만 알림을 제공합니다.')).toBeInTheDocument();
  });

  it('reports denial without scheduling notifications or repeating permission requests', async () => {
    permission.mockResolvedValue('denied');
    render(<NotificationSettings events={[appointment()]} />);
    await enableNotifications();
    expect(screen.getByRole('status')).toHaveTextContent('알림을 허용하지 않았습니다');
    act(() => { vi.advanceTimersByTime(120_000); });
    expect(permission).toHaveBeenCalledTimes(1);
    expect(display).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '브라우저 알림 켜기' })).toBeInTheDocument();
  });

  it('sends Seoul 15:00 at UTC 06:00 once despite duplicate targets, rerenders, and re-enabling', async () => {
    const event = appointment();
    const { rerender } = render(<StrictMode><NotificationSettings events={[event]} /></StrictMode>);
    await enableNotifications();
    expect(display).toHaveBeenCalledTimes(1);
    expect(display).toHaveBeenCalledWith('병원 진료', expect.objectContaining({ body: '일정이 시작됩니다.' }));
    rerender(<StrictMode><NotificationSettings events={[{ ...event }]} /></StrictMode>);
    act(() => { vi.advanceTimersByTime(30_000); });
    fireEvent.click(screen.getByRole('button', { name: '알림 끄기' }));
    await enableNotifications();
    expect(display).toHaveBeenCalledTimes(1);
  });

  it('notifies preparation and event start separately, then clears the interval on unmount', async () => {
    vi.setSystemTime(new Date('2026-09-07T05:30:00.000Z'));
    const { unmount } = render(<NotificationSettings events={[appointment({ shadow: { preparationMinutes: 10, outboundTravelMinutes: 20, returnTravelMinutes: 0, recoveryMinutes: 0 } })]} />);
    await enableNotifications();
    expect(display).toHaveBeenCalledTimes(1);
    expect(display.mock.calls[0][1]?.body).toBe('준비와 이동을 시작할 시간입니다.');
    act(() => { vi.advanceTimersByTime(30 * 60_000); });
    expect(display).toHaveBeenCalledTimes(2);
    expect(display.mock.calls[1][1]?.body).toBe('일정이 시작됩니다.');
    expect(display.mock.calls[0][1]?.tag).not.toBe(display.mock.calls[1][1]?.tag);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not announce events outside the latest minute or future events early', async () => {
    render(<NotificationSettings events={[appointment({ startMinute: 899, endMinute: 959 }), appointment({ id: 'future', startMinute: 901, endMinute: 961 })]} />);
    await enableNotifications();
    expect(display).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(display).toHaveBeenCalledTimes(1);
    expect(display.mock.calls[0][1]?.tag).toContain('future');
  });

  it('reports permission failures and lets a failed display be retried after explicitly re-enabling', async () => {
    permission.mockRejectedValueOnce(new Error('Browser rejected the request'));
    render(<NotificationSettings events={[appointment({ shadow: { preparationMinutes: 10, outboundTravelMinutes: 0, returnTravelMinutes: 0, recoveryMinutes: 0 } })]} />);
    await enableNotifications();
    expect(screen.getByRole('status')).toHaveTextContent('알림 권한을 요청하지 못했습니다');
    display.mockImplementationOnce(() => { throw new Error('Notification temporarily unavailable'); });
    await enableNotifications();
    expect(screen.getByRole('status')).toHaveTextContent('알림을 표시하지 못했습니다');
    expect(display).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '알림 끄기' }));
    await enableNotifications();
    expect(display).toHaveBeenCalledTimes(2);
  });
});
