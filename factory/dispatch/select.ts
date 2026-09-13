/**
 * Dispatcher selection: which open issues become factory tickets right now.
 *
 * Pure. Input is the tracker's open issues reduced to what the rules need;
 * output is the subset to label `agent:implement`. The human intent label is
 * `ready-for-agent`; `agent:*` and `needs-human` are factory state. A ticket
 * is dispatched when a human said it is ready, no label from `HOLD_LABELS`
 * holds it back, nothing open blocks it (GitHub native dependencies, open
 * blockers only), nobody is assigned to it, the factory is not already on it,
 * and its body carries an acceptance-criteria checklist (#257).
 *
 * Imports use explicit `.ts` so the dispatch job can run on bare `node
 * --experimental-strip-types` without installing the engine.
 */

import { FACTORY_STATE_LABELS, HOLD_LABELS, READY_LABEL } from "../lib/labels.ts";
import { issuesClosedBy } from "../lib/linked-issue.ts";
import { authorAssociation, type AuthorAssociation, type TrustPolicy } from "../lib/trusted-authors.ts";
import { parseAcceptanceCriteria } from "../lib/verdict.ts";

export type DispatchIssue = {
  number: number;
  /** The issue title. A title starting `Spec:` is a spec, not a ticket. */
  title: string;
  /** The ticket body, where its acceptance criteria live. */
  body: string | null;
  /** Absent in a listing of open issues; set from a single-issue re-read. */
  state?: "open" | "closed";
  labels: readonly string[];
  assigned: boolean;
  /** Open blockers from `issue_dependencies_summary.blocked_by`. */
  openBlockers: number;
  /** Sub-issue count; a parent with children is a spec, not a ticket. */
  subIssues?: number;
  /** An open PR already says it closes this issue. */
  hasOpenPr: boolean;
  /** GitHub's `author_association` for whoever opened the issue. */
  authorAssociation: AuthorAssociation;
};

/**
 * A ticket with no acceptance-criteria checklist is not dispatched: there is
 * nothing for the reviewer to tick, so an agent would be building to a target
 * nobody wrote down. Structural only, `verdict.ts`'s parser and the reviewer's:
 * the section is there or it is not, and no size is judged. The marker heads the
 * one comment that says so, as the reconciler's no-ticket mark heads its own
 * (#230): same shape, and a marker anywhere else in a body is not it.
 */
export const NO_CRITERIA_REASON = "no acceptance criteria";
export const NO_CRITERIA_MARKER = "<!-- factory:no-acceptance-criteria -->";

/** The comment the dispatcher posts once on a ticket it holds for its shape. */
export const noCriteriaComment = (): string =>
  `${NO_CRITERIA_MARKER}\nNot dispatched: this ticket has no checklist under an "Acceptance criteria" heading, so there is nothing for the reviewer to tick. Add one and the next sweep picks it up.`;

/**
 * Whether the ticket already carries that comment. The marker counts at the
 * head of a comment only, as the reconciler's does, so quoting it in a reply
 * does not silence the dispatcher. Any author counts, where the reconciler
 * weighs one: this comment suppresses nothing an agent would otherwise do,
 * it only stops the factory repeating itself on a ticket it is holding
 * either way, so a forged one costs a human a note and nothing else.
 */
export const alreadyToldNoCriteria = (
  comments: readonly { body: string | null }[],
): boolean => comments.some((c) => (c.body ?? "").startsWith(NO_CRITERIA_MARKER));

/** The reason an issue is not dispatched, or undefined when it is. */
export const whySkipped = (
  issue: DispatchIssue,
  policy: TrustPolicy,
): string | undefined => {
  const has = (label: string) => issue.labels.includes(label);
  if (issue.state === "closed") return "closed since the snapshot";
  if (!has(READY_LABEL)) return `no ${READY_LABEL}`;
  const held = HOLD_LABELS.find(has);
  if (held) return `held: ${held}`;
  const state = FACTORY_STATE_LABELS.find(has);
  if (state) return `already in the factory: ${state}`;
  // After the label checks: a skipped ticket gets no comment, so its one log
  // line should name the state a human can act on, not the author.
  // The issue listing carries no login the policy would use, and the
  // ticket-author channel is not one the factory writes, so there is none to
  // report here.
  if (
    !policy.trusts("ticket-author", {
      association: issue.authorAssociation,
      login: undefined,
    })
  ) {
    return `untrusted author: ${issue.authorAssociation}`;
  }
  if (issue.assigned) return "assigned";
  if (issue.openBlockers > 0) {
    return `${issue.openBlockers} open blocker${issue.openBlockers === 1 ? "" : "s"}`;
  }
  // A spec is not a ticket, sliced or not: once `/to-tickets` runs it has
  // sub-issues, but between `/to-spec` and that it has none and only its title
  // says so. Title or sub-issues, either one is a spec.
  if (issue.title.trim().toLowerCase().startsWith("spec:")) return "spec: title, not a ticket";
  if ((issue.subIssues ?? 0) > 0) return "has sub-issues, not a ticket";
  if (issue.hasOpenPr) return "an open PR already closes it";
  // Last, and structural only: every reason a human can act on is reported
  // first, and a ticket that reaches here is well-formed apart from its shape.
  if (parseAcceptanceCriteria(issue.body ?? "").length === 0) return NO_CRITERIA_REASON;
  return undefined;
};

export const selectForDispatch = (
  issues: readonly DispatchIssue[],
  policy: TrustPolicy,
): DispatchIssue[] =>
  issues.filter((issue) => whySkipped(issue, policy) === undefined);

/**
 * Issue numbers that open PRs claim to close, from their bodies. The keywords
 * are `lib/linked-issue.ts`'s, which is where the readers that have to agree
 * on a PR's ticket are named.
 */
export const issuesClosedByPrs = (
  prs: readonly { number: number; body: string | null }[],
): Set<number> => {
  const closed = new Set<number>();
  for (const pr of prs) {
    for (const number of issuesClosedBy(pr.body)) closed.add(number);
  }
  return closed;
};

/**
 * Reduce GitHub's REST issue objects (`GET /repos/{o}/{r}/issues`) to the
 * dispatch shape. The endpoint lists PRs too; they are dropped.
 */
export const fromGitHub = (
  raw: readonly unknown[],
  closedByOpenPr: ReadonlySet<number>,
): DispatchIssue[] => {
  const issues: DispatchIssue[] = [];
  for (const item of raw) {
    const r = item as Record<string, any>;
    if (r.pull_request) continue;
    issues.push({
      number: Number(r.number),
      title: typeof r.title === "string" ? r.title : "",
      ...(r.state === "open" || r.state === "closed" ? { state: r.state } : {}),
      body: typeof r.body === "string" ? r.body : null,
      labels: (r.labels ?? []).map((label: { name: string }) => label.name),
      assigned: (r.assignees ?? []).length > 0,
      openBlockers: Number(r.issue_dependencies_summary?.blocked_by ?? 0),
      subIssues: Number(r.sub_issues_summary?.total ?? 0),
      hasOpenPr: closedByOpenPr.has(Number(r.number)),
      // Absent, or a value GitHub does not send, reads as an outsider.
      authorAssociation: authorAssociation(r.author_association),
    });
  }
  return issues;
};

/**
 * The listing the snapshot came from is eventually consistent: a ticket
 * closed, re-blocked, or picked up seconds earlier can still be listed as
 * dispatchable (#19: two closed tickets were labeled and implemented). Given
 * the issue re-read on its own (`GET /repos/{o}/{r}/issues/{n}`), the reason
 * not to label it now, or undefined when it is still dispatchable.
 */
export const whyNotDispatchableNow = (
  raw: unknown,
  closedByOpenPr: ReadonlySet<number>,
  policy: TrustPolicy,
): string | undefined => {
  const [issue] = fromGitHub([raw], closedByOpenPr);
  return issue ? whySkipped(issue, policy) : "not an issue";
};
