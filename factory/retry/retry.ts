/**
 * The failure handler the workflows run when an attempt fails (#16), built the
 * way the sweep is (#281, #284): it declares the reads and writes it needs from
 * the target repo as a `RetryNeeds` record and is handed them from outside
 * (`retry-run.ts` in production, an in-memory target repo in `retry.test.ts`).
 * No `gh` call lives here now; what the handler decides does not change, only
 * how it is wired. docs/pipeline.md, "How a script is wired", carries the pattern.
 *
 * This file is the failed-attempt path: given a resolved target and a built
 * failure, decide with `decide.ts` and act. The reads that build the failure
 * for the checks path (the wait for the head's checks, its clock and its gh
 * reads) stay in the entry point, to be seamed with an injected clock in #285.
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
 * Which writes may fail softly is the handler's own policy and stays here: the
 * record always throws (as `target-repo.ts` does), and `soft` catches the ones
 * a standing refusal must not turn the run red for (a re-arm GitHub refused, a
 * label already present, a courtesy note on a PR left open).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { required } from "../agent-workflows/shared/common";
import { errorMessage } from "../lib/errors.ts";
import { linkedIssueNumber } from "../lib/linked-issue.ts";
import { ESCALATION_LABEL, IMPLEMENT_LABEL, IN_PROGRESS_LABEL } from "../lib/labels.ts";
import { type FactoryPrFacts } from "../lib/factory-pr.ts";
import { escalationLabels, type PrFix, prEscalation, prFix } from "./escalation.ts";
import {
  type TellAuthorNote,
  authorConflictReason,
  decide,
  type EscalatedPr,
  type FailureKind,
  findHold,
  type Hold,
  type Subject,
  MAX_RETRIES,
  type Mergeability,
  RATE_LIMITED_REASON,
  renderTellAuthorComment,
  renderEscalationComment,
  renderHandOffComment,
  renderLeftOpenPrComment,
  renderRequeueComment,
  renderRetryComment,
  renderStandDownComment,
  REQUEUED_FILE,
  retriesUsed,
  retryLabel,
  type TicketOrPr,
  ticketOrPr,
  ticketOrPrFromPr,
  ticketOrPrFromTicket,
  type Unresolved,
} from "./decide.ts";

// Re-exported so `decide.ts`'s `RATE_LIMITED_REASON` reaches the entry through
// one import of this module rather than two.
export { RATE_LIMITED_REASON };

// The workflow inputs `resolveTarget` reads. Read at module scope, not with
// `required`, so importing this module for a test never exits: the ticket-only
// path is the one that requires ISSUE_NUMBER, and it does so at call time.
const PR_INPUT = process.env.PR_NUMBER || undefined;
const ISSUE_INPUT = process.env.ISSUE_NUMBER || undefined;
const BRANCH = process.env.BRANCH ?? "";

/**
 * An open PR for the branch: its number, and the facts that place it. One
 * object and not two fields, so there is no state where the number is known and
 * the facts are not; escalation asks `prEscalation` whether the factory
 * authored this PR before it may close it (#174).
 */
export interface OpenPr {
  readonly number: string;
  readonly facts: FactoryPrFacts;
}

export type Target = TicketOrPr<OpenPr>;

/**
 * An open PR's mergeability and base, as GitHub reports them, with the PR they
 * belong to. The whole `OpenPr`, since the hand-off this feeds asks whether the
 * factory authored the branch before it puts an implementer on it (#183).
 */
export interface PrMergeability {
  readonly pr: OpenPr;
  readonly mergeable: Mergeability;
  readonly base: string;
}

/** What ended the attempt, as the entry point built it from files or the head's checks. */
export interface Failure {
  readonly kind: FailureKind;
  readonly summary: string;
  readonly output: string;
  /** Why this is not the ticket's failure: requeue, do not count the attempt. */
  readonly requeue?: string;
  /** Why a retry cannot fix it; escalate at once. */
  readonly unretryable?: string;
  /** The open PR as the wait for checks last read it; undefined when it closed as the handler waited, or when no PR was read. */
  readonly mergeability?: PrMergeability;
}

/**
 * Everything the failed-attempt path needs from the target repo, never a raw
 * `gh` call. Every function throws on failure; the handler decides which throws
 * it shrugs off. #285 adds the checks wait's `now`/`sleep` here without a
 * redesign.
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

/** What one failed attempt is acted on with. `now`/`sleep` join here in #285. */
export interface RetryConfig {
  readonly branch: string;
  readonly runUrl: string;
  /** The workflow's FAILURE_KIND input, not the failure's own kind; only the checks path can lose its PR mid-wait. */
  readonly failureKind: "implement" | "checks";
}

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
 * Where the record of this run goes: the ticket when there is one, since that
 * outlives the PR and is what a human reads; the PR only when no ticket was found.
 */
const recordOn = (target: Target): Subject =>
  target.issue === undefined ? { kind: "pr", number: target.pr.number } : { kind: "issue", number: target.issue };

/**
 * What a label has to go on to move the factory: the open PR when there is one,
 * so implement-pr runs on the branch, and the ticket otherwise. The mirror of
 * `recordOn`; a retry uses both at once.
 */
const actOn = (target: Target): Subject =>
  target.issue === undefined
    ? { kind: "pr", number: target.pr.number }
    : target.pr
      ? { kind: "pr", number: target.pr.number }
      : { kind: "issue", number: target.issue };

/**
 * The ticket and its open PR from whichever number the workflow knows. A PR
 * number names the PR outright; a ticket alone is searched from, and there the
 * open PR is only this run's, on BRANCH and linking the ticket (#204).
 */
const resolveTarget = (needs: RetryNeeds): Target | Unresolved => {
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

/** Hand-off or tell-author on the open PR (#183), from the facts the read that found it came back with. */
const prFixOf = (pr: OpenPr): PrFix => prFix(pr.facts);

/** The label `prFix` decided, on the PR. On a hand-off it starts the next run; on a tell-author it makes the decline stick. */
const labelPr = (needs: RetryNeeds, pr: OpenPr, fix: PrFix): void => {
  needs.addLabel({ kind: "pr", number: pr.number }, fix.add);
};

/**
 * What a requeued or stood-down PR is left in: `agent:in-progress`, the label
 * the reconciler sweeps, plus the marker file for the workflow steps that take
 * that label off on the way out (#148). The label goes on first, then the marker.
 */
const keepInProgress = (needs: RetryNeeds, pr: string, reason: string): void => {
  needs.addLabel({ kind: "pr", number: pr }, IN_PROGRESS_LABEL);
  fs.mkdirSync(outputDir(), { recursive: true });
  fs.writeFileSync(path.join(outputDir(), REQUEUED_FILE), `${reason}\n`);
};

/**
 * Tell the author of a PR the factory did not author (#183): the label
 * `prFix` chose, and what failed, on their own thread. `note` is undefined when
 * this thread already carries the record; when there is one it goes last, since
 * by then the label is on.
 */
const tellAuthor = (needs: RetryNeeds, config: RetryConfig, pr: OpenPr, fix: PrFix, note: TellAuthorNote | undefined): void => {
  labelPr(needs, pr, fix);
  if (note) needs.comment({ kind: "pr", number: pr.number }, renderTellAuthorComment({ ...note, runUrl: config.runUrl }));
  console.log(`PR #${pr.number} is its author's to fix: no ${IMPLEMENT_LABEL}, ${fix.add} on.`);
};

const retry = (needs: RetryNeeds, config: RetryConfig, target: Target, retryNumber: number, failure: Failure): void => {
  const label = retryLabel(retryNumber);
  const fix = target.pr ? prFixOf(target.pr) : undefined;
  const comment = renderRetryComment({
    retry: retryNumber,
    kind: failure.kind,
    runUrl: config.runUrl,
    output: failure.output,
    action: fix?.action,
  });
  // The record goes on whatever the retry hands the fix to: the attempt was
  // made, it failed, and the count moves, so nothing is dropped in silence.
  const on = recordOn(target);
  needs.comment(on, comment);
  soft(() => needs.ensureRetryLabel(label));
  needs.addLabel(on, label);
  // The label goes last, once the context the next run reads is in place.
  if (target.pr && fix) {
    if (fix.action === "tell-author") {
      tellAuthor(
        needs,
        config,
        target.pr,
        fix,
        on.kind === "pr"
          ? undefined
          : {
              reason: failure.summary,
              issueNumber: on.number,
              output: failure.output,
              // The retry just recorded was the ticket's last, so the next
              // failure on this PR escalates it, and the author has to know.
              escalatesNext: retryNumber >= MAX_RETRIES,
            },
      );
    } else {
      labelPr(needs, target.pr, fix);
    }
    console.log(`Retry ${retryNumber} of ${MAX_RETRIES}: ${label} on ${on.kind} #${on.number}, ${fix.add} on pr #${target.pr.number} (${failure.summary}).`);
    return;
  }
  const trigger = actOn(target);
  needs.addLabel(trigger, IMPLEMENT_LABEL);
  console.log(
    `Retry ${retryNumber} of ${MAX_RETRIES}: ${label} on ${on.kind} #${on.number}, ${IMPLEMENT_LABEL} on ${trigger.kind} #${trigger.number} (${failure.summary}).`,
  );
};

const requeue = (needs: RetryNeeds, config: RetryConfig, target: Target, reason: string): void => {
  const on = actOn(target);
  const onPr = on.kind === "pr";
  needs.comment(on, renderRequeueComment({ reason, runUrl: config.runUrl, onPr }));
  if (onPr) keepInProgress(needs, on.number, reason);
  console.log(
    `Requeued ${on.kind} #${on.number} without spending a retry: ${reason}` +
      (onPr
        ? `; left in ${IN_PROGRESS_LABEL}, the reconciler re-adds the start label at its stuck deadline.`
        : "; the dispatcher re-dispatches it."),
  );
};

/**
 * A person holds the subject (#185): the retry's label is the one thing that
 * would have started an agent, and it is not written; neither is
 * `factory:retry-<n>`, nor anything of escalation's. What is left is what a
 * requeue leaves, so removing the hold is the whole of resuming. The comment
 * goes where the hold was found and names the label and the subject.
 */
const standDown = (
  needs: RetryNeeds,
  config: RetryConfig,
  target: Target,
  { hold, reason }: { readonly hold: Hold; readonly reason: string },
  failure: Failure,
): void => {
  const resume = actOn(target);
  const pr = resume.kind === "pr" ? resume.number : undefined;
  needs.comment(hold.on, renderStandDownComment({ hold, summary: failure.summary, runUrl: config.runUrl, pr }));
  if (pr) keepInProgress(needs, pr, reason);
  console.log(
    `Stood down: ${reason}. No retry spent, nothing labeled` +
      (pr ? `; PR #${pr} left in ${IN_PROGRESS_LABEL} for the reconciler once the hold is off.` : "; the dispatcher picks the ticket up once the hold is off."),
  );
};

/**
 * The conflict hand-off update-branch makes, from here (#144): a comment naming
 * the cause, then the implementer's label, on a branch the factory authored; a
 * tell-author otherwise (#183). No retry is spent either way.
 */
const handOff = (needs: RetryNeeds, config: RetryConfig, { pr, base }: PrMergeability, reason: string): void => {
  const fix = prFixOf(pr);
  if (fix.action === "tell-author") {
    tellAuthor(needs, config, pr, fix, { reason: authorConflictReason(base), issueNumber: undefined, output: "" });
    return;
  }
  needs.comment({ kind: "pr", number: pr.number }, renderHandOffComment({ reason, base, runUrl: config.runUrl }));
  labelPr(needs, pr, fix);
  console.log(`Handed off PR #${pr.number} without spending a retry: ${reason}; ${fix.add} on.`);
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

const prNote = (escalatedPr: EscalatedPr | undefined): string =>
  !escalatedPr
    ? ""
    : escalatedPr.closed
      ? `, PR #${escalatedPr.number} closed`
      : `, PR #${escalatedPr.number} left open (the factory did not author it)`;

const escalate = (needs: RetryNeeds, config: RetryConfig, target: Target, reason: string, failure: Failure): void => {
  const openPr = target.pr;
  let escalatedPr: EscalatedPr | undefined;
  if (openPr) {
    const { remove, add, close } = prEscalation({
      ...openPr.facts,
      labels: needs.labelsOf({ kind: "pr", number: openPr.number }),
    });
    for (const label of remove) soft(() => needs.removeLabel({ kind: "pr", number: openPr.number }, label));
    if (add) soft(() => needs.addLabel({ kind: "pr", number: openPr.number }, add));
    if (close) {
      soft(() =>
        needs.closePr(
          openPr.number,
          `Closed by the factory: ${reason}. The branch is kept; see ${target.issue ? `#${target.issue}` : "the run"} for the escalation. Run: ${config.runUrl}`,
        ),
      );
    } else {
      // Closing cancels auto-merge; leaving the PR open does not, so a PR the
      // factory has declared itself done with is disarmed by hand. Refused when
      // none was armed, which `soft` swallows.
      soft(() => needs.disarmAutoMerge(openPr.number));
    }
    escalatedPr = { number: openPr.number, closed: close };
  }
  const on = recordOn(target);
  const labels = escalationLabels(needs.labelsOf(on));
  for (const label of labels.remove) soft(() => needs.removeLabel(on, label));
  // The record: the label and the comment that must not be lost, so neither is soft.
  needs.addLabel(on, labels.add);
  needs.comment(
    on,
    renderEscalationComment({
      issueNumber: on.number,
      reason,
      summary: failure.summary,
      runUrl: config.runUrl,
      logUrl: safeArtifactUrl(needs),
      branch: config.branch,
      branchExists: safeBranchExists(needs),
      pr: escalatedPr,
      output: failure.output,
    }),
  );
  // The courtesy note on a PR left open goes last and soft: the record above is
  // the thing that must not be lost, and this is skipped when the record is the
  // PR's own thread, which the escalation comment already landed on.
  if (escalatedPr && !escalatedPr.closed && on.kind !== "pr") {
    soft(() =>
      needs.comment(
        { kind: "pr", number: escalatedPr!.number },
        renderLeftOpenPrComment({ reason, issueNumber: on.number, runUrl: config.runUrl }),
      ),
    );
  }
  console.log(`Escalated ${on.kind} #${on.number}: ${labels.add} on, ${labels.remove.join(", ") || "no factory labels"} off${prNote(escalatedPr)}.`);
};

/**
 * The failed-attempt path: decide with `decide.ts` from the target's labels and
 * the built failure, then act. The reads and writes go through the record, so a
 * test drives this with an in-memory target repo and asserts what it wrote.
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

  if (decision.action === "stand-down") standDown(needs, config, subject, decision, failure);
  else if (decision.action === "retry") retry(needs, config, subject, decision.retry, failure);
  else if (decision.action === "escalate") escalate(needs, config, subject, decision.reason, failure);
  else if (decision.action === "requeue") requeue(needs, config, subject, decision.reason);
  else if (decision.action === "hand-off") {
    // decide answers hand-off only from a mergeability it was given, and one is given only from a read.
    if (!mergeability) throw new Error("hand-off decided without a mergeability read");
    handOff(needs, config, mergeability, decision.reason);
  }
};

// `main` and `resolveTarget` are exported below rather than at their `const` so
// the review that reads this file by `const <name> =` finds them (#185, #204).
export { main, resolveTarget };
