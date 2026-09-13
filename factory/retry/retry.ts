/**
 * The failure handler the workflows run when an attempt fails (#16), built the
 * way the sweep is (#281, #284): it declares the reads and writes it needs from
 * the target repo as a `RetryNeeds` record and is handed them from outside
 * (`retry-run.ts` in production, an in-memory target repo in `retry.test.ts`).
 * No `gh` call lives here now; what the handler decides does not change, only
 * how it is wired. docs/factory/layout.md, "How a script is wired", carries the pattern.
 *
 * This file is the failed-attempt path: given a resolved target and a built
 * failure, decide with `decide.ts` and act. It also holds the wait for a head's
 * checks (`waitForChecks`, #285), which builds the checks-path failure the same
 * way: its clock and its reads come through a `ChecksNeeds` record, so a test
 * drives each outcome by advancing the injected clock rather than waiting. The
 * log and artifact reads behind that wait go through the run's own record
 * (`assemble.ts`'s `RunReads`, #315) rather than living in the entry point.
 *
 * The outcomes, each rehearsable against the record:
 * - retry: post the failing output as a marker comment on the ticket, add
 *   `factory:retry-<n>`, and label `agent:implement` (on the PR when one is
 *   open, so implement-pr runs on the branch; on the ticket otherwise). Only a
 *   PR the factory authored is labeled (#183); any other open PR is a
 *   tell-author instead, on its own thread.
 * - escalate: agent labels and ready-for-agent off the ticket, needs-human on,
 *   the branch kept, a comment linking the run. The PR is closed only when the
 *   factory authored it (#174); one left open is disarmed and parked instead.
 * - requeue (rate limited (#17), or a check still pending when the wait runs
 *   out): no retry spent, a comment, nothing labeled for a human (#148).
 * - hand-off (#144): the PR conflicts with its base, so the checks never came;
 *   `agent:implement` on a branch the factory authored, a tell-author otherwise.
 * - stand-down (#185): `hold` is on the ticket or its open PR, so no agent
 *   starts, nothing is spent and nothing is escalated; a comment names the label.
 *
 * What each of those outcomes does is `plan.ts`'s (#310): `planFor` turns the
 * verb into an ordered `Effect[]`, and `main` here applies them in order,
 * choosing nothing of its own. Which writes may fail softly is the one policy
 * that stays: the record always throws (as `target-repo.ts` does), and `soft`
 * catches the ones a standing refusal must not turn the run red for (a re-arm
 * GitHub refused, a label already present, a courtesy note on a PR left open).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { required } from "../lib/env";
import { errorMessage } from "../lib/errors.ts";
import { linkedIssueNumber } from "../lib/linked-issue.ts";
import { ESCALATION_LABEL } from "../lib/labels.ts";
import {
  type CheckFailure,
  type CheckState,
  stillPendingReason,
  summariseFailures,
  unretryableReason,
  waitOver,
} from "./checks.ts";
import {
  decide,
  findHold,
  type Subject,
  RATE_LIMITED_REASON,
  REQUEUED_FILE,
  retriesUsed,
  ticketOrPr,
  ticketOrPrFromPr,
  ticketOrPrFromTicket,
  type Unresolved,
} from "./decide.ts";
import {
  type Effect,
  type Failure,
  type OpenPr,
  type PlanReads,
  type PrMergeability,
  type RetryConfig,
  type Target,
  planFor,
  recordOn,
} from "./plan.ts";

// Re-exported so `decide.ts`'s `RATE_LIMITED_REASON` reaches the entry through
// one import of this module rather than two.
export { RATE_LIMITED_REASON };

// The shapes one failed attempt is described with live in `plan.ts`, which is
// pure and which `planFor` reads; they are re-exported here so `retry-run.ts`
// and the tests reach the handler and its inputs through one import.
export type { Failure, OpenPr, PrMergeability, RetryConfig, Target };

/**
 * Everything the failed-attempt path needs from the target repo, never a raw
 * `gh` call. Every function throws on failure; the handler decides which throws
 * it shrugs off. The wait for a head's checks names its own reads and clock in
 * `ChecksNeeds` below, since `main` never uses them and the wait runs before it.
 */
export interface RetryNeeds {
  /** A PR by number: its state, body and head branch, for resolving the target from a PR number. */
  readonly viewPr: (number: string) => { state: string; body: string | null; headRefName: string };
  /** Every open PR, for resolving this run's own PR from a ticket number (#204). */
  readonly openPrs: () => { number: number; body: string | null; headRefName: string; isCrossRepository: boolean }[];
  /** A subject's labels right now, read at act time: the retry count, the hold, whether it is escalated. */
  readonly labelsOf: (on: Subject) => string[];
  /** Whether the branch still exists, for the escalation comment. */
  readonly branchExists: () => boolean;
  /** The uploaded run log artifact, for the escalation comment; undefined when none was found. */
  readonly artifactUrl: () => string | undefined;
  readonly addLabel: (on: Subject, label: string) => void;
  readonly removeLabel: (on: Subject, label: string) => void;
  readonly comment: (on: Subject, body: string) => void;
  /** Create the `factory:retry-<n>` label if it is missing, so adding it cannot fail on an absent label. */
  readonly ensureRetryLabel: (label: string) => void;
  readonly closePr: (number: string, comment: string) => void;
  readonly disarmAutoMerge: (number: string) => void;
}

/**
 * The reads and the clock the wait for a head's checks needs (#285), injected so
 * a test drives the clock instead of waiting on one, the way the heartbeat takes
 * its `now`. A second record for the retry handler's second path: the
 * failed-attempt path writes through `RetryNeeds`, and the wait that builds the
 * checks failure reads through this before `main` ever runs. Every read throws
 * as `RetryNeeds`'s do, and the wait shrugs none off: a read it cannot make ends
 * the run rather than judging the head blind.
 */
export interface ChecksNeeds {
  /** When the wait is running, injected rather than read here so a test advances it. */
  readonly now: () => Date;
  /** Wait one poll. Injected, never `setTimeout`, so a test's clock moves with no wall-clock time passing. */
  readonly sleep: (ms: number) => Promise<void>;
  /** The head's checks reduced to what the decision needs; the mapping (`evaluateChecks`) stays pure in `checks.ts`. */
  readonly readChecks: (sha: string) => CheckState;
  /** The open PR's mergeability and base; undefined once it is no longer open (it closed or merged mid-wait). */
  readonly prMergeability: (pr: OpenPr) => PrMergeability | undefined;
  /** The failing checks' output, joined; the log and artifact reads behind it go through `assemble.ts`'s record. */
  readonly failuresOutput: (failures: readonly CheckFailure[]) => Promise<string>;
}

/** The head and the clock bounds of one wait, read from the env by the entry point. */
export interface ChecksWait {
  readonly sha: string;
  readonly timeoutMs: number;
  readonly pollMs: number;
}

/**
 * Wait for the head's checks to settle, or for GitHub to report the open PR
 * conflicting (#145), then the failure among them, or undefined when the head is
 * green. `waitOver` is the rule for whether one observation ends the wait and
 * `stillPendingReason` the verdict on a stopped one; this is the loop that polls
 * them. Its clock and its reads are the caller's, through `ChecksNeeds`, so a
 * test drives each outcome by advancing the injected clock (#285). Behaviour is
 * the pre-seam entry point's; only the clock and the reads moved behind the record.
 */
export const waitForChecks = async (
  needs: ChecksNeeds,
  wait: ChecksWait,
  pr: OpenPr | undefined,
): Promise<Failure | undefined> => {
  const deadline = needs.now().getTime() + wait.timeoutMs;
  const observe = () => {
    const state = needs.readChecks(wait.sha);
    const mergeability = pr && state.pending.length > 0 ? needs.prMergeability(pr) : undefined;
    return { state, mergeability };
  };
  let seen = observe();
  while (!waitOver(seen.state, seen.mergeability?.mergeable) && needs.now().getTime() < deadline) {
    console.log(`Waiting for ${seen.state.pending.join(", ")} on ${wait.sha.slice(0, 7)}.`);
    await needs.sleep(wait.pollMs);
    seen = observe();
  }
  const { state, mergeability } = seen;
  const stillPending = stillPendingReason(state, mergeability?.mergeable, wait.timeoutMs / 60_000);
  if (stillPending) return { kind: "ci", summary: stillPending, output: "", requeue: stillPending, mergeability };
  const { failures } = state;
  if (failures.length === 0) return undefined;
  const first = failures[0] as CheckFailure;
  return {
    kind: first.kind,
    summary: summariseFailures(failures),
    output: await needs.failuresOutput(failures),
    unretryable: unretryableReason(failures),
  };
};

/** A write whose failure is logged and shrugged off, the handler's own soft-fail policy (#83, #148). */
const soft = (write: () => void): void => {
  try {
    write();
  } catch (error) {
    console.log(errorMessage(error));
  }
};

const outputDir = (): string => process.env.OUTPUT_DIR ?? "/tmp";

/**
 * The marker file a requeued or stood-down PR leaves behind (#148), for the
 * workflow steps that take `agent:in-progress` off on their way out: the one
 * they must not take it off for is this PR.
 */
const writeRequeued = (reason: string): void => {
  fs.mkdirSync(outputDir(), { recursive: true });
  fs.writeFileSync(path.join(outputDir(), REQUEUED_FILE), `${reason}\n`);
};

/**
 * The ticket and its open PR from whichever number the workflow knows. A PR
 * number names the PR outright; a ticket alone is searched from, and there the
 * open PR is only this run's, on BRANCH and linking the ticket (#204).
 */
const resolveTarget = (needs: RetryNeeds): Target | Unresolved => {
  // The workflow inputs, read here and not at module scope, so importing this
  // module never exits and a test drives each path by setting them. `required`
  // is still asked only on the path that needs it, the ticket-only one.
  const PR_INPUT = process.env.PR_NUMBER || undefined;
  const ISSUE_INPUT = process.env.ISSUE_NUMBER || undefined;
  const BRANCH = process.env.BRANCH ?? "";
  const openPr = (number: string, pr: { headRefName: string; body: string | null }): OpenPr => ({
    number,
    facts: { headRef: pr.headRefName, body: pr.body ?? "" },
  });
  if (PR_INPUT) {
    const pr = needs.viewPr(PR_INPUT);
    // Unresolved when nothing resolves; the entry fails on that before any write (#133).
    return ticketOrPrFromPr({
      number: PR_INPUT,
      state: pr.state,
      ticket: ISSUE_INPUT ?? linkedIssueNumber(pr.body),
      pr: openPr(PR_INPUT, pr),
    });
  }
  const issue = required("ISSUE_NUMBER");
  // Every open PR, as the dispatcher lists them, and not a body search (#132); the
  // seam hands them over and `ticketOrPrFromTicket` picks this run's own (#204).
  return ticketOrPrFromTicket({
    ticket: issue,
    branch: BRANCH,
    open: needs.openPrs().map((p) => ({ ...openPr(String(p.number), p), fromFork: p.isCrossRepository })),
  });
};

/** The branch and log reads the escalation comment wants, each shrugged off on failure: a courtesy note is not the record. */
const safeBranchExists = (needs: RetryNeeds): boolean => {
  try {
    return needs.branchExists();
  } catch (error) {
    console.log(errorMessage(error));
    return false;
  }
};
const safeArtifactUrl = (needs: RetryNeeds): string | undefined => {
  try {
    return needs.artifactUrl();
  } catch (error) {
    console.log(errorMessage(error));
    return undefined;
  }
};

/**
 * The costly reads `planFor` asks for at the arm that needs them, backed by the
 * record. The branch and log reads are the escalation comment's courtesy and are
 * shrugged off here, so a read the run cannot make costs it the comment's detail
 * rather than the escalation.
 */
const planReads = (needs: RetryNeeds): PlanReads => ({
  labelsOf: needs.labelsOf,
  branchExists: () => safeBranchExists(needs),
  artifactUrl: () => safeArtifactUrl(needs),
});

/**
 * One planned effect, carried out. The whole of the handler's own policy is
 * here: which purposes a write serves decide whether a refusal of it turns the
 * run red. The record (the comment and the label that carry what happened) must
 * land; a courtesy note, a label GitHub may refuse because it is already there
 * or already gone, a close and a re-arm are shrugged off (#83, #148, #174).
 */
const applyEffect = (needs: RetryNeeds, effect: Effect): void => {
  switch (effect.kind) {
    case "comment":
      return needs.comment(effect.on, effect.body);
    case "note":
      return soft(() => needs.comment(effect.on, effect.body));
    case "add-label":
      return needs.addLabel(effect.on, effect.label);
    case "ensure-label":
      return soft(() => needs.ensureRetryLabel(effect.label));
    case "remove-label":
      return soft(() => needs.removeLabel(effect.on, effect.label));
    case "park-pr":
      return soft(() => needs.addLabel({ kind: "pr", number: effect.number }, effect.label));
    case "close-pr":
      return soft(() => needs.closePr(effect.number, effect.comment));
    case "disarm-auto-merge":
      return soft(() => needs.disarmAutoMerge(effect.number));
    case "mark-requeued":
      return writeRequeued(effect.reason);
    case "log":
      return console.log(effect.line);
  }
};

/**
 * The failed-attempt path: decide with `decide.ts` from the target's labels and
 * the built failure, plan with `plan.ts`, and apply the plan in order. Nothing
 * of what happens is chosen here; the reads and writes go through the record, so
 * a test drives this with an in-memory target repo and asserts what it wrote.
 */
const main = (needs: RetryNeeds, config: RetryConfig, target: Target, failure: Failure): void => {
  let subject = target;
  const mergeability = failure.mergeability;
  // A requeue whose PR closed or merged as the checks wait ran falls back to the
  // ticket rather than labeling a PR nobody keeps (#133); only the checks path
  // waits, so only it can lose its PR that way.
  if (config.failureKind === "checks" && failure.requeue && subject.pr) {
    if (!mergeability) {
      console.log(`PR #${subject.pr.number} closed or merged as the handler waited; it is no longer the subject.`);
      const ticketOnly = ticketOrPr<OpenPr>(subject.issue, undefined);
      if (!ticketOnly) {
        console.log("No ticket to fall back to; nothing to requeue.");
        return;
      }
      subject = ticketOnly;
    }
  }
  const record = recordOn(subject);
  const labels = needs.labelsOf(record);
  // The open PR's labels too when the record is the ticket's: whatever the retry
  // would label goes on the PR, so a hold there stops it the same (#185).
  const pr: Subject | undefined = record.kind === "issue" && subject.pr ? { kind: "pr", number: subject.pr.number } : undefined;
  const held = findHold([{ ...record, labels }, ...(pr ? [{ ...pr, labels: needs.labelsOf(pr) }] : [])]);
  const used = retriesUsed(labels);
  const decision = decide({
    retriesUsed: used,
    kind: failure.kind,
    escalated: labels.includes(ESCALATION_LABEL),
    requeue: failure.requeue,
    mergeable: mergeability?.mergeable,
    unretryable: failure.unretryable,
    held,
  });
  console.log(`${failure.summary}. Retries used: ${used}. Decision: ${decision.action}${"reason" in decision ? ` (${decision.reason})` : ""}.`);

  for (const effect of planFor({ decision, target: subject, config, failure }, planReads(needs))) {
    applyEffect(needs, effect);
  }
};

// `main` and `resolveTarget` are exported below rather than at their `const` so
// the review that reads this file by `const <name> =` finds them (#185, #204).
export { main, resolveTarget };
