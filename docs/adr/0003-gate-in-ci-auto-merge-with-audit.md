---
status: accepted
date: 2026-09-06
---

# The merge gate lives in CI, the reviewer is read-only, and auto-merge is on from day one

The merge gate is required CI status checks (a read-only reviewer's `factory/verdict`, plus `factory/red-green` and `factory/test-integrity` proofs), and merge is GitHub's native auto-merge with no human and no LLM merger. At 50 PRs a month the maintainer will not read them, so unread human review is auto-merge in disguise; and an agent's "done" is a claim (Dex Horthy's lights-off outage, SlopCodeBench's 24% strict pass for Opus 5, Huntley's placeholder warning), so the proofs live in CI where they gate the merge rather than in a step the agent runs and reports on. The first 20 merges are each re-reviewed by an audit with a revert PR on a miss, since auto-merge from day one is only survivable if a second reader that never saw the code written can catch what the first missed.

The mechanics (the ruleset, the checks, the verdict carry, conflict and retry handling, the audit) live under `docs/factory/` (routed from `docs/pipeline.md`). Two decisions this one implies have their own records: how merge lands without a queue (ADR 0006) and who may get a verdict (ADR 0007).

## Considered Options

- **A human at the PR boundary, calibrate, then flip.** Rejected: at this volume PRs go unread, and unread review is auto-merge in disguise. This ADR has no human merge path, deliberately.
- **An edit-in-place reviewer** (sandcastle's). Rejected: a reviewer that pushes commits is a second implementer nobody reviews, and GitHub will not let it approve its own changes.
- **An LLM merger agent.** Rejected: an API call rebases and re-tests deterministically (ADR 0006); an agent is needed only for a true conflict.
