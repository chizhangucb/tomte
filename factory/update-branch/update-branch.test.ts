/**
 * Update-branch driven through its needs-record with an in-memory target repo
 * and no network, in the style of `dispatch/sweep.test.ts` (#281). The plan
 * (`plan.ts`) decides what to do; this proves the job carries those decisions
 * out: the branch update it asks for, the statuses, comments and labels it
 * writes, and the two documented refusals read off the error the record throws.
 *
 * What the plan decides is `plan.test.ts`'s subject and is not re-checked here;
 * these are the writes those decisions produce. A test never asserts on which
 * `gh` command would run, only on what the job wrote back.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { GhError } from "../lib/gh.ts";
import { BLOCKED_LABEL, IMPLEMENT_LABEL } from "../lib/labels.ts";
import {
  type CommitStatus,
  type HeadCommit,
  UPDATE_MARKER_CONTEXT,
  VERDICT_CONTEXT,
} from "./plan.ts";
import {
  type ListedPr,
  type UpdateBranchConfig,
  type UpdateBranchNeeds,
  updateBranch,
} from "./update-branch.ts";

/** One recorded write, so a test asserts on what the job wrote and never on a `gh` command. */
type Recorded =
  | { op: "requestUpdate"; pr: number; expectedHead: string }
  | { op: "postStatus"; sha: string; status: CommitStatus }
  | { op: "comment"; pr: number; body: string }
  | { op: "addLabel"; pr: number; label: string };

/** An in-memory target repo: the reads a test prepares, every write recorded rather than sent. */
const inMemory = (
  overrides: Partial<UpdateBranchNeeds> = {},
): { needs: UpdateBranchNeeds; writes: Recorded[] } => {
  const writes: Recorded[] = [];
  const needs: UpdateBranchNeeds = {
    openPrs: () => [],
    behindBy: () => 0,
    statuses: () => [],
    commit: (sha) => ({ sha, parents: [], committerLogin: null }),
    headOf: () => "",
    requestUpdate: (pr, expectedHead) => writes.push({ op: "requestUpdate", pr, expectedHead }),
    postStatus: (sha, status) => writes.push({ op: "postStatus", sha, status }),
    comment: (pr, body) => writes.push({ op: "comment", pr, body }),
    addLabel: (pr, label) => writes.push({ op: "addLabel", pr, label }),
    ...overrides,
  };
  return { needs, writes };
};

const config = (overrides: Partial<UpdateBranchConfig> = {}): UpdateBranchConfig => ({
  base: "main",
  dryRun: false,
  runUrl: "https://ci.test/run/1",
  // No real waiting: the test's `headOf` already answers with the moved head.
  sleep: async () => {},
  ...overrides,
});

/** A PR as `openPrs` lists it. Auto-merge on, mergeable, factory-authored branch by default. */
const listed = (number: number, pr: Partial<ListedPr> = {}): ListedPr => ({
  number,
  headRef: `agent/issue-${number}-thing`,
  headRefOid: "h1old",
  body: `Closes #${number}\n\nImplemented by the software factory.`,
  autoMerge: true,
  mergeable: "MERGEABLE",
  labels: [],
  ...pr,
});

const status = (context: string, state: CommitStatus["state"], description: string | null = null): CommitStatus =>
  ({ context, state, description, target_url: null });

/** GitHub's own merge commit: two parents, committed by web-flow (an accepted update-branch call). */
const updateMerge: HeadCommit = { sha: "h2new", parents: ["h1old", "m3"], committerLogin: "web-flow" };

/** A `gh` failure carrying one of the two documented 422s, the shape `lib/gh.ts` throws. */
const refuses = (said: string): (() => never) => () => {
  throw new GhError(
    ["api", "--method", "PUT", "repos/o/r/pulls/1/update-branch"],
    Object.assign(new Error("Command failed: gh api"), { status: 1, stderr: `gh: ${said} (HTTP 422)\n` }),
  );
};

test("a PR brought up to date: the update is requested, the marker is posted, and the verdict is carried onto the merge", async () => {
  const { needs, writes } = inMemory({
    openPrs: () => [listed(1)],
    behindBy: () => 2,
    commit: (sha) => (sha === "h2new" ? updateMerge : { sha, parents: ["p0"], committerLogin: "sandcastle-agent[bot]" }),
    statuses: (sha) => (sha === "h1old" ? [status(VERDICT_CONTEXT, "success", "3/3 met")] : []),
    headOf: () => "h2new",
  });
  const result = await updateBranch(needs, config());

  // The update is asked for on the old head, then the marker goes on the old
  // head, then the carried verdict lands on the merge GitHub made: that order.
  assert.deepEqual(
    writes.map((w) => (w.op === "postStatus" ? `postStatus:${w.sha}` : w.op)),
    ["requestUpdate", "postStatus:h1old", "postStatus:h2new"],
  );
  const marker = writes.find((w) => w.op === "postStatus" && w.sha === "h1old") as { status: CommitStatus };
  assert.equal(marker.status.context, UPDATE_MARKER_CONTEXT);
  assert.equal(marker.status.state, "success");
  const carried = writes.find((w) => w.op === "postStatus" && w.sha === "h2new") as { status: CommitStatus };
  assert.equal(carried.status.context, VERDICT_CONTEXT);
  assert.match(carried.status.description ?? "", /carried from h1old by update-branch/);
  // A carried verdict with no link of its own falls back to this run's URL.
  assert.equal(carried.status.target_url, "https://ci.test/run/1");
  assert.equal(result.failed, 0);
  const outcome = result.outcomes.find((o) => o.number === 1)!;
  assert.equal(outcome.newHead, "h2new");
  assert.equal(outcome.verdictCarried, true);
});

test("a conflict on a factory-authored PR is handed to the implementer, not updated", async () => {
  const { needs, writes } = inMemory({
    openPrs: () => [listed(1, { mergeable: "CONFLICTING" })],
  });
  const result = await updateBranch(needs, config());
  assert.deepEqual(writes.map((w) => w.op), ["comment", "addLabel"]);
  const comment = writes.find((w) => w.op === "comment") as { body: string };
  assert.match(comment.body, /could not bring this PR up to date/);
  assert.match(comment.body, /implementer/i);
  assert.deepEqual(writes.find((w) => w.op === "addLabel"), { op: "addLabel", pr: 1, label: IMPLEMENT_LABEL });
  // No update was requested on a PR the API cannot merge.
  assert.equal(writes.some((w) => w.op === "requestUpdate"), false);
  assert.equal(result.outcomes.find((o) => o.number === 1)!.action, "hand-off");
});

test("a conflict on a PR the factory did not author is handed back to its author, not updated", async () => {
  const { needs, writes } = inMemory({
    openPrs: () => [listed(1, { mergeable: "CONFLICTING", headRef: "fix/their-branch", body: "Fixes the thing." })],
  });
  const result = await updateBranch(needs, config());
  assert.deepEqual(writes.map((w) => w.op), ["comment", "addLabel"]);
  const comment = writes.find((w) => w.op === "comment") as { body: string };
  assert.match(comment.body, /did not open this PR/);
  assert.deepEqual(writes.find((w) => w.op === "addLabel"), { op: "addLabel", pr: 1, label: BLOCKED_LABEL });
  assert.equal(writes.some((w) => w.op === "requestUpdate"), false);
  assert.equal(result.outcomes.find((o) => o.number === 1)!.action, "tell-author");
});

test("a head that moved since the scan is skipped and named; nothing is written for it", async () => {
  const { needs, writes } = inMemory({
    openPrs: () => [listed(1)],
    behindBy: () => 2,
    commit: (sha) => ({ sha, parents: ["p0"], committerLogin: "sandcastle-agent[bot]" }),
    statuses: () => [],
    requestUpdate: refuses("expected head sha didn’t match current head ref."),
  });
  const result = await updateBranch(needs, config());
  // The refused update writes no marker, no comment and no label.
  assert.deepEqual(writes, []);
  const outcome = result.outcomes.find((o) => o.number === 1)!;
  assert.equal(outcome.action, "skip");
  assert.match(outcome.reason, /head moved/);
  assert.equal(result.failed, 0);
});

test("a conflict the API answers with, on a PR read as UNKNOWN, is handed off through the same decision", async () => {
  // The second documented 422: the scan could not tell (UNKNOWN), the update is
  // tried, and GitHub refuses with a conflict. Read off the error's fields.
  const { needs, writes } = inMemory({
    openPrs: () => [listed(1, { mergeable: "UNKNOWN" })],
    behindBy: () => 2,
    commit: (sha) => ({ sha, parents: ["p0"], committerLogin: "sandcastle-agent[bot]" }),
    statuses: () => [],
    requestUpdate: refuses("merge conflict between base and head"),
  });
  const result = await updateBranch(needs, config());
  assert.deepEqual(
    writes.filter((w) => w.op !== "requestUpdate").map((w) => w.op),
    ["comment", "addLabel"],
  );
  assert.deepEqual(writes.find((w) => w.op === "addLabel"), { op: "addLabel", pr: 1, label: IMPLEMENT_LABEL });
  const outcome = result.outcomes.find((o) => o.number === 1)!;
  assert.equal(outcome.action, "hand-off");
  assert.match(outcome.reason, /update-branch refused/);
});

test("a PR with no auto-merge is skipped and named, and nothing is written for it", async () => {
  const { needs, writes } = inMemory({
    openPrs: () => [listed(1, { autoMerge: false })],
  });
  const result = await updateBranch(needs, config());
  assert.deepEqual(writes, []);
  const outcome = result.outcomes.find((o) => o.number === 1)!;
  assert.equal(outcome.action, "skip");
  assert.equal(outcome.reason, "auto-merge not enabled");
});

test("a non-refusal failure on the update call is counted and does not stop the other PRs", async () => {
  let calls = 0;
  const { needs } = inMemory({
    openPrs: () => [listed(1, { headRefOid: "a1" }), listed(2, { headRefOid: "b2", autoMerge: false })],
    behindBy: () => 2,
    commit: (sha) => ({ sha, parents: ["p0"], committerLogin: "sandcastle-agent[bot]" }),
    statuses: () => [],
    requestUpdate: () => {
      calls++;
      throw new GhError(["api"], Object.assign(new Error("boom"), { status: 1, stderr: "gh: Server Error (HTTP 500)\n" }));
    },
  });
  const result = await updateBranch(needs, config());
  assert.equal(calls, 1);
  assert.equal(result.failed, 1);
  // #2 was still reached and decided (skip: auto-merge off).
  assert.equal(result.outcomes.find((o) => o.number === 2)!.action, "skip");
});

test("a dry run decides but writes nothing", async () => {
  const { needs, writes } = inMemory({
    openPrs: () => [listed(1, { mergeable: "CONFLICTING" })],
  });
  const result = await updateBranch(needs, config({ dryRun: true }));
  assert.deepEqual(writes, []);
  assert.equal(result.outcomes.find((o) => o.number === 1)!.action, "hand-off");
});
