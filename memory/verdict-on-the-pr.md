---
key: barcode-wms::verdict-on-the-pr
topic: verdict-on-the-pr
scope: barcode-wms
status: live
level: confirmed
date: 2026-11-28
---
A review or verification verdict is recorded on the PR itself (review or comment via gh), never only in a chat message. Chat posts can be lost ("answered together with another message") and automation runs can fail to dispatch (the Claude agent hit its weekly limit on 2026-11-28).

Evidence: verify-merge automation runs 8-10 on 2026-11-28 ended `dispatch_failed` with no PR review; run 11 merged PR #8 but its result was never posted to the coordinator's chat.
