/**
 * Dispatcher: move ready tickets into the factory.
 *
 * Built the way the sweep and the heartbeat are (#286): it takes a
 * `DispatchNeeds` record, the shape of the sweep's `Needs`, and is handed it
 * from outside (`dispatch-run.ts` in production, an in-memory target repo in
 * `dispatch.test.ts`). What it selects does not change, only how it is wired: no
 * `gh` call lives here now. docs/pipeline.md, "How a script is wired", carries
 * the pattern.
 *
 * Runs on the caller's `issues: [closed, labeled, unassigned, unlabeled]`, on
 * the heartbeat, and by hand. Every run is a full scan whatever woke it. It
 * reads the target's open issues through the shared projection (as the sweep and
 * heartbeat do) rather than a full payload, and its open PRs, asks `select.ts`
 * which to dispatch, and adds `agent:implement` to each. The label must be added
 * with the write key: a label added with the read key fires no `issues: labeled`
 * event, so the implementer would never start.
 *
 * It writes one other thing, and only that (#257): a single comment on a ticket
 * held for having no acceptance criteria, the one skip reason a human has not
 * already chosen. Which read may fail softly stays this script's own policy: the
 * comment is a courtesy, so a failure to post it is warned about and the ticket
 * stays held either way.
 *
 * Builtins only, imported with `.ts` extensions, so the dispatch job runs on
 * bare `node --experimental-strip-types` and skips installing the engine.
 */
import { errorMessage } from "../lib/errors.ts";
import { type TrustPolicy } from "../lib/trusted-authors.ts";

import { type Subject } from "./reconcile.ts";
import {
  DISPATCH_LABEL,
  NO_CRITERIA_REASON,
  alreadyToldNoCriteria,
  type DispatchIssue,
  issuesClosedByPrs,
  noCriteriaComment,
  selectForDispatch,
  whySkipped,
} from "./select.ts";

/**
 * Everything the dispatcher needs from the target repo, the shape of the sweep's
 * `Needs`: named domain reads and writes, never a raw `gh` call. Every read
 * throws `GhError` on failure; the dispatcher decides which it shrugs off (only
 * the no-criteria comment's, a courtesy).
 */
export type DispatchNeeds = {
  /**
   * Open issues, via the shared projection rather than a full payload, mapped to
   * the dispatch shape. `hasOpenPr` is left unresolved here (false) and set by
   * the dispatcher against `openPrs`, the way the sweep resolves a run's role.
   */
  readonly openIssues: () => DispatchIssue[];
  /**
   * Open PRs reduced to what says which ticket each closes: their number and
   * body, the closing keywords' source. Read once for the listing and again
   * before labeling, because a PR opened in the gap can claim a ticket (#19).
   */
  readonly openPrs: () => { number: number; body: string | null }[];
  /**
   * One issue re-read right before writing; the listing it came from is seconds
   * stale (#19). A closed issue still comes back, so the recheck can skip it as
   * "closed since the snapshot"; `undefined` only when the number is a PR rather
   * than an issue (a deleted one is a 404, which throws). `hasOpenPr` is
   * unresolved here too, set by the dispatcher.
   */
  readonly readIssue: (number: number) => DispatchIssue | undefined;
  /** A ticket's own comments, projected to the marker head, for whether the no-criteria comment was already posted. */
  readonly comments: (number: number) => { body: string | null }[];
  /** Add a label to a ticket, with the write key so its event fires. */
  readonly addLabel: (subject: Subject, label: string) => void;
  /** Comment on a ticket. */
  readonly comment: (subject: Subject, body: string) => void;
};

/** What one pass is decided against. */
export type DispatchConfig = {
  readonly repo: string;
  readonly policy: TrustPolicy;
  readonly dryRun: boolean;
};

export type DispatchResult = {
  /** The listed open issues in the dispatch shape, `hasOpenPr` resolved, for the artifact. */
  readonly issues: readonly DispatchIssue[];
  readonly dispatched: readonly number[];
  readonly labeled: readonly number[];
  /** Dispatchable when listed, not when re-read: skipped rather than labeled, with the reason. */
  readonly skipped: readonly { number: number; reason: string }[];
  readonly failed: readonly { number: number; error: string }[];
};

/** One pass of the dispatcher against a target repo: read, select, re-read, write, log. */
export const dispatch = (needs: DispatchNeeds, config: DispatchConfig): DispatchResult => {
  const { repo, policy, dryRun } = config;

  /** Resolve `hasOpenPr` against the issue numbers open PRs claim to close, the sweep's way with a run's role. */
  const withPr = (issue: DispatchIssue, closedByOpenPr: ReadonlySet<number>): DispatchIssue => ({
    ...issue,
    hasOpenPr: closedByOpenPr.has(issue.number),
  });

  const closedByOpenPr = issuesClosedByPrs(needs.openPrs());
  const issues = needs.openIssues().map((issue) => withPr(issue, closedByOpenPr));
  const dispatched = selectForDispatch(issues, policy);

  // Re-read the PR list right before labeling; the listing above may be seconds
  // stale, and so may the PR list (#19).
  const closedByOpenPrNow =
    dispatched.length > 0 && !dryRun ? issuesClosedByPrs(needs.openPrs()) : closedByOpenPr;
  /** The reason not to label this issue now, re-read on its own, or undefined when it is still dispatchable. */
  const recheck = (number: number): string | undefined => {
    const reread = needs.readIssue(number);
    return reread ? whySkipped(withPr(reread, closedByOpenPrNow), policy) : "not an issue";
  };

  /**
   * Tell a ticket held for its shape, once. Every other skip reason names a
   * state a human already chose, so it needs no comment; this one names a ticket
   * nobody knows is stuck. The marker heading the comment is what keeps the next
   * sweep quiet, the way the reconciler's no-ticket mark does on a PR (#230).
   *
   * Two reads before the write, for the two ways it could be wrong. The comments
   * say whether the factory has spoken already; the marker fits inside the first
   * 64 characters the comments projection keeps. The issue re-read says the
   * ticket is still held for this and nothing else: a comment stays on the ticket
   * forever, and the listing it came from is seconds stale (#19).
   */
  const tellNoCriteria = (issue: DispatchIssue): void => {
    if (alreadyToldNoCriteria(needs.comments(issue.number))) return;
    if (recheck(issue.number) !== NO_CRITERIA_REASON) return;
    needs.comment({ kind: "issue", number: issue.number }, noCriteriaComment());
    console.log(`Commented on #${issue.number}: ${NO_CRITERIA_REASON}.`);
  };

  console.log(`Trusted ticket authors: ${policy.associations.join(", ")}.`);
  for (const issue of issues) {
    const reason = whySkipped(issue, policy);
    console.log(`#${issue.number}: ${reason ?? "dispatch"}`);
    if (reason !== NO_CRITERIA_REASON || dryRun) continue;
    try {
      tellNoCriteria(issue);
    } catch (error) {
      // The comment is a courtesy; the ticket stays held either way.
      console.error(`Could not comment on #${issue.number}: ${errorMessage(error)}`);
    }
  }

  const labeled: number[] = [];
  const skipped: { number: number; reason: string }[] = [];
  const failed: { number: number; error: string }[] = [];
  for (const issue of dispatched) {
    if (dryRun) continue;
    try {
      const stale = recheck(issue.number);
      if (stale) {
        skipped.push({ number: issue.number, reason: stale });
        console.log(`#${issue.number}: not labeled, ${stale} (re-read before labeling).`);
        continue;
      }
      needs.addLabel({ kind: "issue", number: issue.number }, DISPATCH_LABEL);
      labeled.push(issue.number);
      console.log(`Labeled #${issue.number} ${DISPATCH_LABEL}.`);
    } catch (error) {
      const message = errorMessage(error);
      failed.push({ number: issue.number, error: message });
      console.error(`Could not label #${issue.number}: ${message}`);
    }
  }

  console.log(
    `${issues.length} open issue(s), ${dispatched.length} to dispatch, ${labeled.length} labeled, ${skipped.length} changed since the snapshot${dryRun ? " (dry run)" : ""}.`,
  );

  return { issues, dispatched: dispatched.map((issue) => issue.number), labeled, skipped, failed };
};
