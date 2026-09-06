# Account email delivery

Email is disabled unless explicitly configured. `createMailer({env})` returns `{available,mode,send}`; `send({to,subject,text})` accepts one recipient and resolves only after the SMTP server accepts DATA, or after the development outbox file is written. `available` indicates valid configuration, not verified delivery. No production dependency, email provider account, or deployment is installed automatically.

## Configuration

Keep actual credentials in a protected local environment file or secret manager. Never commit credentials or delivery logs containing account-action links.

| Variable | Default | Supported values |
| --- | --- | --- |
| `SHADOW_MAIL_MODE` | `disabled` | `disabled`, `smtp`, or development-only `outbox` |
| `SHADOW_SMTP_HOST` | Required for SMTP | Bare DNS hostname or IPv4/IPv6 address; no URL, port suffix, or IPv6 scope |
| `SHADOW_SMTP_TLS` | `starttls` (`implicit` when port is `465`) | `starttls` or `implicit`; plaintext is never supported |
| `SHADOW_SMTP_PORT` | `587` for STARTTLS, `465` for implicit TLS | Explicit integer port from 1 to 65535 |
| `SHADOW_SMTP_USER` | Required for SMTP | Nonempty printable ASCII username, at most 256 characters |
| `SHADOW_SMTP_PASSWORD` | Required for SMTP | Nonempty printable ASCII password, at most 256 characters; username plus password at most 330 characters |
| `SHADOW_SMTP_FROM` | Required for SMTP | A single bare ASCII email address; no display name or address list |

An absent mode does not infer SMTP from other variables. Invalid explicit settings fail startup. Disabled mode reports `available:false` and refuses `send`; callers must show that verification/recovery email is unavailable rather than claim a message was sent.

SMTP credentials must belong to a server that permits the configured sender and supports AUTH PLAIN or AUTH LOGIN over TLS. Only one connection and one recipient are used per message. This minimal implementation deliberately excludes OAuth SMTP, SASL mechanisms other than PLAIN/LOGIN, internationalized mailbox addresses, HTML, attachments, bulk sending, connection pooling, delivery queues, and automatic retries.

## Transport protections

Implicit TLS negotiates encryption before the greeting. STARTTLS requires the advertised extension and a successful upgrade; pre-upgrade capabilities are discarded and EHLO is repeated before authentication. Both paths require TLS 1.2 or later, certificate-chain verification, and hostname matching. There is no option to disable certificate verification. This follows the [STARTTLS state-reset rules](https://www.rfc-editor.org/info/rfc3207/) and [authentication over verified TLS requirements](https://www.rfc-editor.org/info/rfc4954/), using [Node 24 TLS APIs](https://nodejs.org/download/release/latest-v24.x/docs/api/tls.html).

Connections and individual replies have a 10-second deadline; the complete send has a 30-second deadline. Replies are bounded to 512 bytes per line, 32 lines/16 KiB per reply, and 64 KiB per connection. The line limit follows [SMTP reply limits](https://www.rfc-editor.org/info/rfc5321/). Four sends may run concurrently; additional sends fail explicitly instead of queueing sensitive messages in memory indefinitely.

Recipient addresses and headers reject CR/LF injection. Subjects are UTF-8 encoded words and plain-text bodies use MIME base64 with 76-character lines. Source bodies are limited to 100,000 UTF-8 bytes. Provider responses, credentials, recipient addresses, message bodies, and account-action links never appear in module errors or logs.

SMTP acceptance is not proof of inbox delivery. If the final DATA acknowledgement is lost, delivery is uncertain; the module does not retry automatically. Once DATA is accepted, a failed QUIT does not turn success into failure. Real DNS, trusted certificates, sender authorization, rate limits, spam filtering, and provider credentials still require an explicitly authorized deployment check.

## Development outbox

Set `SHADOW_MAIL_MODE=outbox` only for local development. `NODE_ENV=production` rejects it. The module does not send network traffic in this mode and uses `shadow@localhost.test` unless `SHADOW_SMTP_FROM` is set.

Messages are exclusively created as randomly named `.eml` files under `data/mail-outbox` relative to the server working directory. Directories are created with mode `0700` and files with `0600`; existing data permissions are not changed. Symbolic links/junctions at `data` or `mail-outbox` are rejected. Windows does not implement POSIX modes as user-only ACLs: keep the project/data directory in a private Windows user profile with appropriate existing ACLs.

Open the local `.eml` in a trusted mail reader to inspect a test account-action link. The base64 body is only transport encoding, not encryption: these files contain usable sensitive tokens. Never expose the directory through static hosting, an HTTP API, screen recordings, logs, source control, or shared backups. No helper prints token-bearing messages. Manually remove obsolete development messages after use; automatic retention/deletion is not implemented.

## Verification

```bash
node --test server/mail.test.mjs
```

The tests mock Node TCP/TLS sockets, exercise fragmented SMTP replies and full command ordering, and create real development outbox files in isolated temporary directories. No real provider, recipient, or external SMTP server is contacted. They verify configured certificate checks, fail-closed STARTTLS, bounded input/replies/time/concurrency, MIME round trips, safe errors, and private exclusive outbox creation. They do not establish real certificate handshakes or deliverability for a configured provider.
