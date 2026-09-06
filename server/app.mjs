import { createServer } from 'node:http';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { createDatabase } from './database.mjs';
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
  return user ? { id: user.id, email: user.email, name: user.name } : null;
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

function validateCredentials(body, register) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, '올바른 이메일을 입력해 주세요.');
  if (typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 128) throw httpError(400, '비밀번호는 10~128자로 입력해 주세요.');
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (register && (!name || name.length > 50)) throw httpError(400, '이름은 1~50자로 입력해 주세요.');
  return { email, password: body.password, name };
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

export function createApp({ dbPath, origin = process.env.SHADOW_ORIGIN || process.env.SHADOW_PUBLIC_URL || 'http://localhost:5173', encryptionKey, integrationFactory, integrationHandler, distPath = resolve('dist') } = {}) {
  const configured = new URL(origin);
  if (!['http:', 'https:'].includes(configured.protocol) || configured.username || configured.password || configured.origin !== origin) throw new Error('SHADOW_ORIGIN must be an http(s) origin without a path.');
  if (process.env.NODE_ENV === 'production' && configured.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(configured.hostname)) throw new Error('Production authentication requires an HTTPS origin.');
  const secure = configured.protocol === 'https:';
  const database = createDatabase({ dbPath, encryptionKey });
  const integrations = integrationFactory?.({ store: database, origin });
  const authAttempts = new Map();
  let activePasswordChecks = 0;

  const rateLimit = (req) => {
    const key = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    for (const [address, entry] of authAttempts) if (entry.expires <= now) authAttempts.delete(address);
    const entry = authAttempts.get(key) ?? { count: 0, expires: now + 15 * 60_000 };
    if (entry.count >= 20 || authAttempts.size >= 10_000 && !authAttempts.has(key)) throw httpError(429, '인증 요청이 너무 많습니다. 15분 뒤 다시 시도해 주세요.');
    entry.count++;
    authAttempts.set(key, entry);
    if (activePasswordChecks >= 4) throw httpError(429, '인증 요청을 처리 중입니다. 잠시 후 다시 시도해 주세요.');
  };

  const setSession = (req, res, userId) => {
    database.deleteSession(sessionToken(req));
    const token = database.createSession(userId, Date.now() + SESSION_SECONDS * 1000);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}${secure ? '; Secure' : ''}`);
  };

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
          setSession(req, res, user.id);
          return json(res, register ? 201 : 200, { user: userView(user) });
        } finally {
          activePasswordChecks--;
        }
      }
      const user = database.getSession(sessionToken(req));
      if (path === '/api/auth/me' && req.method === 'GET') return json(res, 200, { user: userView(user) });
      if (!user) throw httpError(401, '로그인이 필요합니다.');
      if (path === '/api/auth/logout' && req.method === 'POST') {
        database.deleteSession(sessionToken(req));
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`);
        return json(res, 200, { ok: true });
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
  let closed = false;
  return {
    server,
    database,
    async close() {
      if (closed) return;
      closed = true;
      if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
      database.close();
    },
  };
}
