/**
 * The first-20 audit (#18, ADR 0003): re-review a merged factory PR against
 * its ticket with the model the `audit_model` input names, read-only, and
 * write the result for the workflow to post. Nothing here ranks models:
 * whether the audit is a stronger second opinion than the review it audits is
 * the maintainer's choice of `audit_model`, not something this file computes.
 * The workflow decided this merge is one of the first 20 (plan.ts) before
 * running this.
 *
 * The run itself goes through `lib/run-agent-workflow.ts` (#313), the one
 * shell the four agent workflows share: rotation, the config dir per account,
 * `noSandbox()`, the prompt file beside this script, and the `try`/`catch`
 * that turns anything thrown into a failure reason. The audit installs no
 * plugins, its prompt invoking no skill by name.
 *
 * `prompt.md` is the factory's, put through `writing-for-agents` (story 14 of
 * #46), and heads its ticket section `# TICKET` because it has no vendored
 * counterpart whose heading to keep. Story 14 of #75 cut what a mechanism
 * already carries: how the read-only check works, which is `assertReadOnly`
 * below, and the revert-and-wake-a-human line, which RULES already states
 * once. `extraction.md` keeps the shape of the two vendored ones so the three
 * read alike; it is a format contract, not prose.
 */
import * as fs from "node:fs";
import { required } from "../lib/env";
import { fail, writeJson, writeText } from "../lib/run-output";
import { sh } from "../lib/sh";
import { resolveRoleModel } from "../lib/model";
import { assertReadOnly, worktreeState } from "../lib/read-only";
import {
  describeDropped,
  fetchPullRequestContext,
  noCriteriaReason,
} from "../agent-workflows/shared/review-context";
import { prContextRepo } from "../lib/pr-context-repo";
import { trustPolicyFromEnv } from "../lib/trusted-authors";
import { runAgentWorkflow } from "../lib/run-agent-workflow";
import { formatUsageComment } from "../lib/usage";
import { readUsageRecords } from "../lib/usage-record";
import { boundOutput, parseAcceptanceCriteria, resolveVerdict } from "../lib/verdict";
import { auditOutputSchema } from "./output";
import {
  AUDIT_COMMENT_URL_PLACEHOLDER,
  isMiss,
  missReason,
  REVERT_PR_URL_PLACEHOLDER,
  renderAuditComment,
  renderNeedsHumanIssue,
  renderRevertPrBody,
  type AuditResult,
} from "./report";

const PR_NUMBER = required("PR_NUMBER");
const MERGE_SHA = required("MERGE_SHA");
const AUDIT_MODEL = required("AUDIT_MODEL");
const RUN_URL = required("RUN_URL");
const AUDIT_ORDINAL = Number(required("AUDIT_ORDINAL"));
const AUDIT_LIMIT = Number(required("AUDIT_LIMIT"));
const TEST_OUTPUT_FILE = process.env.TEST_OUTPUT_FILE;

const TEST_OUTPUT_LIMITS = { head: 4_000, tail: 12_000 };

/**
 * Everything the workflow posts. The comment carries the audit's own usage;
 * the miss files exist only on a miss, and the workflow keys on them.
 */
const writeAudit = (result: AuditResult, context: { issueNumber: string; prTitle: string; model: string }): void => {
  // No marker: the audit comment nests this table and carries a marker of its own.
  const usageSection = formatUsageComment("audit", readUsageRecords(), { runUrl: RUN_URL });
  writeJson("audit.json", result);
  writeText(
    "audit-comment.md",
    `${renderAuditComment(result, {
      prNumber: PR_NUMBER,
      issueNumber: context.issueNumber,
      mergeSha: MERGE_SHA,
      model: context.model,
      ordinal: AUDIT_ORDINAL,
      limit: AUDIT_LIMIT,
      runUrl: RUN_URL,
      usageSection,
    })}\n`,
  );
  if (isMiss(result)) {
    // Bodies get their links filled by the workflow, which knows the URLs.
    writeText("audit-miss.txt", missReason(result));
    writeText(
      "audit-revert-body.md",
      renderRevertPrBody(result, {
        prNumber: PR_NUMBER,
        prTitle: context.prTitle,
        mergeSha: MERGE_SHA,
        auditCommentUrl: AUDIT_COMMENT_URL_PLACEHOLDER,
        runUrl: RUN_URL,
      }),
    );
    const issue = renderNeedsHumanIssue(result, {
      prNumber: PR_NUMBER,
      prTitle: context.prTitle,
      mergeSha: MERGE_SHA,
      auditCommentUrl: AUDIT_COMMENT_URL_PLACEHOLDER,
      revertPrUrl: REVERT_PR_URL_PLACEHOLDER,
      runUrl: RUN_URL,
    });
    writeText("audit-issue-title.txt", issue.title);
    writeText("audit-issue-body.md", issue.body);
  }
  console.log(`Audit: ${isMiss(result) ? "miss" : "pass"} (${missReason(result)}).`);
};

await runAgentWorkflow(
  {
    name: `audit-${PR_NUMBER}`,
    runName: `audit-pr-${PR_NUMBER}`,
    role: "audit",
    dir: import.meta.dirname,
    plugins: false,
    extract: auditOutputSchema,
  },
  async (run) => {
    const { model } = resolveRoleModel("audit", AUDIT_MODEL);
    console.log(`Audit model: ${model} (from the audit_model input).`);
    const head = sh("git rev-parse HEAD").trim();
    if (head !== MERGE_SHA) fail(`Expected the checkout at the merge commit ${MERGE_SHA}, found ${head}.`);

    // The merged change is the commit's diff to its first parent: a squash has one.
    const diff = sh(`git diff ${MERGE_SHA}^ ${MERGE_SHA}`);
    // Whose words this run reads (story 27, ADR 0008), built once here.
    const policy = trustPolicyFromEnv();
    console.log(`Trusted authors: ${policy.associations.join(", ")}.`);
    const context = fetchPullRequestContext(prContextRepo(), PR_NUMBER, policy, { diff });
    console.log(describeDropped(context.dropped));
    const criteria = parseAcceptanceCriteria(context.issueBody);
    console.log(`Ticket #${context.issueNumber || "(none)"}: ${criteria.length} acceptance criteria.`);

    if (criteria.length === 0) {
      const reason = noCriteriaReason(context);
      writeAudit(
        {
          verdict: resolveVerdict([], { verdict: "fail", criteria: [] }),
          placeholders: [],
          summary: `${reason} A merge with nothing to judge it against is a miss.`,
        },
        { issueNumber: context.issueNumber, prTitle: context.prTitle, model },
      );
    } else {
      const testOutput =
        TEST_OUTPUT_FILE && fs.existsSync(TEST_OUTPUT_FILE)
          ? boundOutput(fs.readFileSync(TEST_OUTPUT_FILE, "utf8"), TEST_OUTPUT_LIMITS)
          : "(no test output was captured)";
      const baseline = worktreeState();

      const result = await run({
        model,
        promptArgs: {
          PR_NUMBER,
          MERGE_SHA,
          PR_TITLE: context.prTitle,
          ISSUE_NUMBER: context.issueNumber,
          ISSUE_TITLE: context.issueTitle,
          ACCEPTANCE_CRITERIA: criteria.map((text, i) => `${i + 1}. ${text}`).join("\n"),
          LINKED_ISSUE: context.linkedIssue,
          MERGED_DIFF: context.diff,
          TEST_OUTPUT: testOutput,
        },
      });

      assertReadOnly("Audit", MERGE_SHA, result.commits.length, baseline);

      writeAudit(
        {
          verdict: resolveVerdict(criteria, result.output),
          placeholders: result.output.placeholders,
          summary: result.output.summary,
        },
        { issueNumber: context.issueNumber, prTitle: context.prTitle, model },
      );
    }
  },
);
