import { gh } from "./gh";
import { authorAssociation, type AuthorAssociation, type TrustPolicy } from "./trusted-authors";

/**
 * What the implementer reads before touching code: the ticket and, when the
 * ticket is a sub-issue of a spec, that spec. The agent has no GitHub token,
 * so the script fetches both before the run and writes them to one file the
 * prompt points at; the review skill reads the same file as its spec source.
 */
export interface ParentIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  /** GitHub's `authorAssociation` for whoever wrote the spec. Absent reads as an outsider. */
  readonly authorAssociation: AuthorAssociation;
}

const PARENT_QUERY =
  "query($owner: String!, $repo: String!, $num: Int!) { repository(owner: $owner, name: $repo) { issue(number: $num) { parent { number title body authorAssociation } } } }";

/** The parent issue in a GraphQL response for PARENT_QUERY, if any. */
export const parentIssueFromGraphql = (json: string): ParentIssue | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  const parent = (
    parsed as { data?: { repository?: { issue?: { parent?: unknown } } } }
  )?.data?.repository?.issue?.parent;
  if (typeof parent !== "object" || parent === null) return undefined;
  const { number, title, body, authorAssociation: association } = parent as Record<
    string,
    unknown
  >;
  if (typeof number !== "number" || typeof title !== "string") return undefined;
  return {
    number,
    title,
    body: typeof body === "string" ? body : "",
    authorAssociation: authorAssociation(
      typeof association === "string" ? association : undefined,
    ),
  };
};

/** Fetch the parent issue of `owner/repo#issueNumber` with the job's gh token. */
export const fetchParentIssue = (
  repo: string,
  issueNumber: string,
): ParentIssue | undefined => {
  const [owner, name] = repo.split("/");
  if (!owner || !name) return undefined;
  try {
    const json = gh([
      "api",
      "graphql",
      "-f",
      `query=${PARENT_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `repo=${name}`,
      "-F",
      `num=${issueNumber}`,
    ]);
    return parentIssueFromGraphql(json);
  } catch {
    return undefined;
  }
};

export interface IssueComment {
  readonly author?: { readonly login: string } | null;
  /** GitHub's `author_association` for the commenter. Absent reads as an outsider. */
  readonly authorAssociation?: string | null;
  readonly body: string;
}

export interface IssueView {
  readonly number: number;
  readonly title: string;
  readonly body?: string | null;
  readonly comments?: readonly IssueComment[];
  /**
   * The ticket's labels, as `gh issue view --json labels` returns them. Absent
   * on a read that did not ask for them; a run that resolves the implementer
   * model from the ticket asks (#119).
   */
  readonly labels?: readonly { readonly name: string }[];
}

/**
 * The ticket as text. Rendered from `--json` rather than gh's own text view:
 * gh 2.95 prints only the comments under `--comments`, so a ticket with no
 * comments would arrive empty.
 *
 * Comments from untrusted authors are dropped, not hidden: on a public target
 * anyone can comment on the owner's ticket, and this text is what the
 * implementer follows. The count of what was dropped stays in, so the agent
 * knows the thread is not the whole thread. The ticket body itself is judged
 * before it gets here: the dispatcher on the implement path, and
 * `pullRequestContext` on the `ticket-author` channel for the reviewer,
 * implement-pr and the audit, which reach a ticket the dispatcher never vetted
 * (#179). So this function renders the body it is handed, whatever that is.
 */
/** The ticket as the agent reads it, with the count of what the policy took out. */
export interface RenderedIssue {
  readonly text: string;
  readonly droppedComments: number;
}

export const renderIssue = (issue: IssueView, policy: TrustPolicy): RenderedIssue => {
  const parts = [`Issue #${issue.number}: ${issue.title}`, (issue.body ?? "").trim()];
  const { kept, dropped } = policy.keep("ticket-comment", issue.comments ?? [], (comment) => ({
    association: comment.authorAssociation,
    login: comment.author?.login,
  }));
  if (kept.length > 0) {
    parts.push("## Comments");
    for (const comment of kept) {
      parts.push(`### ${comment.author?.login ?? "unknown"}\n\n${comment.body.trim()}`);
    }
  }
  if (dropped > 0) {
    parts.push(
      `## Dropped comments\n\n${policy.droppedNote(dropped, "comment(s) on the ticket")}`,
    );
  }
  return { text: parts.join("\n\n"), droppedComments: dropped };
};

/**
 * Fetch and render the ticket with the job's gh token. Throws on an API error.
 * Returns the count as well as the text: the implement run reports what its
 * policy took out, like the three PR runs do.
 */
export const fetchIssue = (issueNumber: string, policy: TrustPolicy): RenderedIssue =>
  renderIssue(
    JSON.parse(
      gh(["issue", "view", issueNumber, "--json", "number,title,body,comments"]),
    ) as IssueView,
    policy,
  );

/**
 * The ticket and its spec, as one file the prompt points at. A spec written by
 * an untrusted author is named by number alone, title as well as body: the
 * dispatcher vouches for the ticket's author, not the parent's, a sub-issue
 * link needs only write access on the child, and a title is the same
 * untrusted channel as a body (#52).
 */
export const ticketDocument = (input: {
  readonly number: number | string;
  readonly issueContext: string;
  readonly parent: ParentIssue | undefined;
  readonly policy: TrustPolicy;
}): string => {
  const { parent, policy } = input;
  const parentSection = !parent
    ? "# Parent spec\n\nThis ticket has no parent spec. The ticket above is the whole brief.\n"
    : // The parent read carries no login the policy would use, and parent-spec
      // is not a channel the factory writes, so there is none to report here.
      policy.trusts("parent-spec", { association: parent.authorAssociation, login: undefined })
      ? `# Parent spec #${parent.number}: ${parent.title}\n\n${parent.body.trim()}\n`
      : `# Parent spec #${parent.number}\n\nNot included, title as well as body: it was written by an untrusted author (${parent.authorAssociation}), and the factory acts only on ${policy.associations.join(", ")}. Work from the ticket above.\n`;
  return `# Ticket #${input.number}\n\n${input.issueContext.trim()}\n\n${parentSection}`;
};
