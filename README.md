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

   **On your own always-on machine.** One script, kept alive, and the machine carries no interval at all:

   ```
   git clone https://github.com/chizhangucb/tomte.git ~/tomte-heartbeat   # a clone of its own, left on main
   GH_TOKEN=<token> FACTORY_HEARTBEAT_PING_URL=<ping url> ~/tomte-heartbeat/scripts/heartbeat-loop.sh
   ```

   Each pass fast-forward pulls `main`, runs the sender, then sleeps the interval it reads back out of `factory/heartbeat/interval.ts`, so a merged fix, a target added to `targets.ts` and a moved interval all reach the heartbeat on the next pass with nothing edited on the host. A failed pull or a failed pass is a line on stderr and the next pass runs anyway. Three things make it a recipe rather than a command that happens to run:

   - **A clone of its own**, kept on `main` and never a working checkout you also open sessions in: the loop pulls, and a branch left behind in a shared clone would change what sweeps your targets.
   - **The heartbeat's scoped token in `GH_TOKEN`**, and the check's URL in `FACTORY_HEARTBEAT_PING_URL`, both set in the loop's environment — it passes them through to each pass untouched, so the host holds no credential the pass does not use.
   - **Sleep off**, `sudo pmset -a sleep 0 disablesleep 1` on a Mac or `sudo systemctl mask sleep.target suspend.target` on Linux: a sleeping host runs no pass, and the dead-man's switch is what would tell you, hours later.

   Then the host's only job is keeping the loop alive. launchd, `~/Library/LaunchAgents/dev.you.tomte-heartbeat.plist`, then `launchctl load` it:

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <plist version="1.0"><dict>
     <key>Label</key><string>dev.you.tomte-heartbeat</string>
     <key>ProgramArguments</key><array><string>/Users/you/tomte-heartbeat/scripts/heartbeat-loop.sh</string></array>
     <key>EnvironmentVariables</key><dict>
       <key>GH_TOKEN</key><string>github_pat_...</string>
       <key>FACTORY_HEARTBEAT_PING_URL</key><string>https://hc-ping.com/...</string>
     </dict>
     <key>KeepAlive</key><true/>
     <key>RunAtLoad</key><true/>
     <key>StandardOutPath</key><string>/Users/you/Library/Logs/tomte-heartbeat.log</string>
     <key>StandardErrorPath</key><string>/Users/you/Library/Logs/tomte-heartbeat.log</string>
   </dict></plist>
   ```

   systemd, `~/.config/systemd/user/tomte-heartbeat.service`, then `systemctl --user enable --now tomte-heartbeat` (and `loginctl enable-linger you`, so it runs while you are logged out):

   ```ini
   [Unit]
   Description=tomte heartbeat loop

   [Service]
   ExecStart=/home/you/tomte-heartbeat/scripts/heartbeat-loop.sh
   Environment=GH_TOKEN=github_pat_...
   Environment=FACTORY_HEARTBEAT_PING_URL=https://hc-ping.com/...
   Restart=always
   RestartSec=60

   [Install]
   WantedBy=default.target
   ```

   Neither says how often to run anything, and neither is a timer: the repo's constant is the only copy of that number, and restarting the loop is the whole of what the host owes it. `RestartSec` is how long systemd waits before restarting a loop that died, not how often a pass runs, and it is there because the default start limit gives up on a unit that exits five times in ten seconds — which is what a host with no `node` on its `PATH` would do. Both hand the loop the keep-alive's own `PATH`, which is a short one and holds none of `node`, `git` or `gh` as nvm or Homebrew installed them — set `PATH` in the example's environment, all three, since they fail differently: without `node` the loop stops on its first pass saying it could not read the interval, while without `git` or `gh` it runs forever, every pull or every pass failing. Keep the log outside the clone, as both examples do: the loop pulls into that clone with `--ff-only`, so the day a merge adds a file where the log sits the pull is refused and the host is stuck on the code it has until somebody moves it.

   **No always-on machine: run it on Render.** The repo carries the whole recipe: `deploy/render/Dockerfile` is the image (Node, `gh`, this repo, the command above), and `render.yaml` at the root is the blueprint — one cron job on the Starter plan, auto-deploying `main`, whose schedule CI holds to the repo's interval. Three steps, in this order:

   1. **Make the healthchecks.io check.** Period the interval, grace about ten minutes. Copy its ping URL; it is the second of the two secrets below.
   2. **Create the environment group.** Render → Env Groups → New, named `tomte-heartbeat`, holding `GH_TOKEN` (the heartbeat's own token, scoped as above) and `FACTORY_HEARTBEAT_PING_URL` (that ping URL). The blueprint states no value itself and takes both from this group, so it has to exist first: deploy without it and every pass fails for want of a token.
   3. **Deploy the blueprint.** Render → New → Blueprint, pointed at your copy of this repo. It reads `render.yaml`, builds the image and creates the cron job; every merge to `main` redeploys it, so the host runs the repo as merged and never a branch.

   The blueprint's schedule is the one copy of the interval a host cannot avoid holding, and CI fails if it stops matching the repo's. A cron container is fresh for each run and keeps no disk, so the sender's pass log does not survive a pass here and its cadence line never appears; a job running slower than its schedule shows up as the check's period running out instead.

   **What it costs.** About $1 a month: Render's monthly minimum per cron service. The compute is well under it — one pass per interval, seconds of a container each — so the minimum is the bill rather than the usage, and it stays the same however many targets one sender covers. No Actions minutes on either count, and the private-repo minutes a woken sweep bills on each target are the same on any host.

   **On another provider,** the recipe is the same image or, with none, the same command: a scheduler that runs `node --experimental-strip-types factory/heartbeat/send.ts` once per interval against a checkout of `main`, with the token and the ping URL in its environment, is a host. **What any host needs** above is the contract, and Render is one worked example of it.

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
