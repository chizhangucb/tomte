/**
 * Vendored from sandcastle 0.12.0, `.sandcastle/agent-workflows/shared/review-context.ts`.
 * Forced differences, each named (#47, #52):
 *
 * - `issueBody`, so the reviewer can parse acceptance criteria: story 5.
 * - the closing-keyword regex moved to `lib/linked-issue.ts`, one definition for
 *   the reviewer, the merge gate, the preflight and the retry handler (#13, #16).
 * - the linked issue read through `--json` and rendered by `lib/ticket-context.ts`:
 *   the text view carries no `author_association`, so nothing on it could be
 *   filtered, and gh 2.95 prints only the comments under `--comments` anyway, so
 *   a ticket with none arrived empty. One `--json` read for body and comments
 *   together (story 27, ADR 0008), with the author's association
 *   beside it, per the bullet below.
 * - the `gh issue view --json` read throws instead of falling back to "", so an
 *   API error can never read as "this ticket has no criteria": story 5.
 * - a required `TrustPolicy`, and the assembly split out of the fetch as the pure
 *   `pullRequestContext`: everything a stranger can write is dropped before it
 *   reaches an agent, the count goes in its place, and the split is what lets a
 *   unit test prove it over fixtures with no network (story 27, ADR 0002
 *   amendment).
 * - an optional `diff`, so the audit can pass the merged commit's: story 18.
 * - the ticket's author read beside the ticket, and its body and title put
 *   through the policy on the `ticket-author` channel: that body is the
 *   reviewer's acceptance criteria and the audit's, the dispatcher's own author
 *   check is on neither path, and gh's `--json` view has no `authorAssociation`
 *   to filter on, so the association comes from a second REST read (#179).
 * - the five reads behind a needs record, `PrContextNeeds`, handed in from
 *   outside instead of made here: `lib/pr-context-repo.ts` in production, an
 *   in-memory PR-context repo in `review-context.test.ts`. The `gh`, GraphQL
 *   and git calls that were in this file went with it, so the fetch's own
 *   assembly of the five answers is what a test can drive (#312).
 * - the ticket read asks for `labels` as well, and `issueLabels` carries them on
 *   the context: #10's rule is that a `model:` label on the ticket moves the
 *   implementer, and implement-pr read that list off the PR (#119). The subject
 *   swapped on the read that was already there rather than a second one.
 */
import { parseDiffLines } from "./diff-lines";
import { linkedIssueNumber } from "../../lib/linked-issue";
import { renderIssue, type IssueView } from "../../lib/ticket-context";
import type { Author, TrustPolicy } from "../../lib/trusted-authors";

export interface ReviewThreadComment {
  readonly commentId: string;
  readonly threadId: string;
  readonly path: string | null;
  readonly line: number | null;
  readonly author: string;
  readonly body: string;
}

/** A top-level comment on the PR, as `gh pr view --json comments` returns it. */
export interface PullRequestComment {
  readonly author?: { readonly login: string } | null;
  /** GitHub's `author_association` for the commenter. Absent reads as an outsider. */
  readonly authorAssociation?: string | null;
  readonly body: string;
  readonly createdAt?: string;
}

/** A submitted review, as `GET /pulls/{n}/reviews` returns it: REST, so snake_case. */
export interface PullRequestReview {
  readonly user?: { readonly login: string } | null;
  readonly author_association?: string | null;
  readonly body?: string | null;
  readonly state: string;
  readonly submitted_at?: string | null;
}

/** A review thread, as the GraphQL query below returns it. */
export interface PullRequestReviewThread {
  readonly id: string;
  readonly isResolved: boolean;
  readonly comments: {
    readonly nodes: readonly {
      readonly id: string;
      readonly path: string | null;
      readonly line: number | null;
      readonly originalLine: number | null;
      readonly body: string;
      readonly author?: { readonly login: string } | null;
      readonly authorAssociation?: string | null;
    }[];
  };
}

/**
 * How much of each channel the trust policy dropped. Comments are counted per
 * channel; the ticket's body is one thing or nothing, so `issueBody` is 1 or 0
 * and it counts the title with it, which goes the same way (#179).
 */
export interface DroppedCounts {
  readonly prComments: number;
  readonly reviewSummaries: number;
  readonly reviewThreadComments: number;
  readonly issueComments: number;
  readonly issueBody: number;
}

export interface PullRequestContext {
  readonly prTitle: string;
  readonly prBody: string;
  readonly issueNumber: string;
  /**
   * The linked issue's title, or a placeholder saying it was not included when
   * an untrusted author opened the ticket. Empty only when the PR links none.
   */
  readonly issueTitle: string;
  /**
   * The linked issue's body alone, for parsing its acceptance criteria. Empty
   * when an untrusted author opened the ticket, so a refused ticket reaches the
   * same mechanical fail as one with no criteria; `dropped.issueBody` and
   * `noCriteriaReason` tell the two apart (#179).
   */
  readonly issueBody: string;
  /**
   * The linked ticket's label names, empty when the PR links none. The
   * implementer model is resolved from these, so a `model:` label on the PR
   * alone moves nothing (#10, #119).
   */
  readonly issueLabels: readonly string[];
  readonly linkedIssue: string;
  readonly diff: string;
  readonly prCommentsJson: string;
  readonly diffLines: Map<string, Set<number>>;
  readonly validReplyIds: Set<string>;
  /** What the trust policy kept out of all of the above (story 27). */
  readonly dropped: DroppedCounts;
}

/**
 * The linked ticket as the reads see it: the ticket, and who opened it.
 *
 * The author is its own field because it comes from its own read. gh's
 * `issue view --json` offers `author` but no `authorAssociation`, and the
 * association is what the policy judges, so the ticket read alone could not
 * filter the body even in principle (#179). Required rather than optional, for
 * the reason the `Author` fields themselves are: a read that could omit it
 * would hand the policy less than it has and pass a stranger's body in silence.
 */
export interface LinkedIssueRead {
  /** The ticket, as `gh issue view --json` returns it. */
  readonly view: IssueView;
  /** Whoever opened it, judged on the `ticket-author` channel. */
  readonly author: Author;
}

/** The pull request itself, as `gh pr view --json title,body,comments` returns it. */
export interface PullRequestRead {
  readonly title: string;
  readonly body?: string | null;
  readonly comments: readonly PullRequestComment[];
}

/** The five reads `fetchPullRequestContext` makes, before any judgement. */
export interface PullRequestReads {
  readonly pr: PullRequestRead;
  /** The linked ticket, or undefined when the PR body links none. */
  readonly issue: LinkedIssueRead | undefined;
  readonly reviews: readonly PullRequestReview[];
  readonly threads: readonly PullRequestReviewThread[];
  readonly diff: string;
}

/**
 * Everything `fetchPullRequestContext` needs from the target repo (#312): the
 * five reads above as named domain reads, never a raw `gh` call, handed in from
 * outside. `lib/pr-context-repo.ts` is the production record and an in-memory
 * one drives the fetch in a test, the way the sweep's `Needs` is wired
 * (docs/factory/layout.md, "How a script is wired").
 *
 * Its own record, not the retry handler's: these reads answer what one PR and
 * its ticket say, where the retry handler's answer what state a run left behind.
 *
 * Every read throws on an API error, as `lib/gh.ts` does. Which of those a
 * caller may shrug off would be the caller's own policy; the fetch shrugs off
 * none, because a body that failed to read must never arrive as "no criteria".
 */
export interface PrContextNeeds {
  /** The PR under review: its title, its body, and its top-level comments. */
  readonly pr: (prNumber: string) => PullRequestRead;
  /** The ticket the PR body links, and whoever opened it. Asked only when there is one. */
  readonly linkedIssue: (issueNumber: string) => LinkedIssueRead;
  /** The PR's submitted reviews, whose summaries are a channel of their own. */
  readonly reviews: (prNumber: string) => readonly PullRequestReview[];
  /** The PR's review threads, the inline half of the same conversation. */
  readonly reviewThreads: (prNumber: string) => readonly PullRequestReviewThread[];
  /** The branch's diff to the base, for a caller that does not bring its own. */
  readonly diff: () => string;
}

/**
 * One line per run naming what the policy took out, so a cut thread is visible
 * in the job log (#52). The body gets its own sentence rather than a fifth
 * count: it is not a comment, and a run that loses it loses its criteria, which
 * is the thing a reader of the log is trying to explain (#179).
 */
export const describeDropped = (dropped: DroppedCounts): string => {
  const total =
    dropped.prComments +
    dropped.reviewSummaries +
    dropped.reviewThreadComments +
    dropped.issueComments;
  const comments =
    total === 0
      ? "Untrusted comments dropped: none."
      : `Untrusted comments dropped: ${total} (PR comments ${dropped.prComments}, review summaries ${dropped.reviewSummaries}, review threads ${dropped.reviewThreadComments}, ticket comments ${dropped.issueComments}).`;
  return dropped.issueBody === 0
    ? comments
    : `${comments} The linked ticket's own body and title were dropped: an untrusted author opened it, so this run reads no acceptance criteria from it.`;
};

/**
 * Why a run has no acceptance criteria, in the words the verdict shows a human.
 *
 * Three different things reach the same mechanical fail, and the PR has to say
 * which: no ticket at all, a ticket the factory refused to read, or a ticket
 * with no checklist. The refused case used to read as the last one, which is
 * false and sends the maintainer looking for a heading that is already there
 * (#179). The job log says the same thing through `describeDropped`; this is
 * the half that reaches the PR.
 */
export const noCriteriaReason = (context: PullRequestContext): string => {
  if (!context.issueNumber) return "The PR body links no ticket (no `Closes #N`).";
  if (context.dropped.issueBody > 0) {
    return `#${context.issueNumber} was opened by an untrusted author, so the factory did not read its body or any criteria in it.`;
  }
  return `#${context.issueNumber} has no checklist under an "Acceptance criteria" heading.`;
};

/** What stands where an untrusted ticket's title was, so the ticket still reads as a ticket. */
const UNTRUSTED_TICKET_TITLE = "(title not included: untrusted author)";

/** What a dropped ticket body and title are called, wherever they are counted. */
const TICKET_BODY = "ticket body and title";

/**
 * What stands where an untrusted ticket's body was: the policy's own sentence
 * about what it dropped and whose words it acts on, which is what stands in for
 * a dropped comment, plus what that means here. Composed rather than written
 * out, so the wording lives in the policy and not in this file (#80, #179).
 */
const untrustedTicketNote = (policy: TrustPolicy): string =>
  `${policy.droppedNote(1, TICKET_BODY)} So there are no acceptance criteria to judge on this PR.`;

/**
 * The context an agent gets, from the reads, under one trust policy. Pure, so
 * the filter is provable over fixtures with no network.
 *
 * The policy is a required argument, not an option with a default: the
 * reviewer, implement-pr and the audit all come through here, and a call site
 * that could omit it would read a stranger's words in silence (story 27).
 */
export const pullRequestContext = (
  reads: PullRequestReads,
  policy: TrustPolicy,
): PullRequestContext => {
  const issueNumber = linkedIssueNumber(reads.pr.body);
  // The ticket's body is the reviewer's ACCEPTANCE_CRITERIA and the audit's, so
  // it goes through the policy like every other channel here (#179). One
  // decision, taken once: what the agent reads, what the criteria are parsed
  // from, and what is counted as dropped cannot disagree about the same ticket.
  // The title goes with the body, a title being the same untrusted channel as a
  // body, which is how an untrusted parent spec is already handled (#52).
  const ticket =
    !reads.issue || policy.trusts("ticket-author", reads.issue.author)
      ? { view: reads.issue?.view, criteria: reads.issue?.view.body ?? "", dropped: 0 }
      : {
          view: {
            ...reads.issue.view,
            title: UNTRUSTED_TICKET_TITLE,
            body: untrustedTicketNote(policy),
          },
          // Empty, not the note above: an untrusted ticket must reach the same
          // outcome as a ticket with no acceptance criteria, which review.ts
          // and audit.ts already turn into a mechanical fail.
          criteria: "",
          dropped: 1,
        };
  // One application of the policy to the ticket, not two: the rendered text and
  // the count come back together, so they cannot drift apart.
  const issue = ticket.view
    ? renderIssue(ticket.view, policy)
    : { text: "(no linked issue found)", droppedComments: 0 };

  // Each read names its channel and reports what it has. Whether the factory's
  // own login counts for anything here is the policy's answer, not this file's
  // (#80): both of #52's shipped bugs were this file getting it wrong.
  const prComments = policy.keep("pr-comment", reads.pr.comments, (comment) => ({
    association: comment.authorAssociation,
    login: comment.author?.login,
  }));
  const reviewSummaries = policy.keep(
    "review-summary",
    reads.reviews.filter((review) => review.body && review.body.trim().length > 0),
    (review) => ({
      association: review.author_association,
      login: review.user?.login,
    }),
  );
  const threadComments = policy.keep(
    "review-thread",
    reads.threads
      .filter((thread) => !thread.isResolved)
      .flatMap((thread) =>
        thread.comments.nodes.map((comment) => ({ thread, comment })),
      ),
    ({ comment }) => ({
      association: comment.authorAssociation,
      login: comment.author?.login,
    }),
  );

  const reviewThreads: ReviewThreadComment[] = threadComments.kept.map(
    ({ thread, comment }) => ({
      commentId: comment.id,
      threadId: thread.id,
      path: comment.path,
      line: comment.line ?? comment.originalLine,
      author: comment.author?.login ?? "unknown",
      body: comment.body,
    }),
  );

  const dropped: DroppedCounts = {
    prComments: prComments.dropped,
    reviewSummaries: reviewSummaries.dropped,
    reviewThreadComments: threadComments.dropped,
    issueComments: issue.droppedComments,
    issueBody: ticket.dropped,
  };
  const droppedInAll =
    dropped.prComments +
    dropped.reviewSummaries +
    dropped.reviewThreadComments +
    dropped.issueComments +
    dropped.issueBody;

  const payload = {
    issue_comments: prComments.kept.map((comment) => ({
      author: comment.author?.login ?? "unknown",
      body: comment.body,
      createdAt: comment.createdAt,
    })),
    review_summaries: reviewSummaries.kept.map((review) => ({
      author: review.user?.login ?? "unknown",
      state: review.state,
      body: review.body,
      submittedAt: review.submitted_at,
    })),
    review_threads: reviewThreads,
    // The count stands in for what was taken out, so the agent reads a cut
    // thread as cut rather than as the whole of it (story 27).
    ...(droppedInAll > 0
      ? {
          dropped_untrusted: {
            // Keyed as the lists above are, so a count cannot be read as
            // belonging to a different list. `review_threads` is a list of
            // comments, so its count says comments.
            issue_comments: dropped.prComments,
            review_summaries: dropped.reviewSummaries,
            review_thread_comments: dropped.reviewThreadComments,
            // The ticket's own count, also written into LINKED ISSUE above.
            linked_issue_comments: dropped.issueComments,
            // The body is not a comment, so it is counted only when it went.
            ...(dropped.issueBody > 0 ? { linked_issue_body: dropped.issueBody } : {}),
            note: policy.droppedNote(
              droppedInAll,
              dropped.issueBody > 0
                ? "item(s) on this PR and its ticket, the ticket's own body and title among them,"
                : "comment(s) on this PR and its ticket",
            ),
          },
        }
      : {}),
  };

  return {
    prTitle: reads.pr.title,
    prBody: reads.pr.body ?? "",
    issueNumber,
    // The placeholder rather than "": implement-pr renders an empty title as
    // "(no linked issue)", and there is a linked ticket, it is just not one the
    // factory reads (#179).
    issueTitle: ticket.view?.title ?? "",
    issueBody: ticket.criteria,
    // The labels stay whoever opened the ticket: writing one takes triage on
    // the repo, so they are not the author's channel, and the implementer's
    // model is resolved from them (#10, #119).
    issueLabels: (ticket.view?.labels ?? []).map((label) => label.name),
    linkedIssue: issue.text,
    diff: reads.diff,
    prCommentsJson: JSON.stringify(payload, null, 2),
    diffLines: parseDiffLines(reads.diff),
    validReplyIds: new Set(reviewThreads.map((comment) => comment.commentId)),
    dropped,
  };
};

/**
 * The context an agent gets for one PR: the five reads made through the record
 * it was handed, then the pure assembly above under the same trust policy.
 *
 * The record is a required argument and comes first, the way every other needs
 * record in the factory is passed (`sweep`, `waitForChecks`): a fetch that
 * could fall back to a `gh` call of its own is one no test crosses.
 */
export const fetchPullRequestContext = (
  needs: PrContextNeeds,
  prNumber: string,
  policy: TrustPolicy,
  options: {
    /** The diff to judge; defaults to the record's. The audit passes the merged commit's. */
    readonly diff?: string;
  } = {},
): PullRequestContext => {
  const pr = needs.pr(prNumber);
  const issueNumber = linkedIssueNumber(pr.body);

  return pullRequestContext(
    {
      pr,
      // No linked ticket is no read: a PR that closes none has no ticket to ask for.
      issue: issueNumber ? needs.linkedIssue(issueNumber) : undefined,
      reviews: needs.reviews(prNumber),
      threads: needs.reviewThreads(prNumber),
      diff: options.diff ?? needs.diff(),
    },
    policy,
  );
};
