import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isAppState } from '../src/domain/validation.ts';

const hash = (value) => createHash('sha256').update(value).digest('hex');

export function createDatabase({ dbPath = process.env.SHADOW_DB_PATH || resolve('data/shadow.sqlite'), encryptionKey = process.env.SHADOW_ENCRYPTION_KEY } = {}) {
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const key = encryptionKey ? Buffer.from(encryptionKey, 'base64') : null;
  if (key && (key.length !== 32 || key.toString('base64') !== encryptionKey)) throw new Error('SHADOW_ENCRYPTION_KEY must be a 32-byte base64 key.');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS calendars (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      state TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE, title TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS shares_user ON shares(user_id);
    CREATE TABLE IF NOT EXISTS connections (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL, encrypted_value TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, provider)
    );
    CREATE TABLE IF NOT EXISTS oauth_states (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL, encrypted_value TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
  `);

  const encrypt = (value, aad) => {
    if (!key) throw new Error('External connections require SHADOW_ENCRYPTION_KEY.');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64')).join('.');
  };
  const decrypt = (value, aad) => {
    if (!key) throw new Error('External connections require SHADOW_ENCRYPTION_KEY.');
    try {
      const [iv, tag, ciphertext] = value.split('.').map((part) => Buffer.from(part, 'base64'));
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
    } catch {
      throw new Error('Stored connection data could not be decrypted. Verify the server encryption key.');
    }
  };

  return {
    encryptionAvailable: !!key,
    close: () => db.close(),
    createUser({ email, name, passwordHash }) {
      const user = { id: randomUUID(), email, name };
      db.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(user.id, email, name, passwordHash, new Date().toISOString());
      return user;
    },
    getUserByEmail(email) {
      const row = db.prepare('SELECT id, email, name, password_hash FROM users WHERE email = ?').get(email);
      return row ? { id: row.id, email: row.email, name: row.name, passwordHash: row.password_hash } : null;
    },
    createSession(userId, expiresAt) {
      const token = randomBytes(32).toString('base64url');
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
      db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(hash(token), userId, expiresAt);
      return token;
    },
    getSession(token) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const row = db.prepare('SELECT users.id, users.email, users.name, sessions.id AS session_id FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.id = ? AND sessions.expires_at > ?').get(hash(token), Date.now());
      return row ? { id: row.id, email: row.email, name: row.name, sessionId: row.session_id } : null;
    },
    deleteSession(token) {
      if (typeof token !== 'string') return;
      const id = hash(token);
      db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      db.prepare('DELETE FROM oauth_states WHERE session_id = ?').run(id);
    },
    getState(userId) {
      const row = db.prepare('SELECT state, revision FROM calendars WHERE user_id = ?').get(userId);
      return row ? { state: JSON.parse(row.state), revision: row.revision } : { state: null, revision: 0 };
    },
    saveState(userId, state, expectedRevision) {
      if (!isAppState(state) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('Invalid calendar state or revision.');
      const json = JSON.stringify(state);
      if (Buffer.byteLength(json) > 2_000_000) throw new Error('Calendar state is too large.');
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = db.prepare('SELECT revision FROM calendars WHERE user_id = ?').get(userId);
        const revision = existing?.revision ?? 0;
        if (revision !== expectedRevision) {
          db.exec('ROLLBACK');
          return { ok: false, revision };
        }
        const next = revision + 1;
        db.prepare('INSERT INTO calendars (user_id, state, revision, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, revision = excluded.revision, updated_at = excluded.updated_at').run(userId, json, next, new Date().toISOString());
        db.exec('COMMIT');
        return { ok: true, revision: next };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    listShares(userId) {
      return db.prepare('SELECT id, token, title, created_at AS createdAt FROM shares WHERE user_id = ? ORDER BY created_at DESC').all(userId);
    },
    createShare(userId, title, state) {
      if (!isAppState(state)) throw new Error('Invalid calendar state.');
      if (db.prepare('SELECT COUNT(*) AS count FROM shares WHERE user_id = ?').get(userId).count >= 100) return null;
      const share = { id: randomUUID(), token: randomBytes(32).toString('base64url'), title, createdAt: new Date().toISOString() };
      db.prepare('INSERT INTO shares (id, user_id, token, title, state, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(share.id, userId, share.token, title, JSON.stringify(state), share.createdAt);
      return share;
    },
    getPublicShare(token) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const row = db.prepare('SELECT title, state FROM shares WHERE token = ?').get(token);
      return row ? { title: row.title, state: JSON.parse(row.state) } : null;
    },
    deleteShare(userId, id) {
      return db.prepare('DELETE FROM shares WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
    },
    listConnections(userId) {
      return db.prepare('SELECT provider, updated_at AS updatedAt FROM connections WHERE user_id = ?').all(userId);
    },
    getConnection(userId, provider) {
      const row = db.prepare('SELECT encrypted_value FROM connections WHERE user_id = ? AND provider = ?').get(userId, provider);
      return row ? decrypt(row.encrypted_value, `${userId}:${provider}`) : null;
    },
    saveConnection(userId, provider, value) {
      const encrypted = encrypt(value, `${userId}:${provider}`);
      db.prepare('INSERT INTO connections (user_id, provider, encrypted_value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, provider) DO UPDATE SET encrypted_value = excluded.encrypted_value, updated_at = excluded.updated_at').run(userId, provider, encrypted, new Date().toISOString());
    },
    deleteConnection(userId, provider) {
      return db.prepare('DELETE FROM connections WHERE user_id = ? AND provider = ?').run(userId, provider).changes > 0;
    },
    saveOAuthState(value) {
      const { state, userId, sessionId, expiresAt } = value;
      const expires = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt);
      if (!state || !userId || !sessionId || !Number.isFinite(expires)) throw new Error('Invalid OAuth state.');
      db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').run(Date.now());
      const id = hash(state);
      db.prepare('INSERT INTO oauth_states (id, user_id, session_id, encrypted_value, expires_at) VALUES (?, ?, ?, ?, ?)').run(id, userId, sessionId, encrypt(value, `oauth:${id}`), expires);
    },
    consumeOAuthState(state, userId, sessionId) {
      if (typeof state !== 'string') return null;
      const id = hash(state);
      const row = db.prepare('DELETE FROM oauth_states WHERE id = ? AND user_id = ? AND session_id = ? AND expires_at > ? RETURNING encrypted_value').get(id, userId, sessionId, Date.now());
      return row ? decrypt(row.encrypted_value, `oauth:${id}`) : null;
    },
  };
}
