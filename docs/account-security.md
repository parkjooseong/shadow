# Account security and recovery

The account panel implements email ownership confirmation, forgotten-password reset, authenticated password change, and revocation of other login sessions. Mail delivery is optional and configured with [mail.md](./mail.md). Existing accounts and calendar data remain valid after the additive SQLite migration. New accounts use mailbox syntax supported by the SMTP transport; existing account login remains backward-compatible.

## User flows

- In **계정 보안**, request an email confirmation link and explicitly confirm it in the linked panel. Opening the link alone does not verify the address.
- From the signed-out panel, choose **비밀번호를 잊으셨나요?**, enter the account email, and request a reset link. Responses do not reveal whether an account exists. Enter and confirm a new 10–128-character password in the linked panel.
- A reset token expires after 30 minutes; an email verification token expires after 24 hours. Tokens are random, stored only as hashes, purpose-bound and consumed atomically once. A new request invalidates an older token of the same purpose.
- Reset and authenticated password change revoke all account sessions, outstanding OAuth states, and pending account-action tokens. They do not delete calendars, shares or provider connections, and do not automatically log the user back in. Enabled server-side provider automation is independent of sessions; explicitly disable it in the account panel if unwanted.
- **다른 기기 로그아웃** retains the current session but revokes other sessions and their OAuth states. Browser calendar data is never erased by logout.

The mail link carries its token in a URL fragment, not an HTTP query parameter. The app immediately removes that fragment from the address bar and browser history entry after opening the panel, keeps the token in memory, and posts it only after user action. Tokens/passwords are never logged or returned in request responses. Development outbox files contain sensitive one-time links: keep them private and never serve or commit them.

Mail request responses are generic `202 Accepted`, meaning the request was accepted, not proof of inbox delivery. Delivery is asynchronous and bounded. Address-hash and IP limits discourage abuse; SMTP errors do not expose whether a particular email is registered. Missing mail configuration is explicitly unavailable (`503`) for everyone. A failed delivery invalidates its token. Operators must verify real delivery, sender/domain configuration and spam-folder behavior before relying on email recovery.

Email verification is displayed but does not retroactively block existing accounts from using their calendars. It is not an administrator or identity-assurance system. Security design follows the [OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).

## HTTP additions

| Endpoint | Input / result |
| --- | --- |
| `GET /api/auth/capabilities` | Mail mode/availability and reset/verification availability |
| `POST /api/auth/password-reset/request` | `{email}`; generic `202 {ok,message}` |
| `POST /api/auth/password-reset/confirm` | `{token,password}`; `{ok,reauthenticate:true}` and expired session cookie |
| `POST /api/auth/email-verification/request` | Signed-in `{}`; `202 {ok,message}` |
| `POST /api/auth/email-verification/confirm` | `{token}`; `{ok:true}`, no login required |
| `POST /api/auth/password/change` | Signed-in `{currentPassword,password}`; `{ok,reauthenticate:true}` |
| `POST /api/auth/sessions/revoke-others` | Signed-in `{}`; `{ok,revokedSessions}` |

User responses include `emailVerified`. All mutations retain exact-Origin protection. Signed-in clients may send `X-Shadow-Account` with the expected account ID; the server rejects a changed account before reading or modifying another account's state. Password hashing and session creation use a password-version check to prevent a concurrent reset from allowing an old-password login.

## Verification

```bash
node --test server/account-security.test.mjs server/mail.test.mjs
npm run test -- --run src/features/account
npm run test:e2e -- tests/e2e/account-security.spec.ts
```

The browser tests use generated test accounts and private development `.eml` files, not external email delivery. Token expiry/replay, concurrent reset, legacy data preservation, session revocation, CSRF and changed-account rejection use real HTTP/SQLite tests.
