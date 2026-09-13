# Merge

No merge queue (unavailable on user-owned repos), so update-branch stands in (ADR 0006) with three deterministic pieces.

- Auto-merge (squash) is enabled on every factory PR the moment `agent-implement.yml` creates it, with `FACTORY_PAT`. GitHub refuses auto-merge on drafts, so factory PRs open ready; the required `factory/verdict`, absent until the reviewer posts it, is what holds the merge.
- The `factory` ruleset requires a PR and the checks above on an up-to-date head, so a PR behind main cannot merge.
- `update-branch.yml` runs on every `push` to main and on the `repository_dispatch` event `factory-update-branch`, which `agent-review.yml` sends with `FACTORY_PAT` after a passing verdict.

For each open PR that has auto-merge enabled and is behind main, update-branch calls GitHub's update-branch API, then carries the passing `factory/verdict` onto the merge commit GitHub made, with its provenance in the status description. That merge commit is made with `FACTORY_PAT`, so the target's CI and the merge gate run again on the new head and auto-merge lands the PR on the latest main.

A verdict travels only across merges GitHub itself made, so a commit a person or an agent pushed never inherits one, and a PR whose governing verdict is pending or failed waits for its re-review.

A conflict the API cannot resolve on a **Factory-authored PR** is handed to the implementer (#19): a comment plus `agent:implement` on the PR, so `agent-implement-pr.yml` runs, sees the conflict, and the agent merges `main` into the branch, resolves and commits. The push re-runs CI, the merge gate and the review, and auto-merge lands the new head. A conflict still present after that run fails it, so the hand-off cannot loop and #16 counts the attempt. A PR already in `agent:implement`, `agent:in-progress`, `agent:review` or `agent:blocked` is left alone, and a resolution that fails takes the normal retry and escalation path (#16).

On any other PR the conflict goes back to its author (#180): a comment naming the cause plus `agent:blocked`, and no agent goes near the branch, because merging `main` in and force-pushing someone else's branch is not the factory's to do (ADR 0007). The label is what makes that stick. This job runs again on every push to `main` with the conflict still there, so without it the comment would repeat; and the reconciler re-arms a **Factory PR** carrying no `agent:*` label at its verdict deadline, so a judged PR would be enrolled again unresolved. `agent:blocked` is both a hand-off label here and a parked label there, so one label answers both, and the author removing it after pushing the resolution is what hands the PR back. Updates are untouched by this: the update call never asks who opened a PR, so any PR with auto-merge armed is kept up to date whoever opened it.
