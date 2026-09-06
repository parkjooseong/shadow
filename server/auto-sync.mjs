const MINUTE = 60_000;
export const AUTO_SYNC_INTERVALS = [5, 15, 60];
const PAUSE_CODES = new Set(['provider_auth', 'connection_recovery_required', 'integration_not_configured', 'not_connected', 'missing_calendar', 'automation_conflict', 'remote_changed']);

export function defaultAutomation() {
  return { enabled: false, intervalMinutes: 15, status: 'idle', nextRunAt: null, lastRunAt: null, lastError: null, failureCount: 0 };
}

function failureMessage(code, paused) {
  if (code === 'provider_auth') return '외부 캘린더 인증을 확인하거나 다시 연결한 뒤 자동 동기화를 다시 켜 주세요.';
  if (code === 'connection_recovery_required') return '연결 정보를 읽지 못해 자동 동기화를 멈췄습니다. 암호화 키를 복구하거나 다시 연결해 주세요.';
  if (code === 'automation_conflict' || code === 'remote_changed') return '서버와 외부 일정의 충돌을 해결한 뒤 자동 동기화를 다시 켜 주세요.';
  if (code === 'missing_calendar') return '서버에 캘린더를 저장한 뒤 자동 동기화를 다시 켜 주세요.';
  if (paused) return '외부 연결 설정을 확인한 뒤 자동 동기화를 다시 켜 주세요.';
  return '외부 캘린더에 연결하지 못했습니다. 잠시 후 자동으로 다시 시도합니다.';
}

/** Single-process scheduler. User-level exclusion is supplied by the integration service. */
export function createAutoSyncScheduler({ store, run, now = Date.now, pollMs = 30_000, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval }) {
  let timer = null;
  let inFlight = null;
  let stopped = false;
  let schedulerError = null;
  const pendingRecords = new Map();
  const available = () => ['getAutomation', 'saveAutomation', 'listDueAutomations', 'listEnabledAutomations'].every((method) => typeof store[method] === 'function');
  const get = (userId, provider) => store.getAutomation?.(userId, provider) ?? defaultAutomation();
  const save = (userId, provider, value) => { store.saveAutomation(userId, provider, value); return value; };

  function configure(userId, provider, { enabled, intervalMinutes }) {
    if (!available()) throw new Error('Automation storage is unavailable.');
    if (typeof enabled !== 'boolean' || !AUTO_SYNC_INTERVALS.includes(intervalMinutes)) throw new Error('Invalid automation settings.');
    const current = get(userId, provider);
    pendingRecords.delete(`${userId}:${provider}`);
    return save(userId, provider, {
      ...current, enabled, intervalMinutes, status: enabled ? 'scheduled' : 'idle',
      nextRunAt: enabled ? now() + intervalMinutes * MINUTE : null,
      lastError: null, failureCount: 0,
    });
  }

  function writeOutcome(userId, provider, { result, error, deferred = false, manual = false }) {
    const current = get(userId, provider);
    // A user may turn automation off while an authorized run is still completing.
    if (!current.enabled) return current;
    if (deferred) return current.status === 'running' ? save(userId, provider, { ...current, status: current.failureCount ? 'backoff' : 'scheduled', nextRunAt: now() + pollMs }) : current;
    const finishedAt = now();
    const code = result?.conflicts?.length ? 'automation_conflict' : error?.code;
    if (error || code) {
      const paused = PAUSE_CODES.has(code) || (manual && current.status === 'paused');
      const failureCount = Math.min(current.failureCount + 1, 20);
      return save(userId, provider, {
        ...current, status: paused ? 'paused' : 'backoff',
        nextRunAt: paused ? null : finishedAt + Math.min(60, current.intervalMinutes * 2 ** Math.min(failureCount, 6)) * MINUTE,
        lastRunAt: finishedAt, lastError: failureMessage(code, paused), failureCount,
      });
    }
    // Resolving a conflict manually does not silently re-enable paused automation.
    if (manual && current.status === 'paused') return save(userId, provider, { ...current, lastRunAt: finishedAt });
    return save(userId, provider, {
      ...current, status: 'scheduled', nextRunAt: finishedAt + current.intervalMinutes * MINUTE,
      lastRunAt: finishedAt, failureCount: 0,
      lastError: result?.warnings?.length ? '지원되지 않는 일부 외부 일정은 원본을 보존했습니다. 수동 동기화 결과에서 상세 내용을 확인할 수 있습니다.' : null,
    });
  }

  function record(userId, provider, outcome) {
    const key = `${userId}:${provider}`;
    pendingRecords.set(key, { userId, provider, outcome });
    const value = writeOutcome(userId, provider, outcome);
    pendingRecords.delete(key);
    return value;
  }

  async function runTick() {
    let runs = 0;
    if (!available()) { schedulerError = '자동 동기화 저장소를 사용할 수 없습니다.'; return { runs, error: schedulerError }; }
    try {
      for (const { userId, provider, outcome } of pendingRecords.values()) record(userId, provider, outcome);
      // Bound each polling batch; next-run ordering keeps overdue users ahead of completed jobs.
      const due = store.listDueAutomations(now()).sort((a, b) => a.nextRunAt - b.nextRunAt).slice(0, 20);
      for (const entry of due) {
        if (stopped) break;
        const { userId, provider } = entry;
        const current = get(userId, provider);
        if (!current.enabled || !['scheduled', 'backoff'].includes(current.status) || current.nextRunAt === null || current.nextRunAt > now()) continue;
        save(userId, provider, { ...current, status: 'running', nextRunAt: null });
        let result, error;
        try { result = await run(userId, provider); }
        catch (cause) { error = cause; }
        if (result?.deferred) { record(userId, provider, { deferred: true }); continue; }
        runs++;
        record(userId, provider, { result, error });
      }
      schedulerError = null;
      return { runs };
    } catch {
      // Expose infrastructure failures in the API without logging credentials or payloads.
      schedulerError = '자동 동기화 상태를 저장하지 못했습니다. 서버 저장소를 확인해 주세요.';
      return { runs, error: schedulerError };
    }
  }

  function tick() {
    if (stopped) return Promise.resolve({ runs: 0 });
    if (inFlight) return inFlight;
    inFlight = runTick().finally(() => { inFlight = null; });
    return inFlight;
  }

  function start() {
    if (timer) return;
    stopped = false;
    if (available()) {
      try {
        for (const { userId, provider, ...current } of store.listEnabledAutomations()) {
          if (current.status !== 'running') continue;
          save(userId, provider, { ...current, status: 'backoff', nextRunAt: now() + 5 * MINUTE, lastError: '서버가 재시작되어 이전 실행 상태를 확인하지 못했습니다. 5분 후 안전하게 다시 확인합니다.' });
        }
      } catch { schedulerError = '자동 동기화의 이전 실행 상태를 복구하지 못했습니다. 서버 저장소를 확인해 주세요.'; }
    }
    timer = setIntervalImpl(() => { void tick(); }, pollMs);
    timer?.unref?.();
    void tick();
  }

  async function stop() {
    stopped = true;
    if (timer) clearIntervalImpl(timer);
    timer = null;
    await inFlight;
  }

  return { get, configure, record, tick, start, stop, status: () => ({ running: timer !== null && !stopped, error: schedulerError }) };
}
