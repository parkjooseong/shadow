import { useEffect, useRef, useState } from 'react';
import { api } from '../../services/api';
import { SidePanel } from '../../app/SidePanel';

interface Capabilities { mail: { available: boolean; mode: string }; passwordReset: { available: boolean }; emailVerification: { available: boolean } }
const errorText = (error: unknown) => error instanceof Error ? error.message : '요청을 처리하지 못했습니다.';
export function sessionChanged() { window.dispatchEvent(new Event('shadow:session-changed')); }

function useCapabilities() {
  const [capabilities, setCapabilities] = useState<Capabilities>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void api<Capabilities>('/api/auth/capabilities').then((result) => { if (active) setCapabilities(result); }).catch((cause: unknown) => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, []);
  return { capabilities, error };
}

function RecoveryForm() {
  const { capabilities, error: capabilityError } = useCapabilities();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  return <form className="stack" onSubmit={(event) => {
    event.preventDefault();
    if (inFlight.current || !capabilities?.passwordReset.available) return;
    const email = new FormData(event.currentTarget).get('recoveryEmail');
    inFlight.current = true; setBusy(true); setError(''); setMessage('');
    void api<{ message: string }>('/api/auth/password-reset/request', 'POST', { email }).then((result) => setMessage(result.message)).catch((cause: unknown) => setError(errorText(cause))).finally(() => { inFlight.current = false; setBusy(false); });
  }}>
    <p className="panel-description">가입한 주소로 일회용 비밀번호 재설정 링크를 요청합니다. 계정 존재 여부는 표시하지 않습니다.</p>
    <label>복구 이메일<input type="email" name="recoveryEmail" required maxLength={254} autoComplete="email" disabled={busy} /></label>
    <button className="button primary" disabled={busy || !capabilities?.passwordReset.available}>재설정 메일 요청</button>
    {capabilities && !capabilities.passwordReset.available && <p className="panel-description">서버 메일 전송이 설정되지 않았습니다. 운영자가 메일 설정을 완료해야 복구할 수 있습니다.</p>}
    {capabilities?.mail.mode === 'outbox' && <p className="panel-description">개발 모드: 메일은 발송하지 않고 서버의 보호된 개발용 메일함에 저장합니다.</p>}
    {(error || capabilityError) && <p className="form-error" role="alert">{error || capabilityError}</p>}
    {message && <p role="status">{message}</p>}
  </form>;
}

export function PasswordRecovery() {
  const [open, setOpen] = useState(false);
  return <section className="account-section"><button className="text-button" aria-expanded={open} onClick={() => setOpen(!open)}>비밀번호를 잊으셨나요?</button>{open && <RecoveryForm />}</section>;
}

export function AccountSecurity({ user, onSignedOut }: { user: { id: string; emailVerified?: boolean }; onSignedOut: () => void }) {
  const { capabilities, error: capabilityError } = useCapabilities();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const run = async (work: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(''); setMessage('');
    try { await work(); } catch (cause) { setError(errorText(cause)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <section className="account-section"><h3>계정 보안</h3>
    <p>이메일 {user.emailVerified ? '확인 완료' : '미확인'}</p>
    {!user.emailVerified && <button className="button ghost" disabled={busy || !capabilities?.emailVerification.available} onClick={() => void run(async () => {
      const result = await api<{ message: string }>('/api/auth/email-verification/request', 'POST', {}, { accountId: user.id });
      setMessage(result.message);
    })}>이메일 확인 메일 요청</button>}
    {capabilities && !capabilities.mail.available && <p className="panel-description">메일 미설정: 이메일 확인·분실 복구는 운영자가 SMTP를 설정한 뒤 사용할 수 있습니다.</p>}
    {capabilities?.mail.mode === 'outbox' && <p className="panel-description">개발 모드에서는 서버의 보호된 개발용 메일함에 저장합니다.</p>}
    <form className="stack" onSubmit={(event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      if (data.get('password') !== data.get('confirmation')) { setError('새 비밀번호 확인이 일치하지 않습니다.'); return; }
      void run(async () => {
        if (!window.confirm('비밀번호를 변경하고 모든 기기에서 로그아웃할까요? 일정은 그대로 유지됩니다.')) return;
        await api('/api/auth/password/change', 'POST', { currentPassword: data.get('currentPassword'), password: data.get('password') }, { accountId: user.id });
        form.reset(); sessionChanged(); onSignedOut();
      });
    }}>
      <label>현재 비밀번호<input name="currentPassword" type="password" required minLength={10} maxLength={128} autoComplete="current-password" disabled={busy} /></label>
      <label>새 비밀번호<input name="password" type="password" required minLength={10} maxLength={128} autoComplete="new-password" disabled={busy} /></label>
      <label>새 비밀번호 확인<input name="confirmation" type="password" required minLength={10} maxLength={128} autoComplete="new-password" disabled={busy} /></label>
      <button className="button primary" disabled={busy}>비밀번호 변경</button>
    </form>
    <button className="button ghost" disabled={busy} onClick={() => void run(async () => {
      if (!window.confirm('현재 기기를 제외한 모든 로그인 세션을 종료할까요?')) return;
      const result = await api<{ revokedSessions: number }>('/api/auth/sessions/revoke-others', 'POST', {}, { accountId: user.id });
      setMessage(`다른 로그인 세션 ${result.revokedSessions}개를 종료했습니다.`);
    })}>다른 기기 로그아웃</button>
    {(error || capabilityError) && <p className="form-error" role="alert">{error || capabilityError}</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}

export interface AccountAction { kind: 'reset-password' | 'verify-email'; token: string }
export function readAccountAction(): AccountAction | null {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  if (hash.has('share')) return null;
  const kind = hash.get('account-action');
  if (kind !== 'reset-password' && kind !== 'verify-email') return null;
  return { kind, token: hash.get('token') ?? '' };
}

export function AccountActionPanel({ action, onClose }: { action: AccountAction; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState('');
  const reset = action.kind === 'reset-password';
  const valid = /^[A-Za-z0-9_-]{43}$/.test(action.token);
  useEffect(() => { history.replaceState(history.state, '', window.location.pathname + window.location.search); }, []);
  const confirm = async (password?: string) => {
    if (inFlight.current || !valid) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      await api(`/api/auth/${reset ? 'password-reset' : 'email-verification'}/confirm`, 'POST', { token: action.token, ...(reset ? { password } : {}) });
      if (reset) sessionChanged();
      setComplete(true);
    } catch (cause) { setError(errorText(cause)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <SidePanel titleId="account-action-title" onClose={onClose}>
    <div className="panel-header"><h2 id="account-action-title">{reset ? '비밀번호 재설정' : '이메일 확인'}</h2><button className="icon-button" aria-label="계정 확인 패널 닫기" onClick={onClose}>×</button></div>
    {!valid ? <p role="alert" className="form-error">링크가 올바르지 않습니다. 새 메일을 요청해 주세요.</p>
      : complete ? <p role="status">{reset ? '비밀번호를 재설정하고 모든 기기의 세션을 종료했습니다. 새 비밀번호로 로그인해 주세요.' : '이메일을 확인했습니다. 계정 패널을 다시 열면 확인 상태가 표시됩니다.'}</p>
      : reset ? <form className="stack" onSubmit={(event) => {
        event.preventDefault(); const data = new FormData(event.currentTarget);
        if (data.get('password') !== data.get('confirmation')) { setError('비밀번호 확인이 일치하지 않습니다.'); return; }
        void confirm(String(data.get('password')));
      }}>
        <p className="panel-description">10~128자의 새 비밀번호를 입력하세요. 완료하면 기존의 모든 로그인 세션이 종료됩니다.</p>
        <label>재설정 비밀번호<input name="password" type="password" required minLength={10} maxLength={128} autoComplete="new-password" disabled={busy} /></label>
        <label>재설정 비밀번호 확인<input name="confirmation" type="password" required minLength={10} maxLength={128} autoComplete="new-password" disabled={busy} /></label>
        <button className="button primary" disabled={busy}>새 비밀번호 저장</button>
      </form> : <><p>아래 버튼을 누르면 이메일 소유 확인을 완료합니다. 링크를 열기만 해서는 처리하지 않습니다.</p><button className="button primary" disabled={busy} onClick={() => void confirm()}>이메일 확인 완료</button></>}
    {error && <p role="alert" className="form-error">{error} 만료되었거나 이미 사용한 링크라면 새 메일을 요청해 주세요.</p>}
    {complete && <button className="button primary" onClick={onClose}>캘린더로 돌아가기</button>}
  </SidePanel>;
}
