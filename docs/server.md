# Account, sync, and sharing server

The server runs on Node.js 24 using built-in HTTP, SQLite, and cryptography APIs. It adds no production package dependency. The default SQLite file is `data/shadow.sqlite`; keep this directory private and outside public static hosting. The React build is served from `dist/` when present.

## Local development

Run the API and Vite in separate terminals:

```bash
node server/index.mjs
npm run dev
```

The API listens on `127.0.0.1:8787`; the expected browser origin is `http://localhost:5173`. Configure Vite to proxy `/api` to the API server. Open the exact configured browser origin: `localhost` and `127.0.0.1` are different origins. Accounts, cloud state, and sharing need no provider credentials. External connections remain unavailable until their encryption key and provider configuration are supplied; see [integrations.md](./integrations.md).

## Server configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | API bind address |
| `PORT` / `SHADOW_PORT` | `8787` | API port (`PORT` takes precedence) |
| `SHADOW_ORIGIN` | `SHADOW_PUBLIC_URL` or `http://localhost:5173` | Exact allowed browser origin without a path or trailing slash |
| `SHADOW_PUBLIC_URL` | Provider-specific default | Public origin used by OAuth callbacks; set equal to `SHADOW_ORIGIN` |
| `SHADOW_DB_PATH` | `data/shadow.sqlite` | Persistent SQLite file; parent directory created if absent |
| `SHADOW_ENCRYPTION_KEY` | None | Base64-encoded 32-byte key for external credentials and OAuth state |
| `SHADOW_TRUSTED_PROXIES` | Empty (trust none) | Comma-separated exact IP addresses of controlled reverse proxies; no hostnames, ports, scopes, or CIDRs |
| `SHADOW_MAIL_MODE` | `disabled` | Optional `smtp` or explicit development-only `outbox`; see [mail.md](./mail.md) for SMTP variables |

For a single-server build, run `npm run build`, then run the server with the origin where users actually access it. A non-local production origin must use HTTPS. Terminate TLS at a trusted reverse proxy and keep the database directory on persistent private storage. Set `HOST=0.0.0.0` only when the hosting environment requires it. Static-only hosting does not provide the API or account functionality. No deployment is created automatically.

Provision `SHADOW_ENCRYPTION_KEY` through the hosting secret manager and preserve it across restarts. Changing it makes existing provider connections unreadable; reconnect after restoring the original key or intentionally replacing those connections. A local PowerShell session can generate a key without printing it:

```powershell
$env:SHADOW_ENCRYPTION_KEY = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"
```

The command above is session-local. Use a protected environment file with Node's `--env-file` option if persistence is needed; never commit that file. Back up the database and encryption key separately. SQLite WAL mode can have `-wal` and `-shm` sidecars while running; stop the process cleanly before making a simple file-copy backup.

## HTTP contract

All APIs return JSON. Errors use `{ "error": "message" }`. Mutations require an exact matching `Origin` header, including registration, login, logout, and OAuth initiation. API responses are not cached. Safe GET requests can omit Origin. Cookies are used only on the same origin; permissive CORS is not enabled.

| Method and path | Request | Response |
| --- | --- | --- |
| `GET /api/health` | — | `{status:"ok",version:1}` |
| `POST /api/auth/register` | `{email,password,name}` | `201 {user:{id,email,name}}` and session cookie |
| `POST /api/auth/login` | `{email,password}` | `{user:{id,email,name}}` and a rotated session cookie |
| `POST /api/auth/logout` | — | `{ok:true}`, invalidated session |
| `GET /api/auth/me` | — | `{user:null}` or `{user:{id,email,name}}` |
| `GET /api/state` | Session | `{state:null,revision:0}` or `{state:AppState,revision:number}` |
| `PUT /api/state` | `{state:AppState,revision:number}` | `{revision:number}`; stale revisions return `409 {error,revision}` |
| `GET /api/shares` | Session | `{shares:[{id,token,title,createdAt}]}` |
| `POST /api/shares` | `{title,state:AppState}` | `201 {share:{id,token,title,createdAt}}` |
| `DELETE /api/shares/:id` | Owner session | `{ok:true}` |
| `GET /api/public/:token` | No session needed | `{title,state:AppState}` |

Email addresses are normalized to lowercase. Names must contain 1–50 characters and passwords 10–128 characters. Passwords are salted and hashed with scrypt (`N=32768`, `r=8`, `p=1`); raw passwords are not persisted. Session cookies are HttpOnly, SameSite=Lax, valid for seven days, and Secure when the configured origin is HTTPS. Only token hashes are stored for sessions. Login rotates the current session; logout revokes it immediately. User responses also include `emailVerified`. Password recovery, email verification, password changes and other-session revocation are implemented in [account-security.md](./account-security.md).

State writes validate the same domain schema as the browser and use an atomic SQLite transaction for optimistic concurrency. A client must load the current revision before replacing server state, and must explicitly handle `409` rather than silently retrying an overwrite. User IDs are derived exclusively from sessions, never request bodies.

The optional `X-Shadow-Account` header binds a request to the account displayed by the client; an authenticated mismatch returns `409` without touching either account. Opt-in [browser and provider automatic synchronization](./auto-sync.md) retains these guards. The server starts/stops the provider scheduler with the HTTP service and waits for active jobs and bounded mail sends before closing SQLite.

Sharing publishes an immutable snapshot of the supplied state, including event titles, locations, shadows, and costs. The UI must obtain explicit consent before creating a link. Anyone possessing the random bearer link can read that snapshot; there is no public write API. Later calendar edits do not modify a share. Revoking a link stops subsequent API reads but cannot erase copies a recipient has already saved. Listing and revoking shares are owner-only; each account may keep up to 100 links.

Request bodies are capped at 2 MB. Authentication is limited to 20 requests per client IP per 15 minutes and four simultaneous password calculations across all clients. By default the client is the direct socket peer, and forwarded headers are ignored. Without an explicit proxy configuration, users behind the same proxy share this IP limit. The limiter is process-local; run one API process for this SQLite-backed MVP. No request bodies, passwords, sessions, or provider tokens are logged.

If a controlled reverse proxy fronts the API, explicitly list its exact IP in `SHADOW_TRUSTED_PROXIES`. For example, `127.0.0.1` is appropriate only if the proxy reaches Node from that loopback address and all processes with access to that socket are trusted. Configure every trusted hop to overwrite untrusted `X-Forwarded-For` input or append the actual peer address correctly, and restrict direct access to the Node port. Never trust an arbitrary client, shared client NAT, hostname, or whole network. Keep the proxy's own connection and rate controls enabled.

Only a trusted immediate peer enables `X-Forwarded-For`. The server walks its bare IP addresses from right to left across explicitly trusted hops and uses the first untrusted address; client-supplied values farther left cannot override it. IPv6 spellings and IPv4-mapped IPv6 addresses are normalized before comparison. A missing header falls back to the socket peer. A malformed trusted header returns `400` before password work; the full chain is limited to 16 addresses and 1,024 bytes. Untrusted peers' headers remain ignored, even if malformed. `Forwarded` and `X-Real-IP` are not used. Configuration accepts at most 64 exact IPv4/IPv6 addresses; invalid entries fail startup instead of silently widening trust. This option does not configure a proxy or modify any deployment automatically.

## Provider integration store

`createApp({dbPath,origin,trustedProxies,encryptionKey,integrationFactory,distPath})` returns `{server,database,close}`. `trustedProxies` defaults to `SHADOW_TRUSTED_PROXIES` and accepts the same comma-separated IP list. `integrationFactory({store,origin})` returns an object with `route({method,path,url,body,userId,sessionId})`, which resolves to `{status,body}` or `{status,redirect}`. These routes execute only after authentication and mutation Origin checks.

The database exposes synchronous `getState`/`saveState` (compare-and-swap revision), user-scoped `getConnection`/`saveConnection`/`deleteConnection`, metadata-only `listConnections`, and `saveOAuthState`/`consumeOAuthState`. Connection JSON and temporary OAuth state are encrypted with AES-256-GCM and bound to the owning user/provider or OAuth identifier using authenticated additional data. OAuth state is consumed once and bound to the originating session.

## Verification

```bash
node --test server/client-ip.test.mjs server/app.test.mjs
```

Tests exercise real ephemeral HTTP servers and SQLite databases: account/session lifecycle, CSRF rejection, schema validation, account isolation, concurrent revision conflicts, immutable shares, owner-only revocation, body/rate limits, independent clients behind trusted proxies, ignored spoofed headers, malformed forwarding chains, the shared four-password-work limit, Secure cookies, encrypted credential persistence, and session-bound single-use OAuth state. Node 24 currently emits an experimental SQLite warning; it is not suppressed. Provider HTTP contract tests are separate and do not establish real provider account authorization.

The SQLite and cryptography APIs follow the [Node.js SQLite documentation](https://nodejs.org/api/sqlite.html) and [Node.js 24 cryptography documentation](https://nodejs.org/docs/latest-v24.x/api/crypto.html).
