# barcode-wms

Project map:

- `server.js` + `db.js` + `public/` — Express production app running on Synology (Docker container `barcode-wms`).
- `worker/` — Cloudflare Worker version, running in parallel until cutover.
- `mercari-watcher/` — standalone Mercari new-listing watcher, separate container service (`mercari-watcher`, health on 127.0.0.1:8788).

Hard rules:

- GitHub account for this repo: `quocdat029x` only.
- Never dispatch `deploy.yml` or `deploy-mercari-watcher.yml` — deploys are manual by Dat.
- The Telegram webhook of the main bot points to Synology until cutover; the watcher bot is a separate bot created via BotFather.
- No comment lines (`//` or `#`) in code; JSDoc one-liners for public functions only.
- Keep source files under 500 lines; JS modules only (`.mjs`); named exports; `===`.
Branch and verification rules (from retro 2026-11-28):

- Record the base commit SHA in the PR body (`Base: <sha>`). If `main` moves after branching (rebase, revert, re-land), rebase onto the new head, resolve, re-run every verification step, and update the Base line before pushing. A reviewer checks mergeability on current `main` before a deep review; a stale base is a request to rebase first.
- Smoke and verification runs that write data must use placeholder or local credentials (`.dev.vars.example`, a local or in-memory DB), never the production Turso database or production tokens. If only production data can prove the change, stop and say so in the PR instead of running against prod.
- A review or verification verdict is recorded on the PR (review or comment via gh), never only in a chat message.
