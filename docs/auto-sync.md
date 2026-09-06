# Opt-in automatic synchronization

There are two independent switches. Both default to **off**. Login, connecting a provider, importing a backup, or restoring an account does not implicitly enable browser upload.

## Browser ↔ account server

In the account panel, use **자동 동기화 켜기** and confirm transmission of event, shadow and cost data. If the server is empty, the confirmed action seeds it from this browser. If populated copies differ, first use the existing manual upload/download controls to choose the desired version. The switch will not silently choose for you.

Local changes are checked approximately one second after persistence and server changes every 15 seconds. Focus and reconnection also trigger checks. Open editing/account dialogs pause automatic reconciliation so stale form contents are not overwritten. Closed browsers do not upload; sleeping/background tabs can be throttled by the browser. The next active check catches up.

The last common state digest and revision are persisted in `shadow.cloudSync.v1`, bound to the opted-in account; no password, token, or additional raw calendar copy is stored there. Web Locks serialize sync attempts across tabs and guard the actual local storage snapshot through a server write. Local writes can briefly wait while a network request finishes. Pending/failed writes remain visible with an unload warning; forced browser termination can still lose unsaved memory.

- Identical copies advance the common baseline without writing calendar data.
- Only the browser changed: write using the server revision (compare-and-swap).
- Only the server changed: apply with an exact in-memory state precondition, then acknowledge the baseline only after a confirmed local storage write.
- Both changed, a server disappeared, or account/session changed: pause without choosing a winner. Back up first, explicitly choose a version through the manual controls, then enable again.

Every automatic state request carries `X-Shadow-Account`; a session switch cannot send the old account's calendar to the new one. Stale tabs also compare their memory with the real `localStorage` snapshot, rather than relying on delayed storage events. Local storage errors/unsupported locks prevent automatic writes.

Offline changes stay local. Transient failures retry after 15, 30, 60, 120, 240 and at most 300 seconds; authentication and revision conflicts pause for explicit recovery. Turning off stops new requests; a request already accepted by the server may complete. Logout/password reset pause browser automation, but do not erase browser data or disable independent server automation.

Local calendar reset first waits for the shared cloud-sync lock, removes browser opt-in settings, and only then resets local storage under the app-storage lock. This ordering keeps an empty reset from being uploaded to the server or propagated to external calendars. Both normal reset and corrupt-storage recovery use the same guard. If disabling synchronization fails, reset stops without clearing calendar data. If the later local write fails, synchronization stays off; it is never automatically re-enabled. Already accepted requests can finish before reset starts, and independent server automation keeps operating on unchanged server data.

## Account server ↔ external provider

Each connected provider card offers **외부 자동 동기화 켜기**, interval **5 / 15 / 60 minutes**, status, last/next run, and explicit disable/resume controls. Enabling starts with the first run after the selected interval. The Node scheduler checks due jobs every 30 seconds, so exact execution can be later. It runs only while the single Node service is available; it does not require an open browser or current login session.

SQLite persists each user's provider-specific opt-in. Scheduling and manual sync share the per-user exclusion guard. Only the connected dedicated SHADOW calendar is modified. Failures use bounded backoff up to one hour; authentication/credential recovery, missing server data, and simultaneous-edit conflicts pause. Resolve the issue then explicitly resume. Unsupported external recurrence data remains preserved with a warning, following [integrations.md](./integrations.md).

Disabling removes future scheduling but does not undo an already-running operation. Disconnect removes that provider's automation configuration along with credentials/mappings, leaving calendars intact. On restart, overdue scheduled jobs catch up once; an interrupted `running` job waits five minutes before reconciliation. Scheduler infrastructure errors are exposed in the account panel without credential-bearing logs. Run one API process, not multiple replicas, with this database/scheduler implementation.

Database recovery is different from a routine restart. The [restore command](./deployment.md#restore-into-a-new-database) disables external automation in the new recovery file and invalidates copied sessions and account-action tokens. Sign in again, inspect the recovered calendar and provider state, then explicitly opt in again. The source database and backup are not changed.

## API and tests

`GET/PUT /api/integrations/:provider/automation` uses `{enabled,intervalMinutes}` and returns `{automation,scheduler}`. The provider listing includes `automation`, and the top-level `scheduler` has `{running,error}`. Automation fields: `enabled`, `intervalMinutes`, `status` (`idle/scheduled/running/backoff/paused`), epoch-millisecond `nextRunAt/lastRunAt` or null, safe `lastError`, and `failureCount`.

```bash
node --test server/auto-sync.test.mjs server/integrations.test.mjs
npm run test -- --run src/services/cloudSync.test.ts src/features/account/CloudSyncProvider.test.tsx
npm run test:e2e -- tests/e2e/auto-sync.spec.ts
```

Tests cover offline reconnection, concurrent edits, stale tabs, account switching, confirmed pull persistence, per-user scheduling, retry, restart recovery and opt-out during a run. Provider tests inject protocol responses; real account consent and live provider acceptance remain operator checks.
