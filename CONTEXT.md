# tomte

Autonomous pipeline that turns well-scoped tickets into merged code with as little human time as possible.

This file is the glossary: the words the specs, prompts, and docs all use for the same things. Name a concept here and every document names it the same way. Definitions only; how a thing is built lives in `docs/pipeline.md` (and the topic files under `docs/factory/` it routes to) and `docs/adr/`.

It binds the factory's own prose, not vendored text: where a name is sandcastle's and the behaviour under it is his, his name stays and the term's `_Except_` line says so.

## Language

**tomte**:
This thing, and the repo it lives in, `chizhangucb/tomte`. Its fixture target is `chizhangucb/tomte-fixture`. Lower case, the way a command is. Named 2026-09-12 (#116); it was `software-factory` before, and GitHub redirects that name rather than freeing it.
_Avoid_: Software Factory, software-factory, the platform, the system.
_Except_ in a dated record: `docs/research/` and the dispatcher's recorded API fixtures were written against the old name and keep it, as does any ADR paragraph arguing from what was true before the rename, and so do the two pages telling the rename's own story, `docs/adr/0003` and `docs/factory/waiver.md`. `factory/lib/factory-repo.ts` is the constant every other copy is checked against, not the only place the address is written: each of the seven `factory_repo` defaults and the caller template spells it out, because a workflow cannot import a constant, and `factory-repo.test.ts` holds every one of them to it.

The factory stays the ordinary word for what tomte does, and every term below still uses it: a factory PR, the factory's reusable workflows, the `factory` ruleset, `FACTORY_PAUSED`. The name changed, the common noun did not.

**Spec**:
A grilled, human-approved description of a feature. Produced by a grilling session then /to-spec. The parent issue of its tickets.
_Avoid_: PRD (Matt's word, same thing), plan.
_Except_ as a vendored step name: the `Refuse PRD-shaped issue` step in `.github/workflows/agent-implement.yml` stays sandcastle's. `docs/provenance/sandcastle-files.md` records that row as kept, wording only.

**Ticket**:
One vertical slice of a spec, sized to one fresh context window, carrying acceptance criteria. Produced by /to-tickets. The unit the factory picks up.
_Avoid_: task, issue (the tracker's word for the container), sub-issue.
_Except_ as a heading: `# ISSUE` and `# LINKED ISSUE` are the vendored prompts' section headings and stay sandcastle's. The prose under them says ticket.
_Except_ as a vendored label string: `wayfinder:task` is one of the `wayfinder:<type>` labels the vendored wayfinder skill creates and reads, so it keeps that spelling wherever the label is written, `scripts/onboard.sh` included. Prose about such a ticket still says ticket.

**Acceptance criteria**:
The checklist on a ticket that says what done means. Written before any agent starts. The reviewer ticks each one with evidence.

**Run**:
One agent's attempt at one ticket in one fresh sandbox, ending in a PR or an escalation.
_Avoid_: iteration (Ralph's word for a loop pass), session.

**Merge gate**:
The mechanical checks a PR must pass before it can merge. Lives in CI as required status checks, never only in an agent prompt. Its own name is `merge-gate`: the workflow, the job and the module folder all carry it, while the checks it posts keep the `factory/` prefix that says whose they are.
_Avoid_: gate on its own, because a target's own CI is often called one too (chronicle's is literally titled `CI Gate`) and because a guard is the other thing the bare word suggests; verification, validation, definition of done (say merge gate plus acceptance criteria).

**Guard**:
A check that refuses one action before it happens, in the harness rather than in CI. Lives under `scripts/guards/` and is wired from `.claude/settings.json`. Distinct from a merge gate: a merge gate blocks a merge after the work, a guard blocks a tool call before it. An accident net, never a security boundary.
_Avoid_: merge gate (the merge word), gate on its own (too broad to name either), hook (the harness's word for how a guard is wired).

**Test command**:
The one command a target's caller hands the merge gate to run a changed test file with, defaulting to `node --test`. Each file gets its own invocation of it, so a failure names the file that failed and no other. The whole-suite command the reviewer and the audit run shares the caller input's name and is a different thing.
_Avoid_: runner, test runner (the Harness entry reserves runner as Actions' word for the machine).

**Routing test command**:
A target's own test command that sends each changed test file to the command that kind of test needs, so a target with two kinds of test gets a real before-and-after proof for both rather than for one. Opt-in and the target's to write, since only the target knows which of its files are which kind; `templates/routing-test-command.sh` is the worked example it starts from.
_Avoid_: router, dispatcher (the factory's own step that moves a ticket into the factory).

**Placeholder**:
Code that satisfies the merge gate without doing the work: a stub, a hardcoded return, a test that asserts the stub, a skipped test, or a deleted test the ticket does not remove.
_Avoid_: cheating, slop.

**Unrunnable test**:
A changed test file whose process died before any test reported a result, which is neither a test that ran and failed nor one the merge gate declined to run. Not a skipped test: a skipped test is a **placeholder**, the thing the merge gate exists to catch, while this is the merge gate's own limit rather than anything the test says about itself.
_Avoid_: skipped, skip (the placeholder's word), ignored (it is named in the status, never passed over in silence).

**Escalation**:
A ticket or PR the factory gives up on: `needs-human` on it, its `agent:*` labels off and `ready-for-agent` with them, branch kept, log attached. Not only when the retry cap runs out; the reconciler and the audit reach it too. The only queue a human must read.
_Avoid_: failure, blocked (bare *blocked* is the tracker's dependency word, and `agent:blocked` is the other state: see **Blocked**).

**Requeue**:
A run handed back to the queue because what stopped it was not the ticket's failure: every account rate limited, or a check still pending when the wait for it runs out. A comment naming the cause, no retry spent, and no label for a human. One meaning on both sides (#148): a ticket is left with no factory label for the dispatcher, a PR in `agent:in-progress` for the reconciler, which re-adds the start label at its stuck deadline.
_Avoid_: retry (the attempt that is counted), hand-off (the implementer's, for a conflict), blocked (a human's).

**PR fix**:
Who repairs a pull request the factory will not merge as-is: the factory itself (a **hand-off**, `agent:implement`) or the PR's author (a **tell-author**, `agent:blocked`). The one two-way choice, keyed on whether the factory authored the PR, decided once in `factory/lib/pr-disposition.ts` (#309) and read wherever a conflict or a failing check raises the question: update-branch's conflict plan, the retry handler's conflict hand-off, its failing-check tell-author. The module returns the label and the sentence naming what it does; each caller keeps its own trigger, comment framing and accounting.
_Avoid_: escalation (the factory done trying, not repairing), requeue (no fix needed, just handed back to a sweep).

**Hand-off**:
A PR given back to the implementer because it conflicts with its base: a comment naming the cause, then `agent:implement`, with no retry spent. Made by update-branch when the API cannot bring the branch up to date, and by the retry handler when GitHub reports the conflict during its wait for checks. Never for a human: that is `agent:blocked`. Either maker makes one only on a **Factory-authored PR**, update-branch since #180 and the retry handler since #183; the same conflict on any other PR gets the comment and `agent:blocked`, since the branch is its author's and no agent may rewrite it.
_Avoid_: requeue (the retry handler's other no-retry path: a ticket goes back to the dispatcher, a PR to the reconciler), escalation (the human queue).

**Stand-down**:
The retry handler's answer to a failed attempt on a **hold** (#185): `hold` on the ticket or its open PR, so no agent is started, no retry is spent and nothing is escalated. A comment names the label and the subject it was found on, and the subject is left where a **requeue** leaves one, so taking the hold off resumes it through the sweep that owns it. Read before every other answer but an escalation already made, the retry cap included.
_Avoid_: requeue (not the ticket's failure, and nobody holding it), escalation (the factory giving up, where here a person has taken the wheel), parked (the factory's own pair).

**Effect**:
One thing the retry handler does, as a value: a small tagged record naming a comment, a label write, a close, a disarm or the requeue marker file, and the subject it lands on. `planFor` in `factory/retry/plan.ts` (#310) turns a decision into the ordered list of them, and the handler applies that list in order and chooses nothing else; each effect names what its write is *for*, never whether a refusal of it may be swallowed, which stays the handler's apply-time policy.
_Avoid_: plan for one of them (the plan is the whole ordered list, and `factory/update-branch/plan.ts` already names one PR's answer a `Plan`), action (the reconciler's word for one repair it makes), command.

**Tell-author**:
The hand-off's counterpart on a PR the factory did not author (#180): the same comment naming the conflict, then `agent:blocked` instead of `agent:implement`, because merging the base in and pushing someone else's branch is not the factory's to do. The label is what makes it stick, holding the PR through the next push to `main` here and, on a PR the reviewer has judged, parking it at the reconciler too, and the author taking it off is what hands the PR back. Updates are untouched either way.

The retry handler tells an author for a second reason (#183): a check that failed on such a PR, where labelling `agent:implement` would put an implementer on the branch just as a conflict would. Same comment shape, same label, and the retry is still recorded on the ticket and still counted, because the attempt was made and failed. So a tell-author spends no retry when a conflict caused it and spends the ticket's one when a failing check did; what it never does either way is put an agent on the branch.
_Avoid_: escalation (the factory is not giving up: a fresh verdict follows the author's fix), hand-back (the PR was never the factory's to hand anywhere), stood down (the dispatcher's word, for leaving alone a ticket an open PR claims, and the retry handler's, for a **Stand-down** on a hold).

**Blocked**:
A ticket or PR the factory has stopped on because something a person has to deal with is in the way: the `agent:blocked` label. A note rather than a transition, so the label takes nothing off and spends no retry. Who that person is and what they do depends on what stopped: a failed step is cleared by re-adding that step's label, a **tell-author** conflict by resolving it and taking the label off. Distinct from an **escalation**, which is the factory done trying rather than waiting.
_Avoid_: blocked on its own (the tracker's dependency word, so prose writes `agent:blocked`), stuck (the reconciler's word for a subject with no live run), failed.

**Parked**:
A ticket or PR the factory has stopped on and no sweep repairs: the `agent:blocked` and `needs-human` pair, `PARKED_LABELS` in `factory/lib/labels.ts`. Always the factory's own doing, which is what separates it from a **hold**, and the way the factory stops touching something without closing it.
_Avoid_: held (a hold is a person choosing the timing), stalled, abandoned.

**Hold**:
A human's instruction that the factory start no work on a ready ticket: the `hold` label, whatever else the ticket carries. It never stops a merge: to stop a started ticket, close its PR. Removing it releases the ticket: on the dispatcher's next sweep, or for work still carrying a state label, the reconciler's first sweep past its stuck deadline. Distinct from an **escalation** (the factory giving up) and from a blocker (the tracker's dependency edge): a hold is a person choosing the timing. `docs/agents/triage-labels.md` is what a triager reads.
_Avoid_: blocked, on hold as a state the factory sets (the factory never adds or removes it); paused, which since #171 names the whole target's breaker rather than one ticket's timing (**Pause**).

**Ready for human**:
A ticket a person is to implement rather than the factory: the `ready-for-human` label, one of the five triage roles `docs/agents/triage-labels.md` maps. The factory neither writes nor reads it.
_Avoid_: human ticket, manual, hold (a **hold** says not yet, this says not the factory).

**Roll-up check**:
One check name in a target's own CI that stands for every test behind it: a job that runs no test itself, reports on every pull request, and is red if any job it rolls up is red. What a target's merge rule names, so the rule never names a test. chronicle's `e2e` is the worked example and the source of the word, rolling up three shards plus a stub for the change it does not apply to.
_Avoid_: summary check (too vague to say what it promises), aggregate, gate and bare roll-up.

**Starter CI file**:
The one workflow file `scripts/onboard.sh` writes into a target that has none that runs on a pull request: `templates/rollup-check.yml` with the target caller's install command, test command and Node version in it, publishing the **roll-up check** `check`. The only file onboarding ever writes to a target, and only where there is no CI to damage.
_Avoid_: scaffold, bootstrap CI, template file (the template is what it is written from).

**Unrequired job**:
A job in a target's CI that no name in the target's merge rule stands for, directly or through a roll-up. Sometimes deliberate: chronicle's `smoke` is path-filtered Windows coverage nobody gates on. The merge gate refuses only one a pull request *adds*, so a deliberate one already in the target stays as the maintainer left it.
_Avoid_: ungated job, unwired job, missing check.

**Waiver**:
A human's declaration that the factory cannot run, so its checks are not required on one target: the repository variable `FACTORY_CHECKS_WAIVED`, whose value is the reason, plus the factory's contexts taken out of the target's merge rule. The target keeps merging on its own CI. Set and cleared only by a human, with `scripts/waive-factory-checks.sh`, never by the factory; the heartbeat names an open one every run until it is cleared, and nothing clears one automatically, because a broken factory restoring its own required checks is how a silent green happens. The exact complement of a **Pause**: a pause stops the factory working and keeps its judgement required, a waiver stops its judgement being required and leaves the factory working.
_Avoid_: outage (names the weather rather than the decision), break-glass, bypass (GitHub's word for the admin route this replaces), exemption.

**Target repo**:
A repo the factory is allowed to work on. First one is chronicle. `factory/lib/target-repo.ts` is the shared module that holds the GitHub-backed reads and writes the factory's scripts make against one, written once, choosing the reading key (`READ_TOKEN`) or the writing key (`FACTORY_PAT`) per function so no script names a key.

**Needs record**:
What one script needs from the Target repo, declared as a record of named domain reads and writes (the sweep's `Needs`, in the shape of the heartbeat's `Pass`) and handed to the script from outside: a production module in a run, an in-memory target repo in a test. Never a raw `gh` call. Each script names only what it uses, and which reads may fail softly stays the script's own policy. `target-repo.ts` holds the production records for the sweep, the dispatcher, update-branch and the retry handler, the ones whose reads and writes choose a key; `pr-context-repo.ts` holds the PR-context reads' own (#312), an agent workflow making them with the job's own token; `retry/run-needs.ts` holds the retry run's own (#315), which read the job's output on disk as much as the target repo, so they sit beside the run rather than in either. Three modules, and a record apiece rather than one wide record between them: what a script needs is what it names.
_Avoid_: seam on its own (too broad), gh wrapper (the record is domain reads, not commands).

**Caller**:
The one workflow file a target repo carries, at its own `.github/workflows/factory.yml`. It calls the factory's reusable workflows and holds that target's inputs. Copied from `templates/factory.yml`.
_Avoid_: client, consumer, the target's workflow.

**Pause**:
One target's circuit breaker: the repository variable `FACTORY_PAUSED`, whose value is the reason it is paused. While it is set the caller starts and advances no work and the heartbeat does not wake the target at all, so a pause costs no Actions minutes on an interval and only the runs the target's own events start; `merge-gate` and `audit` keep judging pull requests, which is what tells it apart from disabling the caller workflow and is why declining the wake takes nothing off a pull request, neither being heartbeat-driven. A property of one target, set by a human and never by the factory, since `FACTORY_PAT` cannot write repo variables. Scoped to the whole repo, which is what tells it from a **Hold**: a hold is a person holding one ticket back and lives on that ticket, a pause stops every ticket at once and lives on the repo. Its complement is a **Waiver**, which leaves the factory working and stops its judgement being required.
_Avoid_: halt, kill switch, freeze; hold (one ticket's, and a human's timing rather than a breaker); disable (GitHub's word for turning a workflow off, and the breaker a pause replaces). Stop is fine as the plain verb for what a pause does to a job, never as the name of the thing.

**Maintainer**:
The human who owns a target repo and the factory working on it. Sets the trust policy and answers what the factory escalates. The actor every spec's user stories are written for, so a spec stays readable when somebody else holds the role.
_Avoid_: owner (GitHub's word for the account holder), user, a personal name.

**Implementer**:
The agent that runs one ticket and produces the PR. Never approves anything.

**Reviewer**:
The agent that judges a PR against its acceptance criteria and emits the verdict. Read-only on the branch.

**Verdict**:
The reviewer's pass or fail, delivered as a required status check. Merge needs the merge gate green plus verdict pass.

**Factory PR**:
A PR the factory opened or worked on: a branch under `agent/`, the marker the implement workflow writes in the body, or the reviewer's verdict section in the body. A human can open one and the factory still owns it, so a PR implement-pr worked on counts. One definition, `factory/lib/factory-pr.ts`, read by the audit and the reconciler.
_Avoid_: agent PR, bot PR.

**Factory-authored PR**:
A PR the factory itself opened, rather than one it later worked on: a branch under `agent/`, or the marker the implement workflow writes in the body. Narrower than a **Factory PR** and answering a different question. Factory PR decides what the factory *reads and judges*; this decides what it may *do to* a branch. Escalation may close one and never another, and a conflict is the implementer's to resolve only on one. One definition, `isFactoryAuthoredPr` in `factory/lib/factory-pr.ts`, sitting beside `isFactoryPr`, which is written as this predicate plus the verdict section so the pair cannot drift.
_Avoid_: hand-authored, human PR (both name what a PR is not, and an outside agent's is neither).

**Producer**:
Anyone opening a pull request on the target other than the factory: a human, an interactive session, or a cloud agent. The audience of the judged path's instruction, and of the line every target carries in its `AGENTS.md`.
_Avoid_: contributor.

**Judged path**:
How a PR the factory did not author reaches a merge on the reviewer's verdict rather than on an admin bypass: `Closes #N` in the body, `agent:review` on the PR, auto-merge armed. Open to any producer whose branch is in the target itself, since every other required check already runs on any such PR; a fork PR is refused. A PR closing no ticket has no acceptance criteria to judge, and the bypass stays its only route. The factory never closes a PR on it or puts the implementer on its branch, since it asks who authored a PR before doing either (ADR 0007), however the PR came to be labelled.
_Avoid_: human merge path (ADR 0003 refuses one and still does; what this replaces is the *unjudged* merge, not the absent human).
_Except_ where ADR 0003 names the option it rejected: "no human merge path" is that file's own phrase for the rejection, in its Considered Options.

**Audit**:
A re-review of a merged PR against its ticket, read-only, run by an agent on the model the maintainer configured, which should be the strongest the subscription serves. Every merged factory PR for the first 20; a sampled cadence after that (deferred). A miss reverts. Reported in the digest.

**Digest**:
The daily Telegram message listing merges, escalations, and audit findings. The human's inbox for the factory.

**Dispatcher**:
The step that moves a ticket into the factory once its blockers close. Bridges the human intent label to the factory's state labels.

**Heartbeat**:
The `factory-sweep` dispatch sent to a target on an interval from outside GitHub. It is what drives the dispatcher's sweep and the reconciler, so it is required: GitHub's own `schedule` cron was removed from the caller in #270 because it did not reliably fire, and the daily recheck (#267) retries a repair that changed nothing. One sender covers any number of targets, and it sends to a running target something is waiting on, reading each target before waking it: a **Pause** is the first question and skips a paused target whatever is open on it (#256), then its open work, which skips an idle one (#212), then what is due on that work, which skips a target whose open subjects are all between deadlines (#264). The three skips are reported apart, because a pause that reads like an idle target is how a forgotten pause goes unnoticed, and a working target that reads like an idle one is how the interval becomes the only lever on the bill. It also keeps a **pass log**, its own few timestamps, and makes a **cadence claim** from it: one line when a run of passes disagrees with the documented interval, because the host's schedule is the last copy of that number the repo cannot see (#265). After the pass it reports the pass's exit status to a **dead-man's switch**, a healthchecks.io check whose ping URL the host configures and which the sender sends nothing to when it is unset or when the pass is a dry run, so a failed pass alerts at once and a pass that never happens alerts after the check's period and grace (#325); a switch that is unreachable or slow is a line on stderr and costs the pass nothing, because watching the heartbeat may not be what stops it.
_Avoid_: cron (GitHub's word for the `schedule` trigger), the sweep (what the heartbeat triggers, not the heartbeat itself).

**Loop runner**:
The script an always-on machine is given instead of an interval: `scripts/heartbeat-loop.sh`, which fast-forward pulls `main`, runs one pass of the sender, sleeps the interval it reads back out of `interval.ts`, and repeats (#326). A failed pull or a failed pass is a line on stderr and never the end of the loop, since one bad pass must not stop every target sweeping. The host's only job is restarting it, launchd's `KeepAlive` or systemd's `Restart=always`, which is what leaves the host carrying no copy of the interval: a merged fix, a target added to `targets.ts` and a moved interval all reach the **Heartbeat** on the next pass with nothing edited on the host.
_Avoid_: daemon, service (the host's word for what it keeps alive), scheduler (the thing a loop runner replaces, a host that carries the interval itself).

**Trusted author**:
Whoever the factory will take instructions from, by GitHub's `author_association`. A ticket body is what the implementer executes, and a PR comment is what the reviewer and implement-pr read, so on a public target the dispatcher runs only tickets written by a trusted author, and every agent reads only trusted authors' comments, review threads and linked-ticket comments, with a count in place of what was dropped. A PR's linked ticket is judged the same way, title and body together: the reviewer, implement-pr and the audit reach a ticket by the PR's closing keyword rather than through the dispatcher, so an untrusted author's ticket gives them no acceptance criteria and a note in place of its body (#179). Default: the repo owner alone.
_Avoid_: allowlist, whitelist.

**Trust policy**:
One target's answer to "whose words does an agent get to read", built once per run from `trusted_author_associations` and passed down as a required argument, so no read path can fall back to a policy of its own.
_Avoid_: trust list, trusted authors list (say trust policy for the object, trusted author for the person).

**Channel**:
One place the factory reads words an agent will act on: a PR comment, a review summary, a review thread, a ticket comment, a ticket's author, a parent spec, the retry marker. The trust policy owns the list and judges by it, so which channels carry the factory's own voice is the policy's answer rather than a reader's (#80).
_Avoid_: source, surface.

**Spec run**:
Every ticket of one spec worked to a merged PR or an escalation on a target repo, with no human action except reading what escalates. Composed of many runs; the first is chronicle spec #294.
_Avoid_: proof run (the fixture repo's acceptance test, a different thing), end-to-end run, real run, production run.

**Proof run**:
The acceptance test for the factory: seven tickets in two chains on a fixture repo, two accounts, one rate limit, zero human actions. Passed in #19; the switch that forced its rate limit is gone (#49), so a re-run needs a real one.
_Avoid_: spec run (a real spec on a real target, judged by what it ships rather than by what it proves).

**Fixture repo**:
A throwaway target repo with a tiny project, used only by the proof run and ticket demos.

**Rotation**:
Choosing which subscription account a run uses, by remaining quota, and retrying once on the next one when a run is rate limited.

**Agent workflow**:
A workflow that runs a model. Named with sandcastle's `agent-` prefix, so the prefix is how a reader tells which jobs spend a subscription: `agent-implement`, `agent-review`, `agent-implement-pr`, `agent-audit`. Everything else under `.github/workflows/` runs no model and keeps a plain name.
_Avoid_: agent job (Actions' word for a step group inside a workflow).

**Run shell**:
The setup every **Agent workflow** runs inside, written once in `factory/lib/run-agent-workflow.ts` (#313): rotation over the accounts with the config dir each one gets, `noSandbox()`, the prompt file beside the script, the plugins installed into that dir before each attempt, and the `try`/`catch` that turns anything thrown into the reason the workflow posts. What the run *says* stays the workflow's: its `prompt.md`, its `promptArgs`, its `extraction.md` and the schema behind it. Distinct from the **Harness**, which is the CLI the shell drives the model through, and from the **Rotation**, which is one of the things it does.
_Avoid_: wrapper, runner (Actions' word for the machine), the run (one attempt at one ticket).

**Harness**:
The CLI a run drives the model through, by sandcastle's provider name: `claude-code` today, `codex` or another vendor's under ADR 0001. What it bundles is the factory's to work around: skills the factory needs and the harness does not ship are vendored under `factory/plugins/`.
_Avoid_: runner (Actions' word for the machine), provider (sandcastle's word for the object), CLI.
