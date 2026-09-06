import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getEventValidationError, isAppState } from '../../src/domain/validation.ts';
import { IntegrationError, fail, fingerprint, remoteToLocal } from './common.mjs';
import { createOAuthAdapter, exchangeToken, oauthConfig } from './providers.mjs';
import { createCalDavAdapter } from './caldav.mjs';

const PROVIDERS = ['google', 'microsoft', 'apple'];
const publicConflicts = (conflicts = []) => conflicts.map(({ id, eventId, title, reason }) => ({ id, eventId, title, reason }));

export function createIntegrationService({ store, env = process.env, fetchImpl = fetch, now = Date.now, adapterFactory } = {}) {
  const busyUsers = new Set();
  const publicOrigin = () => {
    let url;
    try { url = new URL(env.SHADOW_PUBLIC_URL || env.SHADOW_ORIGIN || 'http://localhost:5173'); } catch { fail('invalid_configuration', 'SHADOW_PUBLIC_URL 설정을 확인해 주세요.', 503); }
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) fail('invalid_configuration', '외부 연결은 HTTPS 공개 주소 또는 로컬 주소가 필요합니다.', 503);
    return url.origin;
  };
  const configured = (provider) => {
    if (!store.encryptionAvailable) return '서버 암호화 키 SHADOW_ENCRYPTION_KEY 설정이 필요합니다.';
    try { publicOrigin(); } catch (error) { return error.message; }
    if (provider !== 'apple') {
      const config = oauthConfig(provider, env);
      if (!config.clientId || !config.clientSecret) return `${provider === 'google' ? 'Google' : 'Microsoft'} OAuth 클라이언트 설정이 필요합니다.`;
    }
    return null;
  };
  const save = (userId, provider, connection) => store.saveConnection(userId, provider, connection);
  const newConnection = (credentials) => ({ credentials, calendarId: null, cursor: null, mappings: {}, remoteCache: {}, conflicts: [], lastSyncedAt: null });
  const connectionFor = (userId, provider) => {
    const error = configured(provider);
    if (error) fail('integration_not_configured', error, 503);
    const connection = store.getConnection(userId, provider);
    if (!connection) fail('not_connected', '캘린더를 먼저 연결해 주세요.', 409);
    return connection;
  };
  const adapter = async (userId, provider, connection, state) => {
    if (adapterFactory) return adapterFactory({ provider, connection, state });
    if (provider === 'apple') {
      const { importIcs, exportIcs } = await import('../../src/services/interchange.ts');
      return createCalDavAdapter({ connection, fetchImpl, eventTypes: state?.eventTypes || [], importIcs, exportIcs });
    }
    let credentials = connection.credentials;
    if (credentials.expiresAt < now() + 60000) {
      if (!credentials.refreshToken) fail('provider_auth', '인증이 만료되었습니다. 캘린더를 다시 연결해 주세요.', 401);
      const token = await exchangeToken(fetchImpl, oauthConfig(provider, env), { grant_type: 'refresh_token', refresh_token: credentials.refreshToken });
      credentials = { accessToken: token.access_token, refreshToken: token.refresh_token || credentials.refreshToken, expiresAt: now() + Number(token.expires_in) * 1000 };
      connection.credentials = credentials;
      save(userId, provider, connection);
    }
    return createOAuthAdapter({ provider, connection, fetchImpl, accessToken: credentials.accessToken });
  };

  async function sync(userId, provider, resolution) {
    const connection = connectionFor(userId, provider);
    const initial = store.getState(userId);
    if (!initial.state) fail('missing_calendar', '먼저 내 계정에 캘린더를 저장해 주세요.', 409);
    const api = await adapter(userId, provider, connection, initial.state);
    const result = { imported: 0, exported: 0, deleted: 0, conflicts: [], warnings: [] };
    try {
      await api.ensureCalendar();
      save(userId, provider, connection);
      const remote = await api.list();
      const nextCache = remote.full ? {} : { ...connection.remoteCache };
      for (const item of remote.items) {
        if (typeof item.id !== 'string' || !item.id || (!item.deleted && !item.unsupported && !item.etag)) fail('invalid_provider_response', '외부 일정 식별자 또는 버전이 없습니다.', 502);
        nextCache[item.id] = item;
      }
      if (remote.full) for (const id of Object.keys(connection.remoteCache)) if (!nextCache[id]) nextCache[id] = { id, deleted: true, etag: 'deleted' };
      for (const item of Object.values(nextCache)) {
        if (item.masterId && nextCache[item.masterId] && !nextCache[item.masterId].deleted) {
          nextCache[item.masterId] = { ...nextCache[item.masterId], unsupported: true, warning: item.warning };
        }
      }
      connection.remoteCache = nextCache;
      // Cache remote snapshots before consuming cursors so unresolved conflicts survive incremental sync.
      connection.cursor = remote.cursor;
      const previousConflicts = connection.conflicts;
      connection.conflicts = [];
      save(userId, provider, connection);

      const conflictFingerprint = (mapping, remoteItem, local) => {
        if (!remoteItem.deleted) return fingerprint(local);
        // Deleting a series also deletes its exceptions. Bind the user's choice
        // to every affected stored event, including local-only shadow/cost edits.
        const affected = (store.getState(userId).state?.events || [])
          .filter((event) => event.id === mapping.localId || event.sourceId === mapping.localId)
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((event) => Object.fromEntries(Object.entries(event).sort(([left], [right]) => left.localeCompare(right))));
        return `delete:${createHash('sha256').update(JSON.stringify(affected)).digest('hex')}`;
      };

      const conflict = (mapping, remoteItem, local, reason) => {
        const previous = previousConflicts.find((item) => item.eventId === mapping.localId && item.remoteId === remoteItem.id);
        const item = { id: previous?.id || randomUUID(), eventId: mapping.localId, remoteId: remoteItem.id, title: local?.title || remoteItem.fields?.title || '삭제된 일정', reason, localFingerprint: conflictFingerprint(mapping, remoteItem, local), remoteEtag: remoteItem.etag };
        connection.conflicts.push(item);
        return item;
      };

      const applyRemote = (mapping, remoteItem, local) => {
        const latest = store.getState(userId);
        const current = latest.state?.events.find((event) => event.id === mapping.localId);
        if (!latest.state || fingerprint(current) !== fingerprint(local)) {
          conflict(mapping, remoteItem, current, '동기화 중 내 일정이 수정되었습니다.'); return false;
        }
        let events = latest.state.events.filter((event) => event.id !== mapping.localId && (!remoteItem.deleted || event.sourceId !== mapping.localId));
        let merged;
        if (!remoteItem.deleted) {
          merged = remoteToLocal(remoteItem.fields, current, latest.state.eventTypes, now());
          merged.id = mapping.localId;
          if (merged.sourceId && merged.recurrence) { delete merged.sourceId; delete merged.occurrenceDate; }
          const validation = getEventValidationError(merged, latest.state.eventTypes);
          if (validation) { result.warnings.push(`외부 일정 가져오기 보류: ${validation}`); return false; }
          events = [...events.map((event) => {
            if (event.sourceId === merged.id && (!merged.recurrence || !merged.excludedDates?.includes(event.occurrenceDate))) {
              const standalone = { ...event };
              delete standalone.sourceId; delete standalone.occurrenceDate;
              return standalone;
            }
            return event;
          }), merged];
        }
        const updatedState = { ...latest.state, events };
        if (!isAppState(updatedState)) { result.warnings.push('반복 일정 관계를 안전하게 병합할 수 없어 외부 변경을 보류했습니다.'); return false; }
        const saved = store.saveState(userId, updatedState, latest.revision);
        if (!saved.ok) { conflict(mapping, remoteItem, current, '다른 기기에서 내 캘린더가 수정되었습니다.'); return false; }
        mapping.localFingerprint = fingerprint(merged);
        mapping.remoteEtag = remoteItem.etag;
        mapping.deleted = !!remoteItem.deleted;
        if (remoteItem.deleted) result.deleted++; else result.imported++;
        return true;
      };

      for (const [remoteId, mapping] of Object.entries(connection.mappings)) {
        const item = nextCache[remoteId];
        if (!item) continue;
        const local = store.getState(userId).state?.events.find((event) => event.id === mapping.localId);
        if (item.unsupported) { result.warnings.push(item.warning || '지원되지 않는 외부 일정을 보존했습니다.'); continue; }
        const changedException = item.deleted && local && store.getState(userId).state.events.some((event) => event.sourceId === local.id && !Object.values(connection.mappings).some((linked) => linked.localId === event.id && linked.localFingerprint === fingerprint(event)));
        const localChanged = fingerprint(local) !== mapping.localFingerprint || changedException;
        const remoteChanged = item.etag !== mapping.remoteEtag;
        const existing = previousConflicts.find((entry) => entry.eventId === mapping.localId && entry.remoteId === remoteId);
        let choice;
        if (resolution && existing && resolution.conflictId === existing.id) {
          if (existing.localFingerprint !== conflictFingerprint(mapping, item, local) || existing.remoteEtag !== item.etag) {
            conflict(mapping, item, local, '충돌 확인 후 일정이 다시 변경되었습니다. 다시 선택해 주세요.'); continue;
          }
          choice = resolution.choice;
        }
        if (!choice && (existing || localChanged && remoteChanged)) { conflict(mapping, item, local, existing?.reason || '내 일정과 외부 일정이 모두 변경되었습니다.'); continue; }
        if (choice === 'remote' || (remoteChanged && !localChanged)) {
          applyRemote(mapping, item, local);
        } else if (choice === 'local' || localChanged) {
          try {
            if (!local) {
              if (!item.deleted) await api.remove(item);
              mapping.localFingerprint = fingerprint(null); mapping.remoteEtag = 'deleted'; mapping.deleted = true;
              nextCache[remoteId] = { id: remoteId, deleted: true, etag: 'deleted' };
              result.deleted++;
            } else {
              const updated = await api.put(local, item);
              if (updated.unsupported || !updated.etag || !updated.fields) fail('invalid_provider_response', '저장된 외부 일정 버전을 읽을 수 없습니다.', 502);
              if (updated.id !== remoteId) delete connection.mappings[remoteId];
              connection.mappings[updated.id] = { localId: local.id, localFingerprint: fingerprint(local), remoteEtag: updated.etag };
              nextCache[updated.id] = updated;
              result.exported++;
            }
          } catch (error) {
            if (error.code === 'unsupported_event') result.warnings.push(error.message);
            else if (error.code === 'remote_changed') conflict(mapping, item, local, '동기화 중 외부 일정이 수정되었습니다.');
            else throw error;
          }
        }
        save(userId, provider, connection);
      }

      for (const item of Object.values(nextCache)) {
        if (item.deleted || connection.mappings[item.id]) continue;
        if (item.unsupported) { result.warnings.push(item.warning || '지원되지 않는 외부 일정을 보존했습니다.'); continue; }
        const latest = store.getState(userId);
        const recovery = item.shadowId && latest.state?.events.find((event) => event.id === item.shadowId);
        if (recovery && Object.values(connection.mappings).some((mapping) => mapping.localId === recovery.id && !mapping.deleted)) {
          result.warnings.push('동일한 SHADOW ID의 외부 중복 일정은 자동 병합하지 않았습니다.'); continue;
        }
        const mapping = { localId: recovery?.id || randomUUID(), localFingerprint: fingerprint(recovery), remoteEtag: item.etag };
        if (recovery && fingerprint(recovery) !== fingerprint(item.fields)) {
          mapping.localFingerprint = fingerprint(null); mapping.remoteEtag = '';
          connection.mappings[item.id] = mapping;
          conflict(mapping, item, recovery, '이전 동기화에서 연결된 일정의 내용이 다릅니다.');
        } else if (recovery || applyRemote(mapping, item, undefined)) connection.mappings[item.id] = mapping;
        save(userId, provider, connection);
      }

      for (const local of store.getState(userId).state.events) {
        if (Object.values(connection.mappings).some((mapping) => mapping.localId === local.id && !mapping.deleted)) continue;
        // A unresolved remote deletion must not cause an automatic re-export.
        if (connection.conflicts.some((item) => item.eventId === local.id)) continue;
        try {
          const created = await api.put(local, null);
          if (created.unsupported || !created.etag || !created.fields) fail('invalid_provider_response', '저장된 외부 일정 버전을 읽을 수 없습니다.', 502);
          if (fingerprint(created.fields) !== fingerprint(local)) {
            const mapping = { localId: local.id, localFingerprint: fingerprint(null), remoteEtag: '' };
            connection.mappings[created.id] = mapping;
            conflict(mapping, created, local, '이전 생성 결과와 내 일정이 다릅니다.');
          } else {
            connection.mappings[created.id] = { localId: local.id, localFingerprint: fingerprint(local), remoteEtag: created.etag };
            result.exported++;
          }
          nextCache[created.id] = created;
          save(userId, provider, connection);
        } catch (error) {
          if (error.code === 'unsupported_event') result.warnings.push(error.message);
          else throw error;
        }
      }
      connection.lastSyncedAt = new Date(now()).toISOString();
      connection.lastError = null;
      save(userId, provider, connection);
      result.conflicts = publicConflicts(connection.conflicts);
      result.warnings = [...new Set(result.warnings)];
      return result;
    } catch (error) {
      connection.lastError = error instanceof IntegrationError ? error.message : '동기화를 완료하지 못했습니다. 다시 시도해 주세요.';
      if (error.code === 'provider_auth' && connection.credentials.refreshToken) connection.credentials.expiresAt = 0;
      save(userId, provider, connection);
      throw error;
    }
  }

  async function perform({ method, path, url, body = {}, userId, sessionId }) {
    if (!userId || !sessionId) fail('unauthorized', '로그인이 필요합니다.', 401);
    const parsedUrl = url instanceof URL ? url : new URL(url || path, publicOrigin());
    const pathname = path || parsedUrl.pathname;
    if (method === 'GET' && pathname === '/api/integrations') {
      return { status: 200, body: { providers: PROVIDERS.map((id) => {
        const configurationError = configured(id);
        const stored = store.encryptionAvailable ? store.getConnection(userId, id) : null;
        return { id, configured: !configurationError, configurationError, connected: !!stored, lastSyncedAt: stored?.lastSyncedAt || null, conflicts: publicConflicts(stored?.conflicts), lastError: stored?.lastError || null };
      }) } };
    }
    const match = pathname.match(/^\/api\/integrations\/(google|microsoft|apple)(?:\/(connect|callback|sync|resolve))?$/);
    if (!match) return { status: 404, body: { error: '연결 경로를 찾을 수 없습니다.' } };
    const [, provider, operation] = match;
    if (busyUsers.has(userId)) fail('sync_in_progress', '다른 연결 작업을 처리 중입니다. 잠시 후 다시 시도해 주세요.', 409);
    busyUsers.add(userId);
    try {
      if (method === 'DELETE' && !operation) {
        store.deleteConnection(userId, provider);
        return { status: 200, body: { disconnected: true } };
      }
      const configurationError = configured(provider);
      if (configurationError) fail('integration_not_configured', configurationError, 503);
      if (method === 'POST' && operation === 'connect') {
        if (provider === 'apple') {
          if (typeof body.username !== 'string' || !/^[^:\s@]+@[^\s@]+\.[^\s@]+$/.test(body.username) || body.username.length > 254 || typeof body.password !== 'string' || !/^[a-z]{4}(?:-[a-z]{4}){3}$/i.test(body.password.trim())) fail('invalid_credentials', 'Apple 계정 이메일과 앱 전용 암호(xxxx-xxxx-xxxx-xxxx)를 입력해 주세요.');
          const connection = newConnection({ username: body.username.trim(), password: body.password.trim() });
          const api = await adapter(userId, provider, connection, null);
          await api.discover();
          save(userId, provider, connection);
          return { status: 200, body: { connected: true } };
        }
        const config = oauthConfig(provider, env);
        const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
        const redirectUri = `${publicOrigin()}/api/integrations/${provider}/callback`;
        store.saveOAuthState({ state, userId, sessionId, provider, verifier, redirectUri, expiresAt: now() + 10 * 60000 });
        const authorization = new URL(config.authorization);
        const params = { client_id: config.clientId, response_type: 'code', redirect_uri: redirectUri, scope: config.scope, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'consent' };
        if (provider === 'google') { params.access_type = 'offline'; params.include_granted_scopes = 'true'; }
        else params.response_mode = 'query';
        for (const [key, value] of Object.entries(params)) authorization.searchParams.set(key, value);
        return { status: 200, body: { url: authorization.toString() } };
      }
      if (method === 'GET' && operation === 'callback' && provider !== 'apple') {
        const pending = store.consumeOAuthState(parsedUrl.searchParams.get('state'), userId, sessionId);
        if (!pending || pending.provider !== provider || pending.expiresAt <= now()) fail('invalid_oauth_state', '연결 요청이 만료되었거나 일치하지 않습니다. 다시 연결해 주세요.', 400);
        if (parsedUrl.searchParams.has('error')) return { status: 303, redirect: `/?integration=cancelled&provider=${provider}` };
        const code = parsedUrl.searchParams.get('code');
        if (!code || code.length > 8192) fail('invalid_oauth_code', '인증 코드가 올바르지 않습니다.');
        const token = await exchangeToken(fetchImpl, oauthConfig(provider, env), { grant_type: 'authorization_code', code, code_verifier: pending.verifier, redirect_uri: pending.redirectUri });
        save(userId, provider, newConnection({ accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: now() + Number(token.expires_in) * 1000 }));
        return { status: 303, redirect: `/?integration=connected&provider=${provider}` };
      }
      if (method === 'POST' && (operation === 'sync' || operation === 'resolve')) {
        if (operation === 'resolve') {
          const connection = connectionFor(userId, provider);
          if (!['local', 'remote'].includes(body.choice) || !connection.conflicts.some((item) => item.id === body.conflictId)) fail('invalid_resolution', '해결할 충돌과 적용할 일정을 선택해 주세요.');
        }
        return { status: 200, body: await sync(userId, provider, operation === 'resolve' ? body : undefined) };
      }
      return { status: 405, body: { error: '허용되지 않는 연결 작업입니다.' } };
    } finally { busyUsers.delete(userId); }
  }

  return {
    async route(input) {
      try { return await perform(input); } catch (error) {
        return { status: error instanceof IntegrationError ? error.status : 502, body: { error: error instanceof IntegrationError ? error.message : '캘린더 연결 작업을 완료하지 못했습니다.', code: error instanceof IntegrationError ? error.code : 'integration_failed' } };
      }
    },
  };
}
