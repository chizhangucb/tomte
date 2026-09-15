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

/** `interval.ts` as it is on disk, read once: nothing in a test run rewrites it. */
const SOURCE = fs.readFileSync(new URL("./interval.ts", import.meta.url), "utf8");

/**
 * A comment as prose: markers and line breaks gone, so a phrase is read the
 * way it is written and not missed because it wrapped. `send.test.ts` reads
 * the pages it scans the same way.
 */
const asProse = (raw: string): string => raw.replace(/^\s*\*\s?/gm, " ").replace(/\s+/g, " ");

/** The header of `interval.ts` as prose: its first block comment, which is where the file says how it is run. */
const header = (): string => {
  const block = /^\/\*\*([\s\S]*?)\*\//.exec(SOURCE);
  assert.ok(block, "interval.ts opens with a block comment, which is the header this reads");
  return asProse(block[1]!);
};

/**
 * The launchd job the header used to name, retired by #111 with the heartbeat
 * moved onto a **Host**. Kept as the positive control for the refusals below:
 * a scan is only evidence that the sentence is gone if the patterns are known
 * to match it.
 */
const RETIRED = "host schedules it with, a launchd job on the maintainer's machine today (#111 is where that lives for good)";

/**
 * Every way this file named one host's own wiring, which CONTEXT.md's **Host**
 * entry says to avoid: the role is what runs the sender, and launchd on one
 * machine was only ever one host meeting it.
 *
 * Refused across the whole file and not just its header, because the sentence
 * reads the same wherever in the file it comes back and nothing else guards
 * this one: `send.test.ts`'s repo-wide scan skips `interval.ts` by name.
 *
 * launchd is refused here as the thing that schedules the sender, not as a
 * word: README and the **Loop runner**'s entry both name it for the one job a
 * host still has, restarting the loop, and `heartbeat-loop.test.ts` holds
 * README's example to exactly that. It is this file saying where the sender
 * runs that #111 retired.
 */
const NAMES_ONE_HOSTS_WIRING = [/launchd/i, /maintainer'?s machine/i, /#111\b/];

test("this file names no launchd job and no machine of anyone's, because the factory owns neither", () => {
  // The header was written when one launchd job on one machine was the whole
  // truth about where the heartbeat ran. #111 retired that job, and README's
  // "what any host needs" is the contract now: the choice of provider is an
  // adopter's, so naming one here reads as the way the heartbeat is run.
  const prose = asProse(SOURCE);
  for (const pattern of NAMES_ONE_HOSTS_WIRING) {
    assert.match(RETIRED, pattern, `the refusal would miss the sentence it exists to keep out: ${pattern}`);
    assert.doesNotMatch(prose, pattern, `interval.ts still names one host's own wiring: ${pattern}`);
  }
});

test("the header says a Host runs the sender, in the two shapes a host takes", () => {
  // The half the removal cannot make. A header that merely stopped naming
  // launchd would leave a reader with no answer to who does run the sender,
  // and the answer is the one CONTEXT.md gives: a **Host**, which the factory
  // does not own and cannot see, in either of its two shapes. Which shape
  // matters here and nowhere else in the repo, because it is the question of
  // whether the number in this file is the only copy of itself: a host that
  // schedules carries a second one, and a **loop runner** carries none.
  //
  // The role by its glossary name and not the bare word: the retired sentence
  // said "whatever a host schedules it with" and would pass a test that asked
  // only for "host" and "sender" in one sentence, while saying nothing about
  // either shape.
  // Held per sentence, so a claim is read where a reader meets it rather than
  // assembled out of words from anywhere on the page.
  const text = header();
  const sentences = text.split(/(?<=[.:])\s/);
  assert.ok(
    sentences.some((sentence) => sentence.includes("**Host**") && /\brun/i.test(sentence) && /\bsender\b/i.test(sentence)),
    `the header does not say, in one sentence, that a **Host** is what runs the sender: ${text}`,
  );
  assert.ok(
    sentences.some((sentence) => /\bschedul/i.test(sentence) && /\bcopy\b/i.test(sentence) && /\btest\b/i.test(sentence)),
    `the header does not say a host that schedules carries its own copy, held to this constant by a test: ${text}`,
  );
  assert.ok(
    sentences.some((sentence) => /\bloop runner\b/i.test(sentence) && /\bread/i.test(sentence) && /\bthis file\b/i.test(sentence)),
    `the header does not say a loop runner reads the interval back out of this file: ${text}`,
  );
});
