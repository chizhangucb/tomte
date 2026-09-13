/**
 * The retry handler's wait for a head's checks, driven with an injected clock so
 * no real time passes (#285). `waitForChecks` is the loop; `checks.ts` decides
 * whether one observation ends the wait (`waitOver`) and what a stopped wait
 * means (`stillPendingReason`), and those are `checks.test.ts`'s subject. Here
 * the clock and the reads come through a `ChecksNeeds` record, and a test drives
 * the wait to each outcome by advancing the clock: the sleep the wait calls is
 * the only thing that moves it, so the suite waits on nothing.
 *
 * Each outcome is carried all the way through `main` (the failed-attempt path),
 * so the assertion is on what the handler wrote, never on a `gh` command: a
 * settled failure, a requeue, the two conflict hand-offs, and a PR that closed
 * mid-wait with nothing to write.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { BLOCKED_LABEL, IMPLEMENT_LABEL } from "../lib/labels.ts";
import type { CheckState } from "./checks.ts";
import type { Mergeability, Subject } from "./decide.ts";
import {
  type ChecksNeeds,
  type ChecksWait,
  type Failure,
  type OpenPr,
  type PrMergeability,
  type RetryConfig,
  type RetryNeeds,
  type Target,
  main,
  waitForChecks,
} from "./retry.ts";

/** A clock a test moves only by the sleep the wait calls, so no wall-clock time passes. */
const fakeClock = (): { now: () => Date; sleep: (ms: number) => Promise<void>; elapsed: () => number } => {
  let ms = 0;
  return {
    now: () => new Date(ms),
    sleep: async (delta: number) => {
      ms += delta;
    },
    elapsed: () => ms,
  };
};

/** One poll's worth of checks and mergeability, replayed in order and then held on the last. */
const poll = <T>(readings: readonly T[]): (() => T) => {
  let i = 0;
  return () => readings[Math.min(i++, readings.length - 1)]!;
};

const pending = (contexts: string[]): CheckState => ({ pending: contexts, failures: [] });
const failed = (kind: Failure["kind"], name: string): CheckState => ({
  pending: [],
  failures: [{ name, kind, description: "", url: null }],
});
const mergeable = (pr: OpenPr, m: Mergeability): PrMergeability => ({ pr, mergeable: m, base: "main" });

/** The reads and clock the wait needs; a test overrides `readChecks`/`prMergeability` per outcome. */
const checksNeeds = (clock: ReturnType<typeof fakeClock>, overrides: Partial<ChecksNeeds> = {}): ChecksNeeds => ({
  now: clock.now,
  sleep: clock.sleep,
  readChecks: () => pending(["slow-ci"]),
  prMergeability: () => undefined,
  failuresOutput: async () => "log tail",
  ...overrides,
});

/** A PR read at three minutes and polled at one, so the deadline is three polls out. */
const wait: ChecksWait = { sha: "abc1234def", timeoutMs: 60_000, pollMs: 20_000 };

/* --- the failed-attempt path's record, to assert what the handler wrote --- */

type Recorded =
  | { op: "addLabel"; on: Subject; label: string }
  | { op: "removeLabel"; on: Subject; label: string }
  | { op: "comment"; on: Subject; body: string }
  | { op: "ensureRetryLabel"; label: string }
  | { op: "closePr"; number: string; comment: string }
  | { op: "disarmAutoMerge"; number: string };

const inMemory = (overrides: Partial<RetryNeeds> = {}): { needs: RetryNeeds; writes: Recorded[] } => {
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

const config: RetryConfig = { branch: "agent/issue-7-x", runUrl: "https://run", failureKind: "checks" };

const factoryPr: OpenPr = { number: "12", facts: { headRef: "agent/issue-7-x", body: "" } };
const contributorPr: OpenPr = { number: "12", facts: { headRef: "contributor/fix", body: "please review" } };

/** Run the wait, then the failed-attempt path when it built a failure, the way the entry point does. */
const drive = async (
  checks: ChecksNeeds,
  needs: RetryNeeds,
  target: Target,
  pr: OpenPr | undefined,
): Promise<Failure | undefined> => {
  const failure = await waitForChecks(checks, wait, pr);
  if (failure) main(needs, config, target, failure);
  return failure;
};

/* One test per wait outcome (acceptance criterion 2). */

test("settled checks that fail drive a retry, without the clock moving at all", async () => {
  const clock = fakeClock();
  const checks = checksNeeds(clock, { readChecks: () => failed("verdict", "factory/verdict") });
  const target: Target = { issue: "7", pr: factoryPr };
  const { needs, writes } = inMemory();
  await drive(checks, needs, target, factoryPr);
  // The record on the ticket, the implementer's label on the factory PR.
  assert.ok(writes.some((w) => w.op === "comment" && w.on.kind === "issue" && w.on.number === "7"));
  assert.ok(writes.some((w) => w.op === "addLabel" && w.on.kind === "pr" && w.on.number === "12" && w.label === IMPLEMENT_LABEL));
  // Settled on the first read: the loop never slept.
  assert.equal(clock.elapsed(), 0);
});

test("a check still pending at the deadline is requeued, the clock moved only by the injected sleep", async () => {
  const clock = fakeClock();
  // Always pending, no PR to read: the wait runs to the deadline and requeues.
  const checks = checksNeeds(clock, { readChecks: () => pending(["slow-ci"]) });
  const target: Target = { issue: "7", pr: undefined };
  const { needs, writes } = inMemory();
  const failure = await drive(checks, needs, target, undefined);
  assert.match(failure?.requeue ?? "", /still pending/);
  assert.deepEqual(writes.map((w) => w.op), ["comment"], "a requeue spends no retry and labels nothing");
  // Three polls carried the clock to the deadline; no wall-clock time passed.
  assert.equal(clock.elapsed(), 60_000);
});

test("a conflict mid-wait on a factory-authored PR hands it to the implementer", async () => {
  const clock = fakeClock();
  const checks = checksNeeds(clock, {
    readChecks: () => pending(["factory/red-green (not posted yet)"]),
    // Mergeable on the first poll, conflicting on the second: the conflict arrives mid-wait.
    prMergeability: poll([mergeable(factoryPr, "MERGEABLE"), mergeable(factoryPr, "CONFLICTING")]),
  });
  const target: Target = { issue: "7", pr: factoryPr };
  const { needs, writes } = inMemory();
  await drive(checks, needs, target, factoryPr);
  assert.ok(writes.some((w) => w.op === "comment" && w.on.kind === "pr" && w.on.number === "12"));
  assert.ok(writes.some((w) => w.op === "addLabel" && w.on.kind === "pr" && w.on.number === "12" && w.label === IMPLEMENT_LABEL));
  assert.ok(!writes.some((w) => w.op === "ensureRetryLabel"), "a hand-off spends no retry");
  // The wait ended on the second poll, one sleep in, not at the deadline.
  assert.equal(clock.elapsed(), 20_000);
});

test("a conflict mid-wait on a PR the factory did not author tells its author", async () => {
  const clock = fakeClock();
  const checks = checksNeeds(clock, {
    readChecks: () => pending(["factory/red-green (not posted yet)"]),
    prMergeability: poll([mergeable(contributorPr, "MERGEABLE"), mergeable(contributorPr, "CONFLICTING")]),
  });
  const target: Target = { issue: "7", pr: contributorPr };
  const { needs, writes } = inMemory();
  await drive(checks, needs, target, contributorPr);
  assert.ok(writes.some((w) => w.op === "addLabel" && w.on.kind === "pr" && w.on.number === "12" && w.label === BLOCKED_LABEL));
  assert.ok(writes.some((w) => w.op === "comment" && w.on.kind === "pr" && w.on.number === "12"));
  assert.ok(!writes.some((w) => w.op === "addLabel" && w.label === IMPLEMENT_LABEL), "no implementer on a branch the factory did not open");
  assert.equal(clock.elapsed(), 20_000);
});

test("a PR that closed mid-wait leaves nothing written", async () => {
  const clock = fakeClock();
  // The PR was open when the run started but closed as the wait ran: its mergeability reads undefined.
  const checks = checksNeeds(clock, {
    readChecks: () => pending(["slow-ci"]),
    prMergeability: () => undefined,
  });
  // A PR with no ticket: there is nothing to fall back to, so the requeue writes nothing (#133).
  const target: Target = { issue: undefined, pr: factoryPr };
  const { needs, writes } = inMemory();
  const failure = await drive(checks, needs, target, factoryPr);
  assert.match(failure?.requeue ?? "", /still pending/);
  assert.deepEqual(writes, [], "a PR that closed mid-wait with no ticket behind it is written nothing");
  assert.equal(clock.elapsed(), 60_000);
});
