import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';
import { mkdtemp, mkdir, readFile, readdir, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMailer } from './mail.mjs';

const smtpEnv = (overrides = {}) => ({ SHADOW_MAIL_MODE: 'smtp', SHADOW_SMTP_HOST: 'smtp.example.test', SHADOW_SMTP_USER: 'test-user', SHADOW_SMTP_PASSWORD: 'synthetic-test-password', SHADOW_SMTP_FROM: 'shadow@example.test', ...overrides });
const message = (overrides = {}) => ({ to: 'owner@example.test', subject: 'SHADOW 계정 확인', text: '계정 확인 링크\nhttps://shadow.example/#token=synthetic-test-token\n.\r\nPRIVATE', ...overrides });
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** No real network calls or credentials are used by these protocol tests. */
function smtpServer(t, options = {}) {
  const sockets = [];
  const configurations = [];
  class Socket extends EventEmitter {
    constructor(secure, upgraded) {
      super();
      this.secure = secure;
      this.authorized = options.authorized !== false;
      this.destroyed = false;
      this.writes = [];
      this.expectData = false;
      this.loginStep = 0;
      queueMicrotask(() => {
        if (options.noHandshake) return;
        this.emit(secure ? 'secureConnect' : 'connect');
        if (!upgraded && !this.destroyed) this.respond(options.greeting ?? '220 test SMTP ready\r\n');
      });
    }
    getPeerCertificate() { return { subjectaltname: `DNS:${options.certificateHost ?? 'smtp.example.test'}` }; }
    pause() { return this; }
    destroy() { if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => this.emit('close')); } return this; }
    respond(value) {
      if (value === null) return;
      queueMicrotask(() => {
        if (this.destroyed) return;
        const bytes = Buffer.from(value);
        if (options.fragmented) { for (let offset = 0; offset < bytes.length; offset += 3) this.emit('data', bytes.subarray(offset, offset + 3)); }
        else this.emit('data', bytes);
      });
    }
    write(value, callback) {
      this.writes.push(value);
      callback?.();
      if (options.override) {
        const overridden = options.override(value, this);
        if (overridden !== undefined) { this.respond(overridden); return true; }
      }
      if (this.expectData) { this.expectData = false; this.respond('250 accepted\r\n'); return true; }
      if (this.loginStep === 1) { this.loginStep = 2; this.respond('334 UGFzc3dvcmQ6\r\n'); return true; }
      if (this.loginStep === 2) { this.loginStep = 0; this.respond('235 authenticated\r\n'); return true; }
      if (value.startsWith('EHLO')) {
        const capabilities = this.secure ? (options.capabilities ?? ['AUTH PLAIN LOGIN']) : (options.preCapabilities ?? ['STARTTLS', 'AUTH PLAIN']);
        this.respond(['250-test SMTP', ...capabilities.map((item, index) => `250${index === capabilities.length - 1 ? ' ' : '-'}${item}`)].join('\r\n') + '\r\n');
      } else if (value === 'STARTTLS\r\n') this.respond('220 begin TLS\r\n');
      else if (value.startsWith('AUTH PLAIN ')) this.respond('235 authenticated\r\n');
      else if (value === 'AUTH LOGIN\r\n') { this.loginStep = 1; this.respond('334 VXNlcm5hbWU6\r\n'); }
      else if (value.startsWith('MAIL FROM:') || value.startsWith('RCPT TO:')) this.respond('250 accepted\r\n');
      else if (value === 'DATA\r\n') { this.expectData = true; this.respond('354 send body\r\n'); }
      else if (value === 'QUIT\r\n') { if (options.quitClose) this.destroy(); else this.respond('221 closing\r\n'); }
      else this.respond('500 unsupported\r\n');
      return true;
    }
  }
  t.mock.method(net, 'connect', (config) => { configurations.push({ ...config, secure: false }); const socket = new Socket(false, false); sockets.push(socket); return socket; });
  t.mock.method(tls, 'connect', (config) => { configurations.push({ ...config, secure: true }); const socket = new Socket(true, Boolean(config.socket)); sockets.push(socket); return socket; });
  return { sockets, configurations };
}

test('is disabled by default and rejects invalid or unsafe explicit configuration', async () => {
  const mailer = createMailer({ env: {} });
  assert.equal(mailer.available, false);
  assert.equal(mailer.mode, 'disabled');
  await assert.rejects(mailer.send(message()), { code: 'MAIL_DISABLED' });
  for (const env of [{ SHADOW_MAIL_MODE: 'automatic' }, { SHADOW_MAIL_MODE: 'outbox', NODE_ENV: 'production' }, smtpEnv({ SHADOW_SMTP_HOST: 'smtp.example.test\r\nAUTH' }), smtpEnv({ SHADOW_SMTP_TLS: 'none' }), smtpEnv({ SHADOW_SMTP_PORT: '0' }), smtpEnv({ SHADOW_SMTP_PORT: '65536' }), smtpEnv({ SHADOW_SMTP_USER: '' }), smtpEnv({ SHADOW_SMTP_PASSWORD: 'bad\0value' }), smtpEnv({ SHADOW_SMTP_FROM: 'a@example.test,b@example.test' })]) {
    assert.throws(() => createMailer({ env }), { code: 'MAIL_CONFIG' });
  }
});

test('rejects recipient and header injection, multiple recipients, and oversized bodies before connecting', async (t) => {
  const server = smtpServer(t);
  const mailer = createMailer({ env: smtpEnv() });
  for (const invalid of [message({ to: 'a@example.test\r\nRCPT TO:<b@example.test>' }), message({ to: ['a@example.test', 'b@example.test'] }), message({ to: 'a@example.test,b@example.test' }), message({ to: 'Owner <a@example.test>' }), message({ to: '한글@example.test' }), message({ subject: 'hi\nBcc: attacker@example.test' }), message({ subject: 'x'.repeat(641) }), message({ text: 'x'.repeat(100001) }), message({ text: '\0' })]) {
    await assert.rejects(mailer.send(invalid), { code: 'MAIL_INPUT' });
  }
  assert.equal(server.sockets.length, 0);
});

test('sends MIME UTF-8 base64 via implicit verified TLS and AUTH PLAIN without message injection', async (t) => {
  const server = smtpServer(t, { fragmented: true });
  const mailer = createMailer({ env: smtpEnv({ SHADOW_SMTP_TLS: 'implicit' }) });
  const input = message({ subject: '한글 제목 '.repeat(15) });
  await mailer.send(input);
  assert.equal(mailer.available, true);
  assert.equal(mailer.mode, 'smtp');
  assert.equal(server.configurations.length, 1);
  assert.equal(server.configurations[0].port, 465);
  assert.equal(server.configurations[0].servername, 'smtp.example.test');
  assert.equal(server.configurations[0].rejectUnauthorized, true);
  assert.equal(server.configurations[0].minVersion, 'TLSv1.2');
  const sent = server.sockets[0].writes;
  assert.equal(sent.filter((value) => value.startsWith('RCPT TO:')).length, 1);
  assert.equal(sent[1], `AUTH PLAIN ${Buffer.from('\0test-user\0synthetic-test-password').toString('base64')}\r\n`);
  const data = sent.find((value) => value.startsWith('From:'));
  assert.ok(data.endsWith('\r\n.\r\n'));
  assert.match(data, /Content-Transfer-Encoding: base64/);
  assert.doesNotMatch(data, /synthetic-test-token|PRIVATE/);
  const [headers, body] = data.slice(0, -3).split('\r\n\r\n');
  const decodedSubject = [...headers.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map((match) => Buffer.from(match[1], 'base64').toString('utf8')).join('');
  assert.equal(decodedSubject, input.subject);
  assert.equal(Buffer.from(body.replaceAll('\r\n', ''), 'base64').toString('utf8'), input.text.replace(/\r\n?|\n/g, '\r\n'));
  assert.ok(body.trim().split('\r\n').every((line) => line.length <= 76));
  assert.equal(server.sockets[0].destroyed, true);
});

test('requires STARTTLS, resets pre-TLS capabilities, and authenticates only on the verified secure socket', async (t) => {
  const server = smtpServer(t, { capabilities: ['AUTH LOGIN'] });
  await createMailer({ env: smtpEnv() }).send(message());
  assert.equal(server.configurations[0].port, 587);
  assert.deepEqual(server.sockets[0].writes, ['EHLO shadow.local\r\n', 'STARTTLS\r\n']);
  assert.equal(server.configurations[1].socket, server.sockets[0]);
  assert.equal(server.configurations[1].rejectUnauthorized, true);
  assert.deepEqual(server.sockets[1].writes.slice(0, 4), ['EHLO shadow.local\r\n', 'AUTH LOGIN\r\n', `${Buffer.from('test-user').toString('base64')}\r\n`, `${Buffer.from('synthetic-test-password').toString('base64')}\r\n`]);
});

test('rejects unavailable STARTTLS without transmitting credentials or recipients', async (t) => {
  const server = smtpServer(t, { preCapabilities: ['AUTH PLAIN'] });
  await assert.rejects(createMailer({ env: smtpEnv() }).send(message()), { code: 'MAIL_TRANSPORT' });
  assert.deepEqual(server.sockets[0].writes, ['EHLO shadow.local\r\n']);
});

test('refuses plaintext bytes following the STARTTLS response instead of carrying them into TLS', async (t) => {
  for (const extra of ['250 AUTH PLAIN\r\n', 'partial plaintext']) {
    const server = smtpServer(t, { override: (value) => value === 'STARTTLS\r\n' ? `220 begin TLS\r\n${extra}` : undefined });
    await assert.rejects(createMailer({ env: smtpEnv() }).send(message()), { code: 'MAIL_TRANSPORT' });
    assert.equal(server.sockets.length, 1);
    assert.deepEqual(server.sockets[0].writes, ['EHLO shadow.local\r\n', 'STARTTLS\r\n']);
    t.mock.restoreAll();
  }
});

test('supports the optional AUTH PLAIN challenge with a bare SMTP reply code', async (t) => {
  const credentials = Buffer.from('\0test-user\0synthetic-test-password').toString('base64');
  const server = smtpServer(t, { override: (value) => value.startsWith('AUTH PLAIN ') ? '334\r\n' : value === `${credentials}\r\n` ? '235 authenticated\r\n' : undefined });
  await createMailer({ env: smtpEnv({ SHADOW_SMTP_TLS: 'implicit' }) }).send(message());
  assert.equal(server.sockets[0].writes[2], `${credentials}\r\n`);
});

test('rejects invalid certificates and hostname mismatch before AUTH', async (t) => {
  for (const options of [{ authorized: false }, { certificateHost: 'attacker.example.test' }]) {
    const server = smtpServer(t, options);
    await assert.rejects(createMailer({ env: smtpEnv({ SHADOW_SMTP_TLS: 'implicit' }) }).send(message()), { code: 'MAIL_TRANSPORT' });
    assert.deepEqual(server.sockets[0].writes, []);
    t.mock.restoreAll();
  }
});

test('rejects missing secure AUTH capabilities and does not reuse plaintext advertisements', async (t) => {
  const server = smtpServer(t, { capabilities: ['SIZE 1000000'] });
  await assert.rejects(createMailer({ env: smtpEnv() }).send(message()), { code: 'MAIL_TRANSPORT' });
  assert.deepEqual(server.sockets[1].writes, ['EHLO shadow.local\r\n']);
});

test('bounds response lines, lengths, and malformed or injected multiline replies', async (t) => {
  for (const greeting of ['220 ' + 'x'.repeat(508) + '\r\n', Array(33).fill('220-more').join('\r\n') + '\r\n220 ready\r\n', '220-more\r\n250 wrong code\r\n', '220 bad\nline\r\n', '220 ready\r\n250 unsolicited\r\n', 'x'.repeat(511)]) {
    const server = smtpServer(t, { greeting });
    await assert.rejects(createMailer({ env: smtpEnv({ SHADOW_SMTP_TLS: 'implicit' }) }).send(message()), { code: 'MAIL_TRANSPORT' });
    assert.equal(server.sockets[0].destroyed, true);
    t.mock.restoreAll();
  }
});

test('never exposes SMTP response text, credentials, recipient or private token in errors', async (t) => {
  smtpServer(t, { override: (value) => value.startsWith('AUTH') ? '535 synthetic-test-password owner@example.test synthetic-test-token\r\n' : undefined });
  await assert.rejects(createMailer({ env: smtpEnv() }).send(message()), (error) => error.code === 'MAIL_TRANSPORT' && !/synthetic|owner@example/.test(String(error)) && error.cause === undefined);
});

test('regards a DATA acceptance as success even if the server closes during QUIT', async (t) => {
  smtpServer(t, { quitClose: true });
  await createMailer({ env: smtpEnv() }).send(message());
});

test('bounds handshake and stalled response time and releases sockets', async (t) => {
  for (const options of [{ noHandshake: true }, { override: (value) => value.startsWith('EHLO') ? null : undefined }]) {
    const server = smtpServer(t, options);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const rejected = assert.rejects(createMailer({ env: smtpEnv({ SHADOW_SMTP_TLS: 'implicit' }) }).send(message()), { code: 'MAIL_TRANSPORT' });
    await flush();
    t.mock.timers.tick(10001);
    await rejected;
    assert.equal(server.sockets[0].destroyed, true);
    t.mock.timers.reset();
    t.mock.restoreAll();
  }
});

test('enforces the overall transaction deadline even when individual responses arrive in time', async (t) => {
  const server = smtpServer(t, { override: (value, socket) => {
    const reply = value.startsWith('EHLO') ? '250-test\r\n250 AUTH PLAIN\r\n' : value.startsWith('AUTH') ? '235 ok\r\n' : value.startsWith('MAIL') || value.startsWith('RCPT') ? '250 ok\r\n' : undefined;
    if (!reply) return undefined;
    setTimeout(() => socket.respond(reply), 9000);
    return null;
  } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rejected = assert.rejects(createMailer({ env: smtpEnv({ SHADOW_SMTP_TLS: 'implicit' }) }).send(message()), { code: 'MAIL_TRANSPORT' });
  await flush();
  for (let index = 0; index < 3; index++) { t.mock.timers.tick(9000); await flush(); }
  t.mock.timers.tick(3001);
  await rejected;
  assert.equal(server.sockets[0].destroyed, true);
  assert.ok(!server.sockets[0].writes.includes('DATA\r\n'));
});

test('limits concurrent sends without queuing unbounded sensitive messages', async (t) => {
  smtpServer(t, { noHandshake: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mailer = createMailer({ env: smtpEnv({ SHADOW_SMTP_TLS: 'implicit' }) });
  const pending = Array.from({ length: 4 }, () => assert.rejects(mailer.send(message()), { code: 'MAIL_TRANSPORT' }));
  await assert.rejects(mailer.send(message()), { code: 'MAIL_BUSY' });
  t.mock.timers.tick(10001);
  await Promise.all(pending);
});

test('writes explicit development outbox messages exclusively to private files under data', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadow-mail-test-'));
  const original = process.cwd();
  process.chdir(directory);
  t.after(() => process.chdir(original));
  const mailer = createMailer({ env: { SHADOW_MAIL_MODE: 'outbox', NODE_ENV: 'test', SHADOW_SMTP_FROM: '' } });
  assert.equal(mailer.mode, 'outbox');
  assert.equal(mailer.available, true);
  await Promise.all([mailer.send(message()), mailer.send(message())]);
  const files = await readdir(join(directory, 'data', 'mail-outbox'));
  assert.equal(files.length, 2);
  assert.equal(new Set(files).size, 2);
  for (const name of files) {
    assert.match(name, /^\d+-[0-9a-f-]+\.eml$/);
    const path = join(directory, 'data', 'mail-outbox', name);
    const contents = await readFile(path, 'utf8');
    assert.match(contents, /From: shadow@localhost.test/);
    assert.match(contents, /Content-Transfer-Encoding: base64/);
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
});

test('refuses an outbox data directory redirected through a filesystem link', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadow-mail-link-test-'));
  const target = join(directory, 'elsewhere');
  await mkdir(target);
  await symlink(target, join(directory, 'data'), process.platform === 'win32' ? 'junction' : 'dir');
  const original = process.cwd();
  process.chdir(directory);
  t.after(() => process.chdir(original));
  await assert.rejects(createMailer({ env: { SHADOW_MAIL_MODE: 'outbox' } }).send(message()), { code: 'MAIL_OUTBOX' });
  assert.deepEqual(await readdir(target), []);
});
