import { createServer } from 'node:http';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { createDatabase } from './database.mjs';
import { createClientIpResolver } from './client-ip.mjs';
import { createMailer, isMailAddress } from './mail.mjs';
import { isAppState } from '../src/domain/validation.ts';

const deriveKey = promisify(scrypt);
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const MAX_BODY_BYTES = 2_000_000;
const SESSION_COOKIE = 'shadow_session';
const PASSWORD_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const dummySalt = randomBytes(16).toString('hex');
const dummyHash = randomBytes(64);

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function userView(user) {
  return user ? { id: user.id, email: user.email, name: user.name, emailVerified: !!user.emailVerified } : null;
}

function sessionToken(req) {
  return (req.headers.cookie ?? '').split(';').map((value) => value.trim()).find((value) => value.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function readJson(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    let rejected = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES && !rejected) {
        rejected = true;
        reject(httpError(413, '요청 데이터는 2MB를 초과할 수 없습니다.'));
      }
      if (!rejected) chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      if (!size) return resolveBody({});
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return reject(httpError(415, 'JSON 형식으로 요청해 주세요.'));
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolveBody(body);
      } catch {
        reject(httpError(400, '올바른 JSON 객체를 보내 주세요.'));
      }
    });
    req.on('error', () => reject(httpError(400, '요청을 읽지 못했습니다.')));
  });
}

function validateEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, '올바른 이메일을 입력해 주세요.');
  return email;
}

function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128) throw httpError(400, '비밀번호는 10~128자로 입력해 주세요.');
  return value;
}

function validateCredentials(body, register) {
  const email = validateEmail(body.email);
  if (register && !isMailAddress(email)) throw httpError(400, '메일을 받을 수 있는 영문 이메일 주소를 입력해 주세요. 따옴표, 연속된 점, 64자를 넘는 계정명은 사용할 수 없습니다.');
  const password = validatePassword(body.password);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (register && (!name || name.length > 50)) throw httpError(400, '이름은 1~50자로 입력해 주세요.');
  return { email, password, name };
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await deriveKey(password, salt, 64, PASSWORD_OPTIONS);
  return `scrypt-v1:${salt}:${key.toString('hex')}`;
}

async function checkPassword(password, stored) {
  const [, salt, expected] = (stored ?? '').split(':');
  const key = await deriveKey(password, salt ?? dummySalt, 64, PASSWORD_OPTIONS);
  const expectedKey = expected ? Buffer.from(expected, 'hex') : dummyHash;
  return expectedKey.length === key.length && timingSafeEqual(expectedKey, key) && !!stored;
}

export function createApp({ dbPath, origin = process.env.SHADOW_ORIGIN || process.env.SHADOW_PUBLIC_URL || 'http://localhost:5173', trustedProxies = process.env.SHADOW_TRUSTED_PROXIES || '', encryptionKey, integrationFactory, integrationHandler, mailer = createMailer(), distPath = resolve('dist') } = {}) {
  const configured = new URL(origin);
  if (!['http:', 'https:'].includes(configured.protocol) || configured.username || configured.password || configured.origin !== origin) throw new Error('SHADOW_ORIGIN must be an http(s) origin without a path.');
  if (process.env.NODE_ENV === 'production' && configured.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(configured.hostname)) throw new Error('Production authentication requires an HTTPS origin.');
  const secure = configured.protocol === 'https:';
  const clientIp = createClientIpResolver(trustedProxies);
  const database = createDatabase({ dbPath, encryptionKey });
  const integrations = integrationFactory?.({ store: database, origin });
  const authAttempts = new Map();
  const mailAttempts = new Map();
  const pendingMail = new Set();
  let activePasswordChecks = 0;

  const rateLimit = (req) => {
    const key = clientIp(req);
    const now = Date.now();
    for (const [address, entry] of authAttempts) if (entry.expires <= now) authAttempts.delete(address);
    const entry = authAttempts.get(key) ?? { count: 0, expires: now + 15 * 60_000 };
    if (entry.count >= 20 || authAttempts.size >= 10_000 && !authAttempts.has(key)) throw httpError(429, '인증 요청이 너무 많습니다. 15분 뒤 다시 시도해 주세요.');
    entry.count++;
    authAttempts.set(key, entry);
    if (activePasswordChecks >= 4) throw httpError(429, '인증 요청을 처리 중입니다. 잠시 후 다시 시도해 주세요.');
  };

  const setSession = (req, res, userId, expectedPasswordHash) => {
    database.deleteSession(sessionToken(req));
    const token = database.createSession(userId, Date.now() + SESSION_SECONDS * 1000, expectedPasswordHash);
    if (!token) throw httpError(401, '비밀번호가 변경되었습니다. 다시 로그인해 주세요.');
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}${secure ? '; Secure' : ''}`);
  };
  const clearSession = (res) => res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`);
  const enqueueMail = (operation) => {
    if (!mailer.available || pendingMail.size >= 100) return false;
    // Resolve the HTTP request before looking up the address or contacting SMTP.
    const job = new Promise((resolveJob) => setImmediate(resolveJob)).then(operation).catch(() => undefined);
    pendingMail.add(job);
    void job.finally(() => pendingMail.delete(job));
    return true;
  };
  const reserveMailRequest = (email, purpose) => {
    const now = Date.now();
    for (const [key, entry] of mailAttempts) if (entry.expires <= now) mailAttempts.delete(key);
    const key = createHash('sha256').update(`${purpose}:${email}`).digest('hex');
    const entry = mailAttempts.get(key) ?? { count: 0, expires: now + 60 * 60_000 };
    if (entry.count >= 3 || mailAttempts.size >= 10_000 && !mailAttempts.has(key)) return false;
    entry.count++;
    mailAttempts.set(key, entry);
    return true;
  };
  const requestAccountMail = (email, purpose) => {
    if (!mailer.available) throw httpError(503, '서버에 메일 발송이 설정되지 않아 이메일 확인과 비밀번호 복구를 사용할 수 없습니다.');
    if (pendingMail.size >= 100) throw httpError(429, '메일 요청을 처리 중입니다. 잠시 후 다시 시도해 주세요.');
    if (!reserveMailRequest(email, purpose)) return;
    enqueueMail(async () => {
      const account = database.getUserByEmail(email);
      if (!account || purpose === 'email-verification' && account.emailVerified) return;
      const reset = purpose === 'password-reset';
      const token = database.createAccountToken(account.id, purpose, Date.now() + (reset ? 30 * 60_000 : 24 * 60 * 60_000));
      const link = `${origin}/#${new URLSearchParams({ 'account-action': reset ? 'reset-password' : 'verify-email', token })}`;
      try {
        await mailer.send({ to: account.email, subject: reset ? '[SHADOW] 비밀번호 재설정' : '[SHADOW] 이메일 주소 확인', text: `${reset ? '비밀번호를 재설정하려면' : '이메일 주소를 확인하려면'} 아래 링크를 열고 화면에서 확인해 주세요.\n\n${link}\n\n이 링크는 ${reset ? '30분' : '24시간'} 동안 한 번만 사용할 수 있습니다. 직접 요청하지 않았다면 무시해 주세요.` });
      } catch { database.deleteAccountToken(token); }
    });
  };
  const notifyPasswordChange = (email) => enqueueMail(() => mailer.send({ to: email, subject: '[SHADOW] 비밀번호 변경 알림', text: 'SHADOW 계정 비밀번호가 변경되어 모든 기기의 로그인 세션이 종료되었습니다. 본인이 변경하지 않았다면 즉시 비밀번호 재설정을 요청해 주세요. 이 메일에는 비밀번호가 포함되어 있지 않습니다.' }));

  async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: '허용되지 않는 요청입니다.' });
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { throw httpError(400, '올바르지 않은 경로입니다.'); }
    if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').includes('..')) throw httpError(400, '올바르지 않은 경로입니다.');
    const root = resolve(distPath);
    let target = resolve(root, `.${decoded === '/' ? '/index.html' : decoded}`);
    if (!target.startsWith(`${root}${sep}`)) throw httpError(404, '파일을 찾지 못했습니다.');
    try {
      let actual;
      try {
        actual = await realpath(target);
      } catch (error) {
        if (error.code !== 'ENOENT' || extname(pathname)) throw error;
        target = resolve(root, 'index.html');
        actual = await realpath(target);
      }
      const realRoot = await realpath(root);
      if (!actual.startsWith(`${realRoot}${sep}`) || !(await stat(actual)).isFile()) throw httpError(404, '파일을 찾지 못했습니다.');
      const contents = await readFile(actual);
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2' };
      res.writeHead(200, { 'Content-Type': types[extname(actual)] ?? 'application/octet-stream', 'Content-Length': contents.length });
      res.end(req.method === 'HEAD' ? undefined : contents);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return json(res, 404, { error: '화면 빌드를 찾지 못했습니다. npm run build 후 실행해 주세요.' });
      throw error;
    }
  }

  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 16_384 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url ?? '/', origin);
      const path = url.pathname;
      if (!path.startsWith('/api/')) return await serveStatic(req, res, path);
      if (req.headers.origin && req.headers.origin !== origin) throw httpError(403, '허용되지 않은 요청 출처입니다.');
      if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== origin) throw httpError(403, '요청 출처를 확인할 수 없습니다.');
      if (path === '/api/health' && req.method === 'GET') return json(res, 200, { status: 'ok', version: 1 });
      if (path === '/api/auth/capabilities' && req.method === 'GET') return json(res, 200, { mail: { available: !!mailer.available, mode: mailer.mode }, passwordReset: { available: !!mailer.available }, emailVerification: { available: !!mailer.available } });
      if (path === '/api/auth/password-reset/request' && req.method === 'POST') {
        rateLimit(req);
        const email = validateEmail((await readJson(req)).email);
        requestAccountMail(email, 'password-reset');
        return json(res, 202, { ok: true, message: '해당 이메일의 계정이 있다면 재설정 안내를 보냅니다. 메일을 받지 못했다면 스팸함을 확인하고 잠시 후 다시 요청해 주세요.' });
      }
      if (path === '/api/auth/password-reset/confirm' && req.method === 'POST') {
        rateLimit(req);
        const body = await readJson(req);
        const password = validatePassword(body.password);
        if (activePasswordChecks >= 4) throw httpError(429, '인증 요청을 처리 중입니다. 잠시 후 다시 시도해 주세요.');
        activePasswordChecks++;
        try {
          const account = database.resetPassword(body.token, await hashPassword(password));
          if (!account) throw httpError(400, '재설정 링크가 올바르지 않거나 만료되었습니다. 다시 요청해 주세요.');
          clearSession(res);
          notifyPasswordChange(account.email);
          return json(res, 200, { ok: true, reauthenticate: true });
        } finally { activePasswordChecks--; }
      }
      if (path === '/api/auth/email-verification/confirm' && req.method === 'POST') {
        rateLimit(req);
        if (!database.verifyEmail((await readJson(req)).token)) throw httpError(400, '이메일 확인 링크가 올바르지 않거나 만료되었습니다. 다시 요청해 주세요.');
        return json(res, 200, { ok: true });
      }
      const publicMatch = path.match(/^\/api\/public\/([A-Za-z0-9_-]+)$/);
      if (publicMatch && req.method === 'GET') {
        const share = database.getPublicShare(publicMatch[1]);
        if (!share) throw httpError(404, '공유 링크가 없거나 해제되었습니다.');
        return json(res, 200, share);
      }
      if ((path === '/api/auth/register' || path === '/api/auth/login') && req.method === 'POST') {
        rateLimit(req);
        const register = path.endsWith('/register');
        const credentials = validateCredentials(await readJson(req), register);
        if (activePasswordChecks >= 4) throw httpError(429, '인증 요청을 처리 중입니다. 잠시 후 다시 시도해 주세요.');
        activePasswordChecks++;
        try {
          let user;
          if (register) {
            const passwordHash = await hashPassword(credentials.password);
            if (database.getUserByEmail(credentials.email)) throw httpError(409, '이미 사용 중인 이메일입니다.');
            user = database.createUser({ ...credentials, passwordHash });
          } else {
            user = database.getUserByEmail(credentials.email);
            if (!await checkPassword(credentials.password, user?.passwordHash)) throw httpError(401, '이메일 또는 비밀번호를 확인해 주세요.');
          }
          setSession(req, res, user.id, user.passwordHash);
          return json(res, register ? 201 : 200, { user: userView(user) });
        } finally {
          activePasswordChecks--;
        }
      }
      const user = database.getSession(sessionToken(req));
      const expectedAccount = req.headers['x-shadow-account'];
      if (expectedAccount !== undefined) {
        if (typeof expectedAccount !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(expectedAccount)) throw httpError(400, '계정 확인 헤더가 올바르지 않습니다.');
        if (user && user.id !== expectedAccount) throw httpError(409, '계정이 변경되었습니다. 다시 로그인 상태를 확인해 주세요.');
      }
      if (path === '/api/auth/me' && req.method === 'GET') return json(res, 200, { user: userView(user) });
      if (!user) throw httpError(401, '로그인이 필요합니다.');
      if (path === '/api/auth/logout' && req.method === 'POST') {
        database.deleteSession(sessionToken(req));
        clearSession(res);
        return json(res, 200, { ok: true });
      }
      if (path === '/api/auth/email-verification/request' && req.method === 'POST') {
        rateLimit(req);
        await readJson(req);
        requestAccountMail(user.email, 'email-verification');
        return json(res, 202, { ok: true, message: '아직 확인하지 않은 이메일 주소로 확인 링크를 보냅니다.' });
      }
      if (path === '/api/auth/password/change' && req.method === 'POST') {
        rateLimit(req);
        const body = await readJson(req);
        const password = validatePassword(body.password);
        const currentPassword = validatePassword(body.currentPassword);
        if (activePasswordChecks >= 4) throw httpError(429, '인증 요청을 처리 중입니다. 잠시 후 다시 시도해 주세요.');
        activePasswordChecks++;
        try {
          const account = database.getUserByEmail(user.email);
          if (!await checkPassword(currentPassword, account?.passwordHash)) throw httpError(401, '현재 비밀번호를 확인해 주세요.');
          const passwordHash = await hashPassword(password);
          if (!database.changePassword(user.id, user.sessionId, account.passwordHash, passwordHash)) throw httpError(409, '계정 인증 상태가 변경되었습니다. 다시 로그인해 주세요.');
          clearSession(res);
          notifyPasswordChange(user.email);
          return json(res, 200, { ok: true, reauthenticate: true });
        } finally { activePasswordChecks--; }
      }
      if (path === '/api/auth/sessions/revoke-others' && req.method === 'POST') {
        rateLimit(req);
        await readJson(req);
        return json(res, 200, { ok: true, revokedSessions: database.revokeOtherSessions(user.id, user.sessionId) });
      }
      if (path === '/api/state' && req.method === 'GET') return json(res, 200, database.getState(user.id));
      if (path === '/api/state' && req.method === 'PUT') {
        const { state, revision } = await readJson(req);
        if (!isAppState(state) || !Number.isSafeInteger(revision) || revision < 0) throw httpError(400, '일정 데이터 또는 버전이 올바르지 않습니다.');
        const result = database.saveState(user.id, state, revision);
        if (!result.ok) return json(res, 409, { error: '다른 기기에서 일정이 변경되었습니다. 서버 일정을 다시 확인해 주세요.', revision: result.revision });
        return json(res, 200, { revision: result.revision });
      }
      if (path === '/api/shares' && req.method === 'GET') return json(res, 200, { shares: database.listShares(user.id) });
      if (path === '/api/shares' && req.method === 'POST') {
        const { title, state } = await readJson(req);
        if (typeof title !== 'string' || !title.trim() || title.trim().length > 100 || !isAppState(state)) throw httpError(400, '공유 제목(1~100자)과 올바른 일정 데이터가 필요합니다.');
        const share = database.createShare(user.id, title.trim(), state);
        if (!share) throw httpError(409, '공유 링크는 계정당 100개까지 만들 수 있습니다. 사용하지 않는 링크를 해제해 주세요.');
        return json(res, 201, { share });
      }
      const deleteMatch = path.match(/^\/api\/shares\/([a-f0-9-]+)$/i);
      if (deleteMatch && req.method === 'DELETE') {
        if (!database.deleteShare(user.id, deleteMatch[1])) throw httpError(404, '공유 링크를 찾지 못했습니다.');
        return json(res, 200, { ok: true });
      }
      if (path === '/api/integrations' || path.startsWith('/api/integrations/')) {
        if (integrations) {
          const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readJson(req);
          const result = await integrations.route({ method: req.method, path, url, body, userId: user.id, sessionId: user.sessionId });
          if (result?.redirect) {
            res.writeHead(result.status ?? 302, { Location: result.redirect });
            return res.end();
          }
          return json(res, result?.status ?? 404, result?.body ?? { error: '연결 요청을 찾지 못했습니다.' });
        }
        if (integrationHandler) return await integrationHandler(req, res, user);
        if (path === '/api/integrations' && req.method === 'GET') return json(res, 200, { providers: [], configured: false });
        throw httpError(503, '외부 캘린더 연결이 설정되지 않았습니다.');
      }
      throw httpError(404, 'API 경로를 찾지 못했습니다.');
    } catch (error) {
      if (res.writableEnded) return;
      if (res.headersSent) return res.end();
      if (error.status === 429) res.setHeader('Retry-After', '900');
      json(res, error.status ?? 500, { error: error.status ? error.message : '서버가 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  });
  server.on('listening', () => {
    try { integrations?.start?.(); }
    catch { console.error('Background calendar synchronization could not start. Check server configuration and restart.'); }
  });
  let closed = false;
  return {
    server,
    database,
    async close() {
      if (closed) return;
      closed = true;
      if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
      await integrations?.stop?.();
      await Promise.all(pendingMail);
      database.close();
    },
  };
}
