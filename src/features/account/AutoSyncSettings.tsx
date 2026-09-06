import { useState } from 'react';
import { api } from '../../services/api';
import { useCloudSync } from './CloudSyncProvider';

export interface Automation {
  enabled: boolean;
  intervalMinutes: number;
  status: 'idle' | 'scheduled' | 'running' | 'backoff' | 'paused';
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastError: string | null;
}
const failureText = (cause: unknown) => cause instanceof Error ? cause.message : '자동 동기화 설정을 저장하지 못했습니다.';
const time = (value: number | null) => value ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '없음';

export function CloudSyncSettings({ userId, disabled }: { userId: string; disabled: boolean }) {
  const sync = useCloudSync();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!sync) return null;
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(''); try { await work(); } catch (cause) { setError(failureText(cause)); } finally { setBusy(false); } };
  const enabled = sync.settings?.userId === userId && !sync.settings.paused;
  return <section className="account-section"><h3>이 브라우저 자동 동기화</h3>
    <p className="panel-description">켜면 일정·그림자·비용을 서버와 자동으로 주고받습니다. 편집 패널을 닫은 동안 변경 후 약 1초, 서버 변경은 15초 간격으로 확인합니다. 양쪽이 함께 바뀌면 멈추며 오프라인에서는 재연결을 기다립니다.</p>
    <p role="status">{sync.message}</p>
    <div className="actions-wrap"><button className="button primary" disabled={busy || disabled || enabled} onClick={() => void run(async () => {
      if (window.confirm('이 브라우저와 로그인 계정의 자동 동기화를 켤까요? 일정과 비용이 서버로 전송되며 수정·삭제가 반영됩니다. 서버가 비어 있으면 이 브라우저 데이터를 먼저 저장합니다.')) await sync.enable(userId);
    })}>{sync.settings?.paused ? '자동 동기화 다시 켜기' : '자동 동기화 켜기'}</button><button className="button ghost" disabled={busy || (!sync.settings && sync.status !== 'error')} onClick={() => void run(sync.disable)}>자동 동기화 끄기</button></div>
    {error && <p role="alert" className="form-error">{error}</p>}
  </section>;
}

export function ProviderAutoSync({ provider, userId, automation, disabled, onUpdated }: { provider: string; userId: string; automation?: Automation; disabled: boolean; onUpdated: () => Promise<void> }) {
  const [interval, setInterval] = useState(automation?.intervalMinutes ?? 15);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async (enabled: boolean) => {
    if (busy) return;
    if (enabled && !window.confirm('서버가 켜져 있는 동안 외부 SHADOW 캘린더와 자동으로 수정·삭제를 동기화할까요? 이 브라우저를 닫아도 서버에 저장된 일정은 외부 제공자와 주고받습니다.')) return;
    setBusy(true); setError('');
    try { await api(`/api/integrations/${provider}/automation`, 'PUT', { enabled, intervalMinutes: interval }, { accountId: userId }); await onUpdated(); }
    catch (cause) { setError(failureText(cause)); }
    finally { setBusy(false); }
  };
  const status = { idle: '꺼짐', scheduled: '예약됨', running: '실행 중', backoff: '오류 후 재시도 대기', paused: '확인 필요 · 일시 정지' };
  return <div className="stack">
    <label>외부 자동 동기화 간격<select value={interval} disabled={busy || disabled} onChange={(event) => setInterval(Number(event.target.value))}><option value={5}>5분</option><option value={15}>15분</option><option value={60}>60분</option></select></label>
    <p className="panel-description">{status[automation?.status ?? 'idle']} · 마지막 {time(automation?.lastRunAt ?? null)} · 다음 {time(automation?.nextRunAt ?? null)}</p>
    {automation?.lastError && <p className="form-error">{automation.lastError}</p>}
    <div className="actions-wrap"><button className="button ghost" disabled={busy || disabled} onClick={() => void save(true)}>{automation?.status === 'paused' ? '외부 자동 동기화 재개' : automation?.enabled ? '외부 자동 동기화 간격 저장' : '외부 자동 동기화 켜기'}</button><button className="button ghost" disabled={busy || !automation?.enabled} onClick={() => void save(false)}>외부 자동 동기화 끄기</button></div>
    {error && <p role="alert" className="form-error">{error}</p>}
  </div>;
}
