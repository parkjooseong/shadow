import { useEffect, useMemo, useState } from 'react';
import { addDays, dayNumberToDate, defaultsFromType, formatDateLabel, formatMinutes, formatTime, segmentLabels, startOfWeek, summarizeEvent } from '../domain/calendar';
import type { AppState, CalendarEvent, EventType } from '../domain/types';
import { previewEventConflicts, type PreviewConflict } from '../domain/conflictPreview';
import { useApp } from './AppContext';
import { Calendar } from '../features/calendar/Calendar';
import { SidePanel } from './SidePanel';
import { getEventValidationError, getEventTypeValidationError, isAppState } from '../domain/validation';
import { expandEvents } from '../domain/recurrence';
import { MonthCalendar, monthDates, shiftMonth } from '../features/calendar/MonthCalendar';
import { Statistics } from '../features/calendar/Statistics';
import { DataPanel } from '../features/calendar/DataPanel';
import { NotificationSettings } from '../features/calendar/NotificationSettings';
import { AccountPanel } from '../features/account/AccountPanel';
import { api } from '../services/api';
import { createInitialState } from '../services/storage';
import { StorageNotice } from './StorageNotice';
import { AccountActionPanel, readAccountAction } from '../features/account/AccountSecurity';
import { CloudSyncNotice } from '../features/account/CloudSyncProvider';

interface EventDraft {
  id?: string;
  title: string;
  typeId: string;
  location: string;
  date: string;
  startMinute: number;
  endMinute: number;
  preparationMinutes: number;
  outboundTravelMinutes: number;
  returnTravelMinutes: number;
  recoveryMinutes: number;
  transportWon: number;
  mealWon: number;
  endDate: string;
  allDay: boolean;
  frequency: 'none' | 'daily' | 'weekly' | 'monthly';
  interval: number;
  until: string;
}

function todayInKorea() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function toTimeInput(minute: number) {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

function fromTimeInput(value: string) {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function formatWon(value: number) {
  return new Intl.NumberFormat('ko-KR').format(value) + '원';
}

function useIsNarrow() {
  const [isNarrow, setIsNarrow] = useState(() => window.matchMedia('(max-width: 899px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 899px)');
    const update = () => setIsNarrow(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return isNarrow;
}

function draftFromEvent(event: CalendarEvent | undefined, eventTypes: EventType[], date: string): EventDraft {
  const fallback = eventTypes[0];
  if (event) {
    return {
      id: event.id,
      title: event.title,
      typeId: event.typeId,
      location: event.location ?? '',
      date: event.date,
      startMinute: event.startMinute,
      endMinute: event.endMinute,
      preparationMinutes: event.shadow.preparationMinutes,
      outboundTravelMinutes: event.shadow.outboundTravelMinutes,
      returnTravelMinutes: event.shadow.returnTravelMinutes,
      recoveryMinutes: event.shadow.recoveryMinutes,
      transportWon: event.cost.transportWon,
      mealWon: event.cost.mealWon,
      endDate: event.endDate ?? event.date,
      allDay: event.allDay ?? false,
      frequency: event.recurrence?.frequency ?? 'none',
      interval: event.recurrence?.interval ?? 1,
      until: event.recurrence?.until ?? addDays(event.date, 90),
    };
  }
  const defaults = defaultsFromType(fallback);
  return {
    id: crypto.randomUUID(),
    title: '',
    typeId: fallback.id,
    location: '',
    date,
    startMinute: 15 * 60,
    endMinute: 16 * 60,
    endDate: date,
    allDay: false,
    frequency: 'none',
    interval: 1,
    until: addDays(date, 90),
    ...defaults,
  };
}

function eventFromDraft(draft: EventDraft, existing?: CalendarEvent): CalendarEvent {
  const now = new Date().toISOString();
  return {
    id: existing?.id ?? draft.id!,
    title: draft.title.trim(),
    typeId: draft.typeId,
    location: draft.location.trim() || undefined,
    date: draft.date,
    endDate: draft.endDate === draft.date ? undefined : draft.endDate,
    allDay: draft.allDay || undefined,
    startMinute: draft.allDay ? 0 : draft.startMinute,
    endMinute: draft.allDay ? 1440 : draft.endMinute,
    recurrence: draft.frequency === 'none' ? undefined : { frequency: draft.frequency, interval: draft.interval, until: draft.until },
    excludedDates: draft.frequency === 'none' ? undefined : existing?.excludedDates?.filter((date) => date >= draft.date && date <= draft.until),
    sourceId: existing?.sourceId,
    occurrenceDate: existing?.occurrenceDate,
    shadow: {
      preparationMinutes: draft.preparationMinutes,
      outboundTravelMinutes: draft.outboundTravelMinutes,
      returnTravelMinutes: draft.returnTravelMinutes,
      recoveryMinutes: draft.recoveryMinutes,
    },
    cost: { transportWon: draft.transportWon, mealWon: draft.mealWon },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function getConflictMessage(conflict: PreviewConflict) {
  const startDate = dayNumberToDate(Math.floor(conflict.start / 1440));
  const endDate = dayNumberToDate(Math.floor(conflict.end / 1440));
  const range = `${startDate} ${formatTime(conflict.start)}–${endDate === startDate ? '' : `${endDate} `}${formatTime(conflict.end)}`;
  return `${conflict.event.date} 회차 · “${conflict.otherEvent.title}”의 ${segmentLabels[conflict.otherSegment]}과 ${segmentLabels[conflict.eventSegment]}가 ${formatMinutes(conflict.overlapMinutes)} 겹칩니다 (${range}).`;
}

export function App() {
  const { state: localState, storageError, storageBlocked, storagePending, undo, redo, canUndo, canRedo } = useApp();
  const isNarrow = useIsNarrow();
  const initialDate = todayInKorea();
  const [selectedDate, setSelectedDate] = useState(initialDate);
  const [eventPanel, setEventPanel] = useState<{ event?: CalendarEvent; date: string } | null>(null);
  const [showTypes, setShowTypes] = useState(false);
  const [showData, setShowData] = useState(false);
  const [showAccount, setShowAccount] = useState(() => new URLSearchParams(window.location.search).get('integration') === 'connected');
  const [accountAction, setAccountAction] = useState(readAccountAction);
  useEffect(() => {
    const openAction = () => { const action = readAccountAction(); if (action) setAccountAction(action); };
    window.addEventListener('hashchange', openAction);
    return () => window.removeEventListener('hashchange', openAction);
  }, []);
  const [showStats, setShowStats] = useState(false);
  const [view, setView] = useState<'day' | 'week' | 'month'>(isNarrow ? 'day' : 'week');
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [shared, setShared] = useState<{ title: string; state: AppState }>();
  const [shareError, setShareError] = useState('');
  const [shareToken] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('share'));
  const state = shared?.state ?? (shareToken ? createInitialState() : localState);
  const readOnly = !!shareToken;
  useEffect(() => {
    if (!shareToken) return;
    void api<{ title: string; state: AppState }>(`/api/public/${encodeURIComponent(shareToken)}`).then((result) => {
      if (!isAppState(result.state)) throw new Error('공유 캘린더를 읽지 못했습니다.');
      setShared(result);
      if (result.state.events[0]) setSelectedDate(result.state.events[0].date);
    }).catch((cause: Error) => setShareError(cause.message));
  }, [shareToken]);
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(startOfWeek(selectedDate), index)), [selectedDate]);
  const visibleDays = useMemo(() => view === 'month' ? monthDates(selectedDate) : isNarrow || view === 'day' ? [selectedDate] : weekDays, [view, selectedDate, isNarrow, weekDays]);
  const expansion = useMemo(() => {
    try { return { events: readOnly && !shared ? [] : expandEvents(state.events, visibleDays[0], visibleDays.at(-1)!), error: '' }; }
    catch (cause) { return { events: [], error: cause instanceof Error ? cause.message : '일정을 표시하지 못했습니다.' }; }
  }, [state.events, visibleDays, readOnly, shared]);
  const expanded = expansion.events;
  const filtered = useMemo(() => expanded.filter((event) => (!typeFilter || event.typeId === typeFilter) && `${event.title} ${event.location ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [expanded, query, typeFilter]);
  const selectEvent = (event: CalendarEvent) => { if (!readOnly && !storageBlocked) setEventPanel({ event, date: event.date }); };

  const goPrevious = () => {
    setSelectedDate((date) => view === 'month' ? shiftMonth(date, -1) : addDays(date, isNarrow || view === 'day' ? -1 : -7));
  };
  const goNext = () => {
    setSelectedDate((date) => view === 'month' ? shiftMonth(date, 1) : addDays(date, isNarrow || view === 'day' ? 1 : 7));
  };
  const goToday = () => {
    const today = todayInKorea();
    setSelectedDate(today);
  };

  return (
    <main className="app-shell">
      <a className="skip-link" href="#calendar">캘린더로 건너뛰기</a>
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">S</span>
          <div>
            <p className="eyebrow">THE TRUE COST OF TIME</p>
            <h1>SHADOW</h1>
          </div>
        </div>
        <div className="topbar-actions">
          {!readOnly && <>
            <button className="button ghost" onClick={() => setShowAccount(true)}>계정·연동</button>
            <button className="button ghost" onClick={() => setShowData(true)}>백업·ICS</button>
            <button className="button ghost" onClick={() => setShowTypes(true)}>일정 유형</button>
            <button className="button primary" disabled={storageBlocked} onClick={() => setEventPanel({ date: selectedDate })}>+ 새 일정</button>
          </>}
        </div>
      </header>

      {shareToken && <div className="notice warning" role="status">{shared ? `${shared.title} · 읽기 전용 공유본` : shareError || '공유 캘린더를 불러오는 중…'} <a href="/">내 캘린더로 돌아가기</a></div>}
      {!readOnly && <StorageNotice onReload={() => { setEventPanel(null); setShowTypes(false); setShowData(false); setShowAccount(false); }} />}
      {!readOnly && <CloudSyncNotice />}

      <section className="intro-row">
        <div>
          <p className="eyebrow">YOUR TIME HAS A SHADOW</p>
          <h2>일정의 <em>진짜 가격</em>을 보세요.</h2>
          <p>준비, 이동, 회복까지. SHADOW는 약속이 주변 시간에 만드는 점유를 보여줍니다.</p>
        </div>
        <div className="legend" aria-label="캘린더 범례">
          <span><i className="legend-core" />일정 본체</span>
          <span><i className="legend-shadow" />숨은 시간</span>
          <span><i className="legend-conflict" />충돌</span>
        </div>
      </section>

      <section id="calendar" tabIndex={-1} className="calendar-card" aria-label="SHADOW 캘린더">
        {expansion.error && <p className="notice warning" role="alert">{expansion.error}</p>}
        <div className="calendar-controls">
          <label>보기<select value={view} onChange={(event) => setView(event.target.value as typeof view)}><option value="day">일간</option><option value="week">주간</option><option value="month">월간</option></select></label>
          <label>일정 검색<input type="search" placeholder="제목 또는 장소…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <label>유형 필터<select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="">전체 유형</option>{state.eventTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label>
          <button className="button ghost" aria-pressed={showStats} onClick={() => setShowStats(!showStats)}>통계</button>
          {!readOnly && <><button className="button ghost" disabled={!canUndo} onClick={undo}>실행 취소</button><button className="button ghost" disabled={!canRedo} onClick={redo}>다시 실행</button></>}
        </div>
        <div className="calendar-toolbar">
          <div className="date-navigation">
            <button className="icon-button" onClick={goPrevious} aria-label={view === 'month' ? '이전 달' : isNarrow || view === 'day' ? '이전 날짜' : '이전 주'}>←</button>
            <button className="today-button" onClick={goToday}>오늘</button>
            <button className="icon-button" onClick={goNext} aria-label={view === 'month' ? '다음 달' : isNarrow || view === 'day' ? '다음 날짜' : '다음 주'}>→</button>
            <strong>{view === 'month' ? selectedDate.slice(0, 7) : isNarrow || view === 'day' ? formatDateLabel(selectedDate) : `${formatDateLabel(weekDays[0], true)} — ${formatDateLabel(weekDays[6], true)}`}</strong>
          </div>
          <span className="local-note">{readOnly ? '공유된 복사본' : storageError ? '저장 상태를 확인해 주세요.' : storagePending ? '브라우저에 저장 중…' : '브라우저에 저장 · 계정 메뉴에서 서버 동기화'}</span>
        </div>
        {showStats && <Statistics days={visibleDays} events={filtered} types={state.eventTypes} />}
        {view === 'month' ? <MonthCalendar date={selectedDate} events={filtered} eventTypes={state.eventTypes} readOnly={readOnly} onSelect={selectEvent} onDay={(date) => { setSelectedDate(date); setView('day'); }} /> : <Calendar
          days={visibleDays}
          events={readOnly && !shared ? [] : filtered}
          conflictEvents={state.events}
          readOnly={readOnly}
          eventTypes={state.eventTypes}
          onSelect={selectEvent}
          onCreate={(date) => { if (!readOnly && !storageBlocked) setEventPanel({ date }); }}
        />}
      </section>

      <footer className="privacy-note">
        <span>기본은 로컬 저장이며 서버·외부 동기화와 공유는 직접 선택할 때 실행됩니다.</span>
        <span>공유 기기에서는 로그아웃 후 로컬 데이터도 확인해 주세요.</span>
      </footer>

      {eventPanel && <EventPanel initialEvent={eventPanel.event} date={eventPanel.date} onSaved={setSelectedDate} onClose={() => setEventPanel(null)} />}
      {showTypes && <EventTypesPanel onClose={() => setShowTypes(false)} />}
      {showData && <DataPanel onClose={() => setShowData(false)} />}
      {showAccount && !accountAction && <AccountPanel onClose={() => setShowAccount(false)} />}
      {accountAction && <AccountActionPanel action={accountAction} onClose={() => { setAccountAction(null); setShowAccount(false); }} />}
      {!readOnly && <NotificationSettings events={state.events} />}
    </main>
  );
}


interface FormError {
  field: string;
  message: string;
}

function firstInvalidField(form: HTMLFormElement): FormError | undefined {
  for (const control of Array.from(form.elements)) {
    if ((control instanceof HTMLInputElement || control instanceof HTMLSelectElement) && !control.validity.valid) {
      control.focus();
      return { field: control.name, message: control.validationMessage };
    }
  }
}

function EventPanel({ initialEvent, date, onSaved, onClose }: { initialEvent?: CalendarEvent; date: string; onSaved: (date: string) => void; onClose: () => void }) {
  const { state, dispatch } = useApp();
  const [editingEvent, setEditingEvent] = useState(initialEvent);
  const [draft, setDraft] = useState(() => draftFromEvent(initialEvent, state.eventTypes, date));
  const [error, setError] = useState<FormError>();
  const candidate = useMemo(() => eventFromDraft(draft, editingEvent), [draft, editingEvent]);
  const validationError = getEventValidationError(candidate, state.eventTypes);
  const summary = validationError ? undefined : summarizeEvent(candidate);
  const conflictPreview = useMemo(() => validationError ? undefined : previewEventConflicts(candidate, state.events), [candidate, state.events, validationError]);
  const series = initialEvent?.sourceId ? state.events.find((event) => event.id === initialEvent.sourceId) : undefined;
  const fieldError = (field: string) => ({
    'aria-invalid': error?.field === field || undefined,
    'aria-describedby': error?.field === field ? 'event-form-error' : undefined,
  });
  const setNumber = (key: keyof EventDraft, value: string) => setDraft((current) => ({ ...current, [key]: value === '' ? NaN : Number(value) }));
  const setType = (typeId: string) => {
    const type = state.eventTypes.find((item) => item.id === typeId);
    if (type) setDraft((current) => ({ ...current, typeId, ...defaultsFromType(type) }));
  };
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const invalid = firstInvalidField(event.currentTarget);
    if (invalid) return setError(invalid);
    if (validationError) {
      const field = !draft.title.trim() ? 'title' : 'endMinute';
      setError({ field, message: validationError });
      (event.currentTarget.elements.namedItem(field) as HTMLInputElement)?.focus();
      return;
    }
    if (dispatch({ type: 'event/save', event: candidate })) {
      onSaved(candidate.date);
      onClose();
    } else {
      setError({ field: '', message: '일정을 저장하지 못했습니다. 저장 상태를 확인해 주세요.' });
    }
  };
  const remove = () => {
    if (editingEvent && window.confirm(`“${editingEvent.title}” ${editingEvent.recurrence ? '전체 반복' : '선택한'} 일정을 삭제할까요?`) && dispatch({ type: 'event/delete', id: editingEvent.id, sourceId: editingEvent.sourceId, occurrenceDate: editingEvent.occurrenceDate, updatedAt: new Date().toISOString() })) onClose();
  };

  return <SidePanel titleId="event-panel-title" onClose={onClose}>
    <div className="panel-header">
      <div><p className="eyebrow">{initialEvent ? 'EDIT SHADOW' : 'NEW SHADOW'}</p><h2 id="event-panel-title">{initialEvent ? '일정 편집' : '새 일정'}</h2></div>
      <button className="icon-button" onClick={onClose} aria-label="일정 패널 닫기">×</button>
    </div>
    <form noValidate autoComplete="off" onSubmit={submit} onChange={() => setError(undefined)} className="event-form">
      {series && <label>반복 일정 변경 범위<select aria-label="반복 일정 변경 범위" value={editingEvent?.sourceId ? 'occurrence' : 'series'} onChange={(event) => { const next = event.target.value === 'series' ? series : initialEvent; setEditingEvent(next); setDraft(draftFromEvent(next, state.eventTypes, date)); }}><option value="occurrence">이번 일정만</option><option value="series">전체 반복 일정</option></select></label>}
      <label>일정 제목<input name="title" required {...fieldError('title')} value={draft.title} maxLength={80} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} placeholder="예: 병원 진료…" /></label>
      <label>일정 유형<select name="typeId" value={draft.typeId} onChange={(event) => setType(event.target.value)}>{state.eventTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label>
      <label>장소 <span className="optional">선택</span><input name="location" maxLength={200} value={draft.location} onChange={(event) => setDraft((current) => ({ ...current, location: event.target.value }))} placeholder="예: 강남세브란스…" /></label>
      <div className="field-row">
        <label>날짜<input name="date" required type="date" min="1900-01-01" max="9999-12-31" {...fieldError('date')} value={draft.date} onChange={(event) => setDraft((current) => ({ ...current, date: event.target.value, endDate: current.endDate === current.date ? event.target.value : current.endDate }))} /></label>
        <label>시작<input name="startMinute" required type="time" step="60" disabled={draft.allDay} {...fieldError('startMinute')} value={Number.isFinite(draft.startMinute) ? toTimeInput(draft.startMinute) : ''} onChange={(event) => setDraft((current) => ({ ...current, startMinute: fromTimeInput(event.target.value) }))} /></label>
        <label>종료<input name="endMinute" required type="time" step="60" disabled={draft.allDay || draft.endMinute === 1440} {...fieldError('endMinute')} value={draft.endMinute === 1440 ? '00:00' : Number.isFinite(draft.endMinute) ? toTimeInput(draft.endMinute) : ''} onChange={(event) => setDraft((current) => ({ ...current, endMinute: fromTimeInput(event.target.value) }))} /></label>
      </div>
      <label>종료 날짜<input name="endDate" required type="date" min={draft.date} max="9999-12-31" value={draft.endDate} {...fieldError('endDate')} onChange={(event) => setDraft((current) => ({ ...current, endDate: event.target.value }))} /></label>
      <label className="checkbox-label"><input type="checkbox" checked={draft.allDay} onChange={(event) => setDraft((current) => ({ ...current, allDay: event.target.checked }))} />종일 일정</label>
      {!draft.allDay && <label className="checkbox-label"><input type="checkbox" checked={draft.endMinute === 1440} onChange={(event) => setDraft((current) => ({ ...current, endMinute: event.target.checked ? 1440 : Math.min(current.startMinute + 60, 1439) }))} />자정에 종료 (24:00)</label>}
      {!editingEvent?.sourceId && <fieldset><legend>반복</legend><label>반복 주기<select value={draft.frequency} onChange={(event) => setDraft((current) => ({ ...current, frequency: event.target.value as EventDraft['frequency'] }))}><option value="none">반복 안 함</option><option value="daily">매일</option><option value="weekly">매주</option><option value="monthly">매월</option></select></label>{draft.frequency !== 'none' && <div className="field-row"><label>반복 간격<input name="interval" type="number" required min="1" max="365" value={Number.isFinite(draft.interval) ? draft.interval : ''} onChange={(event) => setNumber('interval', event.target.value)} {...fieldError('interval')} /></label><label>반복 종료일<input name="until" type="date" required min={draft.date} max={addDays(draft.date || date, 1830)} value={draft.until} onChange={(event) => setDraft((current) => ({ ...current, until: event.target.value }))} {...fieldError('until')} /></label></div>}<small>월 반복은 같은 날짜에 생성되며 해당 날짜가 없는 달은 건너뜁니다.</small></fieldset>}
      <fieldset><legend>시간의 그림자</legend><div className="field-grid">
        {([
          ['preparationMinutes', '준비'], ['outboundTravelMinutes', '출발 이동'],
          ['returnTravelMinutes', '귀가 이동'], ['recoveryMinutes', '회복'],
        ] as const).map(([key, label]) => <NumberField key={key} name={key} label={label} value={draft[key]} onChange={(value) => setNumber(key, value)} unit="분" error={error?.field === key ? 'event-form-error' : undefined} />)}
      </div></fieldset>
      <fieldset><legend>실제 비용</legend><div className="field-grid">
        <NumberField name="transportWon" label="교통비" value={draft.transportWon} onChange={(value) => setNumber('transportWon', value)} unit="원" error={error?.field === 'transportWon' ? 'event-form-error' : undefined} />
        <NumberField name="mealWon" label="식비" value={draft.mealWon} onChange={(value) => setNumber('mealWon', value)} unit="원" error={error?.field === 'mealWon' ? 'event-form-error' : undefined} />
      </div></fieldset>
      {summary ? <div className="actual-price"><span>이 약속의 실제 가격</span><strong>시간 {formatMinutes(summary.totalMinutes)} <i aria-hidden="true" /> {formatWon(summary.totalCostWon)}</strong><small>일정 {formatMinutes(summary.coreMinutes)} + 그림자 {formatMinutes(summary.shadowMinutes)}</small></div> : <p className="panel-description">제목과 올바른 시간을 입력하면 실제 시간과 비용이 표시됩니다.</p>}
      {conflictPreview && !conflictPreview.error && candidate.recurrence && <p className="panel-description">반복 종료일까지 {conflictPreview.occurrenceCount}회차의 충돌을 확인합니다.</p>}
      {!!conflictPreview?.conflicts.length && <div className="form-conflicts" role="status"><strong>이 일정의 그림자가 겹칩니다.</strong>{conflictPreview.conflicts.map((conflict, index) => <span key={index}>{getConflictMessage(conflict)}</span>)}{conflictPreview.truncated && <span>추가 충돌이 있습니다. 처음 {conflictPreview.conflicts.length}개 구간만 표시합니다. 반복 기간을 줄여 상세 내용을 확인해 주세요.</span>}</div>}
      {conflictPreview?.error && <p className="form-error" role="status">충돌 미리보기: {conflictPreview.error} 충돌 확인을 완료하지 못했습니다. 일정 저장은 가능합니다.</p>}
      {error && <p id="event-form-error" className="form-error" role="alert">{error.message}</p>}
      <div className="form-actions">{initialEvent && <button type="button" className="button danger" onClick={remove}>삭제</button>}<span /><button type="button" className="button ghost" onClick={onClose}>취소</button><button type="submit" className="button primary">{initialEvent ? '변경 저장' : '일정 만들기'}</button></div>
    </form>
  </SidePanel>;
}

function NumberField({ name, label, value, onChange, unit, error }: { name: string; label: string; value: number; onChange: (value: string) => void; unit: string; error?: string }) {
  return <label>{label}<span className="number-input"><input name={name} required type="number" inputMode="numeric" min="0" max={unit === '분' ? 720 : 10000000} step="1" aria-invalid={!!error || undefined} aria-describedby={error} value={Number.isFinite(value) ? value : ''} onChange={(event) => onChange(event.target.value)} /><small>{unit}</small></span></label>;
}

function EventTypesPanel({ onClose }: { onClose: () => void }) {
  const { state, dispatch, resetData, storageBlocked, storagePending } = useApp();
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<FormError>();
  const [draft, setDraft] = useState<EventType | null>(null);
  const startEdit = (eventType?: EventType) => {
    setEditing(!!eventType);
    setDraft(eventType ?? { id: crypto.randomUUID(), name: '', color: '#7c6cff', preparationMinutes: 15, travelMinutes: 20, recoveryMinutes: 10, transportCostWon: 0, mealCostWon: 0 });
    setMessage('');
    setError(undefined);
  };
  const save = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft) return;
    const invalid = firstInvalidField(event.currentTarget);
    if (invalid) return setError(invalid);
    const normalized = { ...draft, name: draft.name.trim() };
    const validationError = getEventTypeValidationError(normalized);
    if (validationError) {
      setError({ field: 'name', message: validationError });
      (event.currentTarget.elements.namedItem('name') as HTMLInputElement)?.focus();
      return;
    }
    if (dispatch({ type: 'type/save', eventType: normalized })) {
      setDraft(null);
      setMessage('유형을 저장했습니다. 새 일정부터 기본값이 적용됩니다.');
    }
  };
  const remove = (eventType: EventType) => {
    const count = state.events.filter((event) => event.typeId === eventType.id).length;
    if (count) return setMessage(`“${eventType.name}”은(는) ${count}개 일정에서 사용 중이라 삭제할 수 없습니다.`);
    if (state.eventTypes.length === 1) return setMessage('일정 생성을 위해 최소 한 개의 유형이 필요합니다.');
    if (window.confirm(`“${eventType.name}” 유형을 삭제할까요?`) && dispatch({ type: 'type/delete', id: eventType.id })) {
      if (draft?.id === eventType.id) setDraft(null);
      setMessage('유형을 삭제했습니다.');
    }
  };
  const updateNumber = (key: keyof EventType, value: string) => setDraft((current) => current ? ({ ...current, [key]: value === '' ? NaN : Number(value) }) : current);

  return <SidePanel titleId="types-panel-title" className="type-panel" onClose={onClose}>
    <div className="panel-header"><div><p className="eyebrow">DEFAULT SHADOWS</p><h2 id="types-panel-title">일정 유형</h2></div><button className="icon-button" onClick={onClose} aria-label="일정 유형 패널 닫기">×</button></div>
    <p className="panel-description">유형의 값은 새 일정의 기본 그림자가 됩니다. 기존 일정의 시간과 비용은 바뀌지 않습니다.</p>
    <div className="type-list">{state.eventTypes.map((eventType) => <article className="type-card" key={eventType.id}><span aria-hidden="true" className="type-dot" style={{ backgroundColor: eventType.color }} /><div><strong>{eventType.name}</strong><small>준비 {eventType.preparationMinutes} · 편도 이동 {eventType.travelMinutes} · 회복 {eventType.recoveryMinutes}분</small></div><button disabled={storageBlocked} className="text-button" onClick={() => startEdit(eventType)}>편집</button><button disabled={storageBlocked} className="text-button danger-text" onClick={() => remove(eventType)}>삭제</button></article>)}</div>
    <button disabled={storageBlocked} className="button ghost wide" onClick={() => startEdit()}>+ 새 유형</button>
    {draft && <form noValidate autoComplete="off" className="type-form" onSubmit={save} onChange={() => setError(undefined)}>
      <h3>{editing ? '유형 편집' : '새 유형'}</h3>
      <label>이름<input name="name" required value={draft.name} maxLength={30} aria-invalid={error?.field === 'name' || undefined} aria-describedby={error?.field === 'name' ? 'type-form-error' : undefined} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
      <label>색상<input name="color" type="color" value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /></label>
      <div className="field-grid">{([
        ['preparationMinutes', '준비', '분'], ['travelMinutes', '편도 이동', '분'], ['recoveryMinutes', '회복', '분'],
        ['transportCostWon', '교통비', '원'], ['mealCostWon', '식비', '원'],
      ] as const).map(([key, label, unit]) => <NumberField key={key} name={key} label={label} value={draft[key]} onChange={(value) => updateNumber(key, value)} unit={unit} error={error?.field === key ? 'type-form-error' : undefined} />)}</div>
      {error && <p id="type-form-error" className="form-error" role="alert">{error.message}</p>}
      <div className="form-actions"><span /><button type="button" className="button ghost" onClick={() => setDraft(null)}>취소</button><button className="button primary">저장</button></div>
    </form>}
    {message && <p className="form-message" role="status">{message}</p>}
    <div className="danger-zone"><strong>이 브라우저의 일정 지우기</strong><p>브라우저 자동 동기화를 끈 뒤 로컬 데이터만 지웁니다. 되돌릴 수 없으며 서버와 다른 기기의 일정은 유지됩니다.</p><button disabled={storagePending} className="button danger" onClick={async () => { if (window.confirm('브라우저 자동 동기화를 끄고 모든 로컬 일정과 사용자 유형을 초기화할까요? 서버의 일정은 유지됩니다.') && await resetData()) { setDraft(null); setMessage('브라우저 자동 동기화를 끄고 기본 유형으로 초기화했습니다.'); } else setMessage('초기화하지 않았습니다.'); }}>전체 초기화</button></div>
  </SidePanel>;
}
