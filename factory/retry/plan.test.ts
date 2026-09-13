/**
 * The plan a failed attempt produces (#310): `decide` says which verb, and
 * `planFor` turns that verb, the run's target, its config and its failure into
 * the ordered list of effects the handler then applies. Pure, so every arm is
 * asserted as a value here rather than by reading `retry.ts` as source text,
 * and `retry.test.ts` asserts what `main` wrote through `RetryNeeds`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { BLOCKED_LABEL, ESCALATION_LABEL, IMPLEMENT_LABEL, IN_PROGRESS_LABEL } from "../lib/labels.ts";
import { CONFLICT_REASON, RATE_LIMITED_REASON } from "./decide.ts";
import { type Effect, type OpenPr, type PlanReads, type RetryConfig, type Target, planFor } from "./plan.ts";

const config: RetryConfig = { branch: "agent/issue-7-x", runUrl: "https://run", failureKind: "implement" };

const failure = { kind: "implement" as const, summary: "implement: it fell over", output: "log tail" };

const factoryPr: OpenPr = { number: "12", facts: { headRef: "agent/issue-7-x", body: "" } };
const contributorPr: OpenPr = { number: "12", facts: { headRef: "contributor/fix", body: "please review" } };

/** The costly reads only the escalation arm makes; unread is what every other arm leaves them. */
const reads = (overrides: Partial<PlanReads> = {}): PlanReads => ({
  labelsOf: () => [],
  branchExists: () => true,
  artifactUrl: () => undefined,
  ...overrides,
});

/** One effect as a line, so an arm's whole ordered list reads as one assertion. */
const lines = (effects: readonly Effect[]): string[] =>
  effects.map((effect) => {
    switch (effect.kind) {
      case "comment":
      case "note":
        return `${effect.kind} ${effect.on.kind}#${effect.on.number}`;
      case "add-label":
      case "remove-label":
        return `${effect.kind} ${effect.on.kind}#${effect.on.number} ${effect.label}`;
      case "ensure-label":
        return `ensure-label ${effect.label}`;
      case "park-pr":
        return `park-pr pr#${effect.number} ${effect.label}`;
      case "close-pr":
        return `close-pr pr#${effect.number}`;
      case "disarm-auto-merge":
        return `disarm-auto-merge pr#${effect.number}`;
      case "mark-requeued":
        return `mark-requeued ${effect.reason}`;
      case "log":
        return "log";
    }
  });

test("a retry records the attempt on the ticket, then starts the implementer on the factory PR last", () => {
  const target: Target = { issue: "7", pr: factoryPr };
  const effects = planFor({ decision: { action: "retry", retry: 1 }, target, config, failure }, reads());
  assert.deepEqual(lines(effects), [
    "comment issue#7",
    "ensure-label factory:retry-1",
    "add-label issue#7 factory:retry-1",
    `add-label pr#12 ${IMPLEMENT_LABEL}`,
    "log",
  ]);
});

test("a requeue comments where the sweep will find the subject and spends no retry", () => {
  const onTicket = planFor(
    { decision: { action: "requeue", reason: RATE_LIMITED_REASON }, target: { issue: "7", pr: undefined }, config, failure },
    reads(),
  );
  assert.deepEqual(lines(onTicket), ["comment issue#7", "log"]);
  // On a PR the reconciler is the sweep, so the PR keeps the label it sweeps and
  // the marker file tells the workflow steps not to take it off (#148).
  const onPr = planFor(
    { decision: { action: "requeue", reason: RATE_LIMITED_REASON }, target: { issue: "7", pr: factoryPr }, config, failure },
    reads(),
  );
  assert.deepEqual(lines(onPr), [
    "comment pr#12",
    `add-label pr#12 ${IN_PROGRESS_LABEL}`,
    `mark-requeued ${RATE_LIMITED_REASON}`,
    "log",
  ]);
});

test("a stand-down comments where the hold is, starts nothing and escalates nothing", () => {
  const hold = { label: "hold", on: { kind: "issue" as const, number: "7" } };
  const effects = planFor(
    {
      decision: { action: "stand-down", hold, reason: "`hold` is on ticket #7" },
      target: { issue: "7", pr: undefined },
      config,
      failure,
    },
    reads(),
  );
  assert.deepEqual(lines(effects), ["comment issue#7", "log"]);
  // Criteria 2 and 3 of #185: no retry counted, nothing started, nothing parked.
  assert.ok(!effects.some((e) => e.kind === "add-label" || e.kind === "ensure-label" || e.kind === "remove-label"));
});

test("a stand-down leaves the open PR where a requeue leaves one, for the reconciler", () => {
  const hold = { label: "hold", on: { kind: "pr" as const, number: "12" } };
  const effects = planFor(
    { decision: { action: "stand-down", hold, reason: "`hold` is on PR #12" }, target: { issue: "7", pr: factoryPr }, config, failure },
    reads(),
  );
  assert.deepEqual(lines(effects), ["comment pr#12", `add-label pr#12 ${IN_PROGRESS_LABEL}`, "mark-requeued `hold` is on PR #12", "log"]);
});

test("a decision to do nothing does nothing", () => {
  const effects = planFor(
    { decision: { action: "none", reason: "already escalated" }, target: { issue: "7", pr: factoryPr }, config, failure },
    reads(),
  );
  assert.deepEqual(effects, []);
});

/** The body of the one comment an arm plans, for the assertions that read what it says. */
const bodyOf = (effects: readonly Effect[], on: "issue" | "pr"): string => {
  const found = effects.find((e) => (e.kind === "comment" || e.kind === "note") && e.on.kind === on);
  assert.ok(found, `no comment on the ${on}`);
  return found.kind === "comment" || found.kind === "note" ? found.body : "";
};

test("a hand-off comments the conflict, then labels the factory PR, and the plan carries the base it names", () => {
  const effects = planFor(
    {
      decision: { action: "hand-off", reason: CONFLICT_REASON },
      target: { issue: "7", pr: factoryPr },
      config,
      failure: { ...failure, kind: "ci", mergeability: { pr: factoryPr, mergeable: "CONFLICTING", base: "main" } },
    },
    reads(),
  );
  assert.deepEqual(lines(effects), ["comment pr#12", `add-label pr#12 ${IMPLEMENT_LABEL}`, "log"]);
  // The base is in the rendered body, so nothing downstream has to read it again.
  assert.match(bodyOf(effects, "pr"), /merges `main` into the branch/);
});

test("a hand-off on a PR the factory did not author blocks it and tells its author, naming the base", () => {
  const effects = planFor(
    {
      decision: { action: "hand-off", reason: CONFLICT_REASON },
      target: { issue: "7", pr: contributorPr },
      config,
      failure: { ...failure, kind: "ci", mergeability: { pr: contributorPr, mergeable: "CONFLICTING", base: "main" } },
    },
    reads(),
  );
  // The label goes on first, then the note: by the time the author reads it, the label is on.
  assert.deepEqual(lines(effects), [`add-label pr#12 ${BLOCKED_LABEL}`, "comment pr#12", "log"]);
  assert.match(bodyOf(effects, "pr"), /conflicts with `main`/);
  assert.ok(!effects.some((e) => e.kind === "add-label" && e.label === IMPLEMENT_LABEL));
});

test("a retry on a PR the factory did not author records the attempt and tells its author instead of starting one", () => {
  const effects = planFor(
    { decision: { action: "retry", retry: 1 }, target: { issue: "7", pr: contributorPr }, config, failure },
    reads(),
  );
  assert.deepEqual(lines(effects), [
    "comment issue#7",
    "ensure-label factory:retry-1",
    "add-label issue#7 factory:retry-1",
    `add-label pr#12 ${BLOCKED_LABEL}`,
    "comment pr#12",
    "log",
    "log",
  ]);
  // The retry just recorded was the ticket's last, so the author is told the next failure escalates.
  assert.match(bodyOf(effects, "pr"), /last attempt/);
});

const escalated = { action: "escalate" as const, reason: "the retry failed too (2 attempts, 1 retry allowed)" };

test("an escalation closes the factory PR, then parks the ticket with the record", () => {
  const effects = planFor(
    { decision: escalated, target: { issue: "7", pr: factoryPr }, config, failure },
    reads({ labelsOf: (on) => (on.kind === "pr" ? ["agent:review"] : ["ready-for-agent", "agent:review", "factory:retry-1"]) }),
  );
  assert.deepEqual(lines(effects), [
    "remove-label pr#12 agent:review",
    "close-pr pr#12",
    "remove-label issue#7 ready-for-agent",
    "remove-label issue#7 agent:review",
    `add-label issue#7 ${ESCALATION_LABEL}`,
    "comment issue#7",
    "log",
  ]);
  // A closed PR takes auto-merge with it, and needs no parking label of its own.
  assert.ok(!effects.some((e) => e.kind === "disarm-auto-merge" || e.kind === "park-pr"));
});

test("an escalation leaves a PR the factory did not author open, parked and disarmed, with its own note", () => {
  const effects = planFor(
    { decision: escalated, target: { issue: "7", pr: contributorPr }, config, failure },
    reads({
      labelsOf: (on) => (on.kind === "pr" ? ["agent:review"] : ["ready-for-agent", "factory:retry-1"]),
      branchExists: () => false,
      artifactUrl: () => "https://log",
    }),
  );
  assert.deepEqual(lines(effects), [
    "remove-label pr#12 agent:review",
    `park-pr pr#12 ${ESCALATION_LABEL}`,
    "disarm-auto-merge pr#12",
    "remove-label issue#7 ready-for-agent",
    `add-label issue#7 ${ESCALATION_LABEL}`,
    "comment issue#7",
    "note pr#12",
    "log",
  ]);
  // The reads the arm made are in the record a human reads, not asked for and dropped.
  const record = bodyOf(effects, "issue");
  assert.match(record, /Run log: https:\/\/log/);
  assert.match(record, /No branch was pushed/);
  assert.match(record, /PR #12 is left open/);
});

test("only the escalation arm pays for the escalation's reads", () => {
  const asked: string[] = [];
  const counting = reads({
    labelsOf: (on) => (asked.push(`labelsOf ${on.kind}`), []),
    branchExists: () => (asked.push("branchExists"), true),
    artifactUrl: () => (asked.push("artifactUrl"), undefined),
  });
  planFor({ decision: { action: "retry", retry: 1 }, target: { issue: "7", pr: factoryPr }, config, failure }, counting);
  planFor({ decision: { action: "requeue", reason: RATE_LIMITED_REASON }, target: { issue: "7", pr: undefined }, config, failure }, counting);
  assert.deepEqual(asked, [], "an arm that escalates nothing still pays for the escalation comment's reads");
  planFor({ decision: escalated, target: { issue: "7", pr: factoryPr }, config, failure }, counting);
  assert.deepEqual(asked, ["labelsOf pr", "labelsOf issue", "artifactUrl", "branchExists"]);
});

test("a hand-off with no mergeability read names no PR and writes nothing", () => {
  // `decide` answers hand-off only from a mergeability it was given, and one is
  // given only from a read, so this is a state it cannot reach. What used to be
  // a throw in the handler is a line in the plan (#310): there is no PR named
  // and no base to merge, so the plan writes nothing rather than guessing.
  const effects = planFor(
    { decision: { action: "hand-off", reason: CONFLICT_REASON }, target: { issue: "7", pr: factoryPr }, config, failure },
    reads(),
  );
  assert.deepEqual(lines(effects), ["log"]);
  assert.match(effects[0]!.kind === "log" ? effects[0]!.line : "", /no mergeability read/);
});
