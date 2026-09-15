/**
 * The rule behind the interval (#261), which is the only reason the number is
 * 15 and not something else.
 *
 * The deadlines are imported rather than quoted, because the whole point is
 * that the interval follows from them: a test carrying its own copy of
 * `stuckMinutes` would agree with itself forever while the reconciler moved.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

import { DEFAULT_DEADLINES } from "../dispatch/reconcile.ts";
import { HEARTBEAT_INTERVAL_MINUTES } from "./interval.ts";

/**
 * The deadlines the interval samples, as a list.
 *
 * Every member of `Deadlines` is a number of minutes today, so this takes all
 * of them rather than naming three and going stale when a fourth lands. The
 * test below pins the set, so a member added in some other unit, or one that
 * is not a deadline at all, fails here and is looked at rather than silently
 * tightening the interval.
 */
const deadlines = (): number[] => Object.values(DEFAULT_DEADLINES);

test("every deadline sampled is a deadline, in minutes, so taking all of them is safe", () => {
  // The set is pinned because the two tests below take `Object.values` of it.
  // A member added in seconds, or one that is not a deadline at all, would
  // pull the minimum down and tighten the interval with nobody deciding to.
  // Adding a deadline means adding it here, and the name says the unit.
  assert.deepEqual(Object.keys(DEFAULT_DEADLINES).sort(), ["stuckMinutes", "updateMinutes", "verdictMinutes"]);
  for (const [name, value] of Object.entries(DEFAULT_DEADLINES)) {
    assert.match(name, /Minutes$/, `${name} is sampled as minutes and is not named as minutes`);
    assert.ok(Number.isInteger(value) && value > 0, `${name} is ${value}, which is not a number of minutes`);
  }
});

test("the interval is no larger than the tightest reconciler deadline", () => {
  // A deadline is only ever checked when a sweep runs, so a subject that
  // crosses one waits up to a further interval for the sweep that repairs it:
  // repair lands between D and D + I. Holding the interval at or below the
  // tightest deadline is what caps the worst case at twice that deadline,
  // which is the trade this repo has taken. It does not make the deadline
  // exact, and `interval.ts` says so rather than claiming it does.
  //
  // Asserted against the deadlines rather than against 15, so lowering
  // `stuckMinutes` fails here and forces the interval to be revisited, which
  // is the drift this ticket exists to stop.
  assert.ok(deadlines().length > 0, "the reconciler has deadlines to sample");
  assert.ok(
    HEARTBEAT_INTERVAL_MINUTES <= Math.min(...deadlines()),
    `the interval is ${HEARTBEAT_INTERVAL_MINUTES} minutes and the tightest deadline is ${Math.min(...deadlines())}`,
  );
});

test("the interval is the largest one the rule allows, so no sweep is paid for twice over", () => {
  // The other half of the rule, and the half that is a choice rather than a
  // bound. A shorter interval does buy faster repair, proportionally: the
  // worst case is D + I either way. What it costs is a billed minute per pass
  // on every target with work open, which is why the rule picks the top of the
  // range it allows rather than anywhere inside it.
  assert.equal(HEARTBEAT_INTERVAL_MINUTES, Math.min(...deadlines()));
});

test("the interval is 30 minutes, the number a human moved it to alongside the deadlines (#271)", () => {
  // The literal the deadlines were raised to meet: stuck moved from 15 to 30, so
  // the tightest deadline is 30 and the rule lets the interval sit there.
  assert.equal(HEARTBEAT_INTERVAL_MINUTES, 30);
});

test("the interval is a whole number of minutes, which is what a scheduler takes", () => {
  // `StartInterval` is seconds and a cron is minutes; neither takes a fraction.
  assert.ok(Number.isInteger(HEARTBEAT_INTERVAL_MINUTES), `${HEARTBEAT_INTERVAL_MINUTES} is not a whole number of minutes`);
  assert.ok(HEARTBEAT_INTERVAL_MINUTES > 0, "an interval of zero or less is not a schedule");
});

/**
 * The header of `interval.ts` as prose: the first block comment, markers and
 * line breaks gone, so a phrase is read the way it is written and not missed
 * because it wrapped. `send.test.ts` reads the pages it scans the same way.
 */
const header = (): string => {
  const source = fs.readFileSync(new URL("./interval.ts", import.meta.url), "utf8");
  const block = /^\/\*\*([\s\S]*?)\*\//.exec(source);
  assert.ok(block, "interval.ts opens with a block comment, which is the header this reads");
  return block[1]!.replace(/^\s*\*\s?/gm, " ").replace(/\s+/g, " ");
};

/**
 * The launchd job the header used to name, retired by #111 with the heartbeat
 * moved onto a **Host**. Kept as the positive control for the refusals below:
 * a scan is only evidence that the sentence is gone if the patterns are known
 * to match it.
 */
const RETIRED = "host schedules it with, a launchd job on the maintainer's machine today (#111 is where that lives for good)";

/** Every way the header named one host's own wiring, which is what CONTEXT.md's **Host** entry says to avoid. */
const NAMES_A_PROVIDER = [/launchd/i, /maintainer'?s machine/i, /#111\b/];

test("the header names no provider and no machine of anyone's, because the factory does not own the host", () => {
  // The header was written when one launchd job on one machine was the whole
  // truth about where the heartbeat ran. #111 retired that job, and README's
  // "what any host needs" is the contract now: the choice of provider is an
  // adopter's, so naming one here reads as the way the heartbeat is run.
  for (const pattern of NAMES_A_PROVIDER) {
    assert.match(RETIRED, pattern, `the refusal would miss the sentence it exists to keep out: ${pattern}`);
    assert.doesNotMatch(header(), pattern, `the header still names one host's own wiring: ${pattern}`);
  }
});
