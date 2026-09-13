# The factory pipeline

The reference behind README, split so an agent loads one topic. README is the front door: what the factory is and how to onboard a target. This page is the router: one line per topic and a pointer to the file that carries its mechanics, why and gotchas together. Follow the pointer your task needs.

## Topics

- **Onboarding**: the reasoning behind README's steps, the label vocabulary, and what to re-copy for a target onboarded earlier. [factory/onboarding.md](factory/onboarding.md).
- **Caller inputs**: every input a target sets in its calling job's `with:`, each with a default. [factory/caller-inputs.md](factory/caller-inputs.md).
- **Pause**: the `FACTORY_PAUSED` repository variable stops the factory starting or moving work while `merge-gate` and `audit` keep judging pull requests, and the heartbeat stops waking a paused target so a pause costs no idle runs. [factory/pause.md](factory/pause.md).
- **Waiver**: take the factory's checks off a target that cannot run, and the rename-outage window that needs one. [factory/waiver.md](factory/waiver.md).
- **Dispatch**: the sweep runs on the caller's `issues: [closed, labeled, unassigned, unlabeled]`, `workflow_dispatch` and the `factory-sweep` `repository_dispatch`; namespaces, reconciler, and the interval derivation live in [factory/dispatcher.md](factory/dispatcher.md).
- **Heartbeat**: run `GH_TOKEN=<token> node --experimental-strip-types factory/heartbeat/send.ts` every 30 minutes from an outside host, the only thing that sweeps on an interval; mechanics in [factory/dispatcher.md](factory/dispatcher.md).
- **Trust policy**: whose tickets run and whose comments an agent reads, the v0 stand-in for a sandbox. [factory/trust-policy.md](factory/trust-policy.md).
- **Implementer run**: one ticket, one branch, one PR, built through `docs/agents/build-and-review.md`. [factory/implementer-run.md](factory/implementer-run.md).
- **Merge gate**: the two agent-free checks `factory/red-green` and `factory/test-integrity`, per changed test file. [factory/merge-gate.md](factory/merge-gate.md).
- **Reviewer and verdict**: the read-only judge and the `factory/verdict` status it posts. [factory/reviewer-verdict.md](factory/reviewer-verdict.md).
- **Merge**: auto-merge plus update-branch standing in for a merge queue, and who owns a conflict. [factory/merge.md](factory/merge.md).
- **Retry and escalation**: one informed retry, then `needs-human`, and everything that does not spend the retry. [factory/retry-escalation.md](factory/retry-escalation.md).
- **Audit**: the first-20 re-review and its revert on a miss. [factory/audit.md](factory/audit.md).
- **Usage and rotation**: the per-role usage comment and how runs spread across accounts. [factory/usage-rotation.md](factory/usage-rotation.md).
- **Engine**: the vendored sandcastle pin, run logging, and the dev commands. [factory/engine.md](factory/engine.md).
- **Layout**: the tree, and how a script is wired to a needs record. [factory/layout.md](factory/layout.md).

## Pinned facts

Three facts are stated here and held to this page by tests, so they have one home the whole tree defers to.

- **Token scope.** **One `FACTORY_PAT` covers every target in v0** (#20). Per-target tokens buy nothing while the same machine and the same workflows hold them all; split when a target is owned by someone else. Corrected 2026-09-11 (#252): README's secrets step mints a token scoped to the one target being onboarded, by hand; `scripts/onboard.sh` writes no secret. The reasoning above holds for the case it names and misses the second trigger, **reach across visibility**: the secret is stored on every target that uses it, so a token shared by a public target and a private one puts a credential for the private repo in the public repo's secret store (#251). Ownership never changes, so the stated trigger never fires and the exposure grows with each target added. Not a split by visibility tier, the cheaper-looking answer: a tier token still reaches every repo in its tier, and a repo's tier can change, so a private target going public moves credentials for the rest into a world-readable store with nobody touching the token. Per target is one repo of blast radius, needs no judgement at onboarding time, and makes rotation local. It costs one expiry per target, which README's onboarding step covers.
- **Heartbeat interval.** The sender runs every 30 minutes (`HEARTBEAT_INTERVAL_MINUTES` in `factory/heartbeat/interval.ts`, the one place the number lives); the derivation is in [factory/dispatcher.md](factory/dispatcher.md).
- **Trigger set.** The dispatcher's issue trigger set is the one stated in the Dispatch pointer above, matching the caller's `on:` block.
