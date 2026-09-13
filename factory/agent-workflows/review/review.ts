/**
 * Vendored from sandcastle 0.12.0, `.sandcastle/agent-workflows/review/review.ts`.
 * His REST review payload, his inline-comment and reply filtering, his
 * extraction run. Every line that differs is forced, and each is named here
 * (#47 keeps this list true):
 *
 * - read-only: he lets the reviewer commit and push, ours must not. `assertReadOnly`,
 *   no push step: story 5, ADR 0003 ("a reviewer that pushes commits is a second
 *   implementer nobody reviews").
 * - verdict instead of his `improved`/`clean`: acceptance criteria parsed from the
 *   ticket, one judgement per criterion, a `factory/verdict` status and a PR body
 *   section. A ticket with no criteria fails mechanically: stories 5, 6.
 * - the target's test output in the prompt: story 5.
 * - account rotation: stories 15, 16, 17, ADR 0004. Model as an input: story 20.
 * - trusted authors over the PR comments, the review threads and the linked
 *   issue with its comments: story 27, ADR 0008.
 * - `prompt.md` keeps his sections (TASK, LINKED ISSUE, DIFF TO MAIN, PR COMMENTS,
 *   REVIEW PROCESS, then the trailing rules) and gains two: ACCEPTANCE CRITERIA,
 *   one judgement per criterion (stories 5, 6), and TEST OUTPUT, the target's own
 *   test run (story 5). The paragraphs are the factory's (story 5, ADR 0003), and
 *   went through `writing-for-agents` (story 14 of #46): the trailing rules now
 *   say where the output goes before what not to do. Story 14 of #75 then cut
 *   TASK's description of how the read-only rule is checked, which is
 *   `assertReadOnly` below, and brought his four trailing prohibitions back.
 * - `extraction.md` gains `verdict` and `criteria`, and its `summary` field asks
 *   what the PR does and why the verdict is what it is, where his asked what the
 *   reviewer changed: he has no verdict (story 5).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { runWithRotation } from "../../lib/accounts";
import { required } from "../../lib/env";
import { gh } from "../../lib/gh";
import { fail, writeJson, writeText } from "../../lib/run-output";
import { resolveRoleModel } from "../../lib/model";
import { assertReadOnly, worktreeState } from "../../lib/read-only";
import {
  describeDropped,
  fetchPullRequestContext,
  noCriteriaReason,
} from "../shared/review-context";
import { trustPolicyFromEnv } from "../../lib/trusted-authors";
import {
  filterInlineComments,
  filterReplies,
  reviewOutputSchema,
  type InlineComment,
  type ThreadReply,
} from "../shared/review-output";
import { runWithExtraction } from "../shared/run-with-extraction";
import {
  boundOutput,
  parseAcceptanceCriteria,
  renderVerdictSection,
  resolveVerdict,
  upsertVerdictSection,
  verdictDescription,
  type Verdict,
} from "../../lib/verdict";

const PR_NUMBER = required("PR_NUMBER");
const BRANCH = required("BRANCH");
const BRANCH_HEAD_SHA = required("BRANCH_HEAD_SHA");
const REVIEWER_MODEL = required("REVIEWER_MODEL");
const RUN_URL = required("RUN_URL");
/** Captured by the workflow before this script runs; absent means no tests ran. */
const TEST_OUTPUT_FILE = process.env.TEST_OUTPUT_FILE;

const TEST_OUTPUT_LIMITS = { head: 4_000, tail: 12_000 };

interface ReviewFiles {
  readonly verdict: Verdict;
  readonly issueNumber: string;
  readonly summary: string;
  readonly inlineComments: readonly InlineComment[];
  readonly replies: readonly ThreadReply[];
}

/**
 * Everything the workflow posts. The verdict files come last: the workflow
 * treats a missing verdict.txt as a failed run, so nothing written before a
 * late failure can leave a green status behind.
 */
const writeReview = (review: ReviewFiles): void => {
  const { verdict } = review;
  writeJson("review_payload.json", {
    commit_id: BRANCH_HEAD_SHA,
    event: "COMMENT",
    body: `Verdict: ${verdict.verdict} (${verdictDescription(verdict)}).\n\n${review.summary}`,
    comments: review.inlineComments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: "RIGHT",
      body: comment.body,
    })),
  });
  writeJson("replies.json", review.replies);
  writeText("summary.md", review.summary);

  const section = renderVerdictSection(verdict, {
    headSha: BRANCH_HEAD_SHA,
    issueNumber: review.issueNumber || "(none)",
    runUrl: RUN_URL,
  });
  // Re-read the body now, not at the start: a human may have edited it meanwhile.
  const prBody = gh(["pr", "view", PR_NUMBER, "--json", "body", "--jq", ".body"]);
  writeText("pr_body.md", upsertVerdictSection(prBody, section));
  writeText("verdict-description.txt", verdictDescription(verdict));
  writeText("verdict.txt", verdict.verdict === "pass" ? "success" : "failure");
  console.log(`Verdict: ${verdict.verdict} (${verdictDescription(verdict)}).`);
};

try {
  // Whose words this run reads (story 27, ADR 0008): built once here
  // and passed down, so nothing between here and the prompt can widen it.
  const policy = trustPolicyFromEnv();
  console.log(`Trusted authors: ${policy.associations.join(", ")}.`);
  const context = fetchPullRequestContext(PR_NUMBER, policy);
  console.log(describeDropped(context.dropped));
  const criteria = parseAcceptanceCriteria(context.issueBody);
  const { model } = resolveRoleModel("reviewer", REVIEWER_MODEL);
  console.log(`Reviewer model: ${model}.`);
  console.log(
    `Ticket #${context.issueNumber || "(none)"}: ${criteria.length} acceptance criteria.`,
  );

  if (criteria.length === 0) {
    // Nothing to tick, so no reviewer run: the verdict is a mechanical fail.
    const reason = noCriteriaReason(context);
    console.log(reason);
    writeReview({
      verdict: resolveVerdict([], { verdict: "fail", criteria: [] }),
      issueNumber: context.issueNumber,
      summary: `${reason} The reviewer ticks acceptance criteria; without them there is nothing to judge.`,
      inlineComments: [],
      replies: [],
    });
  } else {
    const testOutput =
      TEST_OUTPUT_FILE && fs.existsSync(TEST_OUTPUT_FILE)
        ? boundOutput(fs.readFileSync(TEST_OUTPUT_FILE, "utf8"), TEST_OUTPUT_LIMITS)
        : "(no test output was captured)";
    const baseline = worktreeState();

    const result = await runWithRotation(`review-${PR_NUMBER}`, model, (agent, log) =>
      runWithExtraction({
        name: `review-pr-${PR_NUMBER}`,
        agent,
        sandbox: noSandbox(),
        logging: log.logging,
        promptFile: path.join(import.meta.dirname, "prompt.md"),
        promptArgs: {
          PR_NUMBER,
          BRANCH,
          PR_TITLE: context.prTitle,
          ISSUE_NUMBER: context.issueNumber,
          ISSUE_TITLE: context.issueTitle,
          ACCEPTANCE_CRITERIA: criteria
            .map((text, i) => `${i + 1}. ${text}`)
            .join("\n"),
          LINKED_ISSUE: context.linkedIssue,
          DIFF_TO_MAIN: context.diff,
          TEST_OUTPUT: testOutput,
          PR_COMMENTS_JSON: context.prCommentsJson,
        },
        output: sandcastle.Output.object({
          tag: "output",
          schema: reviewOutputSchema,
        }),
        extractionPrompt: fs.readFileSync(
          path.join(import.meta.dirname, "extraction.md"),
          "utf8",
        ),
      }),
      { role: "reviewer" },
    );

    assertReadOnly("Reviewer", BRANCH_HEAD_SHA, result.commits.length, baseline);

    const inlineComments = filterInlineComments(
      result.output.inlineComments,
      context.diffLines,
    );
    const replies = filterReplies(result.output.replies, context.validReplyIds);
    writeReview({
      verdict: resolveVerdict(criteria, result.output),
      issueNumber: context.issueNumber,
      summary: result.output.summary,
      inlineComments,
      replies,
    });
    console.log(
      `Review complete. Inline comments: ${inlineComments.length}. Replies: ${replies.length}.`,
    );
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
