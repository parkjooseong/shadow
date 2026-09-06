import { backup, DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { link, lstat, mkdtemp, open, rmdir, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sidecars = ['-wal', '-shm', '-journal'];
const fail = (code, message) => Object.assign(new Error(message), { code });

async function requireAbsent(path) {
  try { await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw fail('TARGET_EXISTS', 'The target or a target sidecar already exists. Choose a new filename.');
}

function verifyIntegrity(database) {
  const rows = database.prepare('PRAGMA integrity_check').all();
  if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') throw fail('INVALID_DATABASE', 'SQLite integrity check failed.');
}

function restoredAutomation(value) {
  let record;
  try { record = JSON.parse(value); } catch { /* Report one safe, explicit schema error below. */ }
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || typeof record.enabled !== 'boolean' || ![5, 15, 60].includes(record.intervalMinutes)
    || !['idle', 'scheduled', 'running', 'backoff', 'paused'].includes(record.status)
    || !['nextRunAt', 'lastRunAt'].every((key) => record[key] === null || Number.isSafeInteger(record[key]) && record[key] >= 0)
    || !Number.isSafeInteger(record.failureCount) || record.failureCount < 0
    || !(record.lastError === null || typeof record.lastError === 'string' && record.lastError.length <= 500)) {
    throw fail('RESTORE_AUTOMATION', 'Restore refused: an integration automation record contains invalid JSON or an unsupported schema. The backup was not changed.');
  }
  return { ...record, enabled: false, status: 'paused', nextRunAt: null, lastError: '백업에서 복원되어 자동 동기화를 중지했습니다. 계정과 캘린더를 확인한 뒤 직접 다시 켜 주세요.' };
}

/** Restrict only the unpublished restoration copy; ordinary snapshots preserve access data. */
function applyRestoreSafety(database) {
  const tables = new Set(database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => row.name));
  database.exec('BEGIN IMMEDIATE');
  try {
    if (tables.has('integration_automations')) {
      const update = database.prepare('UPDATE integration_automations SET record = ? WHERE user_id = ? AND provider = ?');
      for (const row of database.prepare('SELECT user_id, provider, record FROM integration_automations').iterate()) {
        update.run(JSON.stringify(restoredAutomation(row.record)), row.user_id, row.provider);
      }
    }
    for (const table of ['oauth_states', 'account_tokens', 'sessions']) {
      if (tables.has(table)) database.exec(`DELETE FROM ${table}`);
    }
    if (tables.has('shares')) {
      const shares = database.prepare('SELECT id, token FROM shares').all();
      const used = new Set(shares.map((share) => share.token));
      const update = database.prepare('UPDATE shares SET token = ? WHERE id = ?');
      for (const share of shares) {
        let token;
        do { token = randomBytes(32).toString('base64url'); } while (used.has(token));
        used.add(token);
        update.run(token, share.id);
      }
    }
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}

/** Publish a validated SQLite online snapshot without ever replacing the target. */
export async function createDatabaseSnapshot({ source, target, restore = false, serverStopped = false }) {
  if (typeof source !== 'string' || !source.trim() || typeof target !== 'string' || !target.trim()) throw fail('SNAPSHOT_ARGUMENTS', 'Explicit --source and --target file paths are required.');
  if (restore && !serverStopped) throw fail('RESTORE_CONFIRMATION', 'Stop the application server, then explicitly pass --server-stopped for a new-file restore.');
  const sourcePath = resolve(source);
  const targetPath = resolve(target);
  const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if ([sourcePath, ...sidecars.map((suffix) => sourcePath + suffix)].some((path) => samePath(path, targetPath))) throw fail('SNAPSHOT_ARGUMENTS', 'The target cannot be the source database or one of its sidecars.');
  let directory;
  let database;
  try {
    const sourceInfo = await lstat(sourcePath);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw fail('INVALID_SOURCE', 'The source must be an existing regular database file, not a link or directory.');
    const parentInfo = await lstat(dirname(targetPath));
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw fail('INVALID_TARGET', 'The target parent must be an existing private directory, not a link.');
    for (const path of [targetPath, ...sidecars.map((suffix) => targetPath + suffix)]) await requireAbsent(path);
    database = new DatabaseSync(sourcePath, { readOnly: true, timeout: 5000 });
    database.exec('PRAGMA trusted_schema = OFF; PRAGMA query_only = ON;');
    verifyIntegrity(database);
    directory = await mkdtemp(join(dirname(targetPath), '.shadow-snapshot-'));
    const temporary = join(directory, 'snapshot.sqlite');
    const placeholder = await open(temporary, 'wx', 0o600);
    await placeholder.close();
    await backup(database, temporary);
    database.close();
    database = undefined;
    const snapshot = new DatabaseSync(temporary, { timeout: 5000 });
    try {
      snapshot.exec('PRAGMA trusted_schema = OFF; PRAGMA journal_mode = DELETE;');
      if (restore) applyRestoreSafety(snapshot);
      verifyIntegrity(snapshot);
    } finally { snapshot.close(); }
    const handle = await open(temporary, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    // Hard-link publication is atomic and fails if another writer won the name.
    // Unlike rename(), it cannot overwrite a file created after our first check.
    for (const suffix of sidecars) await requireAbsent(targetPath + suffix);
    await link(temporary, targetPath);
    return { mode: restore ? 'restore' : 'backup', bytes: (await stat(targetPath)).size };
  } catch (error) {
    if (['TARGET_EXISTS', 'INVALID_DATABASE', 'INVALID_SOURCE', 'INVALID_TARGET', 'RESTORE_AUTOMATION'].includes(error.code)) throw error;
    if (error.code === 'EEXIST') throw fail('TARGET_EXISTS', 'The target already exists. No existing file was overwritten.');
    throw fail('SNAPSHOT_FAILED', 'SQLite snapshot failed. Check source integrity, permissions, and hard-link support on the target filesystem.');
  } finally {
    database?.close();
    if (directory) {
      // Remove only files belonging to this freshly created private staging directory.
      for (const name of ['snapshot.sqlite', ...sidecars.map((suffix) => `snapshot.sqlite${suffix}`)]) {
        await unlink(join(directory, name)).catch((error) => { if (error.code !== 'ENOENT') throw fail('SNAPSHOT_CLEANUP', 'Snapshot staging cleanup failed; a validated target may already exist. Inspect the private staging directory.'); });
      }
      await rmdir(directory).catch(() => { throw fail('SNAPSHOT_CLEANUP', 'Snapshot staging cleanup failed; a validated target may already exist. Inspect the private staging directory.'); });
    }
  }
}

export function parseSnapshotArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === '--restore' || name === '--server-stopped') {
      const key = name === '--restore' ? 'restore' : 'serverStopped';
      if (options[key]) throw fail('SNAPSHOT_ARGUMENTS', 'Duplicate command option.');
      options[key] = true;
    } else if (name === '--source' || name === '--target') {
      const key = name.slice(2);
      const value = args[++index];
      if (options[key] || !value || value.startsWith('--')) throw fail('SNAPSHOT_ARGUMENTS', 'Each source and target must be supplied exactly once.');
      options[key] = value;
    } else throw fail('SNAPSHOT_ARGUMENTS', 'Unsupported command option. Use --help.');
  }
  if (!options.source || !options.target || (options.serverStopped && !options.restore)) throw fail('SNAPSHOT_ARGUMENTS', 'Explicit --source and --target are required; --server-stopped is only for --restore.');
  return options;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseSnapshotArguments(process.argv.slice(2));
    if (options.help) console.info('Usage: node scripts/backup.mjs --source <existing.sqlite> --target <new.sqlite> [--restore --server-stopped]');
    else {
      const result = await createDatabaseSnapshot(options);
      console.info(`SQLite ${result.mode} completed; integrity check passed (${result.bytes} bytes). Encryption key is not included.`);
      if (result.mode === 'restore') console.info('Historical access tokens invalidated; external automation disabled. Sign in again and review calendars before re-enabling synchronization.');
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
