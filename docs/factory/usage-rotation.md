# Usage and rotation

## Usage

Every factory PR carries one usage comment per role: `<!-- factory:usage:implementer -->` from implement and implement-pr, `<!-- factory:usage:reviewer -->` from review. The audit's usage sits inside its own comment.

Rows are attempts: model, wall time, `claude -p` calls, turns, input, cache write, cache read and output tokens, and the agent's list-price cost as a reference figure, not what the run was billed. The account never appears here; see Rotation below. The source is the raw `result` event of every `claude -p` call, summed in `factory/lib/usage.ts` and recorded by `runWithRotation` after each attempt to `OUTPUT_DIR/usage.json` and `usage-<role>.md`, so a run that fails afterwards still reports. sandcastle's own `iterations[].usage` is a context snapshot rather than a total, so it is not used. `factory/lib/upsert-comment.sh` posts the file, editing the existing comment for the marker rather than adding one.

## Rotation

The agent slot and its auth are vendor- and plan-agnostic (ADR 0001, ADR 0002). Rotation is how the current Claude wiring spreads load across subscription accounts to dodge rate limits; an API key or another vendor flows through the same auth seam as a rotation of one. What follows is that current wiring.

The workflow enumerates the `CLAUDE_CODE_OAUTH_TOKEN_<n>` secrets, masks every token, and hands the list to the run script as a file. The script picks the lowest-indexed account, deletes the file, runs, and re-runs once on the next account if the result event says rate limited. Every surface the factory writes names an account by its index, never by token and never by its `CLAUDE_ACCOUNT_<n>` label (#126): the job log, the usage comment posted to the target's PR (#18), the escalation and requeue comments, the log the retry handler attaches, and the uploaded artifacts. A public target's Actions log is world-readable, so a label an operator named after themselves would otherwise be published on every agent run. "Which account paid for this" is answerable from the index everywhere; the label maps an index back to an account and reaches only `OUTPUT_DIR/usage.json`, which stays on the runner. Module: `factory/lib/rotation.ts` (`pickToken`, `isRateLimited`, no network); run path: `factory/lib/accounts.ts`. Quota-aware ranking is #24.

**Nothing caps how many runs are in flight.** Rotation on a real rate limit is the only thing that moves a run off an account; the per-account cap that used to bound it is gone, and no cap of any shape comes back until a real rate limit is observed (#149, ADR 0004). What the workflows still serialise is one subject: each agent job's concurrency group is its own issue number (implement) or PR number (review, implement-pr, audit), with `cancel-in-progress` false, so two runs on one ticket or PR never overlap while two different subjects never wait on each other. The audit's `decide` job has a group of its own for the counter, which is not a cap.
