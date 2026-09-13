/**
 * The retry handler's failed-attempt path driven through its needs record with
 * an in-memory target repo and no network, in the style of `sweep.test.ts`
 * (#281) and `heartbeat.test.ts`. `decide.ts` decides what to do; this proves
 * `main` carries those decisions out: the labels, comments, close and
 * auto-merge disarm it writes for each outcome, and that a write it allows to
 * fail softly is logged and the run continues.
 *
 * What `decide` decides is `decide.test.ts`'s subject and is not re-checked
 * here; these are the writes those decisions produce. The record is driven
 * with a resolved target and a built failure, the two the entry point
 * (`retry-run.ts`) assembles from GitHub before it calls `main`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { GhError } from "../lib/gh.ts";
import { BLOCKED_LABEL, ESCALATION_LABEL, IMPLEMENT_LABEL } from "../lib/labels.ts";
import { MAX_RETRIES, RATE_LIMITED_REASON, type Subject } from "./decide.ts";
import {
  type Failure,
  type OpenPr,
  type RetryConfig,
  type RetryNeeds,
  type Target,
  main,
} from "./retry.ts";

/** One recorded write, so a test asserts on what the handler wrote and never on a `gh` command. */
type Recorded =
  | { op: "addLabel"; on: Subject; label: string }
  | { op: "removeLabel"; on: Subject; label: string }
  | { op: "comment"; on: Subject; body: string }
  | { op: "ensureRetryLabel"; label: string }
  | { op: "closePr"; number: string; comment: string }
  | { op: "disarmAutoMerge"; number: string };

/** An in-memory target repo: the reads a test prepares, and every write recorded rather than sent. */
const inMemory = (
  overrides: Partial<RetryNeeds> = {},
): { needs: RetryNeeds; writes: Recorded[] } => {
  const writes: Recorded[] = [];
  const needs: RetryNeeds = {
    viewPr: () => ({ state: "OPEN", body: "", headRefName: "agent/issue-7-x" }),
    openPrs: () => [],
    labelsOf: () => [],
    branchExists: () => true,
    artifactUrl: () => undefined,
    addLabel: (on, label) => writes.push({ op: "addLabel", on, label }),
    removeLabel: (on, label) => writes.push({ op: "removeLabel", on, label }),
    comment: (on, body) => writes.push({ op: "comment", on, body }),
    ensureRetryLabel: (label) => writes.push({ op: "ensureRetryLabel", label }),
    closePr: (number, comment) => writes.push({ op: "closePr", number, comment }),
    disarmAutoMerge: (number) => writes.push({ op: "disarmAutoMerge", number }),
    ...overrides,
  };
  return { needs, writes };
};

const config = (overrides: Partial<RetryConfig> = {}): RetryConfig => ({
  branch: "agent/issue-7-x",
  runUrl: "https://run",
  failureKind: "implement",
  ...overrides,
});

const failure = (overrides: Partial<Failure> = {}): Failure => ({
  kind: "implement",
  summary: "implement: it fell over",
  output: "log tail",
  ...overrides,
});

const factoryPr: OpenPr = { number: "12", facts: { headRef: "agent/issue-7-x", body: "" } };
const contributorPr: OpenPr = { number: "12", facts: { headRef: "contributor/fix", body: "please review" } };

/** labelsOf answers per subject kind, so a hold or a spent retry can sit on one and not the other. */
const labels = (issue: readonly string[], pr: readonly string[] = []): RetryNeeds["labelsOf"] => (on) =>
  on.kind === "issue" ? [...issue] : [...pr];

const capturingLog = (): { lines: string[]; restore: () => void } => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  return { lines, restore: () => (console.log = original) };
};

/* One test per outcome of the failed-attempt path (acceptance criterion 3). */

test("a retry with retries left records it on the ticket and hands the factory PR to the implementer", () => {
  const target: Target = { issue: "7", pr: factoryPr };
  const { needs, writes } = inMemory({ labelsOf: labels(["ready-for-agent", "agent:in-progress"], ["agent:in-progress"]) });
  main(needs, config(), target, failure());
  // The record (comment + count) lands on the ticket; the implementer's label on the PR.
  assert.deepEqual(
    writes.map((w) => (w.op === "comment" || w.op === "addLabel" ? `${w.op} ${w.on.kind}#${w.on.number}${w.op === "addLabel" ? ` ${w.label}` : ""}` : `${w.op} ${w.op === "ensureRetryLabel" ? w.label : ""}`)),
    [
      "comment issue#7",
      "ensureRetryLabel factory:retry-1",
      "addLabel issue#7 factory:retry-1",
      `addLabel pr#12 ${IMPLEMENT_LABEL}`,
    ],
  );
});

test("a tell-author on a failing check blocks the PR the factory did not author and tells its author", () => {
  const target: Target = { issue: "7", pr: contributorPr };
  const { needs, writes } = inMemory({ labelsOf: labels(["ready-for-agent", "agent:review"], ["agent:review"]) });
  main(needs, config({ failureKind: "checks" }), target, failure({ kind: "verdict", summary: "verdict: 2 of 5 unticked" }));
  // The record still lands on the ticket; the PR is blocked and its author told.
  assert.ok(writes.some((w) => w.op === "addLabel" && w.on.kind === "pr" && w.on.number === "12" && w.label === BLOCKED_LABEL));
  assert.ok(writes.some((w) => w.op === "comment" && w.on.kind === "pr" && w.on.number === "12"));
  // Never the implementer's label on a branch the factory did not open.
  assert.ok(!writes.some((w) => w.op === "addLabel" && w.on.kind === "pr" && w.label === IMPLEMENT_LABEL));
});

test("an escalation at the cap on a factory-authored PR closes it and parks the ticket", () => {
  const target: Target = { issue: "7", pr: factoryPr };
  const { needs, writes } = inMemory({ labelsOf: labels(["ready-for-agent", "agent:review", "factory:retry-1"], ["agent:review"]) });
  main(needs, config({ failureKind: "checks" }), target, failure({ kind: "verdict" }));
  assert.ok(writes.some((w) => w.op === "closePr" && w.number === "12"));
  assert.ok(writes.some((w) => w.op === "addLabel" && w.on.kind === "issue" && w.on.number === "7" && w.label === ESCALATION_LABEL));
  assert.ok(writes.some((w) => w.op === "comment" && w.on.kind === "issue" && w.on.number === "7"));
  // A closed PR keeps auto-merge with it: no separate disarm.
  assert.ok(!writes.some((w) => w.op === "disarmAutoMerge"));
});

test("an escalation at the cap on a PR the factory did not author leaves it open, disarmed and blocked", () => {
  const target: Target = { issue: "7", pr: contributorPr };
  const { needs, writes } = inMemory({ labelsOf: labels(["ready-for-agent", "agent:review", "factory:retry-1"], ["agent:review"]) });
  main(needs, config({ failureKind: "checks" }), target, failure({ kind: "verdict" }));
  assert.ok(!writes.some((w) => w.op === "closePr"), "a PR the factory did not author must not be closed");
  assert.ok(writes.some((w) => w.op === "disarmAutoMerge" && w.number === "12"));
  assert.ok(writes.some((w) => w.op === "addLabel" && w.on.kind === "pr" && w.on.number === "12" && w.label === ESCALATION_LABEL));
  // The ticket carries the escalation, and the left-open PR gets its own note.
  assert.ok(writes.some((w) => w.op === "addLabel" && w.on.kind === "issue" && w.label === ESCALATION_LABEL));
  assert.ok(writes.some((w) => w.op === "comment" && w.on.kind === "pr" && w.on.number === "12"));
});

test("a rate-limited requeue comments and spends no retry", () => {
  const target: Target = { issue: "7", pr: undefined };
  const { needs, writes } = inMemory({ labelsOf: labels(["ready-for-agent"]) });
  main(needs, config(), target, failure({ requeue: RATE_LIMITED_REASON }));
  assert.deepEqual(
    writes.map((w) => w.op),
    ["comment"],
    "a requeue spends no retry and labels nothing for a human",
  );
  assert.equal(writes[0]!.op === "comment" && writes[0]!.on.number, "7");
});

test("a stand-down on a hold comments where the hold is and starts nothing", () => {
  const target: Target = { issue: "7", pr: undefined };
  const { needs, writes } = inMemory({ labelsOf: labels(["ready-for-agent", "hold"]) });
  main(needs, config(), target, failure());
  assert.deepEqual(writes.map((w) => w.op), ["comment"], "standing down writes only a comment");
  assert.ok(!writes.some((w) => w.op === "ensureRetryLabel"), "a stand-down spends no retry");
  assert.ok(!writes.some((w) => w.op === "addLabel"), "a stand-down starts nothing and escalates nothing");
});

/* Soft-fail policy: which writes may fail softly is the handler's own (acceptance criterion 2). */

test("a soft write that fails is logged and the run continues", () => {
  const target: Target = { issue: "7", pr: contributorPr };
  const { needs, writes } = inMemory({
    labelsOf: labels(["ready-for-agent", "agent:review", "factory:retry-1"], ["agent:review"]),
    // Disarming auto-merge is refused when none was armed: the handler shrugs it off.
    disarmAutoMerge: () => {
      throw new GhError(["pr", "merge"], new Error("no auto-merge was armed"));
    },
  });
  const log = capturingLog();
  try {
    main(needs, config({ failureKind: "checks" }), target, failure({ kind: "verdict" }));
  } finally {
    log.restore();
  }
  // The failure was logged, not thrown.
  assert.ok(log.lines.some((line) => line.includes("no auto-merge was armed")), "the soft failure was not logged");
  // And the run carried on: the ticket was still parked and commented.
  assert.ok(writes.some((w) => w.op === "addLabel" && w.on.kind === "issue" && w.label === ESCALATION_LABEL));
  assert.ok(writes.some((w) => w.op === "comment" && w.on.kind === "issue" && w.on.number === "7"));
});
