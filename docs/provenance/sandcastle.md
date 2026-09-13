# Sandcastle 0.12.0 and this factory: what is his, what is ours, what changed

Not a fork of [mattpocock/sandcastle](https://github.com/mattpocock/sandcastle), and not an original pipeline either. Three of his GitHub Actions workflows, their scripts and their prompts were copied in and extended; his npm library is a pinned dependency, unmodified; everything else was written here. This is the essay half of the record, the answer to "why not just fork it", and it is the evidence for ADR 0002 (`docs/adr/0002-vendored-sandcastle-engine.md`), which cites it.

**The file-by-file half is `docs/provenance/sandcastle-files.md`**: the file map, the step-by-step tables for his three workflows, the vendored script and prompt rows with their line counts, and the list of rewrites that were avoidable. Every count, and every rule for changing a vendored file, lives there.

- **Verified against the tree of 2026-09-09.** Every repo path below was re-derived from the tree that day rather than carried forward. The comparison is a clone of sandcastle at tag `v0.12.0`, commit `e99f832`, plus `npm pack @ai-hero/sandcastle@0.12.0`; the counting method and the full verification note are in the companion.
- **Other sources**: this repo's `git log --follow`, ADRs 0001 to 0004, spec #9, spec #46, and the two dated research snapshots in `docs/research/`.
- Matt's YouTube demonstration of the pipeline could not be fetched, so every claim about his intent comes from his README, his workflow files or his code.

## 1. What sandcastle is

Two things share the name, and only one was copied.

- **The npm library** (`src/`, published as `dist/`, `@ai-hero/sandcastle`). His README calls it "A TypeScript library for orchestrating AI coding agents in isolated sandboxes". `run()` resolves a prompt file, runs `claude -p` in a sandbox provider (Docker, Podman, Vercel, Daytona, or none), waits for `<promise>COMPLETE</promise>`, collects commits and usage, and can extract a JSON `<output>` block.
- **The dogfood pipeline in his own repo**: `.github/workflows/agent-*.yml` plus `.sandcastle/agent-workflows/**`. Label-driven Actions calling `run()` with `noSandbox()`. His README and docs site never mention it. This is what was copied.

The library is a dependency, unmodified. `package.json` pins it to exactly `0.12.0`; `package-lock.json`'s `integrity` for `node_modules/@ai-hero/sandcastle` is the live check `npm ci` verifies every run; the tarball is cold storage on this repo's `engine-0.12.0` release and nothing fetches it, where #48 moved it (ADR 0002).

Nothing from `src/` was copied. Re-verified on 2026-09-08 by grepping all 161 exported names of his `src/*.ts` against `factory/`: the only matches are `run`, `claudeCode` and `Output`, all reached through the package, plus `create` and `remove` in unrelated contexts. Add the sub-path export `noSandbox` (`@ai-hero/sandcastle/sandboxes/no-sandbox`), absent from that list, and the whole contract is four names and a few types, as `docs/research/sandcastle-inventory-2026-09.md` proposed:

| Used | Where |
|---|---|
| `run()` | `factory/agent-workflows/shared/run-with-extraction.ts` and `factory/lib/run-agent-workflow.ts`, the shell every agent workflow runs inside (#313). A workflow with a tag to read reaches it through `runWithExtraction`; implement, which has none, through the shell's own call |
| `claudeCode()` | `factory/lib/claude-agent.ts` |
| `noSandbox()` | `factory/lib/run-agent-workflow.ts`, once for all four workflows (#313) |
| `Output.object()` | `factory/lib/run-agent-workflow.ts`, over the schema each workflow hands it (#313); `shared/run-with-extraction.ts` takes the definition it builds and never calls it |
| types `RunOptions`, `RunResult`, `OutputObjectDefinition`, `AgentProvider`, `AgentStreamEvent`, `LoggingOption` | the same files |

## 2. His pipeline's autonomy, honestly

The section a stranger needs, because "sandcastle already does this" and "sandcastle does almost none of this" are both said about the same repo.

**Sandcastle's autonomy lives in a local Ralph loop.** His `simple-loop` template is the autonomous product: an agent picks the next unblocked issue, commits directly, closes it, and a human QAs the app afterwards. The dispatcher here is that loop distributed across cloud runners with a judge in the way. His loop is one machine a person watches; this one is many jobs nobody watches, so everything the factory adds is the cost of removing the person.

His Actions pipeline, the part that was copied, is less autonomous than that loop. It runs with no human for exactly three things: the implement run, once `agent:implement` is on an issue, which adds `agent:review` itself; the review agent, whose prompt says "Actively improve the branch when a concrete improvement is warranted" and whose workflow pushes its commits and runs `gh pr ready`; and the update-branch agent, which merges main into the branch and resolves conflicts once labeled.

A human does everything else, quoted from his workflow files because his README is silent on it:

- Applying `agent:implement` and `agent:update-branch`. Nothing labels an issue.
- Merging. PRs open with `--draft`, and no step merges or enables auto-merge.
- Failure: "`agent:implement` run failed... Re-add `agent:implement` to retry." The same text in all five workflows. One attempt, then `agent:blocked`.
- Refusals: "Close it first, then re-add `agent:implement`."

Section 5 has the rest story by story. In short: no dependency ordering, no escalation, no accounts or rotation, one token secret, and a `verdict.txt` that is only `improved` or `clean`.

## 3. His five agent workflows, and what happened to each

| Workflow | Trigger | What it does | Copied? |
|---|---|---|---|
| agent-implement | `issues: labeled` `agent:implement` | refuse sub-issues, PRD issues, and issues with an open collaborator PR; branch `agent/issue-N-slug`; run implement.ts; force push; open a draft PR; add `agent:review` | yes |
| agent-review | `pull_request_target: labeled` `agent:review` | run review.ts, which may commit; push with lease; post a review; `gh pr ready`; reply to threads | yes |
| agent-implement-pr | `pull_request_target: labeled` `agent:implement` | run implement-pr.ts against unresolved threads; push; post replies and comments | yes |
| agent-update-branch | `pull_request_target: labeled` `agent:update-branch` | merge base into the branch; on conflict an agent resolves; push | no |
| agent-explore | `issues: labeled` `agent:explore` | agent investigates, posts one comment | no |

### What was not copied, and why

- **`agent-update-branch.yml` and `.sandcastle/agent-workflows/update-branch/`** (`update-branch.ts`, `prompt.md`, `extraction.md`). #9's Out of Scope said "the update-branch agent for true conflicts... conflicts escalate in v0", and #21 agreed. #19 then reversed that and built conflict resolution into implement-pr rather than copying his: the largest avoidable rewrite in the vendoring, kept as built for the reason the "Conflict resolution reinvented in implement-pr" entry in `docs/provenance/sandcastle-files.md` gives.
- **`agent-explore.yml` and `.sandcastle/agent-workflows/explore/`**. #21 called it "safe to ignore" and #9 excludes "any planner that invents work".
- **`release.yml`**. Changesets publish to npm; this repo publishes nothing.
- **His `ci.yml`**. `npm ci`, build and test for his own library.
- **`.sandcastle/run.ts` and `plan-prompt.md`, `implement-prompt.md`, `merge-prompt.md`, `review-prompt.md`**. His dogfood parallel-planner loop over Docker, excluded with the planner.
- **`.sandcastle/CODING_STANDARDS.md`**. His house rules, cited by his prompts. The target repo's own `CLAUDE.md`, `CONTEXT.md` and `docs/adr/` take that role (story 23 of #9), so the reference was stripped from the copied prompts.
- **`.sandcastle/Dockerfile`, `test-interactive.ts`, `test-podman.ts`, `test-vercel.ts`, `.env.example`, `.gitignore`**. Image and manual smoke scripts for sandbox providers v0 does not use, plus local-run config.
- **`src/`, `dist/templates/**`, the `sandcastle` CLI (`dist/main.js`), his `docs/` site and his own 20 ADRs.** The library is installed, not copied; the CLI and the scaffolding templates are unused; his docs are his.

## 4. Added with no sandcastle counterpart

| Piece | Story, ADR | Could his code have served? |
|---|---|---|
| dispatch (`factory/dispatch/`) | 1, 2, 21, 28, 30; #15 | No. His pipeline has no dispatcher; a human applies the label, and his `simple-loop` lets an agent pick issues, which #9 excludes ("any planner that invents work"). Story 21 is the exception: the `agent:*` label vocabulary is his, and only the thing applying it is new. |
| merge gate (`factory/merge-gate/`) | 7, 8, 9; ADR 0003; #13 | No. His pipeline trusts the agent's "ran the tests". `diff-lines.ts` was reused as a seed. |
| audit (`factory/audit/`) | 18, 19; ADR 0003; #18 | Partly. It reuses his `review-context.ts` and `run-with-extraction.ts`; the trigger and the revert logic have no counterpart. |
| retry (`factory/retry/`) | 12, 13; #16 | No. His failure path is `agent:blocked` plus "re-add the label". |
| rotation and accounts (`factory/lib/rotation.ts`, `accounts.ts`) | 15, 16, 17; ADR 0004; #17 | No. `claudeCode()` takes one token, and the library drops `is_error` from the result event so a rate limit reads as success (#21, gap 2). |
| usage comment (`factory/lib/usage.ts`) | 27; #18 | Half. The numbers come from his `RunResult.iterations[].usage`; the summing and the comment are ours. |
| trusted authors (`factory/lib/trusted-authors.ts`) | ADR 0002's two trust amendments, no story of #9's | No. His only trust check is "PR author is a collaborator" in the preflight. It began on the implementer path; #52 extended it into his `review-context.ts`, so the reviewer, implement-pr and the audit read only trusted words too. |
| update-branch, API and no agent (`factory/update-branch/`) | 11; ADR 0006 | No for the routine case: his update-branch is an agent on a label, ours an API call on push with a verdict carry. The conflict case is the "Conflict resolution reinvented in implement-pr" entry in `docs/provenance/sandcastle-files.md`. |
| run log (`factory/lib/run-log.ts`) | 12, 13 and rotation; #10 | No. Needed to read raw result events and to have a file to attach; his scripts log to stdout. |

One row has left this table: the turn cap (`factory/lib/turn-cap.ts`, story 14, #12), ten lines wrapping his public `AgentProvider` type to append `--max-turns`, since `claudeCode()` cannot pass a flag through. #49 deleted it under story 18 of #46, so the module is in the history and not in the tree.

## 5. Spec #9's stories on sandcastle

The mapping that answers "how much of this did sandcastle already do".

**He has it, and it was taken as it stands:**

- Story 3, one issue to one PR, with an existing-PR preflight.
- Story 21, the `agent:*` state labels. The whole label vocabulary is his.
- Story 25, the agent registry: the library's provider slot already holds Codex, Copilot, Cursor, OpenCode and Pi.

**He has a version that had to change:**

- Story 5, the reviewer. His edits the branch; ours must not.
- Story 11, update-branch. His is an agent on a label; ours an API call on push.
- Story 12, failure handling. His is `agent:blocked` plus a comment, with no retry, no `needs-human` and no push of the partial branch.
- Story 14, limits. His 60 minute job timeout, yes; a turn cap, no. The factory built one and deleted it (#49, story 18 of #46), so on both sides the stop on a run is the job timeout plus sandcastle's own idle timeout.
- Story 15, concurrency. His is per issue; ours was per account and is now per subject (#149), the issue number on the ticket side and the PR number on the PR side, since three of our four agent runs are about a PR rather than a ticket.
- Story 20, the model. His is hardcoded.
- Story 22, sub-issues. He refuses them; `/to-tickets` output is sub-issues by design.
- Story 23, coding standards. His prompts cite `.sandcastle/CODING_STANDARDS.md`; ours cite the target repo's own docs.
- Story 27, usage. His library returns usage per entry in `RunResult.iterations[]` and nothing posts it.

**Absent from his pipeline entirely:** stories 1, 2, 4, 6, 7, 8, 9, 10, 13, 16, 17, 18, 19, 24, 26, 28, 29, 30.

So: the spine is his and roughly two thirds of his pipeline's lines are still in the tree, while every large addition is a numbered story with no counterpart on his side. That is the honest answer to "why not just fork it": the fork would have been the three workflows, and the three workflows are exactly the part that was copied.