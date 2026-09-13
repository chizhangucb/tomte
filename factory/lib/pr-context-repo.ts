/**
 * The PR-context reads against a target repo (#312): the production half of
 * `PrContextNeeds`, the record `fetchPullRequestContext` is handed. Modelled on
 * `target-repo.ts` and wired the way docs/factory/layout.md, "How a script is
 * wired", describes: the real `gh`, GraphQL and git calls live here, an
 * in-memory record answers them in `shared/review-context.test.ts`, and the
 * fetch itself makes no call of its own.
 *
 * Its own record rather than a member of `target-repo.ts`'s set, for two
 * reasons. It reads a different thing for a different purpose: one PR and the
 * ticket it links, as an agent is about to read them, where that module's
 * records carry the sweep's, the dispatcher's, update-branch's and the retry
 * handler's state. And it makes no key choice: an agent workflow runs with the
 * job's own `gh` token in the environment, so every read here goes through
 * `lib/gh.ts` as the vendored fetch did, where every function over there
 * resolves `FACTORY_PAT` or `READ_TOKEN` per call.
 *
 * The shapes are unchanged: each read returns exactly what the vendored fetch
 * assembled into `PullRequestReads`, and every failure is still the `GhError`
 * `lib/gh.ts` throws, so a body that could not be read reaches nobody as "this
 * ticket has no criteria".
 */
import { gh } from "./gh";
import { safeSh, sh } from "./sh";
import type {
  LinkedIssueRead,
  PrContextNeeds,
  PullRequestComment,
  PullRequestRead,
  PullRequestReview,
  PullRequestReviewThread,
} from "../agent-workflows/shared/review-context";
import type { IssueView } from "./ticket-context";

/**
 * The review threads with the fields the context renders. GraphQL rather than
 * REST because a thread's id and its resolved state are GraphQL's alone, and a
 * reply needs the thread it lands on.
 */
const REVIEW_THREADS_QUERY = `
query($owner:String!,$repo:String!,$number:Int!) {
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$number) {
      reviewThreads(first:100) {
        nodes {
          id
          isResolved
          isOutdated
          comments(first:50) {
            nodes {
              id
              path
              line
              originalLine
              body
              authorAssociation
              author { login }
            }
          }
        }
      }
    }
  }
}`;

/**
 * The linked ticket and whoever opened it, with the job's gh token.
 *
 * Two reads, because they carry different things and both are needed. gh's
 * `--json` view gives the title, the criteria, the comments with the
 * association the policy filters on, and the labels, which decide the
 * implementer's model (#119); it has no `authorAssociation` field for the
 * ticket itself, so it cannot say whose ticket this is. REST does, on
 * `author_association`, and that is the field the `ticket-author` channel is
 * judged on everywhere else (`dispatch/select.ts`).
 *
 * Both throw on an API error, since a missing body must never read as "no
 * criteria", and a missing author must never read as a trusted one.
 */
const readLinkedIssue = (issueNumber: string): LinkedIssueRead => {
  const view = JSON.parse(
    gh(["issue", "view", issueNumber, "--json", "number,title,body,comments,labels"]),
  ) as IssueView;
  const rest = JSON.parse(
    gh(["api", `repos/{owner}/{repo}/issues/${issueNumber}`]),
  ) as {
    author_association?: string | null;
    user?: { login?: string | null } | null;
  };
  return {
    view,
    author: { association: rest.author_association, login: rest.user?.login },
  };
};

/** The PR's review threads, dug out of the one GraphQL answer; a PR with none reads as none. */
const readReviewThreads = (prNumber: string): readonly PullRequestReviewThread[] => {
  const [owner, repo] = (process.env.GH_REPO ?? "").split("/");
  const parsed = JSON.parse(
    gh([
      "api",
      "graphql",
      "-F",
      `owner=${owner}`,
      "-F",
      `repo=${repo}`,
      "-F",
      `number=${prNumber}`,
      "-f",
      `query=${REVIEW_THREADS_QUERY}`,
    ]),
  ) as {
    data?: {
      repository?: {
        pullRequest?: {
          reviewThreads?: { nodes?: PullRequestReviewThread[] };
        };
      };
    };
  };
  return parsed.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
};

/**
 * The GitHub-backed PR-context reads: what the reviewer, implement-pr and the
 * audit hand `fetchPullRequestContext`.
 */
export const prContextRepo = (): PrContextNeeds => ({
  pr: (prNumber) =>
    JSON.parse(
      gh(["pr", "view", prNumber, "--json", "title,body,comments"]),
    ) as PullRequestRead & { comments: PullRequestComment[] },

  linkedIssue: readLinkedIssue,

  reviews: (prNumber) =>
    JSON.parse(
      gh(["api", `repos/{owner}/{repo}/pulls/${prNumber}/reviews`]),
    ) as PullRequestReview[],

  reviewThreads: readReviewThreads,

  // The branch against the base, three dots first so a stale branch is judged on
  // its own change; two dots is the fallback when the merge base cannot be found.
  diff: () => safeSh("git diff main...HEAD") || sh("git diff main..HEAD"),
});
