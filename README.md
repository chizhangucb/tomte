# tomte

An autonomous software factory: reusable GitHub Actions workflows that orchestrate coding agents to turn a labeled ticket into a merged PR, with no human in the path. You write the ticket and read what the factory escalates; everything in between is agents and required status checks.

Two things make it work:

- **The merge gate lives in CI, not at a human boundary.** An agent's "done" is a claim, so a read-only reviewer's verdict and a red-green proof are required checks GitHub gates the merge on. Nobody presses merge; auto-merge does, once every check is green.
- **Any agent, any plan.** The engine's agent slot is vendor-agnostic and auth flows through one seam (ADR 0001), so a coding agent runs on a subscription or an API key without reshaping the pipeline. Today it is wired and tested on Claude.

The factory lives in this repo. A target repo carries one workflow file that calls it.

## How a ticket becomes a merge

1. You label a ticket `ready-for-agent`.
2. The **dispatcher** picks it up once every blocker is closed and adds `agent:implement`.
3. The **implementer** builds it on `agent/issue-N-<slug>` and opens a PR with `Closes #N` and auto-merge enabled.
4. The **merge gate** (no agent) posts `factory/red-green` and `factory/test-integrity` on the PR, alongside the target's own CI.
5. The **reviewer** judges the head against the ticket's acceptance criteria and posts `factory/verdict`.
6. **Auto-merge** squashes the PR once every required check is green.
7. **update-branch** keeps auto-merge PRs current as main moves, handing a real conflict back to the implementer.
8. The **audit** re-reviews each of the first 20 merges and opens a revert PR on a miss.

A failing run or check in steps 3–5 earns one informed retry, then escalates to `needs-human`.

## Prerequisites

A target repo on GitHub, plus:

- **A coding-agent account** — today a Claude subscription (`claude setup-token`, any of Pro, Max, Team, or Enterprise); the auth seam is built to take an API key or another vendor too (ADR 0001).
- **A fine-grained PAT scoped to that one target** — contents, issues, pull requests, and workflows write.
- **A host that runs the heartbeat every 30 minutes** — any always-on machine or cloud scheduler but a GitHub cron (it does not fire reliably), holding the heartbeat's own token and watched by a healthchecks.io check; step 5 below is the whole list of what a host needs.

## Onboard a target repo

1. **Copy the caller.** `templates/factory.yml` → `.github/workflows/factory.yml` in the target. It is the only factory file the target carries.

2. **Add the secrets.**
   - `FACTORY_PAT`: a fine-grained PAT, one per target, so pushes fire the target's CI. Scope it Repository access → Only select repositories → the target being onboarded and nothing else. Reuse no token from another target: one stored on two repos puts write on each inside the other's secret store.
   - `CLAUDE_CODE_OAUTH_TOKEN_<n>`: one per subscription account. Adding an account later is one more secret.

   One token per target is one expiry per target, and nothing in the factory watches them — GitHub emails the owner before it lapses, so record the date. A lapsed token fails every factory job on that target at the first step that uses the token, and the dispatcher then labels nothing, so its tickets sit `ready-for-agent` looking held; one target red while every other target keeps working is a lapsed token, not a factory bug.

3. **Run the onboarding script.** `scripts/onboard.sh owner/repo`. It creates the label vocabulary, allows auto-merge, and writes the `factory` ruleset on the default branch (PR required, squash only, the three factory checks plus the target's own CI required on an up-to-date head). Name the target's own checks as arguments (`scripts/onboard.sh owner/repo check lint`); the script guesses none. Re-run it any time to update the ruleset.

4. **Let this repo serve its workflows.** Settings → Actions → General → Access. A private factory repo will not serve them otherwise.

5. **Add the target to the heartbeat.** One line in `factory/heartbeat/targets.ts`, then run the sender every 30 minutes from a host of your own. One sender covers any number of targets and only wakes a target with work due.

   **What any host needs.** Any provider will do — this is the whole contract, so you can run it wherever you already live:

   - **The command**, once per interval: `GH_TOKEN=<token> node --experimental-strip-types factory/heartbeat/send.ts`.
   - **Node 22 or newer**, which is what strips the types with nothing installed, and `gh` on the host's `PATH`, which every read and every wake goes through.
   - **A checkout of `main`**, pulled before each pass, so a branch left behind in some clone never changes what sweeps your targets.
   - **The heartbeat's own fine-grained token**, never a target's `FACTORY_PAT`, scoped to: contents write, issues read, pull requests read and Actions variables read, on every target in `targets.ts` and nothing else.
   - **The interval**, every 30 minutes, which is the only number the host carries.
   - **A healthchecks.io check, and its ping URL in `FACTORY_HEARTBEAT_PING_URL`**, set in the command's environment beside `GH_TOKEN`. The sender reports each pass's exit status to it, so a failed pass alerts at once and a dead host alerts once the check's period and grace run out; give the check a period of the interval and a grace of about ten minutes. Leave the variable unset and no ping is sent.
   - **Not a GitHub cron**, which was measured firing a small fraction of the times it should and was taken out of the caller for it (`docs/factory/dispatcher.md` has the measurement).

Then label a ticket `ready-for-agent` and the pipeline above runs. To hold a ready ticket back, add `hold`. Labeling `agent:implement` by hand also works.

**Two conditional extras**, both in `docs/factory/caller-inputs.md`: a target with two kinds of test needs a **routing test command** (`templates/routing-test-command.sh`), and any producer opening its own PR (an interactive session, a cloud agent) needs the judged-path line (`templates/agents-md-judged-path.md`) in its `AGENTS.md`; its branch has to be in the target, not a fork, or the PR is refused.

## Operate a target

**Pause** — stop the factory starting or moving work, one repository variable whose value is the reason:

```
gh variable set FACTORY_PAUSED --repo owner/repo --body "runaway sweep, see #123"
gh variable delete FACTORY_PAUSED --repo owner/repo   # resume
```

`merge-gate` and `audit` keep running, so a pause never quietly takes the merge gate off a human's PR. The heartbeat stops waking a paused target (#256), so the pause costs no runs and no billed minutes. In an incident, **pause first, then cancel** — cancelling first buys a replacement run within a minute. Before you resume, fix what caused the pause: no event is replayed, but the first sweep dispatches everything still `ready-for-agent`.

**Waive** — for a factory that cannot run at all (PAT expired, Actions down), take its checks off one target so it keeps merging on its own CI:

```
scripts/waive-factory-checks.sh owner/repo on "factory PAT expired, see #244"
scripts/waive-factory-checks.sh owner/repo off   # put them back
```

Only a human runs the waiver (`FACTORY_PAT` cannot write repo variables), and nothing closes it automatically — the heartbeat names an open one every run.

Don't use `gh workflow disable factory.yml` to pause: it takes `merge-gate` and `audit` down too, and their checks then never appear on a PR rather than failing.

## Where to read more

- `docs/pipeline.md`, the router: a pointer per topic into `docs/factory/`, where every caller input, every stage in full, the failure paths, the engine, and the onboarding caveats a target migrated across versions live.
- `CONTEXT.md` — the glossary. `docs/adr/` — the decisions. The spec is issue #9.
- `docs/provenance/` — why the engine was vendored from sandcastle rather than forked, file by file.
- `docs/agents/` — the rules binding an agent working in this repo.
