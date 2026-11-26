# barcode-wms worker

Cloudflare Workers build of the app. The Express app in the repository root stays the production
server until the migration is finished; this folder is additive.

## Layout

- `wrangler.jsonc`: worker name, static assets (`../public`), the `RATE_LIMITER` binding.
- `src/index.mjs`: Hono app, page guard, `/api` mount, static asset fall-through.
- `src/routes/<domain>.mjs`: one Hono subapp per domain, see `src/routes/README.md`.
- `src/auth.mjs`: accounts from the environment, signed `wms_auth` cookie, `requireAuth`.
- `src/password.mjs`: PBKDF2-SHA256 hashing and verification.
- `src/db.mjs`: Turso client (`@libsql/client/web`), `getDb`, `batch`.
- `src/telegram.mjs`, `src/login_notify.mjs`: Telegram send helpers and the login alert.
- `scripts/hash-password.mjs`: prints the password hash to put in `*_PASS_HASH`.

## Local development

1. `cp .dev.vars.example .dev.vars` and fill it in. `.dev.vars` is git-ignored.
2. `npm install`
3. `npm run hash-password -- '<password>'` for each account, paste the output into `*_PASS_HASH`.
4. `npm run dev`, then open http://localhost:8787/login.html

Keep `TG_DRY_RUN=1` and the placeholder bot token in `.dev.vars`, or every local login sends a real
message to the group.

## Variables

| Variable | Set where | Purpose |
|---|---|---|
| `SESSION_SECRET` | secret | HMAC key of the `wms_auth` cookie; a missing value fails every auth check |
| `ADMIN_USER`, `ADMIN_PASS_HASH` | secret | admin account |
| `STAFF_USER`, `STAFF_PASS_HASH` | secret | staff account |
| `BONG_USER`, `BONG_PASS_HASH` | secret, both optional | entry account |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | secret | Turso database |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | secret | Telegram bot and default chat |
| `NOTIFICATION_GROUP_CHAT_ID` | secret, optional | login-alert chat, defaults to `TELEGRAM_CHAT_ID` |
| `TG_DRY_RUN` | `.dev.vars` only | `1` logs Telegram calls instead of sending |
| `BYPASS_AUTH` | `.dev.vars` only | `true` signs every request in as admin; never deploy it |

Deployed values go in with `npx wrangler secret put <NAME>`; nothing secret belongs in the `vars`
block of `wrangler.jsonc`.

A session cookie stops validating 30 days after it was issued. Password hashes use the format
`pbkdf2$<iterations>$<salt_b64>$<hash_b64>`; the default is 25000 iterations, override with
`PBKDF2_ITERATIONS` when hashing.
