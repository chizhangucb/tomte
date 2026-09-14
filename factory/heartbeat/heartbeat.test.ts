/**
 * The heartbeat's one decision, driven with a stand-in reader and waker and no
 * network, in the style of `dispatch/select.test.ts`: prepared state in, an
 * outcome per target out. A maintainer's question is which targets got woken,
 * which were skipped as idle and whether a failure was reported, so nothing
 * here reaches into how the pass is run.
 *
 * Which labels mean work is `work.test.ts`'s subject, tied there to the
 * factory's own definitions. These are the outcomes those rules produce.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_DEADLINES } from "../dispatch/reconcile.ts";
import { BLOCKED_LABEL, ESCALATION_LABEL, HOLD_LABEL, IMPLEMENT_LABEL, READY_LABEL } from "../lib/labels.ts";
import { type TargetOutcome, sendHeartbeat } from "./heartbeat.ts";
import { type OpenSubject } from "./work.ts";

/** An open ticket carrying these labels. */
const ticket = (...labels: string[]): OpenSubject => ({ pullRequest: false, labels });

/** An open pull request carrying these labels. */
const pullRequest = (...labels: string[]): OpenSubject => ({ pullRequest: true, labels });

/** A target with a ready ticket on it: work, whatever the rest of the pass is testing. */
const someWork = (): OpenSubject[] => [ticket(READY_LABEL)];

/**
 * The pass's clock, which every test drives rather than waits on (#264): what
 * is due is a question about when a subject last changed.
 */
const NOW = new Date("2026-09-12T12:00:00Z");

/** A subject last changed this many minutes before the pass. */
const changed = (minutes: number, subject: OpenSubject): OpenSubject => ({
  ...subject,
  changedAt: new Date(NOW.getTime() - minutes * 60_000).toISOString(),
});

/** No target is paused, which is every test that is not about the pause. */
const running = (): undefined => undefined;

test("every target on the list is woken, and each gets one outcome", () => {
  const woken: string[] = [];
  const outcomes = sendHeartbeat({
    now: () => NOW,
    targets: ["owner/one", "owner/two"],
    readPause: running,
    readOpenWork: someWork,
    wake: (target) => woken.push(target),
    report: () => {},
  });
  assert.deepEqual(woken, ["owner/one", "owner/two"]);
  assert.deepEqual(outcomes, [
    { target: "owner/one", outcome: "woken" },
    { target: "owner/two", outcome: "woken" },
  ]);
});

test("a target that cannot be woken is reported, and the targets behind it are still woken", () => {
  const woken: string[] = [];
  const reported: TargetOutcome[] = [];
  const outcomes = sendHeartbeat({
    now: () => NOW,
    targets: ["owner/bad", "owner/two", "owner/three"],
    readPause: running,
    readOpenWork: someWork,
    wake: (target) => {
      if (target === "owner/bad") throw new Error("HTTP 404: Not Found");
      woken.push(target);
    },
    report: (outcome) => reported.push(outcome),
  });
  assert.deepEqual(woken, ["owner/two", "owner/three"]);
  assert.deepEqual(outcomes, [
    { target: "owner/bad", outcome: "failed", error: "HTTP 404: Not Found" },
    { target: "owner/two", outcome: "woken" },
    { target: "owner/three", outcome: "woken" },
  ]);
  // Reported as the pass runs, so the failure is on the report whether or not
  // anything reads the outcomes back.
  assert.deepEqual(reported, outcomes);
});

test("a target with nothing open is skipped as idle, and never woken", () => {
  const woken: string[] = [];
  const outcomes = sendHeartbeat({
    now: () => NOW,
    targets: ["owner/idle"],
    readPause: running,
    readOpenWork: () => [],
    wake: (target) => woken.push(target),
    report: () => {},
  });
  assert.deepEqual(woken, []);
  assert.deepEqual(outcomes, [{ target: "owner/idle", outcome: "skipped" }]);
});

/** One prepared target state, and the outcome a maintainer should see for it. */
const states: { state: string; open: OpenSubject[]; outcome: "woken" | "skipped" }[] = [
  { state: "a ready ticket", open: [ticket(READY_LABEL)], outcome: "woken" },
  { state: "a ticket in a factory state label", open: [ticket(IMPLEMENT_LABEL)], outcome: "woken" },
  // No factory label on it: the reconciler asks for a verdict on an unjudged
  // pull request whoever produced it, so this target is swept.
  { state: "an open pull request from a producer", open: [pullRequest()], outcome: "woken" },
  { state: "a held ready ticket", open: [ticket(READY_LABEL, HOLD_LABEL)], outcome: "skipped" },
  { state: "a held ticket in a factory state label", open: [ticket(IMPLEMENT_LABEL, HOLD_LABEL)], outcome: "skipped" },
  { state: "a parked ticket", open: [ticket(ESCALATION_LABEL)], outcome: "skipped" },
  { state: "a parked pull request", open: [pullRequest(BLOCKED_LABEL)], outcome: "skipped" },
];

for (const { state, open, outcome } of states) {
  test(`a target whose only open work is ${state} is ${outcome}`, () => {
    const woken: string[] = [];
    const outcomes = sendHeartbeat({
      now: () => NOW,
      targets: ["owner/one"],
      readPause: running,
      readOpenWork: () => open,
      wake: (target) => woken.push(target),
      report: () => {},
    });
    assert.deepEqual(outcomes, [{ target: "owner/one", outcome }]);
    assert.deepEqual(woken, outcome === "woken" ? ["owner/one"] : []);
  });
}

test("a target with work open but nothing due is not woken, and says so apart from idle and paused", () => {
  // #264. Three targets, three reasons not to wake one, and a maintainer has to
  // be able to tell them apart: an idle target has nothing open, a paused one
  // has a human holding it, and this one is working and simply has nothing for
  // a sweep to do this pass.
  const woken: string[] = [];
  const reported: TargetOutcome[] = [];
  const outcomes = sendHeartbeat({
    now: () => NOW,
    targets: ["owner/nothing-due", "owner/idle", "owner/paused"],
    readPause: (target) => (target === "owner/paused" ? "incident" : undefined),
    readOpenWork: (target) => (target === "owner/idle" ? [] : [changed(90, ticket(IMPLEMENT_LABEL))]),
    wake: (target) => woken.push(target),
    report: (outcome) => reported.push(outcome),
  });
  assert.deepEqual(woken, []);
  assert.deepEqual(outcomes, [
    { target: "owner/nothing-due", outcome: "nothing-due" },
    { target: "owner/idle", outcome: "skipped" },
    { target: "owner/paused", outcome: "paused", reason: "incident" },
  ]);
  assert.deepEqual(reported, outcomes);
});

test("the same target is woken on the pass its deadline falls in", () => {
  // The other half: the outcome above is this pass and not this target, so a
  // subject nothing was due on at one pass is woken at the next deadline.
  const woken: string[] = [];
  const pass = (age: number): TargetOutcome[] =>
    sendHeartbeat({
      now: () => NOW,
      targets: ["owner/one"],
      readPause: running,
      readOpenWork: () => [changed(age, ticket(IMPLEMENT_LABEL))],
      wake: (target) => woken.push(target),
      report: () => {},
    });
  assert.deepEqual(pass(DEFAULT_DEADLINES.stuckMinutes), [{ target: "owner/one", outcome: "woken" }]);
  assert.deepEqual(woken, ["owner/one"]);
});

test("a target whose open work cannot be read is reported, and the targets behind it are still answered", () => {
  const woken: string[] = [];
  const reported: TargetOutcome[] = [];
  const outcomes = sendHeartbeat({
    now: () => NOW,
    targets: ["owner/unreadable", "owner/busy", "owner/idle"],
    readPause: running,
    readOpenWork: (target) => {
      if (target === "owner/unreadable") throw new Error("HTTP 403: Resource not accessible by personal access token");
      return target === "owner/busy" ? someWork() : [];
    },
    wake: (target) => woken.push(target),
    report: (outcome) => reported.push(outcome),
  });
  // Failed rather than woken anyway: a target nobody can read is a failure a
  // maintainer has to see, and waking it blind every interval would pay a
  // minute a pass to hide it.
  assert.deepEqual(woken, ["owner/busy"]);
  assert.deepEqual(outcomes, [
    { target: "owner/unreadable", outcome: "failed", error: "HTTP 403: Resource not accessible by personal access token" },
    { target: "owner/busy", outcome: "woken" },
    { target: "owner/idle", outcome: "skipped" },
  ]);
  assert.deepEqual(reported, outcomes);
});

test("a paused target is not woken, and its outcome carries the reason", () => {
  // Acceptance criterion 1. The pause stopped the work and not the run: the
  // heartbeat woke the target every interval, GitHub created a run, and the
  // caller's `paused` job billed a minute to say nothing was happening.
  const woken: string[] = [];
  const outcomes = sendHeartbeat({
    now: () => NOW,
    targets: ["owner/paused"],
    readPause: () => "runaway sweep, see #123",
    // Plenty waiting: the pause is what stops the wake, not the absence of work.
    readOpenWork: someWork,
    wake: (target) => woken.push(target),
    report: () => {},
  });
  assert.deepEqual(woken, []);
  assert.deepEqual(outcomes, [{ target: "owner/paused", outcome: "paused", reason: "runaway sweep, see #123" }]);
});

test("a paused target is told from an idle one, so a forgotten pause is visible in the pass", () => {
  // Acceptance criterion 2. Both are skipped and neither is woken, and that is
  // exactly why they may not share an outcome: a pause that reads as an idle
  // target in the log is how a pause left on for a week goes unnoticed.
  const reported: TargetOutcome[] = [];
  sendHeartbeat({
    now: () => NOW,
    targets: ["owner/paused", "owner/idle"],
    readPause: (target) => (target === "owner/paused" ? "incident" : undefined),
    readOpenWork: () => [],
    wake: () => {},
    report: (outcome) => reported.push(outcome),
  });
  assert.deepEqual(reported, [
    { target: "owner/paused", outcome: "paused", reason: "incident" },
    { target: "owner/idle", outcome: "skipped" },
  ]);
});

test("a target with the pause lifted is woken on the next pass, with nothing else done to it", () => {
  // Acceptance criterion 3. No decision is carried between passes, so the only
  // thing a resume needs is the variable gone.
  const pass = (reason: string | undefined): { woken: string[]; outcomes: TargetOutcome[] } => {
    const woken: string[] = [];
    const outcomes = sendHeartbeat({
      now: () => NOW,
      targets: ["owner/one"],
      readPause: () => reason,
      readOpenWork: someWork,
      wake: (target) => woken.push(target),
      report: () => {},
    });
    return { woken, outcomes };
  };
  assert.deepEqual(pass("incident").woken, []);
  const resumed = pass(undefined);
  assert.deepEqual(resumed.woken, ["owner/one"]);
  assert.deepEqual(resumed.outcomes, [{ target: "owner/one", outcome: "woken" }]);
});

test("one paused target changes nothing for the others in the same pass", () => {
  // Acceptance criterion 4. A pause is a property of one target, so it may not
  // reach the targets either side of it in the list.
  const woken: string[] = [];
  const outcomes = sendHeartbeat({
    now: () => NOW,
    targets: ["owner/busy", "owner/paused", "owner/also-busy"],
    readPause: (target) => (target === "owner/paused" ? "incident" : undefined),
    readOpenWork: someWork,
    wake: (target) => woken.push(target),
    report: () => {},
  });
  assert.deepEqual(woken, ["owner/busy", "owner/also-busy"]);
  assert.deepEqual(outcomes, [
    { target: "owner/busy", outcome: "woken" },
    { target: "owner/paused", outcome: "paused", reason: "incident" },
    { target: "owner/also-busy", outcome: "woken" },
  ]);
});

test("a target whose pause cannot be read is failed, not taken for running and woken", () => {
  // Acceptance criterion 6, and the same rule the open-work read already
  // follows: a read that failed says nothing about the target, and treating
  // silence as "not paused" is how a pause a maintainer set goes on billing a
  // minute a pass behind a read nobody noticed was broken.
  const woken: string[] = [];
  const reported: TargetOutcome[] = [];
  const outcomes = sendHeartbeat({
    now: () => NOW,
    targets: ["owner/unreadable", "owner/busy"],
    readPause: (target) => {
      if (target === "owner/unreadable") throw new Error("HTTP 403: Resource not accessible by personal access token");
      return undefined;
    },
    readOpenWork: someWork,
    wake: (target) => woken.push(target),
    report: (outcome) => reported.push(outcome),
  });
  assert.deepEqual(woken, ["owner/busy"]);
  assert.deepEqual(outcomes, [
    { target: "owner/unreadable", outcome: "failed", error: "HTTP 403: Resource not accessible by personal access token" },
    { target: "owner/busy", outcome: "woken" },
  ]);
  assert.deepEqual(reported, outcomes);
});

test("a paused target's open work is never read, so the pause is one call and no more", () => {
  // The pause is the first question because it is the cheapest answer to the
  // only one that matters: a target that will not be woken whatever is open on
  // it has nothing to learn from reading what is open on it.
  const read: string[] = [];
  sendHeartbeat({
    now: () => NOW,
    targets: ["owner/paused"],
    readPause: () => "incident",
    readOpenWork: (target) => {
      read.push(target);
      return someWork();
    },
    wake: () => {},
    report: () => {},
  });
  assert.deepEqual(read, []);
});
