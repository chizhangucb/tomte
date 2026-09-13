# Waiver

A pause's complement, for a factory that cannot run: `scripts/waive-factory-checks.sh owner/repo on "<reason>"` takes the factory's three contexts out of the target's `factory` ruleset, `off` puts them back. README has the commands.

- **Where it lives.** The repository variable `FACTORY_CHECKS_WAIVED`, beside `FACTORY_PAUSED`, so both switches sit together in the target's settings. Unlike a pause it is not read by the caller: nothing in the factory reads it except the heartbeat, and nothing in the factory writes it at all.
- **The write order is the interface.** Variable, then ruleset, on `on`. A failure between them leaves a nag with nothing waived. `off` writes the ruleset first, so a half-failed close leaves the target gated with the nag still up. Both half-states are the safe one.
- **Nothing closes it.** The heartbeat names an open waiver every run. A broken factory restoring its own required checks is how a silent green happens, so no signal clears one.
- **An `onboard.sh` re-run ends one silently.** It writes the factory's three contexts back unconditionally, and clears no variable, so the target is gated again with the nag still naming a waiver. Run `off` after any re-run on a waived target.
- **It replaces the admin bypass**, which was per pull request, by hand, with no record of why.
- **It is not a standing policy.** A waiver is for a factory that cannot run, and it leaves the target merging on its own CI alone.

## Renaming the factory repo is an outage on every target

Measured on 2026-09-12 (#116), renaming `chizhangucb/software-factory` to `chizhangucb/tomte`. A reusable workflow's `uses:` does not follow GitHub's rename redirect: it is resolved from the workflow file at startup, and a caller naming the old repo fails before a single job exists. On tomte-fixture, runs 34683891313 (`repository_dispatch`) and 34683886124 (`pull_request_target`) both came back with zero jobs and "This run likely failed because of a workflow file issue".

`factory_repo` is the opposite case, and the distinction is the whole lesson. It reaches Actions as an `actions/checkout` input, which is an API call, so it does follow the redirect. Redirects work; `uses:` is the one place they do not, so do not read this as redirects being unreliable in general.

That makes the outage structural and not a race. There is no ordering that avoids it: the caller cannot name the new repo before the rename, and it cannot resolve the old one after. So a rename is a waiver window, per target:

1. `scripts/waive-factory-checks.sh <target> on "<reason naming the rename>"`.
2. Merge that target's retarget pull request, the one pointing every `uses:` at the new name.
3. `scripts/waive-factory-checks.sh <target> off`, then wake the target and check the run reaches a job.

The retarget PR cannot be judged, which is why the waiver is the only route: `factory/verdict` comes from the reviewer, the reviewer runs on `pull_request_target`, and `pull_request_target` reads the workflow from the base branch, which is the broken file. `factory/red-green` and `factory/test-integrity` do pass, since `pull_request` reads the merge ref.

An outage is also a stretch of passes the host does not run, which is the window #267 is about: the wake rule is edge-triggered one interval wide, so a deadline falling inside a window like this one is missed by the edge and caught instead by the daily recheck (#267), which retries a repair that changed nothing. Sweep what was open when the waiver closes rather than assuming the next pass finds it.

A target may also pin the factory's name in its own tests, the way chronicle's `test/factory-caller-inputs.test.mjs` asserts the `uses:` prefix. Its CI then fails the rename on its own account and its retarget PR carries more than the caller. That is the target's test doing its job; expect it rather than debugging it.
