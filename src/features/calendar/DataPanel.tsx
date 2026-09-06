import { useState } from 'react';
import { SidePanel } from '../../app/SidePanel';
import { useApp } from '../../app/AppContext';
import { exportBackup, importBackup, exportIcs, importIcs } from '../../services/interchange';

export function downloadFile(text: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DataPanel({ onClose }: { onClose: () => void }) {
  const { state, dispatch, storageBlocked } = useApp();
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const restore = async (file: File | undefined, kind: 'backup' | 'ics') => {
    if (!file) return;
    setError(''); setMessage('');
    try {
      if (file.size > 5_000_000) throw new Error('5MB 이하의 파일을 선택해 주세요.');
      const text = await file.text();
      if (kind === 'backup') {
        const incoming = importBackup(text);
        if (!window.confirm(`일정 ${incoming.events.length}개가 있는 백업으로 현재 캘린더를 교체할까요? 실행 취소할 수 있습니다.`)) return;
        if (dispatch({ type: 'state/replace', state: incoming })) setMessage('백업을 복원했습니다.');
      } else {
        const incoming = importIcs(text, state.eventTypes);
        const incomingIds = new Set(incoming.events.map((event) => event.id));
        if (!window.confirm(`일정 ${incoming.events.length}개를 가져올까요? 같은 UID의 일정은 갱신합니다.`)) return;
        if (dispatch({ type: 'state/replace', state: { ...state, events: [...state.events.filter((event) => !incomingIds.has(event.id)), ...incoming.events] } })) {
          setMessage(`일정 ${incoming.events.length}개를 가져왔습니다. ${incoming.warnings.join(' ')}`);
        }
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '파일을 읽지 못했습니다.'); }
  };
  return <SidePanel titleId="data-title" onClose={onClose}>
    <div className="panel-header"><h2 id="data-title">백업과 가져오기</h2><button className="icon-button" aria-label="백업 패널 닫기" onClick={onClose}>×</button></div>
    <p className="panel-description">JSON은 유형과 그림자·비용을 모두 보관합니다. ICS는 다른 캘린더와 일정을 주고받는 형식입니다. 내보낸 파일에는 개인정보가 포함됩니다.</p>
    <div className="stack">
      <button className="button primary" onClick={() => downloadFile(exportBackup(state), 'shadow-backup.json', 'application/json')}>JSON 백업 다운로드</button>
      <button className="button ghost" onClick={() => downloadFile(exportIcs(state), 'shadow-calendar.ics', 'text/calendar;charset=utf-8')}>ICS 내보내기</button>
      <label>JSON 백업 복원<input disabled={storageBlocked} type="file" accept=".json,application/json" onChange={(event) => { void restore(event.target.files?.[0], 'backup'); event.target.value = ''; }} /></label>
      <label>ICS 가져오기<input disabled={storageBlocked} type="file" accept=".ics,text/calendar" onChange={(event) => { void restore(event.target.files?.[0], 'ics'); event.target.value = ''; }} /></label>
    </div>
    {message && <p className="form-message" role="status">{message}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </SidePanel>;
}
