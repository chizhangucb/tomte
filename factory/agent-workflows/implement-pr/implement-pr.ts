/**
 * Vendored from sandcastle 0.12.0, `.sandcastle/agent-workflows/implement-pr/implement-pr.ts`.
 * His flow is intact: PR context, one run over the unresolved threads, replies
 * and comments out, refuse to finish with nothing to show. Every line that
 * differs is forced, and each is named here (#47 keeps this list true):
 *
 * - conflict hand-off: update-branch labels a conflicting PR `agent:implement`, so
 *   this run probes with `git merge-tree`, asks the agent to merge and resolve, and
 *   fails if the conflict survives, or the hand-off would loop (#19). A probe that
 *   neither exited 0 nor 1 fails the run too, naming the exit, rather than reading
 *   its own crash as resolved (#53). His own `update-branch` agent does this
 *   upstream; kept as built because the proof run exercised it (story 5 of #46).
 * - retry section in the prompt: stories 12, 13.
 * - factory plugins installed per attempt, so the conflict section's
 *   `mattpocock-skills:resolving-merge-conflicts` exists: story 12 of #46. The
 *   whole plugin goes in, so TASK fences the run to the skills the prompt names:
 *   the other 24 are in the list and some of them describe work this run is not
 *   doing (story 11 of #46).
 * - trusted authors over the PR comments, the review threads, the linked issue
 *   with its comments, and the retry marker: story 27, ADR 0008.
 * - account rotation: stories 15, 16, 17, ADR 0004. Model as an input: story 20.
 * - the implementer model resolved from the linked ticket's labels, which the PR
 *   context above already carries, and the log line naming which subject they
 *   came from: #10's rule is a label on the ticket, and reading the PR's own list
 *   let a follow-up run on the same work pick a model the ticket never asked for
 *   (#119). A PR that links no ticket runs on the configured default.
 * - `prompt.md` keeps his shape, his four outcomes for a thread and his
 *   prohibitions, plus: the CONFLICT and RETRY placeholders (#19); the
 *   no-credentials line (the agent gets no GitHub token, ADR 0002); his
 *   `npm run typecheck` line widened to the repo's own typecheck and full
 *   suite, since nothing here is specific to one repo (story 23); the same
 *   fence to the named skills that the implementer prompt carries, because the
 *   whole plugin is installed and the rest of it waits on a user that this run
 *   does not have (story 12 of #46); and an exhaustive completion criterion in
 *   his PROCESS opener (story 14 of #46), which still stands and is why the
 *   trailing "Done when every thread carries one of those four outcomes" went.
 *   Story 14 of #75 cut that restatement, the merge gate's own description, now that
 *   `factory/red-green` and `factory/test-integrity` are required checks and
 *   the retry marker feeds back the failing excerpt, and the sentence that
 *   sent the agent at the conflict first, which `conflictSection` in
 *   `factory/lib/conflicts.ts` says only when there is a conflict. His TASK
 *   opener, his fourth outcome and his four flat prohibitions came back with
 *   it, which is what puts this file at 26 of his 28 lines.
 *   `extraction.md` stays his to the line: it is a format contract, not prose,
 *   so neither writing pass touched it.
 * - the run goes through `lib/run-agent-workflow.ts` (#313): rotation, the
 *   config dir per account, `noSandbox()`, the prompt file, the plugin install
 *   per attempt and the failure-to-`fail` `try`/`catch` are the one shell's,
 *   not copied here. His extraction run is inside it.
 */
import { spawnSync } from "node:child_process";
import { required } from "../../lib/env";
import { fail, writeJson, writeText } from "../../lib/run-output";
import { resolveRoleModel } from "../../lib/model";
import { describeDropped, fetchPullRequestContext } from "../shared/review-context";
import { prContextRepo } from "../../lib/pr-context-repo";
import { trustPolicyFromEnv } from "../../lib/trusted-authors";
import {
  filterInlineComments,
  filterReplies,
  implementPrOutputSchema,
} from "../shared/review-output";
import { runAgentWorkflow } from "../../lib/run-agent-workflow";
import { retrySectionForRun } from "../../retry/context";
import { conflictSection, parseMergeTreeConflicts } from "../../lib/conflicts";

const PR_NUMBER = required("PR_NUMBER");
/** The target as `owner/repo`, the address the PR-context reads are made against. */
const GH_REPO = required("GH_REPO");
const BRANCH = required("BRANCH");
const IMPLEMENTER_MODEL = required("IMPLEMENTER_MODEL");
/** The base branch, present as a local branch (the workflow runs `git branch -f main origin/main`). */
const BASE_BRANCH = process.env.BASE_BRANCH || "main";

/**
 * Whether this branch conflicts with the base: update-branch hands such PRs to
 * this run. A probe that neither exited 0 nor 1 throws, so the run fails with
 * the exit in the reason rather than reporting a branch it never checked (#53).
 */
const detectConflicts = (): readonly string[] => {
  const probe = spawnSync("git", ["merge-tree", "--write-tree", BASE_BRANCH, "HEAD"], { encoding: "utf8" });
  // The spawn itself failing (no git on PATH) is not a probe result to read.
  if (probe.error) throw probe.error;
  return parseMergeTreeConflicts({
    status: probe.status,
    stdout: probe.stdout,
    stderr: probe.stderr,
    signal: probe.signal,
  });
};

await runAgentWorkflow(
  {
    name: `implement-pr-${PR_NUMBER}`,
    runName: `implement-pr-${PR_NUMBER}`,
    role: "implementer",
    dir: import.meta.dirname,
    plugins: true,
    extract: implementPrOutputSchema,
  },
  async (run) => {
    // Whose words this run reads (story 27, ADR 0008): built once here
    // and passed to the PR context and the retry marker alike, so both follow the
    // target's own policy rather than a default of their own.
    const policy = trustPolicyFromEnv();
    console.log(`Trusted authors: ${policy.associations.join(", ")}.`);
    const context = fetchPullRequestContext(prContextRepo(GH_REPO), PR_NUMBER, policy);
    console.log(describeDropped(context.dropped));

    // #10's rule is a label on the ticket, so the labels come off the linked
    // ticket the context above already read, never off this PR (#119). A PR that
    // links no ticket has nothing to override the configured default with.
    const { model, source } = resolveRoleModel("implementer", IMPLEMENTER_MODEL, context.issueLabels);
    const labelSubject = context.issueNumber ? `ticket #${context.issueNumber}` : "no linked ticket";
    console.log(`Implementer model: ${model} (from ${source}, labels from ${labelSubject}).`);
    // A retry (#16) carries the failing verdict or check log on the linked ticket.
    const retrySection = retrySectionForRun(context.issueNumber || undefined, policy);
    const conflicts = detectConflicts();
    console.log(
      conflicts.length === 0
        ? `No conflict with ${BASE_BRANCH}.`
        : `Conflicts with ${BASE_BRANCH} (${conflicts.join(", ")}): the prompt asks the agent to merge and resolve first.`,
    );

    const result = await run({
      model,
      promptArgs: {
        PR_NUMBER,
        BRANCH,
        PR_TITLE: context.prTitle,
        ISSUE_NUMBER: context.issueNumber || "(none)",
        ISSUE_TITLE: context.issueTitle || "(no linked issue)",
        LINKED_ISSUE: context.linkedIssue,
        DIFF_TO_MAIN: context.diff,
        PR_COMMENTS_JSON: context.prCommentsJson,
        RETRY_SECTION: retrySection,
        CONFLICT_SECTION: conflictSection(BASE_BRANCH, conflicts),
      },
    });

    const threadReplies = filterReplies(
      result.output.threadReplies,
      context.validReplyIds,
    );
    const newInlineComments = filterInlineComments(
      result.output.newInlineComments,
      context.diffLines,
    );
    const hasCommits = result.commits.length > 0;

    // A conflict the agent left in place must fail the run, or the hand-off would loop:
    // review passes the unchanged head, update-branch conflicts again, hands off again.
    if (conflicts.length > 0) {
      const remaining = detectConflicts();
      if (remaining.length > 0) {
        fail(`Branch still conflicts with ${BASE_BRANCH} after the run (${remaining.join(", ")}); the merge was not resolved.`);
      }
      console.log(`Conflict with ${BASE_BRANCH} resolved on the branch.`);
    }

    if (
      !hasCommits &&
      threadReplies.length === 0 &&
      newInlineComments.length === 0 &&
      result.output.topLevelComments.length === 0
    ) {
      fail("Agent finished but made no commits and emitted no comments.");
    }

    writeText("has_commits.txt", hasCommits ? "true" : "false");
    writeJson("implement_thread_replies.json", threadReplies);
    writeJson("implement_new_inline_comments.json", newInlineComments);
    writeJson(
      "implement_top_level_comments.json",
      result.output.topLevelComments,
    );

    console.log("Implement PR complete.");
    console.log(`Commits: ${result.commits.length}.`);
    console.log(`Thread replies: ${threadReplies.length}.`);
    console.log(`Inline comments: ${newInlineComments.length}.`);
    console.log(`Top-level comments: ${result.output.topLevelComments.length}.`);
  },
);
