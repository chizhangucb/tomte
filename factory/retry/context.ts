import { gh } from "../lib/gh";
import { errorMessage } from "../lib/errors";
import type { TrustPolicy } from "../lib/trusted-authors";
import { latestRetryContext, type RetryContext, retryPromptSection } from "./decide";

/**
 * What an implementer run needs to know about the previous attempt: the
 * newest retry marker comment on the ticket, or nothing on a first attempt.
 * Fetched with the job's token before the agent starts, like the ticket
 * itself. Echoed to the job log so a run's prompt input is visible there.
 *
 * Only a trusted author's comments are read. The factory posts its own marker
 * with FACTORY_PAT, so its comments qualify; without this filter anyone who
 * can comment on a public target's ticket could forge a marker and put their
 * own words in the implementer's prompt under "THE PREVIOUS ATTEMPT FAILED".
 * The policy is required, on the ticket path and the PR path alike, so no run
 * can read the marker under a wider policy than its target set (#52).
 */
export const fetchRetryContext = (
  issueNumber: string,
  policy: TrustPolicy,
): RetryContext | undefined => {
  let bodies: string[];
  let labels: string[];
  try {
    const issue = JSON.parse(
      gh(["issue", "view", issueNumber, "--json", "comments,labels"]),
    ) as {
      comments: {
        body: string;
        authorAssociation?: string | null;
        author?: { login: string } | null;
      }[];
      labels: { name: string }[];
    };
    // The marker is posted with FACTORY_PAT, so it arrives as the owner and
    // needs no exemption, and `latestRetryContext` takes the newest body that
    // parses: honouring the bot login here would let any workflow in the target
    // forge a "previous attempt failed" section. That is the policy's call, and
    // `retry-marker` is not one of the channels the factory writes.
    bodies = policy
      .keep("retry-marker", issue.comments, (comment) => ({
        association: comment.authorAssociation,
        login: comment.author?.login,
      }))
      .kept.map((comment) => comment.body);
    labels = issue.labels.map((l) => l.name);
  } catch (error) {
    console.log(
      `Could not read the comments of #${issueNumber}, so no retry context: ${errorMessage(error)}`,
    );
    return undefined;
  }
  return latestRetryContext(bodies, labels);
};

/** The prompt section for this run, logged in full so the run log shows what the agent was told. */
export const retrySectionForRun = (
  issueNumber: string | undefined,
  policy: TrustPolicy,
): string => {
  const context = issueNumber ? fetchRetryContext(issueNumber, policy) : undefined;
  if (!context) {
    console.log("No current retry context on the ticket: first attempt.");
    return "";
  }
  const section = retryPromptSection(context);
  console.log(
    `Retry context found on #${issueNumber}: retry ${context.retry}, previous failure ${context.kind}, ${context.output.length} chars of failure output. Prompt section follows.\n` +
      `----- retry section -----\n${section}\n----- end retry section -----`,
  );
  return section;
};
