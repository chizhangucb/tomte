# Sandcastle 0.12.0 and this factory: the file-by-file record

Every file mapped to its origin, his three copied workflows stepped through step by step, the vendored scripts and prompts row by row with their line counts, and the rewrites that were avoidable. Reference, read a row at a time.

**The essay half is `docs/provenance/sandcastle.md`**: what sandcastle is, how autonomous his pipeline really is, his five agent workflows and what happened to each including what was not copied and why, what the factory added with no counterpart of his, spec #9's stories mapped onto him, and the answer to "why not just fork it". ADR 0002 (`docs/adr/0002-vendored-sandcastle-engine.md`) cites both.

- **Verified against the tree of 2026-09-09.** Every "Ours now" count, every repo path and every tree enumerated below was re-derived from the tree that day rather than carried forward, covering the boundary move (#47), the workflow rename (#61), the tarball move (#48), the writing-for-agents pass over the prompts (#56) and the prompt audit (story 14 of #75). The surviving-line figures come from the 2026-09-08 comparison against his clone, except the three prompt rows, which the prompt audit re-counted against him, and the two rows #119 touched, `implement-pr/implement-pr.ts` and `shared/review-context.ts`, re-derived against his `v0.12.0` tree by the method below and unmoved by that change. A change under `factory/agent-workflows/` or `.github/workflows/agent-*.yml` updates this file, `docs/provenance/sandcastle-files.md`; sections 2 and 3 say which counts it moves. The three "Ours now" counts in section 2 were re-derived on 2026-09-10, when #149 deleted the `slot` job from all four agent workflows: each lost about 20 lines, and the review row was carrying #148's added lines as well. "His lines surviving" is unmoved, the deleted job being ours.
- **Reference for the comparison**: a clone of sandcastle at tag `v0.12.0`, commit `e99f832`, plus `npm pack @ai-hero/sandcastle@0.12.0`. Repo HEAD and the tag are the same commit; `git log v0.12.0..HEAD` is empty.
- **Other sources**: this repo's `git log --follow`, ADRs 0001 to 0004, spec #9, spec #46, and the two dated research snapshots in `docs/research/`. Matt's YouTube demonstration of the pipeline could not be fetched, so every claim about his intent comes from his README, his workflow files or his code.
- **Line counting method, used everywhere below**: non-blank, non-comment lines, whitespace normalised; one of his lines survives if the same normalised line appears anywhere in our version of that file. Coarse: it undercounts a line reindented into a different shape.

## 1. The file map: every file to its origin

One rule, and then the lists that make it checkable file by file, so nobody has to trust the rule on its own.

> Under `factory/`, the folder `agent-workflows/` is sandcastle's and everything else is this repo's. Under `.github/workflows/`, the three named below are his and the rest are this repo's.

A provenance boundary, not a dependency one: `factory/lib/run-agent-workflow.ts` calls his `runWithExtraction` and his `run()`, and the primitives factory-authored modules used to import from his `shared/common.ts` are in `factory/lib/` since #313 dissolved that module.

### Vendored from sandcastle 0.12.0

Fifteen files, each with a row further down: three workflows, `.github/workflows/agent-implement.yml`, `.github/workflows/agent-review.yml` and `.github/workflows/agent-implement-pr.yml`, stepped through in section 2; twelve scripts and prompts under `factory/agent-workflows/`, one row each in section 3's table. `shared/common.ts` was a thirteenth until #313 dissolved it, its helpers rehomed under `factory/lib/`, which is where the list below now accounts for them. His path is `.sandcastle/agent-workflows/<same>` for a script or prompt and `.github/workflows/<same>` for a workflow.

Every line differing from his carries a comment naming the ticket or ADR that forced it (#47). A vendored `.md` carries none, because a comment in a prompt is context the model reads; the sibling script's header accounts for the prompt too.

Three files in that subtree are ours, because he ships no tests: `factory/agent-workflows/shared/diff-lines.test.ts`, `factory/agent-workflows/shared/review-output.test.ts` and `factory/agent-workflows/shared/review-context.test.ts`, the last added by #52 to prove the trust filtering over fixtures with no network. The first two say so in their opening comment; `review-context.test.ts` does not, so this paragraph is the only record that it is ours.

### Written here, no sandcastle counterpart

| Path | What it is |
|---|---|
| `.github/workflows/agent-audit.yml` | the first-20 audit; an agent workflow with no counterpart of his |
| `.github/workflows/dispatch.yml` | the dispatcher |
| `.github/workflows/merge-gate.yml` | the merge gate checks |
| `.github/workflows/update-branch.yml` | the merge-queue stand-in |
| `.github/workflows/ci.yml` | this repo's own CI |
| `.github/dependabot.yml` | watches the sandcastle and Claude Code pins |
| `factory/audit/` | `audit.ts`, `decide.ts`, `fill-links.ts`, `output.ts`, `plan.ts`, `plan.test.ts`, `report.ts`, `report.test.ts`, `prompt.md`, `extraction.md`, `state.sh` |
| `factory/dispatch/` | `dispatch.ts` and its entry point `dispatch-run.ts`, `sweep.ts` and its entry point `sweep-run.ts`, `select.ts`, `reconcile.ts`, `gh-read.ts`, a `.test.ts` for `dispatch`, `sweep`, `select`, `reconcile` and `gh-read`, `triggers.test.ts`, `workflow-names.test.ts`, `fixtures/pages/*.json` |
| `factory/merge-gate/` | `merge-gate.ts`, `changed-files.ts`, `red-green.ts`, `test-integrity.ts`, `unrunnable.ts`, a `.test.ts` sibling for each of those except `merge-gate.ts`, plus `routing-test-command.test.ts` (which covers `templates/routing-test-command.sh`, here for the globbing reason below) and `fixtures/` (`removes.ts` and its test lived here from #13 until #138) |
| `factory/retry/` | `retry.ts`, `context.ts`, `checks.ts`, `decide.ts`, `escalation.ts`, `checks.test.ts`, `decide.test.ts`, `escalation.test.ts` |
| `factory/update-branch/` | `update-branch.ts`, `plan.ts`, `plan.test.ts` |
| `factory/onboard/` | `onboard.test.ts`, which runs `scripts/onboard.sh` against a stub `gh` (story 7 of #75). The script it tests lives under `scripts/`, but `npm test` globs `factory/**/*.test.ts`, so the test lives here. And `judged-path-instruction.test.ts`, which pins `templates/agents-md-judged-path.md` to #181's bytes and holds every copy in the tree to them, here for the same reason (#181) |
| `factory/guards/` | `require-worktree-isolation.test.ts`, the hook contract for `scripts/guards/require-worktree-isolation.sh` (story 15 of #75), here for the same globbing reason |
| `factory/lib/` | `accounts.ts`, `claude-agent.ts`, `coerce.ts`, `conflicts.ts`, `env.ts`, `errors.ts`, `factory-pr.ts`, `gh.ts`, `harness.ts`, `labels.ts`, `linked-issue.ts`, `model.ts`, `plugins.ts`, `pr-disposition.ts`, `preflight.ts`, `read-only.ts`, `rotation.ts`, `run-agent-workflow.ts`, `run-log.ts`, `run-output.ts`, `sh.ts`, `target-repo.ts`, `ticket-context.ts`, `trusted-authors.ts`, `usage.ts`, `usage-record.ts`, `verdict.ts`, a `.test.ts` sibling for each of those except `errors.ts`, `labels.ts`, `read-only.ts` and the five homes #313 rehomed `shared/common.ts` into (`claude-agent.ts`, `coerce.ts`, `env.ts`, `run-output.ts`, `sh.ts`), which `helper-homes.test.ts` covers between them, plus `agent-workflow-shell.test.ts` (which reads the four agent workflow scripts, so it has no source sibling) and `strip-types-cone.test.ts` (which reads workflow files, so it has no source sibling), `agent-docs.test.ts` (which reads the `docs/agents/` pages, so it has none either, #215), `upsert-comment.sh` and `fixtures/` |
| `factory/plugins/` | `README.md`, plus `mattpocock-skills/` vendored whole at 1.2.3 (`LICENSE`, `.claude-plugin/plugin.json`, and all 25 skills under `skills/engineering/` and `skills/productivity/`). A different upstream, not sandcastle. A one-skill subset until #54 took the whole plugin (story 11 of #46), so which of Matt's skills the factory carries is visible rather than cherry-picked |
| `templates/` | `factory.yml`, the caller a target copies; `routing-test-command.sh`, the worked routing test command a target with two kinds of test copies into its own tree and names in its caller (#161); `agents-md-judged-path.md`, the one line every target puts in its `AGENTS.md` so a session opening a PR itself takes the judged path (#181); and `rollup-check.yml`, the shape of a roll-up check, which `scripts/onboard.sh` writes into a target with no CI and prints for one that has some (#242). All four files are ours; `templates/` is sandcastle's word for the folder |
| `scripts/onboard.sh` | labels, auto-merge, and the `factory` ruleset on a target, then prints the line from `templates/agents-md-judged-path.md` |
| `scripts/guards/require-worktree-isolation.sh` | the `PreToolUse` hook that refuses a subagent call handing over a worktree path (story 15 of #75) |
| `.claude/settings.json` | wires that hook in through `$CLAUDE_PROJECT_DIR`, so it survives the repo going public with no local path in it |
| `AGENTS.md`, `CONTEXT.md`, `README.md`, `docs/**` | all this repo's, including this file |
| `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore` | this repo's |

`factory/lib/` is where the boundary move (#47) put the factory-authored modules that used to sit in his `shared/` folder: `preflight.ts`, `conflicts.ts` and `errors.ts` moved out of the vendored subtree, and `gh.ts` is now the repo's one gh wrapper.

#313 finished that move. `shared/common.ts` held sixteen unrelated exports behind one import path, his and ours together, and is gone: `run-output.ts` (`outputDir`, `fail`, `writeJson`, `writeText`), `env.ts` (`required`), `sh.ts` (`sh`, `safeSh`), `coerce.ts` (the Standard Schema adapter and the coercers) and `claude-agent.ts` (`claudeConfigDir`, `claudeAgent`, the auth seam ADR 0001 names) are its five homes, all under `factory/lib/`. The `gh` re-export went with it, every caller importing `lib/gh.ts` directly. Vendored lines that move out of his subtree stay his in origin and are recorded here rather than annotated twice; `factory/lib/helper-homes.test.ts` holds the tree to the new homes.

`factory/lib/run-agent-workflow.ts` is factory-authored and has no counterpart of his: it is the shell the four agent workflows repeated a copy of each, wrapped around his untouched `runWithExtraction` (#313). `factory/lib/agent-workflow-shell.test.ts` pins the run each of the four produces through it.

## 2. The three copied workflows, step by step

**Changing a step in one of his three workflows starts here.** Find it in that workflow's table, its kept list, or the shared list below. A step of his is vendored text, so section 1 says what changing it obliges; a step in an "Added" list is ours and free to change.

Line survival, by the method at the top:

| Workflow | His lines surviving | Ours now | His share of ours |
|---|---|---|---|
| agent-implement.yml | 129 of 188 (69%) | 371 | 35% |
| agent-review.yml | 81 of 112 (72%) | 277 | 29% |
| agent-implement-pr.yml | 123 of 155 (79%) | 334 | 37% |

The "10 to 20 percent of sandcastle is left" impression comes from growth, not deletion: the files are two to two and a half times longer because of the added steps, so his share falls while the count of his surviving lines barely moves.

Some changes landed identically in every workflow, so they are stated once rather than in all three tables:

- **Removed everywhere**: **Install dependencies** and **Build**, which exist only so his scripts can self-reference his own `dist/`. The factory installs the pinned package instead, folding **Install Claude Code** in with them as "Install factory (pinned sandcastle, tsx, Claude Code)", from this repo's lockfile rather than `npm i -g` unpinned (#21, `8f0c3f1`).
- **Added everywhere**: "Enumerate accounts" and "Always remove the accounts file" (`27d972e`, stories 15, 17), "Checkout factory" (`8f0c3f1`, story 24), "Upload run log" (`8f0c3f1`, story 12), "Post usage comment" (`ef60ebd`, story 27). `trusted_author_associations` is an input on all four agent workflows (#52). The `slot` job was added everywhere too (`27d972e`, story 15) and is gone again: the factory built the per-account cap and deleted it (#149), so each agent job now carries a concurrency group keyed on its own subject number, which is his per-issue shape widened to PRs.
- **Added to review and implement-pr**: `refuse-fork` (`20e5f95`), since `pull_request_target` runs with secrets on a fork's head.
- **Added to implement and implement-pr**: "Collect the retry handoff" and the separate `retry:` job behind it (#51, story 20 of #46).

### agent-implement.yml

Kept as his: **Refuse existing PR**, **Transition labels**, **Compute branch name**.

| His step | Ours | Why, cited |
|---|---|---|
| Detect issue shape | changed | sub-issue half dropped (`594fc6a`, story 22, ADR 0002 "sub-issue refusal is removed"); closed-issue check added (`65abf07`, #19) |
| Refuse PRD-shaped issue | kept | wording only. `CONTEXT.md` cites this row: his step name stays, because the glossary binds the factory's own prose, not a vendored step name (story 13 of #75) |
| Refuse sub-issue | removed | same |
| Preflight existing PR | changed | moved into `factory/lib/preflight.ts`, so the closing-keyword regex is shared with the merge gate, the reviewer and the retry handler (`c722a10`) |
| Checkout main | changed | `path: target`, FACTORY_PAT, `persist-credentials: false` (`8f0c3f1`, `20e5f95`, "no PAT in the agent's reach") |
| Create branch | changed | resume the pushed branch on a retry (`87d0eb0`, story 12). His bot identity `sandcastle-agent[bot]` is back (#47) |
| Setup Node.js | changed | `node_version` input (`4d2ca78`). Also runs earlier than he runs it, next to our "Checkout factory", because the preflight is now a Node script |
| Run implementation agent | changed | env for model, trusted authors, OUTPUT_DIR (`8f0c3f1`, `5de4ebd`, `27d972e`, `4d2ca78`). The turn cap and the forced-rate-limit knob were here too until #49 deleted both (#46, stories 18 and 19) |
| Push branch | changed | PAT in the URL, push `refs/heads/$BRANCH` (`20e5f95`, `c722a10`); ADR 0002 "pushes use a PAT so CI runs" |
| Open draft PR | changed | renamed "Open PR" and not a draft: GitHub refuses auto-merge on drafts (`0431d99`, ADR 0003) |
| Request automated review | kept in shape | his AGENT_PAT-or-GITHUB_TOKEN fallback restored with FACTORY_PAT in AGENT_PAT's place, plus a warning that a GITHUB_TOKEN label fires no event (#47) |
| Mark blocked on failure | moved out | his step became the factory's retry-and-escalate path, which #51 moved into the `retry:` job, on `needs: implement` and `always()`: a `timeout-minutes` kill cancels the implement job, so a step gated on `failure()` never runs and a stuck agent stranded its ticket. The blocked comment is still the fallback (`87d0eb0`, story 12) |
| Always remove in-progress | changed | now "Remove in-progress" and no longer `always()`, as in implement-pr: on a failure the retry job owns the label and drops it one step before it relabels, so a ticket is never left with no `agent:*` label for the minutes that job spends starting, which is the shape the dispatcher's sweep re-dispatches (`b595b36`, #51) |

Added here alone: "Refuse closed issue" (`65abf07`), "Enable auto-merge" (`a17609c`, story 10), "Keep partial work on failure" (`87d0eb0`, story 12).

### agent-review.yml

Kept as his: **Transition labels**, **Post PR review** (path under `factory-out`), **Post thread replies**, **Mark blocked on failure**, **Always remove in-progress**.

| His step | Ours | Why, cited |
|---|---|---|
| Checkout PR branch | changed | path, PAT, no persisted credentials (`20e5f95`) |
| Prepare branch | changed | `git branch -f main origin/main` instead of a network fetch, since no credentials remain (`20e5f95`) |
| Setup Node.js | changed | `node_version` (`4d2ca78`) |
| Run review agent | changed | env for model, test output, OUTPUT_DIR (`594fc6a`) |
| Push branch | removed | the reviewer is read-only (`594fc6a`, story 5, ADR 0003, "a reviewer that pushes commits is a second implementer nobody reviews") |
| Mark PR ready | removed | `594fc6a`; then no drafts at all (`0431d99`) |

Added here alone: "Mark verdict pending", "Run target tests", "Write verdict into the PR body", "Set verdict status" (`594fc6a`, `1d4dc25`, stories 5, 6), "Trigger update-branch on a passing verdict" (`421a1b5`, story 11), "Retry or escalate on a failing verdict or merge gate" (`87d0eb0`, story 12).

### agent-implement-pr.yml

Kept as his: **Refuse closed PR** (his per-step `state == 'open'` conditions are back too; the `PR_OPEN` env refactor was undone by #47), **Transition labels**, **Post thread replies**, **Post inline comments**, **Post top-level comments** (verbatim apart from paths).

| His step | Ours | Why, cited |
|---|---|---|
| Checkout PR branch, Prepare branch, Setup Node.js | changed | as in review |
| Run implement-PR agent | changed | env for model, OUTPUT_DIR |
| Push branch | changed | PAT URL, `refs/heads` (`20e5f95`, `c722a10`); his `has_commits` guard kept |
| Mark blocked on failure | changed | "Retry or escalate" wraps it (`87d0eb0`) |
| Always remove in-progress | changed | now "Remove in-progress", since the retry job owns the failure path |

Added here alone: "Request review" after a push (`87d0eb0`, "every push is judged again").

## 3. The vendored scripts and prompts

**Changing a script or prompt under `factory/agent-workflows/` starts here.** Find its row. The last column is the standing list of reasons a difference from him is allowed to exist. The change is done when that row carries the new reason and both of its counts, recounted by the method at the top, in the same PR as the change. The row is in this file, `docs/provenance/sandcastle-files.md`, and nowhere else.

| File | His lines surviving | Ours now | What was forced |
|---|---|---|---|
| `shared/run-with-extraction.ts` | 41 of 41 (100%) | 41 | nothing. Identical to his below the provenance header #87 added, which moves no count because this method excludes comments. |
| `shared/review-output.ts` | 116 of 117 (99%) | 146 | `verdict` and one `criteria` entry per acceptance criterion in the review schema (story 5, ADR 0003). His implement-PR schema is untouched. #313 cost his one remaining line, `} from "./common";`: the coercers it named are in `lib/coerce.ts` now, that module having been dissolved. |
| `shared/review-context.ts` | 109 of 159 (69%) | 312 | `issueBody` for criteria parsing (story 5); the closing-keyword regex moved to `lib/linked-issue.ts` (#13, #16); the linked issue read through `--json` and rendered by `lib/ticket-context.ts`, since the text view carries no `author_association` and gh 2.95 prints only comments under `--comments`; the body read throws rather than falling back to `""`, so an API error cannot read as "no criteria"; an optional `diff` for the audit (story 18); #52's required `TrustPolicy` and the assembly split out of the fetch as the pure `pullRequestContext`, dropping everything a stranger can write before the reviewer, implement-pr or the audit reads it (story 27, ADR 0008); #80's channel on each of its three reads, so this file no longer decides where the factory-login exemption applies; #119's `labels` on the ticket read and `issueLabels` on the context, so implement-pr resolves the model from the ticket #10's rule names rather than from the PR; #179's `ticket-author` filter over the ticket's body and title, with the author's association read from REST beside the `--json` read, which does not carry it, and `noCriteriaReason` so a verdict says which of the three no-criteria cases a PR is in; and #313's two imports where his one read `gh`, `safeSh` and `sh` from the dissolved `shared/common.ts`, which is the one line of his the change cost. None of his lines moved under #52, #80, #119 or #179. |
| `shared/diff-lines.ts` | 28 of 30 (93%) | 35 | `+++ /dev/null` and `--- ` headers handled explicitly, no phantom trailing line. No story forced it; section 4's "`diff-lines.ts` edge cases" says why it stays. |
| `implement/implement.ts` | 24 of 33 (73%) | 74 | account rotation; model input plus `model:` label; the ticket document with parent spec (stories 22, 23); trusted-author filtering (ADR 0008); the retry section (stories 12, 13); the plugin install (story 4); commits counted on `refs/heads/$BRANCH`; and #313's shell, which is where the rotation, the config dir, `noSandbox()`, the prompt file and the plugin install now happen. His `run()` call moved into that shell with them and still runs; his zero-commit check is still here and is his. |
| `review/review.ts` | 54 of 78 (69%) | 141 | read-only plus `assertReadOnly` (story 5, ADR 0003); the verdict, the criteria parse, the PR body section and the status files (stories 5, 6); the target's test output in the prompt; rotation and the model input; #179's shared `noCriteriaReason`, so a ticket the factory refused to read is not reported as a ticket with no checklist. His REST review payload, his inline-comment filtering and his reply filtering are intact. #313 took the rotation, `noSandbox()`, the prompt file and the `try`/`catch` into `lib/run-agent-workflow.ts`; his extraction run is inside it. |
| `implement-pr/implement-pr.ts` | 73 of 79 (92%) | 105 | the conflict hand-off with `git merge-tree` and a re-check after the run (#19); the retry section; the model label, read off the linked ticket that `fetchPullRequestContext` already fetched and logged with the subject it came from (#10, #119), where it used to be a second `gh pr view --json labels` call on the PR; rotation, which #313 took into `lib/run-agent-workflow.ts` with `noSandbox()`, the prompt file, the plugin install and the `try`/`catch`. His flow is otherwise intact. |
| `implement/prompt.md` | 10 of 26 (38%) | 41 | his sections (TASK, ISSUE, CONTEXT, EXECUTION, COMMIT) are back and the paragraphs inside them are ours: parent spec, target-repo docs binding (story 23), never push or label, no network git or gh. Two sections have no counterpart of his: NO PLACEHOLDERS (stories 7, 8, 9, #13) and REVIEW AND FIX. EXECUTION and REVIEW AND FIX invoke `mattpocock-skills:tdd` and `mattpocock-skills:code-review` by name rather than restating them, and TASK fences the run to the skills the prompt names, the whole plugin being installed (story 12 of #46). #56's `writing-for-agents` pass made NO PLACEHOLDERS name the target to hit before each guardrail (story 14 of #46), and story 14 of #75 cut the merge gate's and the reviewer's own descriptions out of it, both reporting themselves. Three of his four trailing prohibitions are back verbatim; the fourth reads `ticket` for his "close the issue", because `CONTEXT.md` binds the factory's own prose and the method above normalises whitespace and nothing else, so a word swapped is a line lost. His shorter TASK line stayed ours because the clause it would have dropped, the branch a retry inherits, is not always in the retry section: `retrySectionForRun` renders nothing when the marker cannot be read. The run's 60 minutes stayed too, because a `timeout-minutes` kill reports nothing to the agent. |
| `review/prompt.md` | 18 of 33 (55%) | 40 | his sections (TASK, LINKED ISSUE, DIFF TO MAIN, PR COMMENTS, REVIEW PROCESS) are back and in his order; the paragraphs turn "actively improve the branch" into a read-only judge ticking criteria (story 5, ADR 0003). ACCEPTANCE CRITERIA and TEST OUTPUT have no counterpart of his, and the verdict needs both. Read-only is stated once with the check that enforces it and the trailing rules are positive (story 14 of #46); TASK no longer describes how that check works, `assertReadOnly` in `factory/lib/read-only.ts` being the check, and his four flat prohibitions sit beside the read-only ones (story 14 of #75). Story 8 of #75 built the reviewer half of #13 into review step 4: a deleted test is judged against what the ticket says it removes; #138 took the merge gate's own token-match approximation of that judgment out, so step 4 no longer names a `## Removes` section. |
| `implement-pr/prompt.md` | 26 of 28 (93%) | 31 | the CONFLICT and RETRY placeholders (#19); the no-credentials line (ADR 0002); his `npm run typecheck` widened to the repo's own typecheck and full suite; and the same fence to the named skills the implementer prompt carries (story 12 of #46). Story 14 of #75 cut the merge gate description, the trailing "Done when every thread carries one of those four outcomes", which restated the sentence above it, and the sentence sending the agent at a conflict first, which `conflictSection` in `factory/lib/conflicts.ts` says only when there is a conflict; it restored his TASK opener, his fourth outcome and his four flat prohibitions. Two of his lines are gone on purpose: his `npm run typecheck` line, which story 23 of #9 forbids hardcoding, and his PROCESS opener, which #56 replaced with an exhaustive one and #75 kept. |
| `review/extraction.md` | 16 of 18 (89%) | 27 | `verdict` and `criteria`, and a `summary` field that asks what the PR does and why the verdict is what it is, where his asked what the reviewer changed: he has no verdict (story 5). |
| `implement-pr/extraction.md` | 20 of 20 (100%) | 20 | nothing. Untouched. |

Four of the seven scripts are over 90 percent his. The three that are not are the three the spec changed most, and `review-context.ts` moved furthest, 97 percent to 69 under #52.

Under the writing passes, only the prompt counts moved, never a script row, because those passes touched prose and comment text and this method excludes comments. A script row moves when the code moves: #119 took `implement-pr/implement-pr.ts` from 125 lines to 122 by dropping its own label read, and `shared/review-context.ts` from 258 to 260 by carrying the labels instead. Neither moved one of his lines. #179 then took `shared/review-context.ts` from 260 to 311 and `review/review.ts` from 154 to 156, the trust filter over the ticket's body plus the reason a verdict shows a human. Both of those are re-derived by the method above; the two surviving-line counts are not, his clone not being on the machine that made the change, and they are left as they were because every line #179 removes is one of ours from story 5, #52 or #119, so none of his could have gone. #313 moved three script rows the same way #179 moved two: the "Ours now" counts above are re-derived by the method at the top, and the three surviving-line counts are not, his clone not being on the machine that made the change. `review/review.ts` went 156 to 141 and `implement-pr/implement-pr.ts` 122 to 105, all of it the copy-adapted shell leaving for `lib/run-agent-workflow.ts`; `implement/implement.ts` is unmoved at 74, its shell's departure paid for by the imports that replaced one grab-bag line with four. One line of his did move out of the subtree with that shell, `implement.ts`'s `sandcastle.run()` call, and it still runs, from the shell rather than from his file; `review.ts` and `implement-pr.ts` lost none of his, everything #313 took from them being ours from stories 15 to 17. `shared/review-context.ts` is 311 to 312, one import of `gh` and `sh` becoming two. Two surviving-line counts did move and are re-derived: `shared/review-output.ts` 117 to 116 and `shared/review-context.ts` 110 to 109, each the one import line of his that named the dissolved module, so `review-output.ts` is 99 percent his rather than 100 and its `Ours now` is unmoved at 146.

The rows above say what each difference is for; here is how the counts got where they are. #47 put his section skeletons back, taking `implement/prompt.md` from 3 surviving lines to 7 and `review/prompt.md` from 12 to 14. #54 moved no line of his, leaving `implement/prompt.md` shorter (42 lines to 40) and `implement-pr/prompt.md` one longer. #56 cost him five lines in `implement-pr/prompt.md`, 89 percent down to 71, and moved neither of the other two, since what survives in them is headings, placeholders, code fences and his closing promise line. Story 14 of #75 then moved all three the other way, restoring his wording wherever a factory line said what the merge gate, the reviewer or a workflow step already says: `implement/prompt.md` 7 to 10, `review/prompt.md` 14 to 18, and `implement-pr/prompt.md` 20 to 26, which at 93 percent is above the 89 it had before #56. Both `extraction.md` files were left alone as a format contract, and `implement-pr/extraction.md` is still the only vendored file that is his to the line.

Story 14 of #75 moved all three prompt rows the other way, on one test: a line the merge gate, the reviewer, `conflictSection` or a workflow step already enforces, renders or reports does not belong in a prompt. A line only the prompt can carry stays, whatever enforces it afterwards: the run's 60 minutes, the vendored plugin's out-of-scope skills, and the branch a retry inherits are all in that class. `implement-pr/prompt.md` went past where #56 found it, 71 percent to 93; `implement/prompt.md` 27 to 38; `review/prompt.md` 42 to 55. `factory/audit/prompt.md` took the same audit and has no row here, because it has no counterpart of his. Every script row is unchanged again, for the same reason as #56: the pass touched prompt prose and comment text only, and this table's method excludes comments.

## 4. Where rewriting was avoidable, and what has been undone since

**"Fixing" a difference from him that no ticket asked for, anywhere in `factory/` or `.github/workflows/`, starts here.** No story or ADR forced any of these, so each looks like a mistake and some are not. **Kept** means it was examined and left on purpose: leave it, and raise a ticket of its own. **Undone** means it is already gone and the entry is history. Most consequential first, with their state as of 2026-09-08.

- **Conflict resolution reinvented in implement-pr** (`3f21533`, `factory/lib/conflicts.ts`, the prompt's CONFLICT section). His `update-branch.ts` plus `agent-update-branch.yml` do exactly this: merge base, agent resolves, push with lease. #9 said conflicts escalate in v0; #19 reversed that and wrote new code. **Kept as built**: story 5 of #46 says reconciliation does not re-prove working code, and the proof run exercised this path.
- **Prompt rewrites went wholesale where edits would have done.** **Undone by #47**, then further by #54 and story 14 of #75, whose rows in section 3 carry the detail: his skeletons, then his wording wherever ours said nothing his did not.
- **Cosmetic renames that break line-for-line comparison**, all from `8f0c3f1`: `sandcastle-agent[bot]` to `factory-agent[bot]`, "Run implementation agent" to "Run implementer", "Checkout main" to "Checkout target repo", "Open draft PR" to "Open PR", the workflow names. **Undone by #61 and #47**: his `agent-` workflow names, his bot identity, and his step names wherever the step is his.
- **The `PR_OPEN` env refactor in implement-pr.yml** (`8f0c3f1`), replacing his per-step `github.event.pull_request.state == 'open'` conditions with one env var. Same behaviour, different text. **Undone by #47.**
- **`refuse-fork` jobs on review and implement-pr** (`20e5f95`). Sound, for the reason section 2's shared list gives, but no story or ADR asked for them. **Kept, with a comment**: removing them would remove a real control.
- **`diff-lines.ts` edge cases** (`20e5f95`). Real bugs (a deleted file's hunk attributed to the previous file, a phantom trailing line on every file), but not a story. **Kept, with a comment**: the merge gate maps findings onto changed lines, so reverting would change behaviour. Covered by `diff-lines.test.ts`, which has no upstream counterpart.
- **`errorMessage` and `GH_MAX_BUFFER` added to `common.ts`** (`b0b79ed`, `c1addc1`). The buffer fixed a real ENOBUFS in the dispatcher but belonged in the gh wrapper alone. **Undone by #47**: `errorMessage` lives in `factory/lib/errors.ts` with its callers, and the buffer in `factory/lib/gh.ts`, which `common.ts` re-exports.
- **Dropping his `AGENT_PAT || GITHUB_TOKEN` fallback** in "Request automated review" (`8f0c3f1`). Keeping his shape cost nothing. **Undone by #47**: the fallback is back, with `FACTORY_PAT` in `AGENT_PAT`'s place.
