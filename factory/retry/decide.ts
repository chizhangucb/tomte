/**
 * Retry and escalation (#16): what the factory does when a run fails.
 *
 * A run fails when the implementer run failed (no commits, an agent error),
 * or when the PR's merge gate (factory/red-green,
 * factory/test-integrity, the target's own CI) or factory/verdict came back
 * failing. The first failure earns one informed retry: the implementer runs
 * again on the same branch with the failing output in its prompt. A second
 * failure escalates: agent labels and ready-for-agent off, needs-human on,
 * branch kept, log linked, no open PR.
 *
 * Attempts are counted with a label on the ticket, `factory:retry-<n>`, so
 * the count survives across workflow runs and a human can see it. The
 * failing output travels as a marker comment on the ticket that the next
 * implementer run reads back. Pure functions here; `retry.ts` acts on the
 * decision through its needs record, and `retry-run.ts` makes the calls.
 */
import type { FactoryPrFacts } from "../lib/factory-pr.ts";
import { BLOCKED_LABEL, ESCALATION_LABEL, HOLD_LABELS, IMPLEMENT_LABEL, IN_PROGRESS_LABEL, READY_LABEL } from "../lib/labels.ts";
import { linkedIssueNumber } from "../lib/linked-issue";
import { boundOutput } from "../lib/verdict";
import type { PrFixAction } from "./escalation.ts";

export type FailureKind = "implement" | "merge-gate" | "ci" | "verdict";

export const FAILURE_KINDS: readonly FailureKind[] = ["implement", "merge-gate", "ci", "verdict"];

/** Retries after the first attempt. One: the spec's retry cap. */
export const MAX_RETRIES = 1;

export const RETRY_LABEL_PREFIX = "factory:retry-";

export const retryLabel = (n: number): string => `${RETRY_LABEL_PREFIX}${n}`;

/** How many retries the ticket has used: the highest `factory:retry-<n>` label. */
export const retriesUsed = (labels: readonly string[]): number =>
  labels.reduce((max, label) => {
    if (!label.startsWith(RETRY_LABEL_PREFIX)) return max;
    const n = Number(label.slice(RETRY_LABEL_PREFIX.length));
    return Number.isInteger(n) && n > max ? n : max;
  }, 0);

/**
 * Whether an attempt that ended this way is the implementer's own failure, so
 * it spends the ticket's one retry. GitHub's outcome for the step that ran the
 * implementer, or for the job when the step's outcome did not survive.
 *
 * `cancelled` is the job timeout (#51): `timeout-minutes` kills the job
 * mid-run, and an attempt killed while working is exactly what a retry is for.
 * Anything else failed around the implementer (a checkout, a push, the PR
 * step), which gets the blocked comment rather than burning the retry.
 */
export const isImplementerFailure = (outcome: string): boolean =>
  outcome === "failure" || outcome === "cancelled";

/**
 * What to report as the failure reason when the attempt wrote no reason file.
 * A cancelled attempt was killed rather than stopped by anything it could
 * write down (#51), so saying "no reason file" would read as a factory bug.
 */
export const missingFailureReason = (outcome: string): string =>
  outcome === "cancelled"
    ? "the run was killed before it could report a reason; a job timeout looks like this"
    : "(no reason file written; see the workflow log)";

/** Why a run that could not reach an account is not the ticket's failure. */
export const RATE_LIMITED_REASON = "rate limited on every account; not the ticket's failure";

/**
 * Written into the output dir when a PR was requeued (#148), for the workflow
 * steps that take `agent:in-progress` off on their way out: the one they must
 * not take it off for is a requeued PR. That label is what the reconciler
 * sweeps, so it is what gets the start label re-added at the stuck deadline;
 * a PR with no `agent:*` label is swept by nothing. A requeued ticket writes
 * no marker, having the opposite need: no factory label is what the
 * dispatcher picks up. A PR stood down on for a hold (#185) writes it too,
 * for the same reason: it is left where a requeue leaves one.
 */
export const REQUEUED_FILE = "requeued.txt";

/**
 * What a run is about: the ticket, its open PR, or both, never neither. A run
 * with neither has nothing to record on or act on, so the type cannot hold one
 * whose numbers are undefined (#133). Generic over the PR so this module stays
 * free of the handler's `gh` reads.
 */
export type TicketOrPr<Pr> =
  | { readonly issue: string; readonly pr: Pr | undefined }
  | { readonly issue: undefined; readonly pr: Pr };

/** The ticket and open PR together, or undefined when neither was found. */
export const ticketOrPr = <Pr>(issue: string | undefined, pr: Pr | undefined): TicketOrPr<Pr> | undefined =>
  issue ? { issue, pr } : pr ? { issue: undefined, pr } : undefined;

/**
 * A run whose subject did not resolve, and why. Not thrown: a run with nothing
 * failed has no write to make, so it needs no subject, and only a run that has
 * something to write fails on this (#133).
 */
export interface Unresolved {
  readonly unresolved: string;
}

/**
 * A run handed a PR number: the PR counts only while open, and the ticket is
 * the one handed over or else the one its body links. Unresolved, naming both
 * facts, when that leaves nothing, which is a PR no longer open whose body
 * links no ticket.
 */
export const ticketOrPrFromPr = <Pr>(input: {
  readonly number: string;
  readonly state: string;
  readonly ticket: string | undefined;
  readonly pr: Pr;
}): TicketOrPr<Pr> | Unresolved =>
  ticketOrPr(input.ticket, input.state === "OPEN" ? input.pr : undefined) ?? {
    unresolved: `PR #${input.number} is ${input.state.toLowerCase()}, not open, and its body links no ticket: nothing to retry or escalate on.`,
  };

/**
 * A run handed only its ticket: the ticket, and the one open PR that is this
 * run's, which is a PR that links the ticket *and* sits on the run's own
 * branch (#204). Linking the ticket is not enough. Anyone can open a PR saying
 * `Closes #7` while the factory's run on #7 is in flight, and one picked on
 * the link alone became the subject of the factory's own failure: a PR the
 * factory did not author gets a tell-author (#183), so its author was handed
 * `agent:blocked` and a comment for an attempt they never made. A PR on any
 * other branch is not this run's, so the run resolves as though none were
 * open and everything after it lands on the ticket alone. Nor is a PR from a
 * fork: GitHub names a fork's head by its branch alone, so a fork branch named
 * like the run's (pushed from a fetch of it, say) passes the branch test, and
 * on an `agent/` branch it would then read as the factory's own and be handed
 * an implementer or closed on escalation.
 *
 * The branch is the one the workflow handed over, `agent-implement.yml` being
 * the only caller on this path. A run handed a PR number never comes here: that
 * PR is named rather than searched for, and `ticketOrPrFromPr` takes it on
 * whatever branch it is.
 */
export const ticketOrPrFromTicket = <Pr extends { readonly facts: FactoryPrFacts; readonly fromFork: boolean }>(input: {
  readonly ticket: string;
  readonly branch: string;
  /**
   * Every open PR, as the handler lists them. `fromFork` is required rather
   * than optional, so a list that never asked GitHub cannot pass for one
   * holding no fork.
   */
  readonly open: readonly Pr[];
}): TicketOrPr<Pr> => ({
  issue: input.ticket,
  pr: input.open.find(
    ({ facts, fromFork }) => !fromFork && facts.headRef === input.branch && linkedIssueNumber(facts.body) === input.ticket,
  ),
});

/** A PR's mergeability as GitHub reports it (`gh pr view --json mergeable`); UNKNOWN while it is still computing. */
export type Mergeability = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

/**
 * The one thing an action is taken on: a ticket or a PR, named the way the
 * sweep names one (`Subject` in `dispatch/reconcile.ts`). Not imported from
 * there: that module is the dispatch job's, and it numbers its subjects with
 * a number, while every number here is the string the workflow handed over,
 * which is also the `gh` argument.
 *
 * A retry has two subjects at once, the one that records it and the one whose
 * label starts the next run, so which is which has to be readable at every
 * call site rather than positional. Here rather than in `retry.ts` because a
 * hold is found on one of the two (#185), and `Hold` has to name which.
 */
export interface Subject {
  readonly kind: "issue" | "pr";
  readonly number: string;
}

/**
 * `hold` on the run's subject, and which subject it was found on (#185): a
 * person has said to leave this alone, and the retry handler says back which
 * label stopped it and where.
 */
export interface Hold {
  readonly label: string;
  readonly on: Subject;
}

/**
 * The first hold label on these subjects, and where it was found; the caller
 * passes the ticket first, then its open PR. `HOLD_LABELS` is the dispatcher's
 * list, so a label that holds a ticket back from dispatch holds it here too.
 *
 * Both subjects and not only the one that records the retry: the label a
 * retry adds goes on the PR whenever one is open, so a hold on the PR is a
 * hold on exactly what the retry would start.
 */
export const findHold = (
  subjects: readonly (Subject & { readonly labels: readonly string[] })[],
): Hold | undefined => {
  for (const { kind, number, labels } of subjects) {
    const label = HOLD_LABELS.find((held) => labels.includes(held));
    if (label) return { label, on: { kind, number } };
  }
  return undefined;
};

/** A subject the way a comment names it: `ticket #7`, `PR #12`. */
const subjectName = (on: Subject): string => `${on.kind === "issue" ? "ticket" : "PR"} #${on.number}`;

export type Decision =
  /** A person holds the subject: no agent starts, nothing is spent, nothing is escalated. */
  | { readonly action: "stand-down"; readonly hold: Hold; readonly reason: string }
  | { readonly action: "retry"; readonly retry: number }
  | { readonly action: "escalate"; readonly reason: string }
  /** Not the ticket's failure: hand it back to the queue without counting an attempt. */
  | { readonly action: "requeue"; readonly reason: string }
  /** The PR conflicts with its base: the implementer's to resolve, no attempt counted. */
  | { readonly action: "hand-off"; readonly reason: string }
  | { readonly action: "none"; readonly reason: string };

/** Why a conflicting PR whose checks never came goes to the implementer rather than to a human. */
export const CONFLICT_REASON =
  "the PR conflicts with its base, so GitHub started no merge gate on this head; the implementer resolves it";

/**
 * Retry or escalate. Every failure kind gets the same one retry; the kind
 * shapes the prompt and the escalation comment, not the count. An escalated
 * ticket is left alone so two failure handlers cannot escalate it twice. A
 * run rate limited on every account is requeued, not retried: the quota is
 * the problem, rotation (#17) is the answer, and the attempt does not count.
 * A head still pending when the wait for its checks runs out is requeued for
 * the same reason: nothing has failed yet, so there is no output to inform a
 * retry, and spending one on a slow target CI leaves only escalation. On a
 * PR a requeue means what it means on a ticket (#148): no `agent:blocked`,
 * and something that already sweeps picks the subject up again, the
 * reconciler at its stuck deadline. But when that PR
 * conflicts with its base (#144) the checks never came because GitHub runs
 * no merge gate on a conflicting PR, so it is handed to the implementer instead.
 * UNKNOWN mergeability is GitHub still deciding and is never acted on. A
 * real failure outranks the conflict, as a failed check outranks a pending
 * one. A failure a retry cannot fix (the ticket has no acceptance criteria)
 * escalates at once.
 *
 * A held subject stands down (#185), and that is read before everything but
 * an escalation already made. Before the retry, since a retry starts an
 * agent. Before the requeue and the hand-off, since a hand-off starts one too
 * and a requeue would say the wrong thing about why nothing moved. And before
 * both escalations, the retry cap and the unretryable failure, because
 * escalating takes every `agent:*` label and `ready-for-agent` off: the
 * factory would be reclaiming a subject a person has just taken, and removing
 * the hold could no longer resume it. Whatever is wrong with the attempt is
 * still wrong once the hold comes off, and the next failure finds it.
 */
export const decide = (input: {
  readonly retriesUsed: number;
  readonly kind: FailureKind;
  readonly escalated?: boolean;
  /** Why this attempt is not the ticket's failure, so it is handed back; undefined when it is. */
  readonly requeue?: string;
  /** The open PR's mergeability; undefined when there is no PR to read. */
  readonly mergeable?: Mergeability;
  /** Why another implementer run cannot fix this failure; undefined when it might. */
  readonly unretryable?: string;
  /** The hold on the ticket or its open PR, from `findHold`; undefined when neither is held. */
  readonly held?: Hold;
}): Decision => {
  if (input.escalated) {
    return { action: "none", reason: `already escalated: ${ESCALATION_LABEL} is on the ticket` };
  }
  if (input.held) {
    return { action: "stand-down", hold: input.held, reason: `\`${input.held.label}\` is on ${subjectName(input.held.on)}` };
  }
  if (input.requeue) {
    if (input.mergeable === "CONFLICTING") return { action: "hand-off", reason: CONFLICT_REASON };
    return { action: "requeue", reason: input.requeue };
  }
  if (input.unretryable) {
    return { action: "escalate", reason: input.unretryable };
  }
  if (input.retriesUsed < MAX_RETRIES) {
    return { action: "retry", retry: input.retriesUsed + 1 };
  }
  const attempts = input.retriesUsed + 1;
  return {
    action: "escalate",
    reason: `the retry failed too (${attempts} attempts, ${MAX_RETRIES} retry allowed)`,
  };
};

export interface RetryContext {
  /** Which retry this context is for: 1 for the one retry, matching the `factory:retry-1` label. */
  readonly retry: number;
  readonly kind: FailureKind;
  readonly runUrl: string;
  /** The failing output: a reviewer checklist, a check's log excerpt, or the run's failure reason. */
  readonly output: string;
}

/**
 * What `renderRetryComment` is given: the context above plus which way the
 * open PR went (#183). Not part of `RetryContext` itself: that is what a later
 * implementer run reads back out of the comment, and by then the PR that
 * failed may be gone.
 */
export interface RetryCommentInput extends RetryContext {
  /** Default `hand-off`, the only answer there was before #183. */
  readonly action?: PrFixAction;
}

const MARKER = /^<!-- factory:retry retry=(\d+) kind=([a-z-]+) -->\n?/;
const RUN_LINE = /^Attempt \d+ failed \([a-z-]+\)\. Run: (\S+)$/m;
/** Fits a GitHub comment (64k) with room for the rest of the body. */
const OUTPUT_LIMITS = { head: 6_000, tail: 10_000 };

const fence = (text: string): string => {
  const longest = Math.max(2, ...[...text.matchAll(/`{3,}/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}text\n${text.trim()}\n${ticks}`;
};

/**
 * The failing output folded away at the end of a comment, bounded, or nothing
 * when there is none to show. Every comment that carries an output carries it
 * the same way, and `parseRetryComment` reads this shape back out of the
 * marker comment.
 */
const failureDetails = (output: string): string[] =>
  output.trim().length === 0
    ? []
    : ["", "<details><summary>Failure output</summary>", "", fence(boundOutput(output, OUTPUT_LIMITS)), "", "</details>"];

/**
 * The marker comment the failure handler posts on the ticket before the retry
 * starts. It records the attempt whoever fixes it (#183), so the count is the
 * same either way and nothing is dropped in silence; only the line saying what
 * happens next changes, because on a PR the factory did not author the answer
 * is "nothing of the factory's does".
 */
export const renderRetryComment = (context: RetryCommentInput): string =>
  [
    `<!-- factory:retry retry=${context.retry} kind=${context.kind} -->`,
    `### Retry ${context.retry} of ${MAX_RETRIES} requested by the factory`,
    "",
    `Attempt ${context.retry} failed (${context.kind}). Run: ${context.runUrl}`,
    "",
    context.action === "tell-author"
      ? `The factory did not author the open PR, so no implementer runs on its branch: the fix is its author's. The PR carries \`${BLOCKED_LABEL}\`, and taking that label off hands it back to the factory; a second failure escalates to \`${ESCALATION_LABEL}\`.`
      : "The implementer runs once more on the same branch with this output in its prompt; a second failure escalates to `needs-human`.",
    ...failureDetails(context.output),
  ].join("\n");

const isFailureKind = (value: string): value is FailureKind =>
  (FAILURE_KINDS as readonly string[]).includes(value);

/** Read a marker comment back; undefined for any other comment. */
export const parseRetryComment = (body: string): RetryContext | undefined => {
  const marker = body.match(MARKER);
  if (!marker || !isFailureKind(marker[2] ?? "")) return undefined;
  const rest = body.slice(marker[0].length);
  const details = rest.match(/<details><summary>Failure output<\/summary>\n\n([\s\S]*?)\n\n<\/details>\s*$/);
  const fenced = details?.[1] ?? "";
  const output = fenced.replace(/^`{3,}text\n/, "").replace(/\n`{3,}$/, "");
  return {
    retry: Number(marker[1]),
    kind: marker[2] as FailureKind,
    runUrl: rest.match(RUN_LINE)?.[1] ?? "",
    output,
  };
};

/**
 * The newest marker comment among a ticket's comments, oldest first, and
 * only while the ticket's `factory:retry-<n>` label says that retry is the
 * current one. A ticket handed back after an escalation (label removed)
 * starts a fresh cycle and its old marker is history.
 */
export const latestRetryContext = (
  commentBodies: readonly string[],
  labels: readonly string[],
): RetryContext | undefined => {
  const current = retriesUsed(labels);
  if (current === 0) return undefined;
  for (let i = commentBodies.length - 1; i >= 0; i--) {
    const parsed = parseRetryComment(commentBodies[i] ?? "");
    if (parsed) return parsed.retry === current ? parsed : undefined;
  }
  return undefined;
};

const KIND_GUIDANCE: Record<FailureKind, string> = {
  implement:
    "The output is the previous run's failure reason and the tail of its log. Find what stopped it and finish the ticket this time; do not repeat the same path.",
  "merge-gate": "The output is a failing check's log. Make that check pass: a new test must fail on main and pass here, a deleted test must be one the ticket removes, and no test may be skipped or narrowed.",
  ci: "The output is the target's own CI log. Make the CI pass without weakening it.",
  verdict:
    "The output is the reviewer's checklist. Every unticked criterion must be met, with evidence visible in the diff, before you finish.",
};

/** The prompt section an implementer gets on a retry; empty on a first attempt. */
export const retryPromptSection = (context: RetryContext | undefined): string => {
  if (!context) return "";
  return [
    "# RETRY: THE PREVIOUS ATTEMPT FAILED",
    "",
    `This is retry ${context.retry} of ${MAX_RETRIES} on this ticket (attempt ${context.retry + 1} of ${MAX_RETRIES + 1}). If it fails again the factory escalates to a human, so fix the cause of the failure first. Attempt ${context.retry} failed (${context.kind}). Run: ${context.runUrl}. The branch carries whatever the previous attempt committed.`,
    "",
    KIND_GUIDANCE[context.kind],
    "",
    fence(context.output),
    "",
  ].join("\n");
};

/**
 * The comment on a requeued ticket or PR: what happened and what moves it
 * next. The reason names the cause, so the heading stays true of every one
 * of them. A requeue means the same thing on both sides (#148): no retry
 * spent, no label of the factory's added, and something that already sweeps
 * picks the subject up again, the dispatcher on a ticket and the reconciler
 * on a PR. Neither is a human, so no requeue reaches `agent:blocked`, which
 * keeps its one meaning: a human must look. A PR that conflicts with its
 * base never gets this comment; it is the implementer's, and
 * `renderHandOffComment` says so.
 */
export const renderRequeueComment = (input: {
  readonly reason: string;
  readonly runUrl: string;
  /** The PR path has no dispatcher: the reconciler re-labels it at its stuck deadline. */
  readonly onPr: boolean;
}): string =>
  [
    "### Requeued without spending a retry",
    "",
    `${input.reason}. No retry was spent. Run: ${input.runUrl}`,
    "",
    input.onPr
      ? "This PR stays in `agent:in-progress` and nothing else is labeled. The reconciler re-adds `agent:review` at its stuck deadline, and the run starts again; the retry count is unchanged."
      : "No factory label is left on the ticket, so the dispatcher picks it up again on its next run (a label event or the next heartbeat sweep) once `agent:in-progress` is gone.",
  ].join("\n");

/**
 * The comment on a held subject the retry handler stood down on (#185),
 * posted where the hold was found, since that is the thread the person who
 * added it is reading. It names the label and the subject, because the factory
 * reads the hold on the ticket and on its PR, and "why did nothing happen" has
 * to be answerable without knowing that.
 *
 * What it leaves behind is a requeue's (#148), and the comment says so: a
 * ticket with no factory label, which the dispatcher skips while it is held
 * and picks up once it is not, and a PR in `agent:in-progress`, which the
 * reconciler leaves alone while it is held and re-labels at its stuck
 * deadline once it is not. No retry is spent, since a person stopped the
 * attempt rather than the implementer failing it, and nothing is escalated:
 * `needs-human` is the factory giving up, and here a person has taken the
 * wheel, so there is nothing for a human to be asked.
 */
export const renderStandDownComment = (input: {
  readonly hold: Hold;
  /** What ended the attempt, one line. */
  readonly summary: string;
  readonly runUrl: string;
  /** The open PR the retry would have labeled, kept in `agent:in-progress`; undefined when the ticket stands alone. */
  readonly pr: string | undefined;
}): string => {
  const { label, on } = input.hold;
  return [
    `### Stood down: \`${label}\` is on ${subjectName(on)}`,
    "",
    `The attempt ended (${input.summary}), and the factory would have started another agent on it now. \`${label}\` on ${subjectName(on)} says a person has this one, so nothing was labeled and nothing was escalated. No retry was spent. Run: ${input.runUrl}`,
    "",
    input.pr
      ? `Take \`${label}\` off to resume. PR #${input.pr} stays in \`${IN_PROGRESS_LABEL}\`, which the reconciler leaves alone while it is held; once the hold is off, its next sweep past the stuck deadline re-adds \`agent:review\`, and the retry count is unchanged.`
      : `Take \`${label}\` off to resume. The ticket is left with no factory label, so the dispatcher picks it up again once the hold is off, with the retry count unchanged.`,
  ].join("\n");
};

/**
 * The comment on a PR handed to the implementer because it conflicts with
 * its base (#144): the same hand-off update-branch makes on a conflict it
 * cannot resolve. Nothing here is for a human.
 */
export const renderHandOffComment = (input: {
  readonly reason: string;
  readonly base: string;
  readonly runUrl: string;
}): string =>
  [
    "### Handed to the implementer without spending a retry",
    "",
    `${input.reason}. No retry was spent. Run: ${input.runUrl}`,
    "",
    `Labeled \`${IMPLEMENT_LABEL}\`. Its run merges \`${input.base}\` into the branch, resolves the conflicts, and pushes; the merge gate and the review then judge the new head and auto-merge lands it.`,
  ].join("\n");

/**
 * The conflict as the PR's own author reads it (#183): the same fact
 * `CONFLICT_REASON` states, without the clause naming the implementer that is
 * not coming, and with the base named, since the merge is theirs to make.
 */
export const authorConflictReason = (base: string): string =>
  `the PR conflicts with \`${base}\`, so GitHub started no merge gate on this head`;

/** What the factory tells the author of a PR it will not put an implementer on (#183). */
export interface TellAuthorNote {
  /** What the factory found: the failure summary, or the conflict. */
  readonly reason: string;
  /** The ticket carrying the record, when the record went elsewhere; undefined when nothing else holds it. */
  readonly issueNumber: string | undefined;
  /** The failing output, when there is one this thread does not already carry. */
  readonly output: string;
  /**
   * Whether the next failure on this PR escalates, which is true once the
   * ticket's retries are spent and false on the conflict path, which spends
   * none. The author reads this thread and not the ticket, so a terminal next
   * round has to be said here or it is not said to them at all.
   */
  readonly escalatesNext?: boolean;
}

/**
 * The comment on a PR the factory will not put an implementer on (#183), for
 * the PR's own thread. Both paths that would have labelled it
 * `agent:implement` post it: the retry after a failing check, and the conflict
 * hand-off.
 *
 * It is the whole of what its author gets, so it carries what failed rather
 * than a link to it: the retry's own record goes on the ticket, which is not
 * this author's thread and may not even be theirs to read. It also says what
 * the labels now say, because a PR whose `agent:*` labels vanished and that
 * acquired `needs-human` otherwise reads as the factory losing interest.
 *
 * What it does not say is "add `agent:review`". Taking `agent:blocked` off is
 * what actually hands the PR back, which is what #180's own tell-author
 * comment says, and telling a producer how to enter the **Judged path** is
 * #181's job rather than a failure comment's.
 */
export const renderTellAuthorComment = (input: TellAuthorNote & { readonly runUrl: string }): string =>
  [
    "### The fix is yours: the factory did not author this PR",
    "",
    `${input.reason}. Run: ${input.runUrl}`,
    "",
    `The factory puts an implementer only on a branch it opened, so no agent of the factory's will rewrite this one. It carries \`${BLOCKED_LABEL}\` instead, this factory's "a human must look", which is what holds the next review and the reconciler back.`,
    "",
    `Push the fix yourself, then take \`${BLOCKED_LABEL}\` off, which hands the PR back. Bringing the branch up to date with its base is the one part that never stops, since it never asks who opened a PR; auto-merge, if it is armed, is untouched throughout.`,
    ...(input.issueNumber ? ["", `The attempt is recorded on #${input.issueNumber}.`] : []),
    ...(input.escalatesNext
      ? [
          "",
          `That was the factory's last attempt on this one. If the next judgement fails too it escalates: \`${ESCALATION_LABEL}\` on this PR and on the ticket, auto-merge disarmed, and a person decides what happens next. Nothing is closed and no commit of yours is touched.`,
        ]
      : []),
    ...failureDetails(input.output),
  ].join("\n");

/**
 * The PR that was open when the factory gave up, and what became of it.
 * Closing is `prEscalation`'s call, not this one's: escalation leaves a PR
 * the factory did not author open (#174), and the comment reports what
 * happened rather than deciding it.
 */
export interface EscalatedPr {
  readonly number: string;
  readonly closed: boolean;
}

/**
 * The comment on a PR escalation left open (#174), for the PR's own thread.
 * The escalation is recorded on the ticket, so without this the PR would show
 * its `agent:*` labels vanishing and say nothing about why. Posted only when
 * the record went elsewhere: with no ticket the escalation comment lands on
 * this PR already and a second one would repeat it.
 */
export const renderLeftOpenPrComment = (input: {
  readonly reason: string;
  readonly issueNumber: string;
  readonly runUrl: string;
}): string =>
  [
    "### Left open by the factory",
    "",
    `${input.reason}. The factory did not author this PR, so it is not the factory's to close.`,
    "",
    `Its \`agent:*\` labels are off and \`${ESCALATION_LABEL}\` is on, so no factory run picks it up again. The escalation is on #${input.issueNumber}. Run: ${input.runUrl}`,
  ].join("\n");

export interface EscalationInput {
  readonly issueNumber: string;
  readonly reason: string;
  /** One line per failure, for the top of the comment. */
  readonly summary: string;
  readonly runUrl: string;
  /** The uploaded run log artifact, when one was found. */
  readonly logUrl: string | undefined;
  readonly branch: string;
  readonly branchExists: boolean;
  /** The PR that was open when the factory gave up; undefined when none was. */
  readonly pr: EscalatedPr | undefined;
  readonly output: string;
}

/** The escalation comment on the ticket: the one thing a human reads. */
export const renderEscalationComment = (input: EscalationInput): string => {
  const branchLine = input.branchExists
    ? `Branch \`${input.branch}\` is kept for you.`
    : `No branch was pushed: no attempt made a commit.`;
  // Three outcomes, not two. A PR left open is the one a reader would
  // otherwise take for a PR that was closed, so it says which and why (#174):
  // the escalation happened, and only the closing did not.
  const prLine = !input.pr
    ? "No PR was open."
    : input.pr.closed
      ? `PR #${input.pr.number} was closed (auto-merge with it) so no open PR remains.`
      : `PR #${input.pr.number} is left open: the factory did not author it, so it is not the factory's to close. Its \`agent:*\` labels are off, \`${ESCALATION_LABEL}\` is on and auto-merge is disarmed, so no factory run picks it up again.`;
  const lines = [
    `## Escalated: \`${ESCALATION_LABEL}\``,
    "",
    `The factory gave up on #${input.issueNumber}: ${input.reason}.`,
    "",
    `- Last failure: ${input.summary}`,
    `- Run: ${input.runUrl}`,
    `- Run log: ${input.logUrl ?? "see the run"}`,
    `- ${branchLine} ${prLine}`,
    "",
    `To hand it back to the factory: fix the ticket, then remove \`${ESCALATION_LABEL}\` and \`${retryLabel(MAX_RETRIES)}\`, then add \`${READY_LABEL}\` back (escalation took it off). The dispatcher picks it up on the next event and the new run starts from main again${input.branchExists ? "; the kept branch is for reading" : ""}.`,
  ];
  lines.push(...failureDetails(input.output));
  return lines.join("\n");
};
