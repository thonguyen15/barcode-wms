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
