import assert from "node:assert/strict";
import { test } from "node:test";

import { FACTORY_BODY_MARKER } from "../lib/factory-pr.ts";
import { GhError } from "../lib/gh.ts";
import { BLOCKED_LABEL, IMPLEMENT_LABEL, PARKED_LABELS } from "../lib/labels.ts";
import {
  type CommitStatus,
  type ConflictSubject,
  type HeadCommit,
  type OpenPr,
  carriedVerdict,
  findVerdict,
  isUpdateMerge,
  planConflict,
  planUpdate,
  planUpdates,
  requestedByFactory,
  updateRefusal,
} from "./plan.ts";

const pr = (number: number, overrides: Partial<OpenPr> = {}): OpenPr => ({
  number,
  headRef: `agent/issue-${number}-thing`,
  body: `Closes #${number}\n\nImplemented by the software factory.`,
  autoMerge: true,
  behindBy: 2,
  mergeable: "MERGEABLE",
  labels: [],
  head: { sha: "h1", parents: ["p0"], committerLogin: "sandcastle-agent[bot]" },
  verdict: { state: "success", sha: "h1" },
  ...overrides,
});

/** A PR somebody else opened: no `agent/` branch, no body marker, nothing the factory writes. */
const NOT_OURS = { headRef: "fix/their-branch", body: "Fixes the thing I hit last week." };

/** A conflicting PR the factory opened, by the branch namespace it owns. */
const authored = (labels: readonly string[] = []): ConflictSubject =>
  ({ number: 7, labels, headRef: "agent/issue-7-thing", body: "Closes #7" });

/** The same conflicting PR, opened by somebody else. */
const theirs = (labels: readonly string[] = []): ConflictSubject => ({ number: 7, labels, ...NOT_OURS });

const actions = (prs: readonly OpenPr[]): string[] =>
  planUpdates(prs).map((plan) => `${plan.number}:${plan.action}${plan.carry ? "+carry" : ""}`);

test("a factory PR with auto-merge on, a passing verdict, and a stale head is updated", () => {
  assert.deepEqual(actions([pr(7)]), ["7:update"]);
  assert.equal(planUpdate(pr(7)).reason, "2 behind main");
});

test("a PR already on the latest main is left alone", () => {
  assert.deepEqual(actions([pr(7, { behindBy: 0 })]), ["7:skip"]);
  assert.equal(planUpdate(pr(7, { behindBy: 0 })).reason, "up to date");
});

test("a PR without auto-merge is not the factory's to update", () => {
  assert.deepEqual(actions([pr(7, { autoMerge: false })]), ["7:skip"]);
  assert.equal(planUpdate(pr(7, { autoMerge: false })).reason, "auto-merge not enabled");
});

test("a PR whose reviewer is running waits; the review's dispatch brings it back", () => {
  const reviewing = pr(7, { verdict: { state: "pending", sha: "h1" } });
  assert.deepEqual(actions([reviewing]), ["7:skip"]);
  assert.equal(planUpdate(reviewing).reason, "reviewer running");
});

test("a stale PR with no verdict yet is still updated; the reviewer's verdict is carried onto the merge", () => {
  assert.deepEqual(actions([pr(7, { verdict: { state: "none", sha: "h1" } })]), ["7:update"]);
});

test("a PR whose verdict failed is not updated, wherever that verdict sits; it cannot merge until a re-review", () => {
  const failed = pr(7, { verdict: { state: "failure", sha: "h1" } });
  assert.deepEqual(actions([failed]), ["7:skip"]);
  assert.equal(planUpdate(failed).reason, "verdict failure on h1, waiting for a re-review");
  assert.deepEqual(actions([pr(7, { verdict: { state: "error", sha: "h0" } })]), ["7:skip"]);
});

test("a conflicting PR the factory did not author is not handed to the implementer", () => {
  assert.deepEqual(planConflict(theirs()), {
    number: 7,
    action: "tell-author",
    reason: "conflicts with main; the factory did not author this PR, so the conflict is its author's to resolve",
  });
});

test("hand-off: a conflicting PR the factory authored and nobody holds goes to the implementer, whoever found the conflict", () => {
  assert.deepEqual(planConflict(authored()), {
    number: 7,
    action: "hand-off",
    reason: "conflicts with main; handing the PR to the implementer",
  });
});

test("held: a conflicting PR an agent already holds, or that is parked, is skipped and the reason names the label", () => {
  for (const label of [IMPLEMENT_LABEL, "agent:in-progress", "agent:review", BLOCKED_LABEL]) {
    // Both branches of the authorship decision: the label holds the PR whoever opened it.
    for (const subject of [authored(["ready-for-agent", label]), theirs(["ready-for-agent", label])]) {
      assert.deepEqual(planConflict(subject), {
        number: 7,
        action: "skip",
        reason: `conflicts with main, already ${label}`,
      }, `${label} on ${subject.headRef}`);
    }
  }
});

test("the author is told once: agent:blocked is what the caller adds, and it skips the PR on the next push to main", () => {
  // The decline has to stick. update-branch runs again on every push to main and the
  // conflict is still there, so without the label the comment would repeat; and the
  // reconciler re-arms a Factory PR with no agent:* label at its verdict deadline.
  // agent:blocked is in HANDED_OFF_LABELS and in PARKED_LABELS, so
  // the same label answers both, and the author removing it hands the PR back.
  assert.equal(planConflict(theirs()).action, "tell-author");
  assert.equal(planConflict(theirs([BLOCKED_LABEL])).action, "skip");
  assert.equal(planConflict(theirs([BLOCKED_LABEL])).reason, `conflicts with main, already ${BLOCKED_LABEL}`);
  assert.ok(PARKED_LABELS.includes(BLOCKED_LABEL), "the reconciler parks on it too, so nothing re-arms the PR");
});

test("the factory's own body marker authors a PR whose branch is not under agent/", () => {
  // Both arms of isFactoryAuthoredPr reach the hand-off: implement-pr can rename a
  // branch, and the marker is what says the factory opened the PR regardless.
  const marked = { ...theirs(), body: `Closes #7\n\n${FACTORY_BODY_MARKER}.` };
  assert.equal(planConflict(marked).action, "hand-off");
});

test("a conflict decision states no verdict carry; the plan that has an opinion on one states its own", () => {
  // The decision never sees a verdict, so the flag it always set to false is not
  // its to state. `planUpdate` is the one that decides a carry, and it says so.
  assert.deepEqual(Object.keys(planConflict(authored())).sort(), ["action", "number", "reason"]);
  assert.equal(planUpdate(pr(7, { mergeable: "CONFLICTING" })).carry, false);
});

/**
 * What `gh api` prints when GitHub answers the update-branch call with one of
 * its two documented 422s: the message GitHub sent, then the status code. The
 * moved-head one carries GitHub's own typographic apostrophe.
 */
const refusal = (said: string): { status: number | null; stderr: string } => ({ status: 1, stderr: `gh: ${said} (HTTP 422)\n` });

test("the two documented 422s are told apart by the failed call's own fields", () => {
  assert.equal(updateRefusal(refusal("merge conflict between base and head")), "conflict");
  assert.equal(updateRefusal(refusal("expected head sha didn’t match current head ref.")), "head moved");
});

test("the refusal is read off the real error the shared gh module throws", () => {
  // `GhFailure` is written structurally so the plan never imports `lib/gh.ts`, so
  // this is what holds the two shapes together: a real GhError, from the module that
  // throws it, read by the decision. A field renamed on either side fails here.
  const refused = new GhError(
    ["api", "--method", "PUT", "repos/o/r/pulls/7/update-branch", "-f", "expected_head_sha=abc"],
    Object.assign(new Error("Command failed: gh api"), { status: 1, stderr: "gh: merge conflict between base and head (HTTP 422)\n" }),
  );
  assert.equal(updateRefusal(refused), "conflict");
  // And the message it renders is the log line, not the decision: nothing above read it.
  assert.match(refused.message, /^gh api --method PUT repos\/o\/r\/pulls\/7\/update-branch/);
});

test("anything else GitHub answers with is not a refusal, and the caller keeps the error", () => {
  assert.equal(updateRefusal(refusal("Validation Failed")), undefined, "a 422 this endpoint does not document");
  assert.equal(updateRefusal({ status: 1, stderr: "gh: Not Found (HTTP 404)\n" }), undefined);
  assert.equal(updateRefusal({ status: 1, stderr: "gh: merge conflict between base and head (HTTP 409)\n" }), undefined);
  // No exit status is a call that never got an answer: killed, or never spawned at all.
  assert.equal(updateRefusal({ status: null, stderr: "" }), undefined);
});

test("a stale PR the factory did not author is still brought up to date: the update half does not narrow", () => {
  // ADR 0006: the update call is deterministic and applies to any PR with
  // auto-merge armed, whoever opened it. Arming auto-merge on a hand-authored PR is the
  // normal thing to do under a strict ruleset, and that enrolment is the point.
  assert.deepEqual(actions([pr(7, NOT_OURS)]), ["7:update"]);
  assert.equal(planUpdate(pr(7, NOT_OURS)).reason, "2 behind main");
  assert.deepEqual(actions([pr(7, { ...NOT_OURS, behindBy: 0 })]), ["7:skip"]);
  // And the verdict carry is the same deterministic path, still open to it.
  const stalled = pr(7, { ...NOT_OURS, head: updateMerge, verdict: { state: "success", sha: "h1" } });
  assert.deepEqual(actions([stalled]), ["7:update+carry"]);
});

test("the plan hands a conflicting PR back to its author through the same decision", () => {
  assert.deepEqual(actions([pr(7, { ...NOT_OURS, mergeable: "CONFLICTING" })]), ["7:tell-author"]);
  assert.equal(planUpdate(pr(7, { ...NOT_OURS, mergeable: "CONFLICTING" })).carry, false);
});

test("the plan takes the conflict decision before it looks at any verdict", () => {
  assert.deepEqual(actions([pr(7, { mergeable: "CONFLICTING" })]), ["7:hand-off"]);
  // A failing verdict would give its own skip reason; the conflict decision gets there first.
  const held = pr(8, { mergeable: "CONFLICTING", labels: ["agent:review"], verdict: { state: "failure", sha: "h1" } });
  assert.deepEqual(actions([held]), ["8:skip"]);
  assert.equal(planUpdate(held).reason, "conflicts with main, already agent:review");
});

test("an unknown mergeability is tried anyway; the API answers with a conflict if there is one", () => {
  assert.deepEqual(actions([pr(7, { mergeable: "UNKNOWN" })]), ["7:update"]);
});

test("two stale PRs opened together are both updated, lowest number first", () => {
  assert.deepEqual(actions([pr(9), pr(8), pr(10, { behindBy: 0 })]), ["8:update", "9:update", "10:skip"]);
});

const updateMerge: HeadCommit = { sha: "h2", parents: ["h1", "m3"], committerLogin: "web-flow" };

test("a passing verdict below the head is carried onto the head", () => {
  const stalled = pr(7, { behindBy: 0, head: updateMerge, verdict: { state: "success", sha: "h1" } });
  assert.deepEqual(actions([stalled]), ["7:skip+carry"]);
  assert.equal(planUpdate(stalled).reason, "up to date, verdict to carry from h1");
});

test("a stale head carries first, then updates, so the verdict survives a chain of updates", () => {
  assert.deepEqual(actions([pr(7, { head: updateMerge, verdict: { state: "success", sha: "h1" } })]), ["7:update+carry"]);
});

test("every plan carries a reason a log line can print", () => {
  for (const plan of planUpdates([pr(1), pr(2, { autoMerge: false }), pr(3, { mergeable: "CONFLICTING" })])) {
    assert.ok(plan.reason.length > 0, `#${plan.number}`);
  }
});

test("isUpdateMerge names GitHub's own two-parent merge and nothing else", () => {
  assert.equal(isUpdateMerge(updateMerge), true);
  assert.equal(isUpdateMerge({ ...updateMerge, committerLogin: null }), false);
  assert.equal(isUpdateMerge({ ...updateMerge, committerLogin: "sandcastle-agent[bot]" }), false);
  assert.equal(isUpdateMerge({ ...updateMerge, parents: ["h1"] }), false);
});

const status = (state: CommitStatus["state"]): CommitStatus => ({ context: "factory/verdict", state, description: null, target_url: null });
/** The marker update-branch posts on a head when GitHub accepts its update call. */
const requested: CommitStatus = { context: "factory/update-branch", state: "success", description: "requested", target_url: null };

const chain = (
  commits: Record<string, HeadCommit>,
  statuses: Record<string, CommitStatus[]>,
) => ({
  statusesOf: (sha: string) => statuses[sha] ?? [],
  commitOf: (sha: string) => {
    const c = commits[sha];
    if (!c) throw new Error(`no commit ${sha}`);
    return c;
  },
});

test("findVerdict takes the verdict on the head itself first", () => {
  const { statusesOf, commitOf } = chain({}, { h2: [status("failure")] });
  assert.deepEqual(findVerdict(updateMerge, statusesOf, commitOf), { state: "failure", sha: "h2" });
});

test("findVerdict walks first parents through the factory's update merges to the head the reviewer judged", () => {
  const h1: HeadCommit = { sha: "h1", parents: ["p0"], committerLogin: "sandcastle-agent[bot]" };
  const h3: HeadCommit = { sha: "h3", parents: ["h2", "m4"], committerLogin: "web-flow" };
  const { statusesOf, commitOf } = chain({ h2: updateMerge, h1 }, { h2: [requested], h1: [status("failure"), requested] });
  assert.deepEqual(findVerdict(h3, statusesOf, commitOf), { state: "failure", sha: "h1" });
});

test("findVerdict does not cross a GitHub merge the factory never asked for: a conflict resolved in the web editor", () => {
  const h1: HeadCommit = { sha: "h1", parents: ["p0"], committerLogin: "sandcastle-agent[bot]" };
  const { statusesOf, commitOf } = chain({ h1 }, { h1: [status("success")] });
  assert.equal(isUpdateMerge(updateMerge), true, "same shape as an update merge");
  assert.deepEqual(findVerdict(updateMerge, statusesOf, commitOf), { state: "none", sha: "h2" });
  assert.equal(requestedByFactory([requested]), true);
  assert.equal(requestedByFactory([{ ...requested, state: "pending" }]), false);
});

test("findVerdict stops at a commit a person or an agent made, and reports none on the head", () => {
  const agentMerge: HeadCommit = { sha: "h2", parents: ["h1", "m3"], committerLogin: "sandcastle-agent[bot]" };
  const h1: HeadCommit = { sha: "h1", parents: ["p0"], committerLogin: "sandcastle-agent[bot]" };
  const { statusesOf, commitOf } = chain({ h1 }, { h1: [status("success")] });
  assert.deepEqual(findVerdict(agentMerge, statusesOf, commitOf), { state: "none", sha: "h2" });
  assert.deepEqual(findVerdict(h1, statusesOf, commitOf), { state: "success", sha: "h1" });
});

test("findVerdict reports exhaustion after maxHops without touching commits beyond it", () => {
  const commits: Record<string, HeadCommit> = {};
  const statuses: Record<string, CommitStatus[]> = { h0: [status("success"), requested] };
  for (let i = 1; i <= 5; i++) {
    commits[`h${i}`] = { sha: `h${i}`, parents: [`h${i - 1}`, "m"], committerLogin: "web-flow" };
    statuses[`h${i}`] = [requested];
  }
  const { statusesOf, commitOf } = chain(commits, statuses);
  assert.deepEqual(findVerdict(commits.h5!, statusesOf, commitOf, 2), { state: "exhausted", sha: "h5" });
  assert.deepEqual(findVerdict(commits.h5!, statusesOf, commitOf), { state: "success", sha: "h0" });
});

test("an exhausted walk skips the PR and asks for a re-review instead of deepening the chain", () => {
  const plan = planUpdate(pr(4, { verdict: { state: "exhausted", sha: "h1" } }));
  assert.equal(plan.action, "skip");
  assert.equal(plan.carry, false);
  assert.match(plan.reason, /agent:review/);
});

const verdict = (state: CommitStatus["state"]): CommitStatus => ({
  context: "factory/verdict",
  state,
  description: "3/3 acceptance criteria met",
  target_url: "https://example.test/run/1",
});

test("a passing verdict on the old head is carried with its provenance", () => {
  const carried = carriedVerdict([verdict("success")], "aaaaaaa1bbbbbbb2");
  assert.deepEqual(carried, {
    context: "factory/verdict",
    state: "success",
    description: "3/3 acceptance criteria met (carried from aaaaaaa by update-branch)",
    target_url: "https://example.test/run/1",
  });
});

test("a verdict carried a second time keeps one provenance note, not a chain", () => {
  const once = carriedVerdict([verdict("success")], "aaaaaaa1")!;
  const twice = carriedVerdict([once], "bbbbbbb2");
  assert.equal(twice?.description, "3/3 acceptance criteria met (carried from bbbbbbb by update-branch)");
});

test("a failing or pending verdict is never carried", () => {
  assert.equal(carriedVerdict([verdict("failure")], "aaaaaaa1"), undefined);
  assert.equal(carriedVerdict([verdict("pending")], "aaaaaaa1"), undefined);
  assert.equal(carriedVerdict([verdict("error")], "aaaaaaa1"), undefined);
});

test("other contexts are ignored and a head without a verdict carries nothing", () => {
  const mergeGate: CommitStatus = { context: "factory/red-green", state: "success", description: "clean", target_url: null };
  assert.equal(carriedVerdict([mergeGate], "aaaaaaa1"), undefined);
  assert.equal(carriedVerdict([], "aaaaaaa1"), undefined);
});

test("the carried description stays inside GitHub's 140 character status limit", () => {
  const long: CommitStatus = { ...verdict("success"), description: "x".repeat(140) };
  const description = carriedVerdict([long], "aaaaaaa1")?.description ?? "";
  assert.ok(description.length <= 140 && description.length > 40);
  assert.ok(description.endsWith("(carried from aaaaaaa by update-branch)"));
});
