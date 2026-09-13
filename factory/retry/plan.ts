/**
 * What a failed attempt does, as a value (#310): `decide.ts` answers which verb
 * the attempt earned, and `planFor` here turns that verb, the run's target, its
 * config and its failure into the ordered list of effects that carries it out.
 * Pure, so every arm is a value a test asserts on rather than a sequence of
 * calls read back out of `retry.ts`'s source.
 *
 * `retry.ts`'s `main` is the interpreter: it applies these in order through its
 * `RetryNeeds` record and chooses nothing of its own. Which of them it lets
 * fail softly is its policy and is not written down here: an effect says what
 * the write is for, and the handler decides which purposes a standing refusal
 * must not turn the run red for.
 *
 * `Effect` and not `Plan`: `factory/update-branch/plan.ts` already has a `Plan`,
 * one per open PR, and the two shapes are not the same thing.
 */
import { type FactoryPrFacts } from "../lib/factory-pr.ts";
import { IMPLEMENT_LABEL, IN_PROGRESS_LABEL } from "../lib/labels.ts";
import { type PrDisposition, prDisposition } from "../lib/pr-disposition.ts";
import { escalationLabels, prEscalation } from "./escalation.ts";
import {
  type Decision,
  type EscalatedPr,
  type FailureKind,
  type Hold,
  type Mergeability,
  type Subject,
  type TellAuthorNote,
  type TicketOrPr,
  MAX_RETRIES,
  authorConflictReason,
  renderHandOffComment,
  renderEscalationComment,
  renderLeftOpenPrComment,
  renderRequeueComment,
  renderRetryComment,
  renderStandDownComment,
  renderTellAuthorComment,
  retryLabel,
} from "./decide.ts";

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

/** What one failed attempt is acted on with. */
export interface RetryConfig {
  readonly branch: string;
  readonly runUrl: string;
  /** The workflow's FAILURE_KIND input, not the failure's own kind; only the checks path can lose its PR mid-wait. */
  readonly failureKind: "implement" | "checks";
}

/**
 * One thing the handler does, named by what the write is for. The list is
 * ordered and the handler applies it in order, so "the start label goes on
 * last, once the context the next run reads is in place" is a fact about the
 * plan rather than about the shape of the code that applies it.
 */
export type Effect =
  /** The record of what happened, on the thread that must carry it. */
  | { readonly kind: "comment"; readonly on: Subject; readonly body: string }
  /** A courtesy note on a thread the record did not land on. */
  | { readonly kind: "note"; readonly on: Subject; readonly body: string }
  /** A label that moves the factory or counts the attempt. */
  | { readonly kind: "add-label"; readonly on: Subject; readonly label: string }
  /** `factory:retry-<n>` created if the repo lacks it, so adding it cannot fail on an absent label. */
  | { readonly kind: "ensure-label"; readonly label: string }
  | { readonly kind: "remove-label"; readonly on: Subject; readonly label: string }
  /** The parking label on a PR the escalation left open, so no sweep picks it up again. */
  | { readonly kind: "park-pr"; readonly number: string; readonly label: string }
  | { readonly kind: "close-pr"; readonly number: string; readonly comment: string }
  | { readonly kind: "disarm-auto-merge"; readonly number: string }
  /** The marker file a requeued or stood-down PR leaves for the workflow steps that would drop its label (#148). */
  | { readonly kind: "mark-requeued"; readonly reason: string }
  /** What the job log says the handler did. Planned with the writes so no line is derived a second time from the verb. */
  | { readonly kind: "log"; readonly line: string };

/**
 * The costly reads only some arms make, one GitHub call each, asked for at the
 * arm that needs them the way the reconciler asks for its merge reads (#302,
 * #307): a retry or a requeue makes none of them. The handler passes readers
 * backed by its `RetryNeeds` record, with its own soft-fail policy behind them.
 */
export interface PlanReads {
  /** A subject's labels right now: what escalation takes off the ticket and off its open PR. */
  readonly labelsOf: (on: Subject) => readonly string[];
  /** Whether the branch still exists, for the escalation comment. */
  readonly branchExists: () => boolean;
  /** The uploaded run log artifact, for the escalation comment; undefined when none was found. */
  readonly artifactUrl: () => string | undefined;
}

/** What `planFor` is given: the verb `decide` answered, and the run it was answered about. */
export interface PlanInput {
  readonly decision: Decision;
  readonly target: Target;
  readonly config: RetryConfig;
  readonly failure: Failure;
}

/**
 * Where the record of this run goes: the ticket when there is one, since that
 * outlives the PR and is what a human reads; the PR only when no ticket was
 * found. Exported because the handler reads that subject's labels before it
 * decides, and the two must name the same thread.
 */
export const recordOn = (target: Target): Subject =>
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

const prSubject = (pr: OpenPr): Subject => ({ kind: "pr", number: pr.number });

/**
 * Tell the author of a PR the factory did not author (#183): the label the PR
 * fix chose, and what failed, on their own thread. `note` is undefined when this
 * thread already carries the record; when there is one it goes last, since by
 * then the label is on.
 */
const tellAuthor = (
  config: RetryConfig,
  pr: OpenPr,
  fix: PrDisposition,
  note: TellAuthorNote | undefined,
): Effect[] => [
  { kind: "add-label", on: prSubject(pr), label: fix.add },
  ...(note
    ? [
        {
          kind: "comment" as const,
          on: prSubject(pr),
          body: renderTellAuthorComment({ ...note, sentence: fix.sentence, runUrl: config.runUrl }),
        },
      ]
    : []),
  { kind: "log", line: `PR #${pr.number} is its author's to fix: no ${IMPLEMENT_LABEL}, ${fix.add} on.` },
];

/** The retry (#16): the record on whatever carries it, the count, then the label that starts the next run. */
const retryEffects = (config: RetryConfig, target: Target, retryNumber: number, failure: Failure): Effect[] => {
  const label = retryLabel(retryNumber);
  const fix = target.pr ? prDisposition(target.pr.facts) : undefined;
  // The record goes on whatever the retry hands the fix to: the attempt was
  // made, it failed, and the count moves, so nothing is dropped in silence.
  const on = recordOn(target);
  const record: Effect[] = [
    {
      kind: "comment",
      on,
      body: renderRetryComment({
        retry: retryNumber,
        kind: failure.kind,
        runUrl: config.runUrl,
        output: failure.output,
        action: fix?.action,
      }),
    },
    { kind: "ensure-label", label },
    { kind: "add-label", on, label },
  ];
  // The start label goes last, once the context the next run reads is in place.
  if (target.pr && fix) {
    const started =
      fix.action === "tell-author"
        ? tellAuthor(
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
          )
        : [{ kind: "add-label" as const, on: prSubject(target.pr), label: fix.add }];
    return [
      ...record,
      ...started,
      {
        kind: "log",
        line: `Retry ${retryNumber} of ${MAX_RETRIES}: ${label} on ${on.kind} #${on.number}, ${fix.add} on pr #${target.pr.number} (${failure.summary}).`,
      },
    ];
  }
  const trigger = actOn(target);
  return [
    ...record,
    { kind: "add-label", on: trigger, label: IMPLEMENT_LABEL },
    {
      kind: "log",
      line: `Retry ${retryNumber} of ${MAX_RETRIES}: ${label} on ${on.kind} #${on.number}, ${IMPLEMENT_LABEL} on ${trigger.kind} #${trigger.number} (${failure.summary}).`,
    },
  ];
};

/**
 * What a requeued or stood-down PR is left in: `agent:in-progress`, the label
 * the reconciler sweeps, plus the marker file for the workflow steps that take
 * that label off on the way out (#148). The label goes on first, then the marker.
 */
const keepInProgress = (pr: string, reason: string): Effect[] => [
  { kind: "add-label", on: { kind: "pr", number: pr }, label: IN_PROGRESS_LABEL },
  { kind: "mark-requeued", reason },
];

/** The requeue (#17, #148): a comment naming the cause, no retry spent, and nothing labeled for a human. */
const requeueEffects = (config: RetryConfig, target: Target, reason: string): Effect[] => {
  const on = actOn(target);
  const onPr = on.kind === "pr";
  return [
    { kind: "comment", on, body: renderRequeueComment({ reason, runUrl: config.runUrl, onPr }) },
    ...(onPr ? keepInProgress(on.number, reason) : []),
    {
      kind: "log",
      line:
        `Requeued ${on.kind} #${on.number} without spending a retry: ${reason}` +
        (onPr
          ? `; left in ${IN_PROGRESS_LABEL}, the reconciler re-adds the start label at its stuck deadline.`
          : "; the dispatcher re-dispatches it."),
    },
  ];
};

/**
 * A person holds the subject (#185): the retry's label is the one thing that
 * would have started an agent, and it is not written; neither is
 * `factory:retry-<n>`, nor anything of escalation's. What is left is what a
 * requeue leaves, so removing the hold is the whole of resuming. The comment
 * goes where the hold was found and names the label and the subject.
 */
const standDownEffects = (
  config: RetryConfig,
  target: Target,
  { hold, reason }: { readonly hold: Hold; readonly reason: string },
  failure: Failure,
): Effect[] => {
  const resume = actOn(target);
  const pr = resume.kind === "pr" ? resume.number : undefined;
  return [
    {
      kind: "comment",
      on: hold.on,
      body: renderStandDownComment({ hold, summary: failure.summary, runUrl: config.runUrl, pr }),
    },
    ...(pr ? keepInProgress(pr, reason) : []),
    {
      kind: "log",
      line:
        `Stood down: ${reason}. No retry spent, nothing labeled` +
        (pr
          ? `; PR #${pr} left in ${IN_PROGRESS_LABEL} for the reconciler once the hold is off.`
          : "; the dispatcher picks the ticket up once the hold is off."),
    },
  ];
};

/**
 * The conflict hand-off update-branch makes, from here (#144): a comment naming
 * the cause, then the implementer's label, on a branch the factory authored; a
 * tell-author otherwise (#183). No retry is spent either way. The base is the
 * one the mergeability read named, and it reaches the reader through the body
 * rendered here, so nothing downstream has to have read it.
 */
const handOffEffects = (config: RetryConfig, { pr, base }: PrMergeability, reason: string): Effect[] => {
  const fix = prDisposition(pr.facts, base);
  if (fix.action === "tell-author") {
    return tellAuthor(config, pr, fix, { reason: authorConflictReason(base), issueNumber: undefined, output: "" });
  }
  return [
    {
      kind: "comment",
      on: prSubject(pr),
      body: renderHandOffComment({ reason, add: fix.add, sentence: fix.sentence, runUrl: config.runUrl }),
    },
    { kind: "add-label", on: prSubject(pr), label: fix.add },
    { kind: "log", line: `Handed off PR #${pr.number} without spending a retry: ${reason}; ${fix.add} on.` },
  ];
};

const prNote = (escalatedPr: EscalatedPr | undefined): string =>
  !escalatedPr
    ? ""
    : escalatedPr.closed
      ? `, PR #${escalatedPr.number} closed`
      : `, PR #${escalatedPr.number} left open (the factory did not author it)`;

/**
 * The escalation (#50, #174): the open PR stood down first, closed only when
 * the factory authored it and disarmed and parked when it did not, then the
 * record, which is the label and the comment a human reads. The branch and log
 * reads the comment wants are asked for here, so an arm that escalates nothing
 * never pays for them.
 */
const escalateEffects = (
  config: RetryConfig,
  target: Target,
  reason: string,
  failure: Failure,
  reads: PlanReads,
): Effect[] => {
  const openPr = target.pr;
  const effects: Effect[] = [];
  let escalatedPr: EscalatedPr | undefined;
  if (openPr) {
    const on = prSubject(openPr);
    const { remove, add, close } = prEscalation({ ...openPr.facts, labels: reads.labelsOf(on) });
    for (const label of remove) effects.push({ kind: "remove-label", on, label });
    if (add) effects.push({ kind: "park-pr", number: openPr.number, label: add });
    if (close) {
      effects.push({
        kind: "close-pr",
        number: openPr.number,
        comment: `Closed by the factory: ${reason}. The branch is kept; see ${target.issue ? `#${target.issue}` : "the run"} for the escalation. Run: ${config.runUrl}`,
      });
    } else {
      // Closing cancels auto-merge; leaving the PR open does not, so a PR the
      // factory has declared itself done with is disarmed by hand.
      effects.push({ kind: "disarm-auto-merge", number: openPr.number });
    }
    escalatedPr = { number: openPr.number, closed: close };
  }
  const on = recordOn(target);
  const labels = escalationLabels(reads.labelsOf(on));
  for (const label of labels.remove) effects.push({ kind: "remove-label", on, label });
  // The record: the label and the comment that must not be lost.
  effects.push({ kind: "add-label", on, label: labels.add });
  effects.push({
    kind: "comment",
    on,
    body: renderEscalationComment({
      issueNumber: on.number,
      reason,
      summary: failure.summary,
      runUrl: config.runUrl,
      logUrl: reads.artifactUrl(),
      branch: config.branch,
      branchExists: reads.branchExists(),
      pr: escalatedPr,
      output: failure.output,
    }),
  });
  // The courtesy note on a PR left open goes last: the record above is the thing
  // that must not be lost, and this is skipped when the record is the PR's own
  // thread, which the escalation comment already landed on.
  if (escalatedPr && !escalatedPr.closed && on.kind !== "pr") {
    effects.push({
      kind: "note",
      on: { kind: "pr", number: escalatedPr.number },
      body: renderLeftOpenPrComment({ reason, issueNumber: on.number, runUrl: config.runUrl }),
    });
  }
  effects.push({
    kind: "log",
    line: `Escalated ${on.kind} #${on.number}: ${labels.add} on, ${labels.remove.join(", ") || "no factory labels"} off${prNote(escalatedPr)}.`,
  });
  return effects;
};

/**
 * The whole of what one failed attempt does, in the order it is done. Nothing
 * here reads or writes; the reads some arms need are asked for through
 * `PlanReads`, which the handler backs with its record.
 */
export const planFor = ({ decision, target, config, failure }: PlanInput, reads: PlanReads): Effect[] => {
  if (decision.action === "stand-down") return standDownEffects(config, target, decision, failure);
  if (decision.action === "retry") return retryEffects(config, target, decision.retry, failure);
  if (decision.action === "escalate") return escalateEffects(config, target, decision.reason, failure, reads);
  if (decision.action === "requeue") return requeueEffects(config, target, decision.reason);
  if (decision.action === "hand-off") {
    // `decide` answers hand-off only from a mergeability it was given, and one
    // is given only from a read: with none there is no PR named and no base to
    // merge, so the plan says that rather than guessing at either.
    const { mergeability } = failure;
    return mergeability
      ? handOffEffects(config, mergeability, decision.reason)
      : [{ kind: "log", line: `Hand-off decided with no mergeability read (${decision.reason}); no PR to hand off.` }];
  }
  return [];
};
