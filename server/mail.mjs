import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const MAX_TEXT_BYTES = 100_000;
const RESPONSE_TIMEOUT_MS = 10_000;
const TRANSACTION_TIMEOUT_MS = 30_000;
const MAX_REPLY_BYTES = 16_384;

function mailError(code, message) { return Object.assign(new Error(message), { code }); }
const transportError = () => mailError('MAIL_TRANSPORT', '메일 서버와 안전하게 통신하지 못했습니다. SMTP 설정을 확인해 주세요.');
const controls = (value) => [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

function validDomain(value) {
  return value.length <= 253 && value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

export function isMailAddress(value) {
  if (typeof value !== 'string' || value.length > 254 || value.split('@').length !== 2) return false;
  const [local, domain] = value.split('@');
  return local.length > 0 && local.length <= 64 && /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/i.test(local)
    && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..') && domain.includes('.') && validDomain(domain);
}

function validateMessage(message) {
  if (!message || !isMailAddress(message.to) || typeof message.subject !== 'string' || !message.subject.trim()
    || Buffer.byteLength(message.subject) > 640 || controls(message.subject)
    || typeof message.text !== 'string' || !message.text.length || message.text.includes('\0') || Buffer.byteLength(message.text) > MAX_TEXT_BYTES) {
    throw mailError('MAIL_INPUT', '메일은 유효한 단일 수신 주소, 제목, 100KB 이하의 본문이 필요합니다.');
  }
}

function encodedSubject(subject) {
  const chunks = [];
  let current = '';
  for (const character of subject) {
    if (Buffer.byteLength(current + character) > 42) { chunks.push(current); current = ''; }
    current += character;
  }
  if (current) chunks.push(current);
  return chunks.map((chunk) => `=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`).join('\r\n ');
}

function renderMessage(from, { to, subject, text }) {
  const body = Buffer.from(text.replace(/\r\n?|\n/g, '\r\n'), 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
  return [
    `From: ${from}`, `To: ${to}`, `Subject: ${encodedSubject(subject)}`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${randomUUID()}@${from.split('@')[1]}>`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', body, '',
  ].join('\r\n');
}

/** A single sequential SMTP exchange; no response text escapes this module. */
class SmtpWire {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.lines = [];
    this.replyBytes = 0;
    this.receivedBytes = 0;
    this.failure = null;
    this.waiter = null;
    this.ready = null;
    this.onData = (chunk) => this.consume(chunk);
    socket.on('data', this.onData);
    socket.on('error', () => this.fail());
    socket.on('close', () => this.fail());
  }

  fail() {
    this.failure ??= transportError();
    if (this.waiter) {
      clearTimeout(this.waiter.timer);
      this.waiter.reject(this.failure);
      this.waiter = null;
    }
    this.socket.destroy();
  }

  consume(chunk) {
    if (this.failure) return;
    this.receivedBytes += chunk.length;
    if (this.receivedBytes > 65_536) return this.fail();
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.includes('\r\n')) {
      const end = this.buffer.indexOf('\r\n');
      if (end + 2 > 512) return this.fail();
      const line = this.buffer.subarray(0, end).toString('utf8');
      this.buffer = this.buffer.subarray(end + 2);
      const match = /^([2-5][0-9]{2})(?:([ -])(.*))?$/.exec(line);
      this.replyBytes += end + 2;
      if (!match || controls(line) || this.lines.length >= 32 || this.replyBytes > MAX_REPLY_BYTES
        || (this.lines.length && this.lines[0].code !== Number(match[1]))) return this.fail();
      this.lines.push({ code: Number(match[1]), text: match[3] ?? '' });
      if (match[2] === '-') continue;
      const reply = { code: Number(match[1]), lines: this.lines.map((item) => item.text) };
      this.lines = [];
      this.replyBytes = 0;
      if (this.waiter) {
        clearTimeout(this.waiter.timer);
        this.waiter.resolve(reply);
        this.waiter = null;
      } else if (!this.ready) this.ready = reply;
      else return this.fail();
    }
    if (this.buffer.length > 510) this.fail();
  }

  read() {
    if (this.failure) return Promise.reject(this.failure);
    if (this.ready) { const reply = this.ready; this.ready = null; return Promise.resolve(reply); }
    if (this.waiter) return Promise.reject(transportError());
    return new Promise((resolveReply, reject) => {
      this.waiter = { resolve: resolveReply, reject, timer: setTimeout(() => this.fail(), RESPONSE_TIMEOUT_MS) };
    });
  }

  assertClean() {
    if (this.failure || this.ready || this.lines.length || this.buffer.length || this.waiter) throw transportError();
  }

  async exchange(value, expected, data = false) {
    this.assertClean();
    if (!data && (controls(value) || Buffer.byteLength(value) + 2 > 512)) throw transportError();
    const response = this.read();
    try { this.socket.write(value + (data ? '' : '\r\n'), (error) => { if (error) this.fail(); }); }
    catch { this.fail(); }
    const reply = await response;
    if (!expected.includes(reply.code)) throw transportError();
    return reply;
  }

  detach() {
    this.assertClean();
    this.socket.pause();
    this.socket.off('data', this.onData);
  }
}

function connected(socket, secure, host) {
  return new Promise((resolveConnected, reject) => {
    const done = (error) => {
      clearTimeout(timer);
      socket.off(secure ? 'secureConnect' : 'connect', onConnect);
      socket.off('error', onFailure);
      socket.off('close', onFailure);
      if (error) { socket.destroy(); reject(transportError()); } else resolveConnected();
    };
    const onFailure = () => done(true);
    const onConnect = () => {
      try {
        if (secure && (socket.authorized !== true || tls.checkServerIdentity(host, socket.getPeerCertificate()))) return done(true);
        done(false);
      } catch { done(true); }
    };
    const timer = setTimeout(onFailure, RESPONSE_TIMEOUT_MS);
    socket.once(secure ? 'secureConnect' : 'connect', onConnect);
    socket.once('error', onFailure);
    socket.once('close', onFailure);
  });
}

function tlsOptions(config, socket) {
  return { host: config.host, port: config.port, servername: net.isIP(config.host) ? undefined : config.host, socket, minVersion: 'TLSv1.2', rejectUnauthorized: true };
}

function authenticationMethods(reply) {
  return reply.lines.flatMap((line) => /^AUTH[ =]/i.test(line) ? line.slice(5).trim().toUpperCase().split(/\s+/) : []);
}

async function smtpSend(config, to, rendered) {
  const sockets = [];
  let wire;
  const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); wire?.fail(); }, TRANSACTION_TIMEOUT_MS);
  try {
    let socket = config.security === 'implicit' ? tls.connect(tlsOptions(config)) : net.connect({ host: config.host, port: config.port });
    sockets.push(socket);
    wire = new SmtpWire(socket);
    await connected(socket, config.security === 'implicit', config.host);
    if ((await wire.read()).code !== 220) throw transportError();
    let greeting = await wire.exchange('EHLO shadow.local', [250]);
    if (config.security === 'starttls') {
      if (!greeting.lines.some((line) => /^STARTTLS$/i.test(line.trim()))) throw transportError();
      await wire.exchange('STARTTLS', [220]);
      wire.detach();
      socket = tls.connect(tlsOptions(config, socket));
      sockets.push(socket);
      wire = new SmtpWire(socket);
      await connected(socket, true, config.host);
      // RFC 3207 discards pre-TLS capabilities and requires a new EHLO.
      greeting = await wire.exchange('EHLO shadow.local', [250]);
    }
    const methods = authenticationMethods(greeting);
    if (methods.includes('PLAIN')) {
      const credentials = Buffer.from(`\0${config.user}\0${config.password}`).toString('base64');
      const reply = await wire.exchange(`AUTH PLAIN ${credentials}`, [235, 334]);
      if (reply.code === 334) await wire.exchange(credentials, [235]);
    } else if (methods.includes('LOGIN')) {
      await wire.exchange('AUTH LOGIN', [334]);
      await wire.exchange(Buffer.from(config.user).toString('base64'), [334]);
      await wire.exchange(Buffer.from(config.password).toString('base64'), [235]);
    } else throw transportError();
    await wire.exchange(`MAIL FROM:<${config.from}>`, [250]);
    await wire.exchange(`RCPT TO:<${to}>`, [250, 251]);
    await wire.exchange('DATA', [354]);
    await wire.exchange(`${rendered}.\r\n`, [250], true);
    // DATA 250 means accepted: a failed QUIT must not encourage duplicate retries.
    try { await wire.exchange('QUIT', [221]); } catch { /* Already accepted by the SMTP server. */ }
  } catch { throw transportError(); }
  finally { clearTimeout(timer); for (const socket of sockets) socket.destroy(); }
}

function smtpConfig(env) {
  const host = env.SHADOW_SMTP_HOST;
  const security = env.SHADOW_SMTP_TLS || (env.SHADOW_SMTP_PORT === '465' ? 'implicit' : 'starttls');
  const portText = env.SHADOW_SMTP_PORT || (security === 'implicit' ? '465' : '587');
  const user = env.SHADOW_SMTP_USER;
  const password = env.SHADOW_SMTP_PASSWORD;
  const from = env.SHADOW_SMTP_FROM;
  const credential = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256 && [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) <= 126);
  if (typeof host !== 'string' || (!net.isIP(host) && !validDomain(host)) || host.includes('%')
    || !['implicit', 'starttls'].includes(security) || !/^\d{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535
    || !credential(user) || !credential(password) || user.length + password.length > 330 || !isMailAddress(from)) {
    throw mailError('MAIL_CONFIG', 'SHADOW_SMTP_HOST/PORT/TLS/USER/PASSWORD/FROM 설정을 확인해 주세요.');
  }
  return { host, security, port: Number(portText), user, password, from };
}

async function saveOutbox(rendered) {
  try {
    const data = resolve('data');
    const directory = join(data, 'mail-outbox');
    await mkdir(data, { recursive: true, mode: 0o700 });
    const dataInfo = await lstat(data);
    if (!dataInfo.isDirectory() || dataInfo.isSymbolicLink()) throw new Error();
    await mkdir(directory, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
    const file = await open(join(directory, `${Date.now()}-${randomUUID()}.eml`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await file.writeFile(rendered, 'utf8'); await file.sync(); } finally { await file.close(); }
  } catch { throw mailError('MAIL_OUTBOX', '개발 메일 보관함에 저장하지 못했습니다. 로컬 디렉터리 접근 권한을 확인해 주세요.'); }
}

export function createMailer({ env = process.env } = {}) {
  const mode = env.SHADOW_MAIL_MODE || 'disabled';
  if (!['smtp', 'outbox', 'disabled'].includes(mode) || (mode === 'outbox' && env.NODE_ENV === 'production')) {
    throw mailError('MAIL_CONFIG', 'SHADOW_MAIL_MODE는 disabled/smtp/outbox 중 하나이며 production에서 outbox를 사용할 수 없습니다.');
  }
  if (mode === 'disabled') return { available: false, mode, async send() { throw mailError('MAIL_DISABLED', '메일 발송이 설정되지 않았습니다.'); } };
  const config = mode === 'smtp' ? smtpConfig(env) : null;
  const from = config?.from ?? (env.SHADOW_SMTP_FROM || 'shadow@localhost.test');
  if (!isMailAddress(from)) throw mailError('MAIL_CONFIG', 'SHADOW_SMTP_FROM 발신 주소를 확인해 주세요.');
  let active = 0;
  return {
    available: true, mode,
    async send(message) {
      validateMessage(message);
      if (active >= 4) throw mailError('MAIL_BUSY', '메일 발송이 처리 중입니다. 잠시 후 다시 시도해 주세요.');
      active++;
      try {
        const rendered = renderMessage(from, message);
        if (config) await smtpSend(config, message.to, rendered);
        else await saveOutbox(rendered);
      } finally { active--; }
    },
  };
}
