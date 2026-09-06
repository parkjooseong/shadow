# External calendar connections

SHADOW uses a Node.js 24 server and the authenticated user's encrypted SQLite connection records. Provider connections are optional; an unconfigured provider displays its missing configuration and never reports a successful connection. OAuth tokens and Apple credentials never enter browser storage or API responses.

## Configuration

Set server-only environment variables before starting the server. Never add real values to Git or use the `VITE_` prefix for these values.

| Variable | Purpose |
| --- | --- |
| `SHADOW_PUBLIC_URL` | Exact browser origin, for example `http://localhost:5173` locally or the HTTPS deployment origin. No path or trailing slash. |
| `SHADOW_ENCRYPTION_KEY` | A stable, randomly generated 32-byte key encoded as base64. Retain securely when restarting or restoring the database. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth **Web application** credentials with the Calendar API enabled. |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | Microsoft Entra app registration, **Web** redirect platform, delegated `Calendars.ReadWrite` permission. |
| `MICROSOFT_TENANT` | Optional tenant ID; defaults to `common` for supported work, school and personal Microsoft accounts. |

Generate the encryption key using a local secure secret-management workflow. Losing this key makes existing connection credentials unreadable; replacing the key requires reconnecting providers. Existing calendar data and account passwords use their separate storage mechanisms.

If a stored provider record is corrupt or the original encryption key is unavailable, the account panel keeps that provider visible as **connection recovery required**. Its Sync action is disabled, while healthy providers, account calendars and sharing remain available. The server does not discard credentials merely because it cannot decrypt them, and does not include decryption diagnostics or credential contents in the response.

First restore the original server key if available, then refresh the account status. Otherwise choose **연결 정보 제거** for the affected provider and confirm the removal. This deletes only that provider's stored connection/mapping data; it leaves local, server and external calendar events intact. Removal remains available even when the provider's OAuth configuration or encryption key is currently missing. Configure a working key/client, then use the separate connect action and confirm it to authenticate again. No reconnection or synchronization starts automatically. The next explicit sync creates a new dedicated SHADOW calendar, leaving the previous one unchanged.

Register these exact callback URLs, replacing the origin for deployment:

```text
http://localhost:5173/api/integrations/google/callback
http://localhost:5173/api/integrations/microsoft/callback
```

The browser origin must proxy `/api` to the SHADOW server in development. Production uses a same-origin server or reverse proxy over HTTPS. Registration in a provider console and granting consent are manual account-owner steps; no live credentials are bundled with the repository.

Google requests `calendar.app.created`, the least-privilege scope for calendars created by the app. OAuth authorization codes use S256 PKCE and a random, ten-minute, single-use state bound to the SHADOW user and session. The callback consumes state before token exchange. Google offline access and Microsoft `offline_access` enable refresh tokens. [Google OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Google PKCE](https://developers.google.com/identity/protocols/oauth2/native-app), [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth), [Microsoft authorization flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow).

Apple requires an Apple Account email and an **app-specific password**, not the normal account password. Generate one in the Apple Account settings with two-factor authentication enabled. The server discovers the principal and calendar home through CalDAV; no user-supplied server URL is accepted. [Apple app-specific passwords](https://support.apple.com/en-us/102654), [CalDAV protocol](https://www.rfc-editor.org/rfc/rfc4791).

## User-visible behavior

1. Sign in to SHADOW and save the current calendar to the account.
2. Connect Google, Outlook or Apple. Connection alone performs no remote event/calendar writes.
3. Press **Sync** explicitly. The first sync creates a dedicated calendar named **SHADOW**. Only that calendar participates in synchronization.
4. SHADOW events are created there, and events created in that dedicated calendar are imported into SHADOW. Further syncs transfer edits and deletions in both directions.
5. When both copies changed since the last sync, neither overwrites the other. Select **local** or **remote** for the reported conflict. Changed versions invalidate an old choice and ask for a new decision.
6. Disconnect removes the stored credentials/mappings. Local and remote events remain. To revoke the provider's underlying consent or Apple app password, use that provider's account settings. Reconnecting creates a new dedicated calendar on the next sync; existing remote calendars are not deleted or adopted by name.

As an alternative to repeated manual runs, each provider has a separate **외부 자동 동기화 켜기** action with explicit consent and 5/15/60-minute intervals. It is off by default, persists per account/provider, and runs on the Node server even after browser logout/closure. Authentication or simultaneous-edit conflicts pause it; transient errors back off. Turning it off prevents future runs but does not cancel a request already in progress. See [auto-sync.md](./auto-sync.md) for scheduling, status and recovery.

Shared fields are title, location, date/time, all-day/multiday status and supported recurrence. SHADOW preparation, outbound/return travel, recovery, costs, event type and other local metadata remain local and survive imports. New remote events start with zero shadow/cost values and the first available local type. Core event data will be transmitted to the selected provider when syncing; that provider's privacy and retention policies apply.

## API

All endpoints require the current authenticated session. State-changing requests also require the server's normal same-origin CSRF checks. Callback GETs require the session plus the OAuth state, not an Origin header.

| Method and path | Request / result |
| --- | --- |
| `GET /api/integrations` | `{ providers: [{ id, configured, configurationError, connected, recoveryRequired, recoveryMessage, lastSyncedAt, conflicts, lastError }] }`; `connected` records stored connection presence, while `recoveryRequired` indicates unreadable credentials. |
| `POST /api/integrations/google/connect` | `{ url }` for the consent page. Microsoft uses the same shape. |
| `POST /api/integrations/apple/connect` | Body `{ username, password }`; result `{ connected: true }` only after successful discovery. |
| `GET /api/integrations/:provider/callback` | OAuth `code` and `state`; redirects to `/?integration=connected&provider=...` on success. |
| `POST /api/integrations/:provider/sync` | `{ imported, exported, deleted, conflicts, warnings }` |
| `POST /api/integrations/:provider/resolve` | Body `{ conflictId, choice: "local" \| "remote" }`; performs a fresh version check and sync. |
| `DELETE /api/integrations/:provider` | `{ disconnected: true }`; does not delete provider calendars. |
| `GET/PUT /api/integrations/:provider/automation` | Read/configure `{enabled,intervalMinutes:5\|15\|60}`; result `{automation,scheduler}`. |

Conflict entries contain `id`, `eventId`, `title`, `reason`. Errors return an HTTP failure and `{ error, code }` with a safe user message, never token payloads. Provider permission failures require reconnecting or retrying after token refresh. Rate-limit responses are surfaced without silently retrying write operations.

## Synchronization and limitations

Google stores `nextSyncToken`, follows all page tokens, consumes cancellation tombstones and performs a fresh snapshot if a token expires (`410`). Outlook uses the stable Graph v1.0 dedicated-calendar list with pagination and ETags; the documented stable delta API targets the primary calendar, so SHADOW does not depend on a beta endpoint or modify the primary calendar. iCloud uses bounded calendar-query snapshots and ETags. Completed snapshots detect remote deletions; missing entries from incomplete/failed requests do not trigger deletion. [Google incremental sync](https://developers.google.com/workspace/calendar/api/guides/sync), [Microsoft stable delta scope](https://learn.microsoft.com/en-us/graph/api/event-delta?view=graph-rest-1.0).

Remote writes carry `If-Match`, or `If-None-Match` for new CalDAV objects. Google deterministic IDs and Outlook transaction IDs reduce duplicate creation on retries; local/remote mappings and caches are persisted after successful operations. A sync can partially complete if the network fails; successful changes remain recorded and retry reconciles the rest. Imports merge into the latest local state using its revision, preserving concurrent local work. The server serializes integration operations per user; deploy a single server process with this SQLite implementation.

The v1 connector accepts a maximum of 5,000 remote objects, 100 list pages and 5 MB per provider response. Provider requests have a 15-second timeout. Date/time is normalized to Asia/Seoul. Common bounded daily, weekly and monthly series work. Google rules with unsupported BYxxx/count/RDATE semantics, edited individual Google recurrence instances, Outlook recurring exclusions or unsupported recurrence patterns, and iCloud resources that import as multiple components/materialized occurrences are retained remotely and reported as warnings instead of converted lossily. These cases can be handled via reviewed ICS import/export. This is not a general-purpose complete implementation of every recurrence feature in every provider.

Only `caldav.icloud.com` and numbered `pNN-caldav.icloud.com` HTTPS hosts receive Apple credentials, including on redirects. Event writes are constrained to the connected dedicated collection. XML parsing rejects DTDs, custom entities, mismatched tags and excessive nesting/size; it does not resolve external entities. Google/Microsoft next-page URLs cannot forward bearer tokens to another host.

## Verification

Run `node --test server/integrations.test.mjs` (or the server test script). The tests use real SQLite and injected protocol-level provider responses to cover PKCE/state/session checks, token refresh, Google create/update/delete in both directions, conflict choice, remote deletion recovery, ETag conditions, dedicated Outlook paths, iCloud ICS, request bounds and credential-forwarding rejection. These are transport-contract tests, not proof of a successful live Google/Microsoft/Apple consent flow.

Credential-recovery tests additionally corrupt a real SQLite encrypted record, reopen a database with a different key, and reopen it without a key. They verify isolated recovery status, secret-safe responses, unchanged calendar data and explicit connection deletion without provider network calls. `npm run test -- --run src/features/account/AccountPanel.test.tsx` verifies that cancelling removal/reconnection performs no mutation and that unavailable configuration does not prevent removing unreadable credentials.

Before real deployment, register each OAuth client, configure HTTPS/origin/encryption, connect actual test accounts, then verify create → sync → edit in provider → sync → conflict choice → delete → sync in the dedicated SHADOW calendars. Exercise token expiration/revocation and disconnect with those accounts. Live provider credentials are not available in the automated test environment, so this account-owner acceptance check remains required.
