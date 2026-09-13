/**
 * The factory's label vocabulary: the strings the dispatcher, the retry
 * handler, the reconciler and update-branch read and write, here so that the
 * modules that import them cannot drift apart.
 *
 * `ready-for-agent` is a human's intent, `agent:*` is factory state (which
 * step holds the subject right now), `needs-human` is the factory giving up,
 * and `hold` is a human's instruction to leave a ready ticket alone.
 *
 * Not yet every home. `dispatch/select.ts` still spells `agent:implement` as
 * its own `DISPATCH_LABEL`, and its `FACTORY_STATE_LABELS` is
 * `HANDED_OFF_LABELS` plus `needs-human`. Repointing them is the dispatch
 * half of story 5 of #76 (#122), which owns that file; this module is where
 * they land when it does.
 *
 * Imports use explicit `.ts` and this module imports nothing, so the dispatch
 * job and the update-branch job can both run it on bare
 * `node --experimental-strip-types` without installing the engine. Nothing
 * may be imported here: two sparse-checkout cones list this file and reach it
 * from a pure module, and an import either of them cannot resolve kills the
 * job with ERR_MODULE_NOT_FOUND.
 */

/** A human said this ticket is ready for the factory. */
export const READY_LABEL = "ready-for-agent";

/** The factory gave up on it; it is parked for a human. */
export const ESCALATION_LABEL = "needs-human";

/**
 * A human said no agent starts on this ticket: the dispatcher does not
 * dispatch it, the retry handler stands down, and the reconciler neither
 * re-adds a start label nor asks for a verdict on it or its PR (#185). It
 * stops no merge, and not two hand-offs on an open PR, update-branch's
 * conflict hand-off and an agent run labelling its own PR `agent:review`: to
 * stop a started ticket, close its PR (#210). Unprefixed because it is a
 * human's instruction, not factory state.
 *
 * Before it, people held tickets with `needs-triage`, and a triage pass that
 * cleared the pair as drift released 12 tickets at once (#169).
 */
export const HOLD_LABEL = "hold";

/**
 * Hand the subject to the implementer. On a ticket it starts an implement run;
 * on a PR it starts agent-implement-pr.yml, which works on the branch. The
 * dispatcher adds it to dispatch a ticket, the retry handler to start a retry,
 * and update-branch to a conflicting PR so the implementer merges the base in
 * and resolves.
 */
export const IMPLEMENT_LABEL = "agent:implement";

/** The factory is waiting on a human before this PR or ticket moves again. */
export const BLOCKED_LABEL = "agent:blocked";

/**
 * A run holds the subject right now. It is also what the reconciler sweeps on
 * a PR no run is left on, so a requeued PR keeps it and is picked up at the
 * stuck deadline (#148) rather than sitting with no `agent:*` label at all.
 */
export const IN_PROGRESS_LABEL = "agent:in-progress";

/**
 * Hand the PR to the reviewer. A producer labels its own PR with it to ask for
 * a verdict (ADR 0007), the implement run adds it when it has opened the PR,
 * and the reconciler re-adds it on a PR whose review run was lost or whose
 * head has gone unjudged past the deadline.
 */
export const REVIEW_LABEL = "agent:review";

/**
 * The factory's own pair: a subject the factory has stopped on and no sweep
 * repairs. The reconciler reports such a subject and leaves it alone, the
 * heartbeat counts it as nothing waiting, and update-branch neither re-arms
 * nor updates its PR. Always the factory's doing, which is what separates it
 * from a `hold`, a person choosing the timing (CONTEXT.md).
 */
export const PARKED_LABELS: readonly string[] = [BLOCKED_LABEL, ESCALATION_LABEL];

/**
 * Labels that stop an agent starting, read from here by the dispatcher, the
 * retry handler (`findHold`) and the reconciler so they cannot disagree. `hold`
 * alone since #210.
 */
export const HOLD_LABELS: readonly string[] = [HOLD_LABEL];

/** Labels that say an agent already holds the subject (implementer or reviewer, running or queued) or that it is parked. */
export const HANDED_OFF_LABELS: readonly string[] = [IMPLEMENT_LABEL, IN_PROGRESS_LABEL, REVIEW_LABEL, BLOCKED_LABEL];

/**
 * The label the dispatcher adds to dispatch a ticket. The implementer's own
 * label under the name the dispatcher's log and its tests call it by: one
 * string, so the label a ticket is dispatched with is the label the workflow
 * that starts on it listens for.
 */
export const DISPATCH_LABEL = IMPLEMENT_LABEL;

/**
 * The factory already holds this ticket or PR in some state, so no agent is
 * started on it afresh: the dispatcher skips such a ticket and the heartbeat
 * counts it as work the sweep owns. Derived from the set above rather than
 * listed again, so a label handed to an agent is a label the dispatcher knows
 * the factory is on; `needs-human` joins them because an escalated subject is
 * the factory's state too, the one a human answers.
 */
export const FACTORY_STATE_LABELS: readonly string[] = [...HANDED_OFF_LABELS, ESCALATION_LABEL];

/**
 * The two namespaces the factory writes labels in. A target's caller drops
 * the `unlabeled` events for both, so that the factory's own label removals
 * do not wake a sweep that re-stamps the ticket (#170), and
 * `dispatch/triggers.test.ts` pins the caller's clauses to these strings.
 * Renaming one here without renaming it in `templates/factory.yml` fails
 * that test rather than quietly restarting the loop.
 */
export const AGENT_LABEL_PREFIX = "agent:";
export const FACTORY_LABEL_PREFIX = "factory:";

/** Factory state: which step holds this ticket or PR right now. */
export const isAgentLabel = (label: string): boolean => label.startsWith(AGENT_LABEL_PREFIX);

/** The `agent:*` labels among these, in the order given. */
export const agentLabels = (labels: readonly string[]): string[] => labels.filter(isAgentLabel);
