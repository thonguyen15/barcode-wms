---
key: barcode-wms::no-prod-credentials-in-smoke
topic: no-prod-credentials-in-smoke
scope: barcode-wms
status: live
level: confirmed
date: 2026-11-28
---
Smoke and verification runs that write data use placeholder or local credentials (`.dev.vars.example`, a local or in-memory DB), never the production Turso database or production tokens. If only production data can prove a change, stop and say so in the PR instead of running against prod.

Evidence: review of PR #6 (2026-11-27) reported the implementer's smoke ran against production Turso and left edit/inventory log rows.
