import { useEffect, useMemo, useState } from 'react';
import { addDays, defaultsFromType, detectConflicts, formatDateLabel, formatMinutes, segmentLabels, startOfWeek, summarizeEvent } from '../domain/calendar';
import type { CalendarEvent, Conflict, EventType } from '../domain/types';
import { useApp } from './AppContext';
import { Calendar } from '../features/calendar/Calendar';
import { SidePanel } from './SidePanel';
import { getEventValidationError, getEventTypeValidationError } from '../domain/validation';

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
    startMinute: draft.startMinute,
    endMinute: draft.endMinute,
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

function getConflictMessage(conflict: Conflict, events: CalendarEvent[]) {
  const other = events.find((event) => event.id === conflict.otherEventId);
  return `${other?.title ?? '다른 일정'}의 ${segmentLabels[conflict.otherSegment]}과 ${segmentLabels[conflict.eventSegment]}가 ${formatMinutes(conflict.overlapMinutes)} 겹칩니다.`;
}

export function App() {
  const { state, storageError, storageBlocked, retrySave, resetData } = useApp();
  const isNarrow = useIsNarrow();
  const initialDate = todayInKorea();
  const [selectedDate, setSelectedDate] = useState(initialDate);
  const [eventPanel, setEventPanel] = useState<{ event?: CalendarEvent; date: string } | null>(null);
  const [showTypes, setShowTypes] = useState(false);
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(startOfWeek(selectedDate), index)), [selectedDate]);
  const visibleDays = isNarrow ? [selectedDate] : weekDays;

  const goPrevious = () => {
    setSelectedDate((date) => addDays(date, isNarrow ? -1 : -7));
  };
  const goNext = () => {
    setSelectedDate((date) => addDays(date, isNarrow ? 1 : 7));
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
          <button className="button ghost" onClick={() => setShowTypes(true)}>일정 유형</button>
          <button className="button primary" disabled={storageBlocked} onClick={() => setEventPanel({ date: selectedDate })}>+ 새 일정</button>
        </div>
      </header>

      {storageError && (
        <div className="notice warning" role="alert">
          <span>{storageError}</span>
          {storageBlocked ? <button className="button danger" onClick={() => { if (window.confirm('보존 중인 저장 데이터를 지우고 초기화할까요? 이 작업은 되돌릴 수 없습니다.')) resetData(); }}>데이터 초기화</button> : <button className="button ghost" onClick={retrySave}>저장 재시도</button>}
        </div>
      )}

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
        <div className="calendar-toolbar">
          <div className="date-navigation">
            <button className="icon-button" onClick={goPrevious} aria-label={isNarrow ? '이전 날짜' : '이전 주'}>←</button>
            <button className="today-button" onClick={goToday}>오늘</button>
            <button className="icon-button" onClick={goNext} aria-label={isNarrow ? '다음 날짜' : '다음 주'}>→</button>
            <strong>{isNarrow ? formatDateLabel(selectedDate) : `${formatDateLabel(weekDays[0], true)} — ${formatDateLabel(weekDays[6], true)}`}</strong>
          </div>
          <span className="local-note">{storageError ? '저장 상태를 확인해 주세요.' : '모든 데이터는 이 브라우저에만 저장됩니다.'}</span>
        </div>
        <Calendar
          days={visibleDays}
          events={state.events}
          eventTypes={state.eventTypes}
          onSelect={(event) => { if (!storageBlocked) setEventPanel({ event, date: event.date }); }}
          onCreate={(date) => { if (!storageBlocked) setEventPanel({ date }); }}
        />
      </section>

      <footer className="privacy-note">
        <span>개인 일정은 외부로 전송되지 않습니다.</span>
        <span>공유 기기에서는 브라우저 데이터가 노출될 수 있습니다.</span>
      </footer>

      {eventPanel && <EventPanel initialEvent={eventPanel.event} date={eventPanel.date} onSaved={setSelectedDate} onClose={() => setEventPanel(null)} />}
      {showTypes && <EventTypesPanel onClose={() => setShowTypes(false)} />}
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
  const [draft, setDraft] = useState(() => draftFromEvent(initialEvent, state.eventTypes, date));
  const [error, setError] = useState<FormError>();
  const candidate = eventFromDraft(draft, initialEvent);
  const validationError = getEventValidationError(candidate, state.eventTypes);
  const summary = validationError ? undefined : summarizeEvent(candidate);
  const conflicts = validationError ? [] : detectConflicts(candidate, state.events);
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
    if (initialEvent && window.confirm(`“${initialEvent.title}” 일정을 삭제할까요?`) && dispatch({ type: 'event/delete', id: initialEvent.id })) onClose();
  };

  return <SidePanel titleId="event-panel-title" onClose={onClose}>
    <div className="panel-header">
      <div><p className="eyebrow">{initialEvent ? 'EDIT SHADOW' : 'NEW SHADOW'}</p><h2 id="event-panel-title">{initialEvent ? '일정 편집' : '새 일정'}</h2></div>
      <button className="icon-button" onClick={onClose} aria-label="일정 패널 닫기">×</button>
    </div>
    <form noValidate autoComplete="off" onSubmit={submit} onChange={() => setError(undefined)} className="event-form">
      <label>일정 제목<input name="title" required {...fieldError('title')} value={draft.title} maxLength={80} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} placeholder="예: 병원 진료…" /></label>
      <label>일정 유형<select name="typeId" value={draft.typeId} onChange={(event) => setType(event.target.value)}>{state.eventTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label>
      <label>장소 <span className="optional">선택</span><input name="location" maxLength={200} value={draft.location} onChange={(event) => setDraft((current) => ({ ...current, location: event.target.value }))} placeholder="예: 강남세브란스…" /></label>
      <div className="field-row">
        <label>날짜<input name="date" required type="date" min="1900-01-01" max="9999-12-31" {...fieldError('date')} value={draft.date} onChange={(event) => setDraft((current) => ({ ...current, date: event.target.value }))} /></label>
        <label>시작<input name="startMinute" required type="time" step="60" {...fieldError('startMinute')} value={Number.isFinite(draft.startMinute) ? toTimeInput(draft.startMinute) : ''} onChange={(event) => setDraft((current) => ({ ...current, startMinute: fromTimeInput(event.target.value) }))} /></label>
        <label>종료<input name="endMinute" required type="time" step="60" disabled={draft.endMinute === 1440} {...fieldError('endMinute')} value={draft.endMinute === 1440 ? '00:00' : Number.isFinite(draft.endMinute) ? toTimeInput(draft.endMinute) : ''} onChange={(event) => setDraft((current) => ({ ...current, endMinute: fromTimeInput(event.target.value) }))} /></label>
      </div>
      <label className="checkbox-label"><input type="checkbox" checked={draft.endMinute === 1440} onChange={(event) => setDraft((current) => ({ ...current, endMinute: event.target.checked ? 1440 : Math.min(current.startMinute + 60, 1439) }))} />자정에 종료 (24:00)</label>
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
      {conflicts.length > 0 && <div className="form-conflicts" role="status"><strong>이 일정의 그림자가 겹칩니다.</strong>{conflicts.map((conflict, index) => <span key={index}>{getConflictMessage(conflict, state.events)}</span>)}</div>}
      {error && <p id="event-form-error" className="form-error" role="alert">{error.message}</p>}
      <div className="form-actions">{initialEvent && <button type="button" className="button danger" onClick={remove}>삭제</button>}<span /><button type="button" className="button ghost" onClick={onClose}>취소</button><button type="submit" className="button primary">{initialEvent ? '변경 저장' : '일정 만들기'}</button></div>
    </form>
  </SidePanel>;
}

function NumberField({ name, label, value, onChange, unit, error }: { name: string; label: string; value: number; onChange: (value: string) => void; unit: string; error?: string }) {
  return <label>{label}<span className="number-input"><input name={name} required type="number" inputMode="numeric" min="0" max={unit === '분' ? 720 : 10000000} step="1" aria-invalid={!!error || undefined} aria-describedby={error} value={Number.isFinite(value) ? value : ''} onChange={(event) => onChange(event.target.value)} /><small>{unit}</small></span></label>;
}

function EventTypesPanel({ onClose }: { onClose: () => void }) {
  const { state, dispatch, resetData, storageBlocked } = useApp();
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
    <div className="danger-zone"><strong>이 브라우저의 일정 지우기</strong><p>이 작업은 되돌릴 수 없으며 다른 기기에는 영향을 주지 않습니다.</p><button className="button danger" onClick={() => { if (window.confirm('모든 일정과 사용자 유형을 초기화할까요?') && resetData()) { setDraft(null); setMessage('기본 유형으로 초기화했습니다.'); } else setMessage('초기화하지 않았습니다.'); }}>전체 초기화</button></div>
  </SidePanel>;
}
