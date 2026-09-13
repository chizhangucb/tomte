/**
 * Vendored from sandcastle 0.12.0, `.sandcastle/agent-workflows/implement/implement.ts`.
 * His shape stands: read the issue, `sandcastle.run()` the prompt file, fail
 * when the agent made no commits. Every line that differs is forced, and each
 * is named here (#47 keeps this list true):
 *
 * - account rotation, one config dir per account: stories 15, 16, 17, ADR 0004.
 * - model as a workflow input plus a `model:` label override: story 20.
 * - ticket document, parent spec and `ticket-N.md`: stories 22, 23.
 * - trusted authors over the ticket, its comments, the parent and the retry
 *   marker: ADR 0008.
 * - retry section in the prompt: stories 12, 13.
 * - factory plugins installed per attempt, so the prompt's skills exist: story 4.
 *   The whole plugin goes in, so TASK fences the run to the skills the prompt
 *   names: the other 23 are in the list and some of them describe work this run
 *   is not doing (story 11 of #46).
 * - the bundled-review step rendered for the agent provider in hand: story 12
 *   of #46.
 * - `idleTimeoutSeconds` raised over the library's 10 minute default, since the
 *   review skills run in sub-agents whose output never reaches this stream;
 *   with the turn cap gone it is the run's only in-process bound (#49).
 * - commits counted on `refs/heads/$BRANCH` against main, not on HEAD: a retry
 *   that inherits the last attempt's commits still has a branch to judge (#16).
 * - `prompt.md` keeps his sections (TASK, ISSUE, CONTEXT, EXECUTION, COMMIT) and
 *   gains two: NO PLACEHOLDERS, since the merge gate is the factory's (stories 7, 8, 9,
 *   #13), and REVIEW AND FIX, which names the review skills (story 4, story 12 of
 *   #46). The paragraphs inside every section are the factory's (stories 4, 7, 8,
 *   23); EXECUTION and REVIEW AND FIX invoke `mattpocock-skills:tdd` and
 *   `mattpocock-skills:code-review` by name rather than restating them (story 12
 *   of #46). Every paragraph then went through `writing-for-agents` (story 14
 *   of #46), which is where NO PLACEHOLDERS states its rules as targets to hit
 *   rather than as a list of things not to do. Story 14 of #75 then took the
 *   merge gate's and the reviewer's own descriptions out of NO PLACEHOLDERS, because
 *   `factory/red-green` and `factory/test-integrity` are required checks and
 *   the retry marker feeds the failure back. His four trailing prohibitions
 *   came back with it, with `issue` read as `ticket` because `CONTEXT.md`
 *   binds the factory's own prose. What only the prompt can carry
 *   stayed: the run's 60 minutes, because a `timeout-minutes` kill reports
 *   nothing to the agent (move it whenever `agent-implement.yml` moves); the
 *   branch a retry inherits, because `retrySectionForRun` renders nothing when
 *   the marker cannot be read; and the fence to the named skills, because the
 *   whole plugin is installed and the rest of it waits on a user that this run
 *   does not have (story 12 of #46).
 */
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { runWithRotation } from "../../lib/accounts";
import { required } from "../../lib/env";
import { gh } from "../../lib/gh";
import { fail, outputDir, writeText } from "../../lib/run-output";
import { sh } from "../../lib/sh";
import { resolveRoleModel } from "../../lib/model";
import { bundledReviewStep } from "../../lib/harness";
import { installPluginsForAttempt } from "../../lib/plugins";
import { fetchIssue, fetchParentIssue, ticketDocument } from "../../lib/ticket-context";
import { trustPolicyFromEnv } from "../../lib/trusted-authors";
import { retrySectionForRun } from "../../retry/context";

const ISSUE_NUMBER = required("ISSUE_NUMBER");
const ISSUE_TITLE = required("ISSUE_TITLE");
const BRANCH = required("BRANCH");
const IMPLEMENTER_MODEL = required("IMPLEMENTER_MODEL");

try {
  const repo =
    process.env.GH_REPO ??
    gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
  // Whose words this run acts on (ADR 0008). One list for the ticket,
  // its comments, its parent spec, and the retry marker.
  const policy = trustPolicyFromEnv();
  console.log(`Trusted authors: ${policy.associations.join(", ")}.`);
  // Throws on an API error: a missing body must never read as an empty ticket.
  const issue = fetchIssue(ISSUE_NUMBER, policy);
  const issueContext = issue.text;
  console.log(
    issue.droppedComments === 0
      ? "Untrusted comments dropped: none."
      : `Untrusted comments dropped: ${issue.droppedComments} on the ticket.`,
  );
  const parent = fetchParentIssue(repo, ISSUE_NUMBER);
  console.log(
    parent
      ? `Parent spec: #${parent.number} ${parent.title} (${parent.authorAssociation}).`
      : "Parent spec: none, the ticket stands alone.",
  );
  const ticketFile = `ticket-${ISSUE_NUMBER}.md`;
  writeText(
    ticketFile,
    ticketDocument({ number: ISSUE_NUMBER, issueContext, parent, policy }),
  );
  // A retry (#16) runs on the same branch with the previous failure in its prompt.
  const retrySection = retrySectionForRun(ISSUE_NUMBER, policy);

  const labels = JSON.parse(
    gh(["issue", "view", ISSUE_NUMBER, "--json", "labels", "--jq", "[.labels[].name]"]),
  ) as string[];
  const { model, source } = resolveRoleModel("implementer", IMPLEMENTER_MODEL, labels);
  console.log(`Implementer model: ${model} (from ${source}).`);

  const result = await runWithRotation(`implement-${ISSUE_NUMBER}`, model, (agent, log) => {
    // Each account runs in its own config dir, so the skills the prompt
    // invokes by name go into the dir of the account this attempt uses.
    installPluginsForAttempt(agent.env.CLAUDE_CONFIG_DIR);
    return sandcastle.run({
      name: `implement-#${ISSUE_NUMBER}`,
      agent,
      sandbox: noSandbox(),
      logging: log.logging,
      // The review skills run in sub-agents whose output never reaches this
      // stream, so the parent can be silent for a while: the library's 10
      // minute idle default would cut a long review short. With the turn cap
      // gone (#49) the two bounds left are this idle timeout and the 60
      // minute job timeout.
      idleTimeoutSeconds: 30 * 60,
      promptFile: path.join(import.meta.dirname, "prompt.md"),
      promptArgs: {
        ISSUE_NUMBER,
        ISSUE_TITLE,
        BRANCH,
        ISSUE_CONTEXT: issueContext,
        TICKET_FILE: path.join(outputDir(), ticketFile),
        RETRY_SECTION: retrySection,
        BUNDLED_REVIEW_STEP: bundledReviewStep(agent.name),
      },
    });
  }, { role: "implementer" });

  // Against main, not this run's start: a retry that inherits the previous
  // attempt's commits and rightly changes nothing still has a branch to judge.
  // On the branch by name, which is what the workflow pushes, not on HEAD.
  const commitsAhead = Number(sh(`git rev-list --count "main..refs/heads/${BRANCH}"`).trim());
  if (!Number.isFinite(commitsAhead) || commitsAhead === 0) {
    fail("Agent finished but no commits were made on the branch.");
  }

  console.log(`Implementation produced ${commitsAhead} commit(s) ahead of main.`);
  console.log(`Commits this run: ${result.commits.length}.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
