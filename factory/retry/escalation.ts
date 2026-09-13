/**
 * What the factory does to a subject it is parking: the labels escalation
 * leaves behind (#50) and what escalation does to the open PR (#174). Pure, a
 * fact about the subject in and the actions out, so the callers cannot park a
 * ticket two ways. Whether the retry may put an implementer on a PR's branch is
 * the **PR fix** decision, and lives in `factory/lib/pr-disposition.ts` (#183);
 * both it and `prEscalation` ask `isFactoryAuthoredPr`, so "the factory may
 * write to this branch" is answered the same way in both.
 *
 * Two paths escalate. The retry handler does it when the retry fails too,
 * and the reconciler (#35) does it when the event that starts a run is lost
 * twice, or when re-dispatching has hit its cap without the run ever
 * getting started. A human reading a parked ticket cannot tell which one did
 * it, so both ask here and a parked ticket looks the same either way.
 *
 * Imports use explicit `.ts` so the dispatch job can run this on bare `node
 * --experimental-strip-types` without installing the engine.
 */
import { type FactoryPrFacts, isFactoryAuthoredPr } from "../lib/factory-pr.ts";
import { agentLabels, ESCALATION_LABEL, isAgentLabel, READY_LABEL } from "../lib/labels.ts";

/**
 * Escalating: `needs-human` on, every `agent:*` label off, and
 * `ready-for-agent` off with them. The dispatcher refuses a ticket carrying
 * `needs-human`, so one that also still said "ready" said two things at
 * once. An escalated ticket shows one label and a human re-adds
 * `ready-for-agent` to rerun it.
 *
 * Only labels the subject carries are named, so no caller asks GitHub to
 * remove a label that is not there, and a PR, which never carries
 * `ready-for-agent`, loses only its `agent:*` ones.
 */
export const escalationLabels = (
  labels: readonly string[],
): { readonly remove: string[]; readonly add: typeof ESCALATION_LABEL } => ({
  remove: labels.filter((label) => isAgentLabel(label) || label === READY_LABEL),
  add: ESCALATION_LABEL,
});

/** What escalation needs to know about the open PR: enough to place it, plus its labels. */
export interface EscalatedPrFacts extends FactoryPrFacts {
  readonly labels: readonly string[];
}

/** What escalation does to the open PR: which labels come off, which goes on, and whether it closes. */
export interface PrEscalation {
  readonly remove: string[];
  /** The parking label a PR left open needs, `undefined` when it closes. */
  readonly add: string | undefined;
  readonly close: boolean;
}

/**
 * What escalation does to the open PR (#174).
 *
 * Every `agent:*` label comes off either way. A PR escalation is done with is
 * a PR no factory run may pick up again, and that is true whether it closes or
 * stays open; a closed PR carries no state besides. Closing says nothing about
 * the ticket, which keeps its own labels until the escalation decides them.
 *
 * A PR left open needs `needs-human` on it as well, and not only the removals.
 * Bare removal stands it down for exactly as long as nothing repairs it: the
 * reconciler reads any **Factory PR** with no `agent:*` label as one to arm
 * and judge, and re-adds `agent:review` at its verdict deadline, which is the
 * very step that escalated this PR in the first place. `needs-human` is what
 * the reconciler parks on, so the label that records the escalation is also
 * the one that makes "no factory run picks it up again" true. Closing already
 * takes the PR out of every listing the reconciler reads, so it needs none.
 *
 * Closing is right only for a PR the factory opened: the attempt failed, the
 * ticket still holds the work, and a later run cuts a fresh branch from main
 * and opens a new PR from it. Applied to a PR a person or an outside agent
 * wrote, the same step throws away work nothing can recreate, and the path is
 * reachable without anyone intending it. A PR the factory did not author
 * closes no ticket, so the reviewer has no acceptance criteria to tick and
 * posts `factory/verdict` as a failure; `unretryableReason` rightly calls that
 * unfixable by any implementer run, `decide` turns unretryable into an
 * escalation, and escalation closed the PR. Labelling such a PR `agent:review`,
 * the one action that gets it judged, destroyed it.
 *
 * `isFactoryAuthoredPr` and not `isFactoryPr`: the broad one answers what the
 * factory reads and judges, and its verdict arm is *exactly* the PR the factory
 * did not author that must survive this. Not a label either, per #174: the
 * branch prefix and the body marker are written by the factory when it opens
 * the PR and are not the sort of thing a human adds or removes on one.
 */
export const prEscalation = (pr: EscalatedPrFacts): PrEscalation => {
  const close = isFactoryAuthoredPr(pr);
  return {
    remove: agentLabels(pr.labels),
    add: close ? undefined : ESCALATION_LABEL,
    close,
  };
};
