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
 *
 * Every read names the repo it is made against, the way each factory in
 * `target-repo.ts` does: `--repo` on a `gh` subcommand, the address spelled out
 * in a REST path, and GraphQL's two variables split off it. The vendored fetch
 * left four of the five to gh's own ambient resolution (`{owner}/{repo}` and a
 * bare `pr view`, which follow `GH_REPO` or the checkout's remote) while
 * addressing the GraphQL read from `GH_REPO` itself, so a record built for one
 * target and a process pointed at another would have read two.
 *
 * Imported with bare specifiers and free to import a package: no strip-types
 * entrypoint reaches this module (`lib/strip-types-cone.test.ts` lists them),
 * the three workflows that build the record installing the engine first. A
 * cone that ever reaches it has to add the `.ts` extensions with it.
 */
import { gh } from "./gh";
import { safeSh, sh } from "./sh";
import type {
  LinkedIssueRead,
  PrContextNeeds,
  PullRequestReview,
  PullRequestReviewThread,
  PullRequestView,
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
const readLinkedIssue = (repoAddress: string, issueNumber: string): LinkedIssueRead => {
  const view = JSON.parse(
    gh(["issue", "view", issueNumber, "--repo", repoAddress, "--json", "number,title,body,comments,labels"]),
  ) as IssueView;
  const rest = JSON.parse(
    gh(["api", `repos/${repoAddress}/issues/${issueNumber}`]),
  ) as {
    author_association?: string | null;
    user?: { login?: string | null } | null;
  };
  return {
    view,
    author: { association: rest.author_association, login: rest.user?.login },
  };
};

/**
 * The PR's review threads, dug out of the one GraphQL answer; a PR with none
 * reads as none. The owner and the repo are GraphQL's required variables and
 * come from the `owner/repo` the record was built for, the way every factory in
 * `target-repo.ts` takes its repo rather than reading the env itself.
 */
const readReviewThreads = (
  repoAddress: string,
  prNumber: string,
): readonly PullRequestReviewThread[] => {
  const [owner, repo] = repoAddress.split("/");
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
 * The GitHub-backed PR-context reads for one `owner/repo`: what the reviewer,
 * implement-pr and the audit hand `fetchPullRequestContext`. Each of the three
 * reads the address out of its own env (`GH_REPO`) and passes it here, so the
 * record is built for a target rather than reading one out of the air.
 */
export const prContextRepo = (repoAddress: string): PrContextNeeds => ({
  pr: (prNumber) =>
    JSON.parse(
      gh(["pr", "view", prNumber, "--repo", repoAddress, "--json", "title,body,comments"]),
    ) as PullRequestView,

  linkedIssue: (issueNumber) => readLinkedIssue(repoAddress, issueNumber),

  reviews: (prNumber) =>
    JSON.parse(
      gh(["api", `repos/${repoAddress}/pulls/${prNumber}/reviews`]),
    ) as PullRequestReview[],

  reviewThreads: (prNumber) => readReviewThreads(repoAddress, prNumber),

  // The branch against the base, three dots first so a stale branch is judged on
  // its own change; two dots is the fallback when the merge base cannot be found.
  diff: () => safeSh("git diff main...HEAD") || sh("git diff main..HEAD"),
});
