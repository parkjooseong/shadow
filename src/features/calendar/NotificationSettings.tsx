import { useEffect, useRef, useState } from 'react';
import { addDays, getFootprint } from '../../domain/calendar';
import { expandEvents } from '../../domain/recurrence';
import type { CalendarEvent } from '../../domain/types';

export function NotificationSettings({ events }: { events: CalendarEvent[] }) {
  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState('');
  const sent = useRef(new Set<string>());
  const enable = async () => {
    if (!('Notification' in window)) return setMessage('이 브라우저는 알림을 지원하지 않습니다.');
    try {
      const permission = await Notification.requestPermission();
      setEnabled(permission === 'granted');
      setMessage(permission === 'granted' ? '이 탭이 열린 동안 준비 시작과 일정 시작을 알려드립니다.' : '알림을 허용하지 않았습니다. 브라우저 설정에서 변경할 수 있습니다.');
    } catch { setMessage('알림 권한을 요청하지 못했습니다. 브라우저 설정을 확인해 주세요.'); }
  };
  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      const now = Date.now();
      const date = new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
      let occurrences: CalendarEvent[];
      try { occurrences = expandEvents(events, addDays(date, -1), addDays(date, 1)); }
      catch (cause) { setMessage(cause instanceof Error ? cause.message : '알림 일정을 확인하지 못했습니다.'); return; }
      for (const event of occurrences) {
        const footprint = getFootprint(event);
        const targets = [footprint[0], footprint.find((segment) => segment.kind === 'event')!];
        for (const target of targets) {
          const scheduled = target.start * 60000 - 9 * 3600_000;
          const key = `${event.id}:${target.start}`;
          if (scheduled <= now && scheduled > now - 60000 && !sent.current.has(key)) {
            try { new Notification(event.title, { body: target.kind === 'event' ? '일정이 시작됩니다.' : '준비와 이동을 시작할 시간입니다.', tag: key }); sent.current.add(key); }
            catch { setMessage('알림을 표시하지 못했습니다. 브라우저 설정을 확인해 주세요.'); }
          }
        }
      }
    };
    tick();
    const timer = window.setInterval(tick, 15000);
    return () => window.clearInterval(timer);
  }, [enabled, events]);
  return <div className="notification-settings">
    <button className="button ghost" onClick={() => enabled ? (setEnabled(false), setMessage('알림을 껐습니다.')) : void enable()}>{enabled ? '알림 끄기' : '브라우저 알림 켜기'}</button>
    <span role={message ? 'status' : undefined}>{message || '이 탭이 열린 동안만 알림을 제공합니다.'}</span>
  </div>;
}
