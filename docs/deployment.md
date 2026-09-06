# Single-server deployment and database recovery

These files prepare a deployment; they do not create hosting, publish an image, configure a domain, or change a live service. The application remains one Node 24 API process with built-in SQLite and a static React build. Do not run multiple API replicas against this SQLite file: session rate limits and integration scheduling are process-local.

## Container layout

The Dockerfile uses a [multi-stage build](https://docs.docker.com/build/building/multi-stage/): `npm ci` and the Vite build run in the build stage; the runtime contains built assets, the server, required shared TypeScript domain/ICS files, and the backup script. It does not need runtime npm packages. The process runs as the image's non-root `node` user. `.dockerignore` excludes local environments, databases, development mail, VCS state, tests, and logs from the build context.

The [Compose service](https://docs.docker.com/reference/compose-file/services/) uses a persistent `shadow-data` volume mounted at `/app/data`, a read-only root filesystem, a small temporary filesystem, dropped capabilities, and no-new-privileges. Only host loopback `127.0.0.1:8787` is published. A health check verifies `/api/health`; it does not prove mail delivery or external provider authorization. Graceful shutdown closes the SQLite connection before process exit.

Before an authorized deployment:

1. Install Docker with Compose and prepare a private `.env` file using `.env.example` as a reference. Set `SHADOW_ORIGIN` to the exact public HTTPS origin with no trailing slash. Compose also uses it for provider callback origin. Keep all secrets out of shell history and command output.
2. Place a separately managed HTTPS reverse proxy in front of the host loopback port. Domain registration, TLS certificates, proxy configuration, firewall rules, and hosting are intentionally not created here. If the proxy is itself containerized, deliberately configure its network rather than broadly publishing the API.
3. Configure only known proxy peer IPs in `SHADOW_TRUSTED_PROXIES`, following [server.md](./server.md). A Docker bridge peer may differ from host loopback. Do not guess trust entries or disable TLS/Origin checks.
4. Provision a persistent 32-byte base64 `SHADOW_ENCRYPTION_KEY` and retain it securely outside database backups. Configure SMTP/provider credentials only when those optional features are wanted; production rejects the development outbox. See [mail.md](./mail.md) and [integrations.md](./integrations.md).
5. Review the configuration with `docker compose config --quiet`. Do not print the expanded Compose configuration in shared logs because environment values may contain secrets.

When the operator chooses to start the service:

```bash
docker compose build
docker compose up -d
docker compose ps
```

The first named volume inherits `/app/data` ownership for the non-root user. Existing volumes or bind mounts need compatible private ownership/ACLs; this repository does not change host permissions automatically. Do not use `docker compose down --volumes` for routine upgrades: it removes persistent data. Rebuild and replace the service only after a verified backup, leaving the volume intact.

## Online database backup

```bash
npm run backup -- --source data/shadow.sqlite --target data/shadow-backup-2026-09-07.sqlite
```

Supply both paths explicitly. The source must exist, and the target and its SQLite sidecars must not exist. The target parent must already be a private directory. Choose a new filename for every snapshot; there is no overwrite, delete, rotation, or broad-directory operation.

The script uses the [Node SQLite online backup API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html#sqlitebackupsource-db-path-options), not a live file copy, so committed WAL data is included consistently while the server remains available. It validates source and result with `PRAGMA integrity_check`, converts the result to a standalone rollback-journal database, syncs the file, and publishes it with an exclusive hard link. A racing target creator cannot be overwritten. Only the script's newly created private staging files are cleaned up. The target filesystem must support hard links; unsupported filesystems fail explicitly. Heavy concurrent writes can prolong a backup, so use a quiet period for large databases.

For the container, use explicit in-volume paths:

```bash
docker compose exec shadow node scripts/backup.mjs --source /app/data/shadow.sqlite --target /app/data/shadow-backup-2026-09-07.sqlite
```

The snapshot contains personal calendar data, accounts/password hashes, sessions, share links, and encrypted provider credentials. It does not copy environment secrets, SMTP credentials, the encryption key, or outbox files. Treat it as sensitive: POSIX files are created with `0600`; Windows requires private existing ACLs. Copy verified snapshots to a separately protected storage location as an operator action. A copy on the same volume is not disaster recovery. Keep the encryption key separately and test recovery periodically.

## Restore into a new database

Stop the application before recovery. The acknowledgement flag records the operator's decision; the script cannot prove that a separately running service has stopped. It creates a new validated database and never replaces the active file. Only `--restore` applies these safety changes in one transaction to the private restoration copy before publication:

- Disable and pause all stored external automatic synchronization, clear the next-run time, and require explicit review/re-enabling.
- Remove historical sessions, pending OAuth authorization states, and password-reset/email-verification tokens. Users must sign in again and request fresh verification/reset links if needed.
- Preserve each share's ID, owner, title, calendar snapshot, and creation date, but generate a new 256-bit bearer token. Old public links no longer work; owners must deliberately redistribute the new links.

Accounts/password hashes, calendars, revisions, encrypted external connections, and share contents remain intact. Ordinary backups preserve all records unchanged; neither mode edits its source or the original backup. Older databases lacking the newer security/automation tables are supported. Malformed automation JSON or an unsupported record schema aborts restoration explicitly without publishing a target.

```bash
npm run backup -- --restore --server-stopped --source data/shadow-backup-2026-09-07.sqlite --target data/shadow-restored.sqlite
```

For Compose, stop the API container first, then use a temporary service container against the existing volume:

```bash
docker compose stop shadow
docker compose run --rm --no-deps shadow node scripts/backup.mjs --restore --server-stopped --source /app/data/shadow-backup-2026-09-07.sqlite --target /app/data/shadow-restored.sqlite
```

After successful verification, explicitly configure the stopped server to use the new file and the matching encryption key, then restart and verify account/calendar access. For Compose, change its `SHADOW_DB_PATH` entry deliberately; the supplied compose file fixes the default path, so changing only `.env` does not override it. Preserve the former database and sidecars until recovery is confirmed. Restore does not change configuration, rename the active database, reset account passwords, or restart the service. Sign in again, review the restored data, and explicitly re-enable desired external automation. Account credentials and encrypted provider credentials match the backup; review them as part of recovery. The original backup still contains historical tokens and must remain private. Token invalidation affects the new restored server database, not copies of data that recipients already saved.

## Verification and limits

```bash
node --test server/backup.test.mjs server/mail.test.mjs
node scripts/backup.mjs --help
docker compose config --quiet
docker build --tag shadow-calendar:local .
```

Real temporary SQLite tests cover live WAL snapshots, uncommitted-write isolation, no-overwrite races, stale sidecars, corruption, restore acknowledgement, restored-only token invalidation/automation pausing, preservation of account/calendar/share contents, legacy schemas, malformed automation records, and safe CLI output. Local Docker availability is required for image/runtime verification. The CI workflow runs Node 24 checks, browser tests, a built-SPA smoke test, and an image build, without deployment, registry push, production credentials, or publishing sensitive test artifacts. GitHub Actions do not run until the workflow is committed/pushed by the user. Action setup uses the official [checkout](https://github.com/actions/checkout) and [setup-node](https://github.com/actions/setup-node) actions.
