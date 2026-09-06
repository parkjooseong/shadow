import { addDays, formatDateLabel, getFootprint, startOfWeek, toAbsoluteMinute } from '../../domain/calendar';
import type { CalendarEvent, EventType } from '../../domain/types';
import { eventForeground } from './layout';

export function monthDates(date: string) {
  const first = startOfWeek(date.slice(0, 7) + '-01');
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}

export function shiftMonth(date: string, direction: number) {
  const target = new Date(date.slice(0, 7) + '-01T00:00:00Z');
  target.setUTCMonth(target.getUTCMonth() + direction);
  return target.toISOString().slice(0, 10);
}

export function MonthCalendar({ date, events, eventTypes, readOnly, onSelect, onDay }: {
  date: string; events: CalendarEvent[]; eventTypes: EventType[]; readOnly?: boolean;
  onSelect: (event: CalendarEvent) => void; onDay: (date: string) => void;
}) {
  return <div className="month-grid" aria-label="월간 캘린더">
    {['월', '화', '수', '목', '금', '토', '일'].map((day) => <div className="month-heading" key={day}>{day}</div>)}
    {monthDates(date).map((day) => {
      const start = toAbsoluteMinute(day, 0);
      const dayEvents = events.filter((event) => getFootprint(event).some((segment) => segment.start < start + 1440 && segment.end > start));
      return <section key={day} className={day.slice(0, 7) === date.slice(0, 7) ? 'month-day' : 'month-day other-month'}>
        <button className="text-button" onClick={() => onDay(day)} aria-label={formatDateLabel(day)}>{day.slice(8)}<span className="month-weekday"> {formatDateLabel(day, true).match(/\(.+\)/)?.[0]}</span></button>
        {dayEvents.map((event) => {
          const color = eventTypes.find((type) => type.id === event.typeId)?.color ?? '#7c6cff';
          const shadowOnly = !getFootprint(event).some((segment) => segment.kind === 'event' && segment.start < start + 1440 && segment.end > start);
          return <button key={event.id} disabled={readOnly} className={`month-event${shadowOnly ? ' shadow-only' : ''}`} style={{ background: shadowOnly ? '#2c2844' : color, color: shadowOnly ? '#e8e2ff' : eventForeground(color), borderColor: color }} onClick={() => onSelect(event)}>{shadowOnly ? '그림자 · ' : event.allDay ? '종일 · ' : ''}{event.title}</button>;
        })}
      </section>;
    })}
  </div>;
}
