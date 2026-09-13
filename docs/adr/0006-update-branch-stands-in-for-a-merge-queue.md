---
status: accepted
date: 2026-09-07
---

# Update-branch stands in for a merge queue

GitHub offers merge queues only on org-owned repos, and on Enterprise Cloud for private ones, and the factory serves private user-owned targets, so a queue is unavailable. In its place, `update-branch.yml` rebases deterministically: on every push to main it calls GitHub's update-branch API for each open PR that has auto-merge armed and is behind main, then carries the passing `factory/verdict` onto the new head. The plan (which PRs) is a pure function with unit tests, and no LLM is anywhere in this path. A conflict the API cannot resolve is the one case an agent is needed, and it is handed off rather than queued (ADR 0007 draws the line on whose branch the factory may write). The mechanics are in `docs/factory/merge.md`.

This is not a temporary fallback: it is the permanent merge path for private targets. A queue stays a possible opt-in for org-owned public targets, but it is out of scope, not retired (#26, #27 closed on this basis).

## Consequences

- Each extra in-flight PR costs one more CI round per merge ahead of it, where a queue would batch. Fine at v0 volume.
- update-branch runs on the heartbeat sweep and on push, so a PR is kept current with main only while the maintainer's machine is awake.
