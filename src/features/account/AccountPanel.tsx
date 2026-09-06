import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../../app/AppContext';
import { SidePanel } from '../../app/SidePanel';
import type { AppState } from '../../domain/types';
import { isAppState } from '../../domain/validation';
import { api, ApiError } from '../../services/api';

interface User { id: string; email: string; name: string }
interface CloudState { state: AppState | null; revision: number }
interface Share { id: string; token: string; title: string; createdAt: string }
interface Connection { id: string; configured: boolean; connected: boolean; lastSyncedAt?: string | null; configurationError?: string | null; lastError?: string | null; conflicts?: { id: string; title: string; reason: string }[] }
const names: Record<string, string> = { google: 'Google Calendar', microsoft: 'Outlook Calendar', apple: 'Apple iCloud' };
const authorizationHosts: Record<string, string> = { google: 'accounts.google.com', microsoft: 'login.microsoftonline.com' };

function validateCloudState(cloud: CloudState) {
  if (!cloud || !Number.isSafeInteger(cloud.revision) || cloud.revision < 0 || cloud.state !== null && !isAppState(cloud.state)) {
    throw new Error('서버 캘린더 형식이 올바르지 않습니다.');
  }
  return cloud;
}

const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : '요청에 실패했습니다.';

export function AccountPanel({ onClose }: { onClose: () => void }) {
  const { state, dispatch, storageBlocked } = useApp();
  const [user, setUser] = useState<User | null>(null);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const inFlight = useRef(false);
  const [remote, setRemote] = useState<CloudState>();
  const [shares, setShares] = useState<Share[]>([]);
  const [providers, setProviders] = useState<Connection[]>([]);
  const [shareTitle, setShareTitle] = useState('SHADOW 일정 공유');
  const conflicts = providers.flatMap((provider) => (provider.conflicts ?? []).map((conflict) => ({ ...conflict, provider: provider.id })));

  const run = async (work: () => Promise<void>) => {
    if (inFlight.current || checkingSession) return;
    inFlight.current = true;
    setBusy(true); setError(''); setMessage('');
    try { await work(); } catch (cause) { setError(errorMessage(cause)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const refresh = useCallback(async (isActive: () => boolean = () => true) => {
    const results = await Promise.allSettled([
      api<CloudState>('/api/state'), api<{ shares: Share[] }>('/api/shares'), api<{ providers: Connection[] }>('/api/integrations'),
    ]);
    if (!isActive()) return;
    const [cloud, links, connections] = results;
    const errors: string[] = [];
    if (cloud.status === 'fulfilled') {
      try { setRemote(validateCloudState(cloud.value)); }
      catch (cause) { setRemote(undefined); errors.push(errorMessage(cause)); }
    } else { setRemote(undefined); errors.push(errorMessage(cloud.reason)); }
    if (links.status === 'fulfilled') setShares(links.value.shares);
    else errors.push(`공유 목록: ${errorMessage(links.reason)}`);
    if (connections.status === 'fulfilled') setProviders(connections.value.providers);
    else errors.push(`외부 캘린더: ${errorMessage(connections.reason)}`);
    if (errors.length) throw new Error(errors.join(' '));
  }, []);
  useEffect(() => {
    let active = true;
    void api<{ user: User | null }>('/api/auth/me').then(async (result) => {
      if (!active) return;
      setUser(result.user);
      if (result.user) await refresh(() => active);
    }).catch((cause: unknown) => { if (active) setError(errorMessage(cause)); })
      .finally(() => { if (active) setCheckingSession(false); });
    return () => { active = false; };
  }, [refresh]);
  const authenticate = (form: HTMLFormElement) => {
    const data = new FormData(form);
    void run(async () => {
      const result = await api<{ user: User }>(`/api/auth/${mode}`, 'POST', { email: data.get('email'), password: data.get('password'), name: data.get('name') });
      setUser(result.user);
      form.reset();
      await refresh();
      setMessage('연결되었습니다. 아래에서 서버와 이 브라우저의 캘린더를 확인하고 동기화하세요.');
    });
  };
  const upload = () => void run(async () => {
    if (!remote) throw new Error('먼저 서버 상태를 확인해 주세요.');
    if (remote.state && !window.confirm('이 브라우저의 일정으로 서버 캘린더를 교체할까요? 다른 기기에서 변경된 경우에는 중단됩니다.')) return;
    let result: { revision: number };
    try {
      result = await api<{ revision: number }>('/api/state', 'PUT', { state, revision: remote.revision });
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setRemote(undefined);
        throw new Error('다른 기기에서 서버 일정이 변경되었습니다. 브라우저 일정은 유지됩니다. 서버 상태 새로고침으로 최신 버전을 확인하거나 서버 데이터를 가져와 주세요.');
      }
      throw cause;
    }
    if (!Number.isSafeInteger(result.revision) || result.revision < 1) throw new Error('서버 저장 결과를 확인할 수 없습니다. 서버 상태를 새로고침해 주세요.');
    setRemote({ state, revision: result.revision });
    setMessage('서버에 저장했습니다. 다른 기기에서 서버 데이터 가져오기를 누르면 반영됩니다.');
  });
  const pull = () => void run(async () => {
    const latest = validateCloudState(await api<CloudState>('/api/state'));
    setRemote(latest);
    if (!latest.state) throw new Error('서버에 저장된 일정이 없습니다.');
    if (window.confirm('서버 캘린더로 이 브라우저의 일정을 교체할까요? 실행 취소할 수 있습니다.')) {
      if (!dispatch({ type: 'state/replace', state: latest.state })) throw new Error('브라우저에 일정을 적용하지 못했습니다. 로컬 저장 상태를 확인해 주세요.');
      setMessage('서버 캘린더를 가져왔습니다.');
    }
  });
  const sync = (provider: string) => void run(async () => {
    if (!window.confirm('서버 캘린더와 외부 SHADOW 캘린더를 양방향으로 동기화할까요? 수정·삭제도 반영됩니다. 이 브라우저 변경사항은 먼저 서버에 저장해 주세요.')) return;
    const result = await api<{ imported: number; exported: number; deleted: number; conflicts: { id: string; title: string; reason: string }[]; warnings: string[] }>(`/api/integrations/${provider}/sync`, 'POST', {});
    await refresh();
    setMessage(`가져오기 ${result.imported} · 내보내기 ${result.exported} · 삭제 ${result.deleted}. ${(result.warnings ?? []).join(' ')} 서버 데이터 가져오기로 이 브라우저에도 반영하세요.`);
  });

  return <SidePanel titleId="account-title" className="type-panel" onClose={onClose}>
    <div className="panel-header"><h2 id="account-title">계정과 동기화</h2><button className="icon-button" aria-label="계정 패널 닫기" onClick={onClose}>×</button></div>
    {!user ? <>
      <p className="panel-description">계정을 사용하면 캘린더를 서버에 보관하고 다른 기기와 공유할 수 있습니다. 로컬 데이터는 로그인만으로 업로드되지 않습니다.</p>
      <form className="stack" onSubmit={(event) => { event.preventDefault(); authenticate(event.currentTarget); }}>
        {mode === 'register' && <label>이름<input name="name" required maxLength={50} autoComplete="name" disabled={busy || checkingSession} /></label>}
        <label>이메일<input type="email" name="email" required maxLength={254} autoComplete="email" disabled={busy || checkingSession} /></label>
        <label>비밀번호<input type="password" name="password" required minLength={10} maxLength={128} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} disabled={busy || checkingSession} /></label>
        <p className="panel-description">비밀번호는 10~128자로 입력해 주세요.</p>
        <button disabled={busy || checkingSession} className="button primary">{mode === 'register' ? '계정 만들기' : '로그인'}</button>
        <button type="button" disabled={busy || checkingSession} className="button ghost" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>{mode === 'login' ? '회원가입으로 전환' : '로그인으로 전환'}</button>
      </form>
    </> : <>
      <p>{user.name} · {user.email}</p>
      <button className="button ghost" disabled={busy || checkingSession} onClick={() => void run(async () => {
        try { await api('/api/auth/logout', 'POST', {}); } catch (cause) { if (!(cause instanceof ApiError) || cause.status !== 401) throw cause; }
        setUser(null); setRemote(undefined); setProviders([]); setShares([]); setShareTitle('SHADOW 일정 공유');
        setMessage('로그아웃했습니다. 이 브라우저의 데이터는 남아 있습니다. 공유 기기에서는 백업 후 전체 초기화를 이용하세요.');
      })}>로그아웃</button>
      <section className="account-section"><h3>서버 캘린더</h3>
        <p className="panel-description">브라우저 {state.events.length}개 · 서버 {remote ? `${remote.state?.events.length ?? 0}개` : '확인 필요'} · 버전 {remote?.revision ?? '—'}. 내용이 다른 경우 자동으로 덮어쓰지 않습니다.</p>
        <div className="stack"><button disabled={busy || checkingSession || storageBlocked || !remote} className="button primary" onClick={upload}>이 브라우저 데이터를 서버에 저장</button><button disabled={busy || checkingSession || storageBlocked} className="button ghost" onClick={pull}>서버 데이터 가져오기</button><button disabled={busy || checkingSession} className="button ghost" onClick={() => void run(() => refresh())}>서버 상태 새로고침</button></div>
      </section>
      <section className="account-section"><h3>읽기 전용 공유</h3>
        <p className="panel-description">현재 캘린더의 복사본을 공유합니다. 제목·장소·시간·비용을 링크를 가진 사람이 볼 수 있습니다. 이후 수정은 기존 공유본에 반영되지 않습니다.</p>
        <label>공유 제목<input value={shareTitle} maxLength={100} disabled={busy || checkingSession || storageBlocked} onChange={(event) => setShareTitle(event.target.value)} /></label>
        <button disabled={busy || checkingSession || storageBlocked || !shareTitle.trim()} className="button primary" onClick={() => void run(async () => {
          if (!window.confirm('현재 캘린더 전체의 읽기 전용 공유 링크를 만들까요? 개인정보와 비용이 포함됩니다.')) return;
          await api('/api/shares', 'POST', { title: shareTitle.trim(), state });
          await refresh();
          setMessage('읽기 전용 공유 링크를 만들었습니다. 링크를 열어 내용을 확인할 수 있습니다.');
        })}>공유 링크 만들기</button>
        {shares.map((share) => <article className="share-row" key={share.id}><a target="_blank" rel="noreferrer" href={`/#share=${encodeURIComponent(share.token)}`}>{share.title}</a><button className="text-button danger-text" disabled={busy} onClick={() => void run(async () => { if (window.confirm('이 공유 링크를 폐기할까요?')) { await api(`/api/shares/${share.id}`, 'DELETE'); await refresh(); } })}>폐기</button></article>)}
      </section>
      <section className="account-section"><h3>외부 캘린더 양방향 연동</h3>
        <p className="panel-description">연결 후 동기화를 누르면 외부 계정에 전용 SHADOW 캘린더를 만듭니다. 일반 캘린더의 다른 일정은 변경하지 않습니다.</p>
        {!providers.length && !checkingSession && <p className="panel-description">외부 제공자 설정을 확인할 수 없습니다. 서버 상태 새로고침으로 다시 확인해 주세요.</p>}
        {providers.map((provider) => <article className="integration-card" key={provider.id}>
          <strong>{names[provider.id] ?? provider.id}</strong>
          <p className="panel-description">{provider.connected ? `연결됨 · 마지막 동기화 ${provider.lastSyncedAt ?? '아직 없음'}` : provider.configured ? '연결할 수 있습니다.' : provider.configurationError ?? '서버에 제공자 앱 정보와 암호화 키를 설정해 주세요.'}</p>
          {provider.lastError && <p className="form-error">마지막 동기화 오류: {provider.lastError}</p>}
          {provider.connected ? <div className="actions-wrap"><button className="button primary" disabled={busy} onClick={() => sync(provider.id)}>양방향 동기화</button><button className="button ghost" disabled={busy} onClick={() => void run(async () => { if (window.confirm('연결을 해제할까요? 외부 캘린더와 일정은 유지됩니다.')) { await api(`/api/integrations/${provider.id}`, 'DELETE'); await refresh(); } })}>연결 해제</button></div>
          : provider.id === 'apple' ? <form className="stack" autoComplete="off" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); void run(async () => { await api('/api/integrations/apple/connect', 'POST', { username: data.get('username'), password: data.get('password') }); form.reset(); await refresh(); }); }}>
            <label>Apple 계정 이메일<input name="username" type="email" required maxLength={254} disabled={busy || checkingSession || !provider.configured} autoComplete="off" /></label><label>앱 전용 비밀번호<input name="password" type="password" required minLength={19} maxLength={19} pattern="[A-Za-z]{4}(-[A-Za-z]{4}){3}" title="xxxx-xxxx-xxxx-xxxx 형식의 앱 전용 암호" disabled={busy || checkingSession || !provider.configured} autoComplete="new-password" /></label>
            <button className="button ghost" disabled={busy || !provider.configured}>Apple 연결</button>
          </form> : <button className="button ghost" disabled={busy || checkingSession || !provider.configured} onClick={() => void run(async () => { const { url } = await api<{ url: string }>(`/api/integrations/${provider.id}/connect`, 'POST', {}); const target = new URL(url); if (target.protocol !== 'https:' || target.hostname !== authorizationHosts[provider.id] || target.username || target.password || target.port) throw new Error('올바르지 않은 인증 주소입니다.'); window.location.assign(url); })}>{names[provider.id]} 연결</button>}
        </article>)}
        {conflicts.map((conflict) => <article className="form-conflicts" key={`${conflict.provider}-${conflict.id}`}><strong>{names[conflict.provider]} · {conflict.title}</strong><p>{conflict.reason}</p><div className="actions-wrap">{(['local', 'remote'] as const).map((choice) => <button disabled={busy || checkingSession} className="button ghost" key={choice} onClick={() => void run(async () => { await api(`/api/integrations/${conflict.provider}/resolve`, 'POST', { conflictId: conflict.id, choice }); await refresh(); setMessage('선택한 버전으로 동기화를 실행했습니다. 남은 충돌을 확인하고 서버 데이터 가져오기로 이 브라우저에도 반영하세요.'); })}>{choice === 'local' ? 'SHADOW 서버 버전 사용' : '외부 버전 사용'}</button>)}</div></article>)}
      </section>
    </>}
    {(busy || checkingSession) && <p role="status">{checkingSession ? '계정 상태 확인 중…' : '처리 중…'}</p>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {message && <p role="status" className="form-message">{message}</p>}
  </SidePanel>;
}
