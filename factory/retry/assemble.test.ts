/**
 * The retry run's assembly driven through its reads record with an in-memory
 * target repo and no `gh`, in the style of `retry.test.ts` (#284) and
 * `sweep.test.ts` (#281). `retry-run.ts` is the wiring that hands the record
 * the real `gh`/fs reads; this proves what it assembles from them: the failure
 * an implementer's bad ending becomes, and the reads the checks wait runs on.
 *
 * What the handler then does with either is `retry.test.ts`'s subject, and what
 * the wait decides is `checks-wait.test.ts`'s; neither is re-checked here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { GhError } from "../lib/gh.ts";
import { type CheckFailure } from "./checks.ts";
import { RATE_LIMITED_REASON } from "./decide.ts";
import { SECTION_END, SECTION_START } from "../lib/verdict.ts";
import { assembleRun, type RunConfig, type RunNeeds } from "./assemble.ts";

/** An in-memory stand-in for the run's reads: every read answers from memory, none reaches `gh` or the disk. */
const inMemory = (overrides: Partial<RunNeeds> = {}): RunNeeds => ({
  failureReason: () => undefined,
  rateLimited: () => false,
  newestRunLog: () => undefined,
  verdictPrBody: () => undefined,
  verdictSummary: () => undefined,
  failedRunLog: () => "(no log)",
  mergeGateArtifact: async () => undefined,
  workflowName: () => "Target CI",
  commitStatuses: () => [],
  checkRuns: () => [],
  prView: () => ({ state: "OPEN", mergeable: "MERGEABLE", baseRefName: "main" }),
  ...overrides,
});

const facts = (overrides: Partial<RunConfig> = {}): RunConfig => ({
  own: { workflowName: "Implement", runId: "900" },
  now: () => new Date("2026-09-13T00:00:00Z"),
  sleep: async () => {},
  ...overrides,
});

const capturingLog = (): { lines: string[]; restore: () => void } => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  return { lines, restore: () => (console.log = original) };
};

test("an implementer's failure carries its reason, its summary line and the tail of the newest run log", () => {
  const reads = inMemory({
    failureReason: () => "the tests never went green\nand the branch was left dirty\n",
    newestRunLog: () => ({ name: "claude-2.log", text: "line one\nline two\nline three" }),
  });
  const failure = assembleRun(reads, facts()).implementFailure("failure");
  assert.equal(failure.kind, "implement");
  assert.equal(failure.summary, "implement: the tests never went green");
  assert.match(failure.output, /^Reason: the tests never went green\nand the branch was left dirty$/m);
  assert.match(failure.output, /Log tail \(claude-2\.log, last 3 lines\):\nline one\nline two\nline three/);
  assert.equal(failure.requeue, undefined, "an attempt that reached an account is the ticket's failure");
});

test("an attempt that wrote no reason is described by how it ended, and a rate-limited one requeues", () => {
  const reads = inMemory({ rateLimited: () => true });
  const failure = assembleRun(reads, facts()).implementFailure("cancelled");
  assert.match(failure.summary, /^implement: the run was killed before it could report a reason/);
  assert.equal(failure.requeue, RATE_LIMITED_REASON, "every account rate limited is not the ticket's failure");
  assert.doesNotMatch(failure.output, /Log tail/, "a run with no log gets no log tail section");
});

/* The reads the wait for a head's checks runs on, assembled into its `ChecksNeeds` record. */

const checkRun = (name: string, runId: string, conclusion: string | null, status = "completed") => ({
  name,
  status,
  conclusion,
  html_url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
});

test("a head's checks are judged with each check run's workflow read, and this run's own is not the target's CI", () => {
  const asked: string[] = [];
  const reads = inMemory({
    commitStatuses: () => [
      { context: "factory/red-green", state: "success" },
      { context: "factory/test-integrity", state: "success" },
    ],
    checkRuns: () => [checkRun("retry", "900", "failure"), checkRun("build", "901", "failure"), checkRun("lint", "901", "failure")],
    workflowName: (runId) => {
      asked.push(runId);
      return runId === "900" ? "Implement" : "Target CI";
    },
  });
  const state = assembleRun(reads, facts()).checksNeeds().readChecks("abc1234");
  // The failing check runs of the target's own CI, and not this run's own job.
  assert.deepEqual(state.failures.map((f) => f.name), ["build", "lint"]);
  assert.deepEqual(state.pending, []);
  // Two check runs of one Actions run cost one read of its workflow name.
  assert.deepEqual(asked, ["900", "901"]);
});

test("a workflow name that cannot be read is logged, and the head is still judged", () => {
  const reads = inMemory({
    commitStatuses: () => [
      { context: "factory/red-green", state: "success" },
      { context: "factory/test-integrity", state: "failure", description: "a changed test passed on main", target_url: "https://github.com/o/r/actions/runs/7" },
    ],
    checkRuns: () => [checkRun("build", "901", null, "in_progress")],
    workflowName: () => {
      throw new GhError(["api", "repos/o/r/actions/runs/901"], new Error("404 Not Found"));
    },
  });
  const log = capturingLog();
  let state;
  try {
    state = assembleRun(reads, facts()).checksNeeds().readChecks("abc1234");
  } finally {
    log.restore();
  }
  assert.ok(log.lines.some((line) => line.includes("404 Not Found")), "the failed read was not logged");
  assert.deepEqual(state.failures.map((f) => f.name), ["factory/test-integrity"]);
  assert.deepEqual(state.pending, ["build"], "a check run whose workflow is unknown is still the target's");
});

test("the open PR's mergeability is read as GitHub reports it, and a PR that closed mid-wait has none", () => {
  const pr = { number: "12", facts: { headRef: "agent/issue-7-x", body: "" } };
  const open = assembleRun(inMemory({ prView: () => ({ state: "OPEN", mergeable: "CONFLICTING", baseRefName: "release" }) }), facts())
    .checksNeeds()
    .prMergeability(pr);
  assert.deepEqual(open, { pr, mergeable: "CONFLICTING", base: "release" });
  const gone = assembleRun(inMemory({ prView: () => ({ state: "MERGED", mergeable: "MERGEABLE", baseRefName: "main" }) }), facts())
    .checksNeeds()
    .prMergeability(pr);
  assert.equal(gone, undefined, "nothing is handed off or labeled on a PR no longer open");
});

/* The failing checks' output, which is what a retry marker or an escalation comment carries. */

const failure = (kind: "verdict" | "merge-gate" | "ci", name: string, runId = "901"): CheckFailure => ({
  name,
  kind,
  description: "",
  url: `https://github.com/o/r/actions/runs/${runId}`,
});

const outputOf = (reads: RunNeeds, failures: readonly CheckFailure[]): Promise<string> =>
  assembleRun(reads, facts()).checksNeeds().failuresOutput(failures);

test("a failing verdict is reported as the reviewer wrote it: its PR body section and its summary", async () => {
  const reads = inMemory({
    verdictPrBody: () => `Closes #7\n${SECTION_START}\n2 of 5 criteria unticked\n${SECTION_END}\ntrailing`,
    verdictSummary: () => "criterion 3 has no test\n",
  });
  const output = await outputOf(reads, [failure("verdict", "factory/verdict")]);
  assert.match(output, /^## factory\/verdict: verdict failure\n/);
  assert.match(output, /2 of 5 criteria unticked\n\ncriterion 3 has no test/);
  assert.doesNotMatch(output, /Closes #7|trailing/, "only the verdict section, never the whole PR body");
});

test("a verdict whose files the job never wrote says so rather than reporting an empty failure", async () => {
  const output = await outputOf(inMemory(), [failure("verdict", "factory/verdict")]);
  assert.match(output, /\(the verdict files were not found\)/);
});

test("a verdict the reviewer summarised but posted no section for is reported from the summary", async () => {
  const output = await outputOf(inMemory({ verdictPrBody: () => "Closes #7", verdictSummary: () => "the run died before it posted" }), [
    failure("verdict", "factory/verdict"),
  ]);
  assert.match(output, /the run died before it posted/);
  assert.doesNotMatch(output, /the verdict files were not found/);
});

test("a merge gate failure is reported from the run's artifact, read once for every failure of that run", async () => {
  const downloaded: string[] = [];
  const reads = inMemory({
    mergeGateArtifact: async (runId) => {
      downloaded.push(runId);
      return {
        mergeGate: { redGreen: { ok: false, reasons: ["factory/plan.test.ts passed on main"] } },
        baseLog: "base log line",
        headLog: "head log line",
      };
    },
  });
  const output = await outputOf(reads, [failure("merge-gate", "factory/red-green"), failure("merge-gate", "factory/test-integrity")]);
  assert.match(output, /factory\/plan\.test\.ts passed on main/);
  assert.match(output, /base log line/);
  assert.deepEqual(downloaded, ["901"], "one run's artifact is downloaded once, however many of its checks failed");
});

test("a merge gate run that uploaded no artifact falls back to its failed-step log", async () => {
  const reads = inMemory({ failedRunLog: (runId) => `the failed steps of run ${runId}` });
  const output = await outputOf(reads, [failure("merge-gate", "factory/red-green")]);
  assert.match(output, /uploaded no merge-gate\.json/);
  assert.match(output, /the failed steps of run 901/);
});

test("a target CI failure is reported from that run's failed-step log, and a log that cannot be read says so", async () => {
  const readable = await outputOf(inMemory({ failedRunLog: () => "  build failed: exit 2  " }), [failure("ci", "build")]);
  assert.match(readable, /^## build: ci failure\n/);
  assert.match(readable, /build failed: exit 2/);
  const unreadable = await outputOf(
    inMemory({
      failedRunLog: () => {
        throw new GhError(["run", "view", "901"], new Error("403 Forbidden"));
      },
    }),
    [failure("ci", "build")],
  );
  assert.match(unreadable, /could not read the log of run 901.*403 Forbidden/s, "a log the run cannot read costs the detail, not the failure");
});

test("a failing check whose url names no run is reported without one", async () => {
  const output = await outputOf(inMemory(), [{ name: "build", kind: "ci", description: "timed_out", url: null }]);
  assert.match(output, /^## build: ci failure \(timed_out\)\n/);
  assert.match(output, /\(no run log: no url\)/);
});
