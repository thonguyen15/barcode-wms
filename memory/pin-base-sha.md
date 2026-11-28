---
key: barcode-wms::pin-base-sha
topic: pin-base-sha
scope: barcode-wms
status: live
level: confirmed
date: 2026-11-28
---
Record the base commit SHA in the PR body (`Base: <sha>`). When `main` moves after branching (rebase, revert, re-land), rebase onto the new head, resolve, re-run every verification step and update the Base line before pushing. Reviewers check mergeability on current `main` before a deep review.

Evidence: PRs #4, #5, #6 (2026-11-26) stayed open 423-446 minutes after `main` was reverted (0943ddb) and re-landed (f4e564d) mid fan-out; reviewer found missing foundation files and add/add conflicts.
