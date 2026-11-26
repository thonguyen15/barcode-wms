# barcode-wms worker

Cloudflare Workers build of the app. The Express app in the repository root stays the production
server until the migration is finished; this folder is additive.

## Layout

- `wrangler.jsonc`: worker name, static assets (`../public`), the `RATE_LIMITER` binding.
- `src/index.mjs`: Hono app, page guard, `/api` mount, static asset fall-through.
- `src/routes/<domain>.mjs`: one Hono subapp per domain, see `src/routes/README.md`.
- `src/auth.mjs`: accounts from the environment, signed `wms_auth` cookie, `requireAuth`, `requireAdmin`.
- `src/password.mjs`: PBKDF2-SHA256 hashing and verification.
- `src/db.mjs`: Turso client (`@libsql/client/web`), `getDb`, `batch`.
- `src/telegram.mjs`, `src/login_notify.mjs`: Telegram send helpers and the login alert.
- `scripts/hash-password.mjs`: prints the password hash to put in `*_PASS_HASH`.
- `src/label/`: the shipping label renderer, see "Label renderer" below.
- `src/routes/label.mjs`: `GET /api/debug/label/:sample` (admin), returns a sample label PNG.
- `scripts/build-atlas.mjs`, `scripts/compare-label.mjs`, `scripts/in-image.mjs`: label tooling, see below.

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

## Label renderer

`src/label/` draws the 548x338 shipping label of `generateLabelBuffer` in `server.js` without
`canvas`, in a few milliseconds of Worker CPU:

- `index.mjs`: `renderLabel(item, qrText)` returns a PNG as a `Uint8Array`. `item` carries `mvd`,
  `serial_clean`, `serial_raw` and `name`; `qrText` is the token the QR code encodes.
- `render.mjs`: the layout of `server.js` (QR at `548-7-326`, MVD baseline 47, serial 75, name
  from 99 every 24px, logo at the bottom centre) and the QR code, drawn on the module grid of the
  `qrcode` PNG with the bilinear downscale Cairo applies to it.
- `text.mjs`: glyph lookup, advances, kerning, wrapping and the font rules node-canvas gets from
  Pango: kerning only inside one script run, a space takes the font of the text before it (or of the
  text after it when that font is earlier in the font list), and Latin runs sit 0.53px (20px) or
  0.48px (18px) higher in a line that starts with Japanese.
- `atlas.mjs`, `atlas.bin`: the pre-rendered glyphs; `png.mjs`: RGB PNG encoder on
  `CompressionStream`; `samples.mjs`: the sample items of the debug route and the comparison.

Output is RGB, not grayscale, because the logo is a colour image. Combining marks, format
characters and control characters are drawn as zero-width; every other character outside the atlas
is drawn as U+25A1 and logged once per isolate.

### Glyph atlas

`atlas.bin` is a build artifact of 8.2 MiB. It holds every glyph of Gill Sans MT Bold at 34, 18 and
20px and JIS X 0208 level 1 (rows 1-8 and 16-47, 2,965 kanji) plus a few extras of Noto Sans JP
Bold at 18 and 20px, each in 4 (Gill) or 1-2 (Noto) horizontal sub-pixel phases and two vertical
positions, with advance widths, kerning pairs and the pre-scaled logo. wrangler imports it as a
`Data` module.

Build it inside the production image, where the anti-aliasing and the baseline shift are measured
from the image's FreeType and Pango:

    npm run build-atlas:image

That builds the Docker image of the repository root and runs the script in a copy of the tree that
uses the image's `node_modules`.
`npm run build-atlas` on a developer machine also runs, but the result differs per platform; commit
only an atlas built in the image. `fonts/NotoSansJP-Bold.ttf` is a variable font whose default
instance is Thin, so the build asks for weight 700 through the family name instead of the
`Noto Sans JP` alias that `server.js` registers.

### Compare with the Express label

`npm run compare-label -- [--sample japanese] [--threshold 32] [--max-diff 0.01]` renders every
sample with the `server.js` drawing code, once with the production font list and once with the
atlas fonts, and with the atlas. It writes the PNGs and a difference table to
`worker/dist/label-compare/` and exits non-zero when the same-font text difference of a sample
exceeds `--max-diff`. Run it inside the production image for numbers that mean anything, because
on a developer machine the canvas falls back to system fonts for Japanese:
`npm run compare-label:image -- --max-diff 0.01`.

### Debug route

`GET /api/debug/label/:sample` (admin session) returns the PNG of a sample from `samples.mjs`;
`?repeat=200` renders it 200 times and reports the average render time in the `Server-Timing`
header.
