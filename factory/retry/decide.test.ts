import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

import { RATE_LIMITED_FILE } from "../lib/accounts";
import { whySkipped } from "../dispatch/select.ts";
import { BLOCKED_LABEL, IMPLEMENT_LABEL, IN_PROGRESS_LABEL } from "../lib/labels";
import { prDisposition } from "../lib/pr-disposition.ts";
import { trustPolicy } from "../lib/trusted-authors.ts";
import {
  CONFLICT_REASON,
  decide,
  FAILURE_KINDS,
  findHold,
  REQUEUED_FILE,
  authorConflictReason,
  renderTellAuthorComment,
  renderHandOffComment,
  isImplementerFailure,
  RATE_LIMITED_REASON,
  missingFailureReason,
  latestRetryContext,
  parseRetryComment,
  renderEscalationComment,
  renderLeftOpenPrComment,
  renderRequeueComment,
  renderRetryComment,
  renderStandDownComment,
  retriesUsed,
  retryLabel,
  retryPromptSection,
  ticketOrPr,
  ticketOrPrFromPr,
  ticketOrPrFromTicket,
} from "./decide";

test("retriesUsed counts the highest factory:retry-<n> label, zero without one", () => {
  assert.equal(retriesUsed([]), 0);
  assert.equal(retriesUsed(["ready-for-agent", "agent:in-progress"]), 0);
  assert.equal(retriesUsed(["factory:retry-1"]), 1);
  assert.equal(retriesUsed(["factory:retry-1", "factory:retry-2"]), 2);
  assert.equal(retriesUsed(["factory:retry-x", "factory:retry-"]), 0);
});

test("retryLabel names the label the workflow adds", () => {
  assert.equal(retryLabel(1), "factory:retry-1");
});

test("decide retries once on every failure kind, then escalates", () => {
  for (const kind of ["implement", "merge-gate", "ci", "verdict"] as const) {
    assert.deepEqual(decide({ retriesUsed: 0, kind }), { action: "retry", retry: 1 });
    assert.deepEqual(decide({ retriesUsed: 1, kind }), {
      action: "escalate",
      reason: "the retry failed too (2 attempts, 1 retry allowed)",
    });
    assert.equal(decide({ retriesUsed: 2, kind }).action, "escalate");
  }
});

test("decide does nothing on a ticket that is already escalated", () => {
  assert.deepEqual(decide({ retriesUsed: 0, kind: "merge-gate", escalated: true }), {
    action: "none",
    reason: "already escalated: needs-human is on the ticket",
  });
});

/** A hold on the ticket, as `findHold` reports one: the label and the subject it was found on. */
const heldTicket = { label: "hold", on: { kind: "issue" as const, number: "7" } };

test("decide stands down on a held subject instead of starting an agent, and spends nothing", () => {
  // #185: the retry would re-add `agent:implement`, which starts an agent on a
  // subject a person said to leave alone. Standing down is not a retry.
  const decision = decide({ retriesUsed: 0, kind: "implement", held: heldTicket });
  assert.equal(decision.action, "stand-down");
  assert.deepEqual("hold" in decision && decision.hold, heldTicket);
  assert.match("reason" in decision ? decision.reason : "", /`hold` is on ticket #7/);
});

test("a held subject whose retry is spent stands down rather than escalating", () => {
  // Escalation takes every `agent:*` label and `ready-for-agent` off and puts
  // `needs-human` on: the factory reclaiming a subject a person has just
  // taken, and a state removing `hold` could never resume from. So the hold
  // is read before anything that escalates.
  for (const kind of FAILURE_KINDS) {
    assert.equal(decide({ retriesUsed: 1, kind, held: heldTicket }).action, "stand-down", `${kind}, retry spent`);
  }
  assert.equal(
    decide({ retriesUsed: 0, kind: "verdict", unretryable: "the ticket has no acceptance criteria", held: heldTicket }).action,
    "stand-down",
  );
  // A conflict hand-off puts `agent:implement` on the PR, an agent starting like any other.
  const requeue = "check still pending after 15 minutes; not the ticket's failure";
  assert.equal(decide({ retriesUsed: 0, kind: "ci", requeue, mergeable: "CONFLICTING", held: heldTicket }).action, "stand-down");
  assert.equal(decide({ retriesUsed: 0, kind: "ci", requeue, held: heldTicket }).action, "stand-down");
  // Already escalated still wins: nothing to do, and no second comment.
  assert.equal(decide({ retriesUsed: 1, kind: "verdict", escalated: true, held: heldTicket }).action, "none");
});

test("findHold reads the hold on the ticket first and then on its open PR", () => {
  const ticket = (labels: string[]) => ({ kind: "issue" as const, number: "7", labels });
  const pr = (labels: string[]) => ({ kind: "pr" as const, number: "12", labels });
  assert.deepEqual(findHold([ticket(["ready-for-agent", "hold"])]), heldTicket);
  // A hold on the PR alone still stops the retry: the retry's label goes on the PR.
  assert.deepEqual(findHold([ticket(["ready-for-agent"]), pr(["hold"])]), { label: "hold", on: { kind: "pr", number: "12" } });
  assert.deepEqual(findHold([ticket(["hold"]), pr(["hold"])])?.on, { kind: "issue", number: "7" }, "the ticket is named first");
  assert.equal(findHold([ticket(["ready-for-agent", "agent:in-progress", "factory:retry-1"]), pr(["agent:review"])]), undefined);
  assert.equal(findHold([]), undefined);
});

test("the stand-down comment names the label and the subject, and what resumes it", () => {
  const base = { summary: "implement: the run was killed", runUrl: "u" };
  const onTicket = renderStandDownComment({ ...base, hold: heldTicket, pr: undefined });
  assert.match(onTicket, /`hold` is on ticket #7/);
  assert.match(onTicket, /the run was killed/);
  assert.match(onTicket, /No retry was spent/);
  assert.match(onTicket, /Run: u/);
  // A ticket is left with no factory label, which is the dispatcher's to pick up once the hold is off.
  assert.match(onTicket, /take `hold` off/i);
  assert.match(onTicket, /dispatcher/);
  // Not an escalation and not a note for a human: the person already has it.
  assert.doesNotMatch(onTicket, /needs-human|agent:blocked/);

  const onPr = renderStandDownComment({ ...base, hold: { label: "hold", on: { kind: "pr", number: "12" } }, pr: "12" });
  assert.match(onPr, /`hold` is on PR #12/);
  // A PR is left where a requeue leaves one (#148), for the reconciler's stuck path.
  assert.match(onPr, /`agent:in-progress`/);
  assert.match(onPr, /reconciler/);
  assert.match(onPr, /stuck deadline/);
  assert.doesNotMatch(onPr, /needs-human|agent:blocked/);
});

test("a cancel with no hold gets exactly one bounded replacement, as before #185", () => {
  // #51's case, a `timeout-minutes` kill, reads as `cancelled` at the gate and
  // is indistinguishable there from a person's `gh run cancel`. Unheld, it
  // still spends the one retry, and a second cancel escalates.
  assert.equal(isImplementerFailure("cancelled"), true);
  assert.deepEqual(decide({ retriesUsed: 0, kind: "implement" }), { action: "retry", retry: 1 });
  assert.deepEqual(decide({ retriesUsed: 1, kind: "implement" }), {
    action: "escalate",
    reason: "the retry failed too (2 attempts, 1 retry allowed)",
  });
  assert.deepEqual(decide({ retriesUsed: 0, kind: "implement", held: undefined }), { action: "retry", retry: 1 });
});

test("decide requeues a run rate limited on every account without spending the retry", () => {
  const decision = decide({ retriesUsed: 0, kind: "implement", requeue: RATE_LIMITED_REASON });
  assert.deepEqual(decision, { action: "requeue", reason: RATE_LIMITED_REASON });
  // The retry already used stays used, and the rate limit still does not count as the second failure.
  assert.equal(decide({ retriesUsed: 1, kind: "implement", requeue: RATE_LIMITED_REASON }).action, "requeue");
  assert.equal(
    decide({ retriesUsed: 0, kind: "implement", requeue: RATE_LIMITED_REASON, escalated: true }).action,
    "none",
  );
});

test("decide requeues a head still pending at the deadline without spending the retry", () => {
  const requeue = "check still pending after 15 minutes; not the ticket's failure";
  assert.deepEqual(decide({ retriesUsed: 0, kind: "ci", requeue }), { action: "requeue", reason: requeue });
  // The retry already used stays used: a slow CI is never the second failure that escalates.
  assert.equal(decide({ retriesUsed: 1, kind: "ci", requeue }).action, "requeue");
  assert.equal(decide({ retriesUsed: 0, kind: "ci", requeue, escalated: true }).action, "none");
  // Nothing pending: a real failure still spends the retry.
  assert.deepEqual(decide({ retriesUsed: 0, kind: "ci" }), { action: "retry", retry: 1 });
});

test("decide hands a conflicting PR to the implementer when its checks are still pending, spending nothing", () => {
  const requeue = "check still pending after 15 minutes; not the ticket's failure";
  const decision = decide({ retriesUsed: 0, kind: "ci", requeue, mergeable: "CONFLICTING" });
  assert.equal(decision.action, "hand-off");
  assert.match("reason" in decision ? decision.reason : "", /conflict/);
  // The retry already used stays used: a conflict never counts against the ticket's attempts.
  assert.equal(decide({ retriesUsed: 1, kind: "ci", requeue, mergeable: "CONFLICTING" }).action, "hand-off");
  assert.equal(decide({ retriesUsed: 0, kind: "ci", requeue, mergeable: "CONFLICTING", escalated: true }).action, "none");
});

test("decide requeues a pending head whose PR is mergeable or not yet decided; unknown is never a hand-off", () => {
  const requeue = "check still pending after 15 minutes; not the ticket's failure";
  assert.deepEqual(decide({ retriesUsed: 0, kind: "ci", requeue, mergeable: "MERGEABLE" }), { action: "requeue", reason: requeue });
  assert.deepEqual(decide({ retriesUsed: 0, kind: "ci", requeue, mergeable: "UNKNOWN" }), { action: "requeue", reason: requeue });
  // No PR to read: nothing to hand off.
  assert.deepEqual(decide({ retriesUsed: 0, kind: "ci", requeue }), { action: "requeue", reason: requeue });
});

test("a failed check outranks a conflict: a conflicting PR with a real failure follows the failure", () => {
  assert.deepEqual(decide({ retriesUsed: 0, kind: "merge-gate", mergeable: "CONFLICTING" }), { action: "retry", retry: 1 });
  assert.equal(decide({ retriesUsed: 1, kind: "merge-gate", mergeable: "CONFLICTING" }).action, "escalate");
  assert.equal(
    decide({ retriesUsed: 0, kind: "verdict", mergeable: "CONFLICTING", unretryable: "the ticket has no acceptance criteria" }).action,
    "escalate",
  );
});

test("decide escalates at once on a failure a retry cannot fix", () => {
  assert.deepEqual(
    decide({ retriesUsed: 0, kind: "verdict", unretryable: "the ticket has no acceptance criteria" }),
    { action: "escalate", reason: "the ticket has no acceptance criteria" },
  );
});

test("the requeue comment says what moves the ticket or PR next, and neither is a human", () => {
  const onTicket = renderRequeueComment({ reason: "r", runUrl: "u", onPr: false });
  assert.match(onTicket, /No retry was spent/);
  assert.match(onTicket, /dispatcher/);
  assert.doesNotMatch(onTicket, /agent:blocked/);
  // A requeue on a PR is the ticket's requeue (#148): the reconciler re-adds the start
  // label at its stuck deadline, nothing is labeled here, and nothing is asked of a
  // human, so `agent:blocked` keeps its one meaning.
  const onPr = renderRequeueComment({ reason: "r", runUrl: "u", onPr: true });
  assert.match(onPr, /No retry was spent/);
  assert.match(onPr, /reconciler/);
  assert.match(onPr, /stuck deadline/);
  assert.doesNotMatch(onPr, /agent:blocked/);
  assert.doesNotMatch(onPr, /human/);
});

/** One step of a workflow by name, its comment lines dropped, split the way `reviewStep` below splits them. */
const workflowStep = (file: string, name: string, from = 0): string => {
  const yaml = fs.readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8").slice(from);
  const step = yaml.split(/\n(?= {6}- )/).find((s) => s.includes(`- name: ${name}`));
  assert.ok(step, `${file} has no step named ${name}`);
  return step.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
};

test("a stood-down ticket resumes through the dispatcher once the hold comes off", () => {
  // What a ticket carries by the time the handler runs on it: the implement job
  // took `agent:implement` off as it started, and the retry job takes
  // `agent:in-progress` off a step before the handler. Standing down adds
  // neither back, so nothing is left for the reconciler's stuck path, which
  // reads only those two on a ticket; the dispatcher is what resumes it.
  const file = "agent-implement.yml";
  const yaml = fs.readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8");
  const retryJob = yaml.indexOf("\n  retry:");
  assert.match(workflowStep(file, "Transition labels"), /--remove-label "agent:implement"/);
  assert.match(workflowStep(file, "Remove in-progress", retryJob), /--remove-label "agent:in-progress"/);
  assert.ok(
    yaml.indexOf("- name: Remove in-progress", retryJob) < yaml.indexOf("- name: Retry or escalate", retryJob),
    "the retry job no longer drops agent:in-progress before the handler runs",
  );

  const policy = trustPolicy("OWNER");
  const stoodDown = { number: 7, title: "Resume the stood-down ticket", body: "## Acceptance criteria\n\n- [ ] the stood-down ticket resumes\n", labels: ["ready-for-agent", "hold"], assigned: false, openBlockers: 0, hasOpenPr: false, authorAssociation: "OWNER" as const };
  assert.equal(whySkipped(stoodDown, policy), "held: hold", "the dispatcher starts nothing while it is held");
  assert.equal(whySkipped({ ...stoodDown, labels: ["ready-for-agent"] }, policy), undefined, "and resumes it once the hold is off");
  // A retry already spent before the hold stays spent, and does not stop the resume either.
  assert.equal(whySkipped({ ...stoodDown, labels: ["ready-for-agent", "factory:retry-1"] }, policy), undefined);
});

/**
 * One step of `agent-review.yml` by name, its comment lines dropped: what the
 * step says about itself is prose, and every assertion below is about what it
 * runs. Steps are split on `- ` at six-space indent, the way
 * `lib/accounts.test.ts` and `lib/strip-types-cone.test.ts` split them.
 */
const reviewStep = (name: string): string => {
  const yaml = fs.readFileSync(new URL("../../.github/workflows/agent-review.yml", import.meta.url), "utf8");
  const step = yaml.split(/\n(?= {6}- )/).find((s) => s.includes(`- name: ${name}`));
  assert.ok(step, `agent-review.yml has no step named ${name}`);
  return step
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
};

/**
 * The review side's own failure labelling, the one the retry handler below it
 * never reaches: a reviewer that crashed, or that never got an account. A run
 * rate limited on every account is not this PR's failure, so it is requeued
 * the way a ticket is (#148), and `RATE_LIMITED_FILE` in the output dir is
 * the fact that says so. Every other failure still means a human must look.
 */
test("the review workflow's failure step requeues a rate limit on every account and blocks on anything else", () => {
  const step = reviewStep("Requeue or mark blocked on failure");
  const guard = step.indexOf(RATE_LIMITED_FILE);
  assert.ok(guard > 0, `the step never reads ${RATE_LIMITED_FILE}`);
  const branchEnd = step.indexOf("exit 0", guard);
  assert.ok(branchEnd > guard, `the ${RATE_LIMITED_FILE} branch does not end the step`);

  const rateLimited = step.slice(guard, branchEnd);
  assert.ok(!rateLimited.includes(BLOCKED_LABEL), `a rate limit on every account still adds ${BLOCKED_LABEL}`);
  assert.match(rateLimited, /pr comment/, "a rate limit on every account posts no comment");
  // The comment is the requeue comment itself, not prose that drifts from it.
  assert.match(rateLimited, /requeue-comment\.ts/, "the comment is not the one renderRequeueComment writes");
  // And the PR keeps the label the reconciler sweeps: the step below reads this file.
  assert.ok(rateLimited.includes(REQUEUED_FILE), `the requeue writes no ${REQUEUED_FILE}`);

  const otherFailure = step.slice(branchEnd);
  assert.ok(
    otherFailure.includes(`--add-label "${BLOCKED_LABEL}"`),
    `a failure that is not a rate limit no longer adds ${BLOCKED_LABEL}`,
  );
  assert.match(otherFailure, /pr comment/, "a failure that is not a rate limit posts no comment");
});

/**
 * The review job takes `agent:in-progress` off on its way out, whatever
 * happened. A requeued PR is the one case where it must not: that label is
 * what `decidePrLabel` in the reconciler reads, and a PR with no `agent:*`
 * label at all is swept by nothing, so dropping `agent:blocked` without this
 * would strand the PR instead of requeueing it (#148).
 */
test("the review workflow leaves agent:in-progress on a requeued PR for the reconciler to sweep", () => {
  const step = reviewStep("Always remove in-progress");
  const guard = step.indexOf(REQUEUED_FILE);
  assert.ok(guard > 0, `the step removes ${IN_PROGRESS_LABEL} without reading ${REQUEUED_FILE}`);
  const branchEnd = step.indexOf("exit 0", guard);
  assert.ok(branchEnd > guard, `the ${REQUEUED_FILE} branch does not end the step`);
  assert.ok(!step.slice(guard, branchEnd).includes("--remove-label"), "a requeued PR still loses its label");
  assert.ok(
    step.slice(branchEnd).includes(`--remove-label "${IN_PROGRESS_LABEL}"`),
    `nothing removes ${IN_PROGRESS_LABEL} on any other way out`,
  );
});

/** The label-bound sentence `prDisposition` hands each caller, from a factory branch or someone else's. */
const handOffSentence = prDisposition({ headRef: "agent/issue-7-thing", body: "" }, "main").sentence;
const tellAuthorSentence = prDisposition({ headRef: "maintainer/flaky-login", body: "Fixes it." }).sentence;

test("the hand-off comment names the conflict, the implementer's label, and that no retry was spent", () => {
  const body = renderHandOffComment({ reason: CONFLICT_REASON, add: IMPLEMENT_LABEL, sentence: handOffSentence, runUrl: "u" });
  assert.match(body, /conflicts with its base/);
  assert.match(body, /`main`/);
  assert.match(body, /`agent:implement`/);
  assert.match(body, /No retry was spent/);
  assert.match(body, /Run: u/);
  // Not a human's: the blocked label is never named as what moves it next.
  assert.doesNotMatch(body, /agent:blocked/);
});

test("the comment on a PR the factory did not author says what failed and that the fix is its author's", () => {
  // #183, acceptance criterion 2. The author never reads the ticket's retry
  // comment, so what failed has to be on their own thread, with it.
  const body = renderTellAuthorComment({
    reason: "verdict: 2 of 5 acceptance criteria unticked",
    sentence: tellAuthorSentence,
    runUrl: "u",
    issueNumber: "42",
    output: "## Verdict: fail\n\n- [ ] the helper exists",
  });
  assert.match(body, /2 of 5 acceptance criteria unticked/);
  assert.match(body, /the helper exists/);
  assert.match(body, /Run: u/);
  assert.match(body, /#42/);
  // The one promise it must not make: nothing of the factory's touches this branch.
  assert.doesNotMatch(body, /`agent:implement`/);
  // The label #180 already tells this author's PR with, not a second one, and
  // it is the label the hand-back instruction names.
  assert.match(body, /take `agent:blocked` off/);
  // Never `needs-human` as the thing on this PR now: that one means the factory
  // has given up, and a fresh verdict follows this author's fix.
  assert.doesNotMatch(body, /needs-human` (?:is on|on this)/);
  // Entering the judged path is #181's instruction to give, not a failure
  // comment's; taking the label off is what actually hands the PR back.
  assert.doesNotMatch(body, /agent:review/);
});

test("an author whose next failure is terminal is told so on their own thread", () => {
  // The retry that spends the ticket's last one is recorded on the ticket,
  // which this author has no reason to read: the escalation that follows puts
  // `needs-human` on their PR and disarms its auto-merge, so being told after
  // the fact is being told too late.
  const note = { reason: "verdict: failed", sentence: tellAuthorSentence, runUrl: "u", issueNumber: "42", output: "" };
  const last = renderTellAuthorComment({ ...note, escalatesNext: true });
  assert.match(last, /last attempt/);
  assert.match(last, /`needs-human`/);
  assert.match(last, /Nothing is closed/);
  // The conflict path spends no retry, so the same warning there would be a lie.
  assert.doesNotMatch(renderTellAuthorComment(note), /last attempt/);
});

test("the author's comment leaves out an output nothing gave it", () => {
  // The conflict hand-off has a reason and no failing output, there being no
  // check that failed; an empty <details> would promise one.
  const body = renderTellAuthorComment({ reason: "verdict: failed", sentence: tellAuthorSentence, runUrl: "u", issueNumber: undefined, output: "" });
  assert.doesNotMatch(body, /<details>/);
  assert.doesNotMatch(body, /#undefined/);
});

test("a conflict reads the same to the author, minus the implementer that is not coming", () => {
  const reason = authorConflictReason("main");
  assert.match(reason, /conflicts with `main`/);
  assert.match(reason, /no merge gate/);
  assert.doesNotMatch(reason, /implementer/);
});

test("the retry comment promises an implementer run only when one is coming", () => {
  const record = { retry: 1, kind: "verdict" as const, runUrl, output: "out" };
  const factory = renderRetryComment({ ...record, action: "hand-off" });
  assert.match(factory, /The implementer runs once more/);
  const author = renderRetryComment({ ...record, action: "tell-author" });
  assert.doesNotMatch(author, /The implementer runs once more/);
  assert.match(author, /did not author/);
  assert.match(author, /`agent:blocked`/);
  // Still the record #183's fourth criterion asks for: same marker, same count.
  assert.match(author, /^<!-- factory:retry retry=1 kind=verdict -->\n/);
  assert.match(author, /Retry 1 of 1/);
  assert.equal(parseRetryComment(author)?.output, "out");
});

test("the requeue comment names the cause in its reason, never a rate limit it did not hit", () => {
  const body = renderRequeueComment({
    reason: "check still pending after 15 minutes; not the ticket's failure",
    runUrl: "u",
    onPr: true,
  });
  assert.match(body, /still pending after 15 minutes/);
  assert.doesNotMatch(body, /[Rr]ate limited/);
  assert.doesNotMatch(body, /quota/);
});

const runUrl = "https://github.com/o/r/actions/runs/1";

test("a retry comment round-trips through its marker", () => {
  const body = renderRetryComment({
    retry: 1,
    kind: "verdict",
    runUrl,
    output: "## Verdict: fail\n\n- [ ] the helper exists. Evidence: no file",
  });
  assert.match(body, /^<!-- factory:retry retry=1 kind=verdict -->\n/);
  assert.match(body, /Retry 1 of 1/);
  assert.match(body, /Attempt 1 failed \(verdict\)\. Run: https:\/\/github\.com\/o\/r\/actions\/runs\/1/);
  const parsed = parseRetryComment(body);
  assert.ok(parsed);
  assert.equal(parsed.retry, 1);
  assert.equal(parsed.kind, "verdict");
  assert.equal(parsed.runUrl, runUrl);
  assert.match(parsed.output, /- \[ \] the helper exists/);
});

test("every failure kind round-trips through a retry comment, run link included", () => {
  // A hyphenated kind (merge-gate) must survive both the marker and the "Attempt N
  // failed (kind)" line. A pattern that accepts only letters parses the marker and
  // then silently drops the run link, leaving the implementer no run to read.
  for (const kind of FAILURE_KINDS) {
    const parsed = parseRetryComment(renderRetryComment({ retry: 1, kind, runUrl, output: "out" }));
    assert.equal(parsed?.kind, kind, `kind ${kind} did not survive the marker`);
    assert.equal(parsed?.runUrl, runUrl, `kind ${kind} lost its run link`);
  }
});

test("parseRetryComment ignores comments without the marker", () => {
  assert.equal(parseRetryComment("just a comment"), undefined);
  assert.equal(parseRetryComment("<!-- factory:verdict -->\n## Verdict"), undefined);
});

test("a retry comment bounds long output and keeps its tail", () => {
  const output = `${"a".repeat(30_000)}\nTHE END`;
  const body = renderRetryComment({ retry: 1, kind: "implement", runUrl, output });
  assert.ok(body.length < 20_000, `comment is ${body.length} chars`);
  assert.match(body, /characters cut/);
  assert.match(body, /THE END/);
});

test("latestRetryContext picks the newest marker comment while the retry label matches it", () => {
  const first = renderRetryComment({ retry: 1, kind: "merge-gate", runUrl, output: "old" });
  const second = renderRetryComment({ retry: 1, kind: "verdict", runUrl, output: "new" });
  const labels = ["ready-for-agent", "factory:retry-1"];
  assert.equal(latestRetryContext([], labels), undefined);
  assert.equal(latestRetryContext(["hello", "world"], labels), undefined);
  assert.equal(latestRetryContext([first, "chatter", second], labels)?.output.trim(), "new");
  assert.equal(latestRetryContext([second, first], labels)?.kind, "merge-gate");
});

test("latestRetryContext is empty once the retry label is gone or names another cycle", () => {
  const marker = renderRetryComment({ retry: 1, kind: "verdict", runUrl, output: "stale" });
  assert.equal(latestRetryContext([marker], ["ready-for-agent"]), undefined, "handed back: fresh first attempt");
  assert.equal(latestRetryContext([marker], ["factory:retry-2"]), undefined, "marker from an older retry");
});

test("retryPromptSection is empty without a context and names the failure with it", () => {
  assert.equal(retryPromptSection(undefined), "");
  const section = retryPromptSection({
    retry: 1,
    kind: "merge-gate",
    runUrl,
    output: "factory/red-green: no test failed on main",
  });
  assert.match(section, /^# RETRY: THE PREVIOUS ATTEMPT FAILED/);
  assert.match(section, /retry 1 of 1/);
  assert.match(section, /attempt 2 of 2/);
  assert.match(section, /failing check/);
  assert.match(section, /factory\/red-green: no test failed on main/);
});

test("renderEscalationComment links the run and the log, keeps the branch, names the closed PR", () => {
  const body = renderEscalationComment({
    issueNumber: "7",
    reason: "the retry failed too (2 attempts, 1 retry allowed)",
    summary: "verdict: 1/3 acceptance criteria met",
    runUrl,
    logUrl: "https://github.com/o/r/actions/runs/1/artifacts/9",
    branch: "agent/issue-7-thing",
    branchExists: true,
    pr: { number: "12", closed: true },
    output: "## Verdict: fail",
  });
  assert.match(body, /needs-human/);
  assert.match(body, /Run: https:\/\/github\.com\/o\/r\/actions\/runs\/1\b/);
  assert.match(body, /Run log: https:\/\/github\.com\/o\/r\/actions\/runs\/1\/artifacts\/9/);
  assert.match(body, /`agent\/issue-7-thing` is kept/);
  assert.match(body, /PR #12 was closed/);
  assert.match(body, /factory:retry-1/);
  assert.match(body, /## Verdict: fail/);
});

test("the escalation comment asks for ready-for-agent back, since escalation took it off", () => {
  const body = renderEscalationComment({
    issueNumber: "7",
    reason: "the retry failed too (2 attempts, 1 retry allowed)",
    summary: "verdict: 1/3 acceptance criteria met",
    runUrl,
    logUrl: undefined,
    branch: "agent/issue-7-thing",
    branchExists: true,
    pr: { number: "12", closed: true },
    output: "",
  });
  assert.match(body, /remove `needs-human` and `factory:retry-1`, then add `ready-for-agent` back/);
});

test("the escalation comment says a PR the factory did not author was left open, and why", () => {
  // #174: escalation still happens on a PR it does not close, so the comment
  // has to carry the one thing that differs, or the PR looks silently skipped.
  const body = renderEscalationComment({
    // The PR's own number: a PR the factory did not author closes no ticket,
    // so the escalation is recorded on the PR itself and this self-links.
    issueNumber: "12",
    reason: 'the ticket has no acceptance criteria (no "Acceptance criteria" checklist)',
    summary: "verdict: no acceptance criteria",
    runUrl,
    logUrl: undefined,
    branch: "maintainer/flaky-login",
    branchExists: true,
    pr: { number: "12", closed: false },
    output: "",
  });
  assert.match(body, /PR #12 is left open/);
  assert.match(body, /did not author it/);
  assert.match(body, /auto-merge is disarmed/);
  assert.doesNotMatch(body, /was closed/);
  // The escalation itself still happened: the label is named and the run is linked.
  assert.match(body, /needs-human/);
  assert.match(body, /Run: https:\/\/github\.com\/o\/r\/actions\/runs\/1\b/);
});

test("the PR left open is told on its own thread why its agent:* labels went", () => {
  // The escalation itself is recorded on the ticket, so this is the only thing
  // the PR's own readers see (#174).
  const body = renderLeftOpenPrComment({
    reason: 'the ticket has no acceptance criteria (no "Acceptance criteria" checklist)',
    issueNumber: "7",
    runUrl,
  });
  assert.match(body, /Left open by the factory/);
  assert.match(body, /did not author this PR/);
  assert.match(body, /`agent:\*` labels are off/);
  assert.match(body, /escalation is on #7/);
  assert.match(body, /Run: https:\/\/github\.com\/o\/r\/actions\/runs\/1\b/);
});

test("renderEscalationComment says when there is no branch and no PR", () => {
  const body = renderEscalationComment({
    issueNumber: "7",
    reason: "the retry failed too (2 attempts, 1 retry allowed)",
    summary: "implement: no commits",
    runUrl,
    logUrl: undefined,
    branch: "agent/issue-7-thing",
    branchExists: false,
    pr: undefined,
    output: "",
  });
  assert.match(body, /No branch was pushed/);
  assert.match(body, /no PR was open/i);
  assert.match(body, /Run log: see the run/);
});

test("a run killed at the job timeout spends a retry, a failure around the implementer does not", () => {
  // The implementer's own attempt ended badly: this is what the one retry is for.
  assert.equal(isImplementerFailure("failure"), true);
  // `timeout-minutes` kills the job, and GitHub reports the killed step as cancelled (#51).
  assert.equal(isImplementerFailure("cancelled"), true);
  // A push, a PR step or a checkout failed around it: the blocked comment, not the retry.
  assert.equal(isImplementerFailure("skipped"), false);
  assert.equal(isImplementerFailure("success"), false);
  assert.equal(isImplementerFailure(""), false);
});

test("a killed attempt that wrote no reason file says it was killed", () => {
  assert.match(missingFailureReason("cancelled"), /killed/);
  assert.match(missingFailureReason("cancelled"), /timeout/);
  // Nothing killed it, so the reason really is missing and the log is where to look.
  assert.match(missingFailureReason("failure"), /no reason file/);
});

test("a run with neither a ticket nor an open PR has nothing to act on", () => {
  assert.equal(ticketOrPr(undefined, undefined), undefined);
  assert.equal(ticketOrPr("", undefined), undefined);
  assert.deepEqual(ticketOrPr("7", undefined), { issue: "7", pr: undefined });
  assert.deepEqual(ticketOrPr(undefined, { number: "12" }), { issue: undefined, pr: { number: "12" } });
  assert.deepEqual(ticketOrPr("7", { number: "12" }), { issue: "7", pr: { number: "12" } });
});

test("a PR input no longer open, whose body links no ticket, fails naming both facts", () => {
  // #133: the handler used to carry on and hand `gh` an undefined number.
  const pr = { number: "12" };
  const unresolved = (result: object): string => ("unresolved" in result ? String(result.unresolved) : "");
  assert.match(
    unresolved(ticketOrPrFromPr({ number: "12", state: "CLOSED", ticket: "", pr })),
    /PR #12 is closed, not open, and its body links no ticket/,
  );
  assert.match(unresolved(ticketOrPrFromPr({ number: "12", state: "MERGED", ticket: undefined, pr })), /PR #12 is merged/);
  // A closed PR with a ticket falls back to the ticket; an open one counts either way.
  assert.deepEqual(ticketOrPrFromPr({ number: "12", state: "CLOSED", ticket: "7", pr }), { issue: "7", pr: undefined });
  assert.deepEqual(ticketOrPrFromPr({ number: "12", state: "OPEN", ticket: "", pr }), { issue: undefined, pr });
  assert.deepEqual(ticketOrPrFromPr({ number: "12", state: "OPEN", ticket: "7", pr }), { issue: "7", pr });
});

/** The branch `agent-implement.yml` cut for ticket 7's run (#204). */
const RUN_BRANCH = "agent/issue-7-add-a-widget";

/** An open PR the way the retry handler lists one on the ticket-only path. */
const listed = (number: string, headRef: string, body: string, fromFork = false) => ({ number, facts: { headRef, body }, fromFork });

test("a person's PR that links the ticket from another branch is not the ticket's open PR", () => {
  // #204: opened while the factory's run on #7 was in flight. The failure used
  // to become a tell-author on it, `agent:blocked` and a comment blaming them.
  const stranger = listed("12", "someone/fix-7", "Closes #7");
  const resolved = ticketOrPrFromTicket({ ticket: "7", branch: RUN_BRANCH, open: [stranger] });
  // Exactly what no open PR resolves to, so every write after it (the retry's
  // record, its label, a hold, an escalation) lands on the ticket alone.
  assert.deepEqual(resolved, ticketOrPrFromTicket({ ticket: "7", branch: RUN_BRANCH, open: [] }));
  assert.deepEqual(resolved, { issue: "7", pr: undefined });
});

test("the run's own PR is the ticket's open PR, however many others link the ticket ahead of it", () => {
  const stranger = listed("12", "someone/fix-7", "Closes #7");
  const own = listed("13", RUN_BRANCH, "Implemented by the software factory.\n\nCloses #7");
  const other = listed("14", "agent/issue-8-other", "Closes #8");
  assert.deepEqual(ticketOrPrFromTicket({ ticket: "7", branch: RUN_BRANCH, open: [stranger, other, own] }), { issue: "7", pr: own });
  // `#007` is ticket 7, as every other reader of the link counts it (#132).
  const padded = listed("13", RUN_BRANCH, "Closes #007");
  assert.deepEqual(ticketOrPrFromTicket({ ticket: "7", branch: RUN_BRANCH, open: [padded] }).pr, padded);
});

test("a PR on the run's branch that links no ticket, or another one, is not the ticket's open PR either", () => {
  const unlinked = listed("13", RUN_BRANCH, "no closing keyword");
  const elsewhere = listed("13", RUN_BRANCH, "Closes #8");
  assert.equal(ticketOrPrFromTicket({ ticket: "7", branch: RUN_BRANCH, open: [unlinked] }).pr, undefined);
  assert.equal(ticketOrPrFromTicket({ ticket: "7", branch: RUN_BRANCH, open: [elsewhere] }).pr, undefined);
});

test("a fork's PR on a branch named like the run's is not the ticket's open PR", () => {
  // GitHub names a fork's head by its branch alone, so the branch test by itself would pass it.
  const fork = listed("12", RUN_BRANCH, "Closes #7", true);
  const own = listed("13", RUN_BRANCH, "Implemented by the software factory.\n\nCloses #7");
  assert.equal(ticketOrPrFromTicket({ ticket: "7", branch: RUN_BRANCH, open: [fork] }).pr, undefined);
  assert.equal(ticketOrPrFromTicket({ ticket: "7", branch: RUN_BRANCH, open: [fork, own] }).pr, own);
});
