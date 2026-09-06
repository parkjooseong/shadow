import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { useApp } from '../../app/AppContext';
import { addDays, dateToDayNumber, formatDateLabel, formatMinutes, formatTime, segmentLabels, toAbsoluteMinute } from '../../domain/calendar';
import { previewEventConflicts } from '../../domain/conflictPreview';
import { expandEvents } from '../../domain/recurrence';
import type { CalendarEvent, EventType } from '../../domain/types';
import { DAY_MINUTES, eventForeground, HOUR_HEIGHT, layoutDay, MIN_EVENT_HEIGHT, MINUTE_HEIGHT, snapStartMinute, summarizeVisibleConflicts } from './layout';

interface CalendarProps {
  days: string[];
  events: CalendarEvent[];
  /** Unfiltered stored events, including recurrence masters outside the current view. */
  conflictEvents?: CalendarEvent[];
  readOnly?: boolean;
  eventTypes: EventType[];
  onSelect: (event: CalendarEvent) => void;
  onCreate: (date: string) => void;
}

interface DragSession {
  event: CalendarEvent;
  pointerId: number;
  startX: number;
  startY: number;
  grabOffset: number;
  grabbedDate: string;
  active: boolean;
}

function todayInKorea() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function Calendar({ days, events, conflictEvents = events, eventTypes, readOnly = false, onSelect, onCreate }: CalendarProps) {
  const { dispatch } = useApp();
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialScrollTop = useRef(events.length ? 6 * HOUR_HEIGHT : 0);
  const sessionRef = useRef<DragSession | null>(null);
  const suppressClickRef = useRef(false);
  const [preview, setPreview] = useState<CalendarEvent | null>(null);
  const eventsWithPreview = useMemo(() => events.map((event) => preview?.id === event.id ? preview : event), [events, preview]);
  const conflictCalculation = useMemo(() => {
    try {
      return { events: expandEvents(conflictEvents, days[0], days.at(-1)!), error: '' };
    } catch (cause) {
      return { events: [], error: cause instanceof Error ? cause.message : '충돌을 계산하지 못했습니다.' };
    }
  }, [days, conflictEvents]);
  const previewId = preview?.id;
  const conflictSummary = useMemo(() => summarizeVisibleConflicts(conflictCalculation.events.filter((event) => event.id !== previewId), days), [conflictCalculation.events, days, previewId]);
  const conflictIds = new Set(conflictSummary.conflictIds);
  const dragPreview = useMemo(() => preview ? previewEventConflicts(preview, conflictEvents) : undefined, [preview, conflictEvents]);
  if (preview) {
    for (const conflict of dragPreview?.conflicts ?? []) {
      conflictIds.add(conflict.eventId);
      conflictIds.add(conflict.otherEventId);
    }
  }
  const today = todayInKorea();

  useEffect(() => {
    // Preserve a useful morning starting point while keeping midnight reachable by scrolling.
    if (scrollRef.current) scrollRef.current.scrollTop = initialScrollTop.current;
  }, []);

  useEffect(() => {
    const resolvePointer = (pointer: PointerEvent): CalendarEvent | null => {
      const session = sessionRef.current;
      const grid = gridRef.current;
      if (!session || session.pointerId !== pointer.pointerId || !grid) return null;
      if (!session.active && Math.hypot(pointer.clientX - session.startX, pointer.clientY - session.startY) < 5) return null;
      session.active = true;
      suppressClickRef.current = true;
      const columns = [...grid.querySelectorAll<HTMLElement>('[data-calendar-date]')];
      const column = columns.find((item) => pointer.clientX < item.getBoundingClientRect().right) ?? columns.at(-1);
      if (!column) return null;
      if (session.event.allDay || (session.event.endDate && session.event.endDate !== session.event.date)) {
        const dayDelta = dateToDayNumber(column.dataset.calendarDate!) - dateToDayNumber(session.grabbedDate);
        return { ...session.event, date: addDays(session.event.date, dayDelta), endDate: session.event.endDate ? addDays(session.event.endDate, dayDelta) : undefined };
      }
      const rawMinute = (pointer.clientY - grid.getBoundingClientRect().top - session.grabOffset) / MINUTE_HEIGHT;
      const duration = session.event.endMinute - session.event.startMinute;
      const startMinute = snapStartMinute(rawMinute, duration);
      return { ...session.event, date: column.dataset.calendarDate!, endDate: undefined, startMinute, endMinute: startMinute + duration };
    };
    const move = (pointer: PointerEvent) => {
      const next = resolvePointer(pointer);
      if (next) setPreview(next);
    };
    const finish = (pointer: PointerEvent) => {
      const session = sessionRef.current;
      if (!session || session.pointerId !== pointer.pointerId) return;
      const next = resolvePointer(pointer);
      sessionRef.current = null;
      setPreview(null);
      if (next && (next.date !== session.event.date || next.startMinute !== session.event.startMinute)) {
        dispatch({ type: 'event/save', event: { ...next, updatedAt: new Date().toISOString() } });
      }
    };
    const cancel = () => {
      if (sessionRef.current?.active) suppressClickRef.current = true;
      sessionRef.current = null;
      setPreview(null);
    };
    const cancelPointer = (pointer: PointerEvent) => {
      if (pointer.pointerId === sessionRef.current?.pointerId) cancel();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && sessionRef.current) {
        event.preventDefault();
        cancel();
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancelPointer);
    window.addEventListener('keydown', keydown);
    window.addEventListener('blur', cancel);
    return () => {
      sessionRef.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancelPointer);
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('blur', cancel);
    };
  }, [dispatch]);

  const begin = (pointer: ReactPointerEvent<HTMLButtonElement>, event: CalendarEvent, date: string) => {
    if (readOnly || pointer.button !== 0 || !pointer.isPrimary || sessionRef.current || !gridRef.current) return;
    suppressClickRef.current = false;
    sessionRef.current = {
      event,
      pointerId: pointer.pointerId,
      startX: pointer.clientX,
      startY: pointer.clientY,
      grabOffset: pointer.clientY - gridRef.current.getBoundingClientRect().top - event.startMinute * MINUTE_HEIGHT,
      grabbedDate: date,
      active: false,
    };
  };

  return <>
    <div className="calendar-week-header" style={{ gridTemplateColumns: `64px repeat(${days.length}, minmax(0, 1fr))` }}>
      <span />
      {days.map((date) => <button key={date} disabled={readOnly} className={`day-header ${date === today ? 'today' : ''}`} onClick={() => onCreate(date)}><span>{formatDateLabel(date, true)}</span>{!readOnly && <small>+ 일정</small>}</button>)}
    </div>
    <div className="calendar-drag-region">
      <div className={`drag-status${preview ? ' is-active' : ''}`} role="status" aria-live="polite" aria-atomic="true">
        {preview ? `${formatTime(preview.startMinute)} — ${formatTime(preview.endMinute)} · ${dragPreview?.error ? `충돌 확인을 완료하지 못했습니다: ${dragPreview.error}` : dragPreview?.conflicts.length ? `그림자가 ${dragPreview.truncated ? '최소 ' : ''}${formatMinutes(dragPreview.conflicts.reduce((total, conflict) => total + conflict.overlapMinutes, 0))} 겹칩니다. 숨긴 일정도 확인합니다. 저장은 가능합니다.` : '그림자가 함께 이동 중입니다. 숨긴 일정도 확인합니다.'} Escape 키로 취소` : ''}
      </div>
      <div ref={scrollRef} className="calendar-scroll" tabIndex={0} aria-label="시간표 · 위아래로 스크롤하여 0시부터 24시까지 확인">
        <div ref={gridRef} className="calendar-grid" style={{ gridTemplateColumns: `64px repeat(${days.length}, minmax(0, 1fr))` }}>
          <div className="time-rail" aria-hidden="true" style={{ height: DAY_MINUTES * MINUTE_HEIGHT }}>{Array.from({ length: 25 }, (_, hour) => <span key={hour} style={{ top: hour * HOUR_HEIGHT, transform: hour === 0 ? 'none' : hour === 24 ? 'translateY(-100%)' : 'translateY(-50%)' }}>{String(hour).padStart(2, '0')}:00</span>)}</div>
          {days.map((date) => {
            const dayStart = toAbsoluteMinute(date, 0);
            return <div className="calendar-day" data-calendar-date={date} key={date} style={{ height: DAY_MINUTES * MINUTE_HEIGHT }} onDoubleClick={() => { if (!readOnly) onCreate(date); }}>
              {layoutDay(eventsWithPreview, date).flatMap(({ event, segments, lane, laneCount }) => segments.map((segment) => {
                const type = eventTypes.find((item) => item.id === event.typeId);
                const top = Math.max(segment.start, dayStart) - dayStart;
                const minutes = Math.min(segment.end, dayStart + DAY_MINUTES) - Math.max(segment.start, dayStart);
                const isCore = segment.kind === 'event';
                const conflict = conflictIds.has(event.id);
                const style = {
                  top: top * MINUTE_HEIGHT,
                  height: Math.min((DAY_MINUTES - top) * MINUTE_HEIGHT, Math.max(minutes * MINUTE_HEIGHT, isCore ? MIN_EVENT_HEIGHT : 2)),
                  left: `calc(${lane / laneCount * 100}% + 4px)`,
                  width: `calc(${100 / laneCount}% - 8px)`,
                  right: 'auto',
                  '--event-color': type?.color ?? '#b8a6ff',
                  '--event-foreground': eventForeground(type?.color ?? '#b8a6ff'),
                } as CSSProperties;
                if (!isCore) return <div key={`${event.id}-${segment.kind}`} className={`shadow-segment ${segment.kind} ${conflict ? 'has-conflict' : ''}`} style={style} title={`${event.title} · ${segmentLabels[segment.kind]} ${formatMinutes(minutes)}`}><span>{segmentLabels[segment.kind]}</span></div>;
                return <button
                  key={`${event.id}-event`}
                  className={`event-block ${conflict ? 'has-conflict' : ''} ${preview?.id === event.id ? 'is-dragging' : ''}`}
                  style={style}
                  onPointerDown={(pointer) => begin(pointer, event, date)}
                  onDoubleClick={(pointer) => pointer.stopPropagation()}
                  onClick={(pointer) => {
                    if (suppressClickRef.current && pointer.detail !== 0) return;
                    onSelect(event);
                  }}
                  aria-label={`${event.title}, ${event.allDay ? '종일' : `${formatTime(event.startMinute)}부터 ${formatTime(event.endMinute)}까지`}.${event.endDate ? ` ${event.endDate}까지.` : ''}${conflict ? ' 다른 일정과 충돌.' : ''}${readOnly ? ' 읽기 전용' : ' Enter 키로 편집'}`}
                >
                  <strong>{event.title}{event.sourceId ? ' ↻' : ''}</strong><span>{event.allDay ? '종일' : `${formatTime(event.startMinute)} — ${formatTime(event.endMinute)}`}{event.endDate ? ` · ${event.endDate.slice(5)}까지` : ''}</span>
                </button>;
              }))}
            </div>;
          })}
        </div>
        {!events.length && <div className="empty-calendar"><div><span className="empty-orbit" aria-hidden="true">◌</span><h3>표시할 일정이 없습니다.</h3><p>선택한 날짜와 검색 조건을 확인해 주세요.</p>{!readOnly && <button className="button primary" onClick={() => onCreate(days[0])}>첫 일정 만들기</button>}</div></div>}
      </div>
    </div>
    {conflictSummary.overlapMinutes > 0 && !preview && <div className="conflict-summary" role="status"><strong>겹치는 실제 시간이 있습니다.</strong><span>선택한 날짜에서 일정 쌍 기준 {formatMinutes(conflictSummary.overlapMinutes)}이 겹칩니다. 검색·유형 필터로 숨긴 일정도 포함합니다. 일정은 그대로 유지됩니다.</span></div>}
    {conflictCalculation.error && <p className="form-error" role="status">충돌 확인을 완료하지 못했습니다: {conflictCalculation.error}</p>}
  </>;
}
