/**
 * The cadence the sender is actually run at, against the one this repo
 * documents (#265), like the switch reads in `variable.ts`: a pure function
 * from what the last few passes looked like to what the sender prints.
 *
 * `interval.ts` is documentation with a test on it, because the factory cannot
 * set its own interval: a host schedules the sender, a launchd job on the
 * maintainer's machine today (#111 is where that lives for good). So the
 * documented number and the number the host is configured with are two copies
 * of one fact, edited by hand, and nothing failed when they parted. The sender
 * is the only thing that sees both: it knows what the repo says, and it can
 * see how long it has been since the last pass.
 *
 * **Where the previous pass comes from: a log of the sender's own.** `send.ts`
 * deliberately held no state, and this breaks that, which is the decision the
 * ticket asked to be written down here. The alternative was reading the host's
 * own log, which already stamps every pass, and that is coupling to one host:
 * its path, its format, and its truncation, none of which this repo owns and
 * all of which #111 may change. A handful of timestamps the sender writes
 * itself is portable to any host and readable by nothing else. What made
 * statelessness worth keeping is preserved anyway: no lock, no pass waiting on
 * another, and a log that cannot be read or written costs the pass nothing but
 * this line, because `send.ts` treats every failure here as silence.
 *
 * **What counts as disagreement: a run of passes.** The heartbeat runs on a
 * laptop, so a machine asleep overnight is the common case and one long gap is
 * not evidence of anything. A claim is made only when every one of the last
 * `DISAGREEING_PASSES` gaps disagrees, which a sleep cannot produce: waking
 * restores the host's own rhythm on the next gap, while a host configured with
 * a different number disagrees on every gap forever.
 *
 * Builtins only and explicit `.ts`, so `send.ts` reaches it on bare
 * `node --experimental-strip-types`.
 */
import * as path from "node:path";

import { HEARTBEAT_INTERVAL_MINUTES, INTERVAL_PHRASE } from "./interval.ts";

/**
 * How many consecutive gaps have to disagree before the pass says so.
 *
 * Four, which is four intervals of unbroken disagreement. One gap is a
 * sleeping laptop and two is a laptop that slept twice; four in a row is a
 * rhythm rather than an interruption, and a host whose schedule really did move
 * produces them from the fourth pass after the change onwards. The cost of the
 * number is how long the claim takes to arrive, which is nothing against a
 * number that went a day unnoticed.
 */
export const DISAGREEING_PASSES = 4;

/**
 * How far a gap may be from the documented interval and still agree with it:
 * half of it either way, exclusive, so a halved or doubled interval disagrees
 * and a pass merely late does not.
 *
 * The band is wide because the failure it must not produce is a nag a
 * maintainer learns to skip, and a laptop that is used intermittently takes
 * gaps a little over its schedule all afternoon without anything being
 * misconfigured. So what this catches is a host whose number was halved or
 * doubled, which is the shape a hand edit takes, and what it misses is a
 * smaller edit inside the band. That is the trade, and the exclusive edge is
 * deliberate: exactly half the interval is exactly twice the billed minutes,
 * which is worth a line.
 */
export const AGREEING_BAND = 0.5;

/** Where the sender leaves the timestamps, overridable so a test never touches a real host's. */
export const PASS_LOG_ENV = "FACTORY_HEARTBEAT_PASS_LOG";

/**
 * The file the sender appends its passes to: the env var, or one dotfile in the
 * home directory of whoever the host runs it as. A path and not a directory
 * tree, because the whole state is a few lines of text.
 */
export const passLogPath = (env: Record<string, string | undefined>, home: string): string =>
  env[PASS_LOG_ENV] || path.join(home, ".factory-heartbeat-passes");

/**
 * The log with this pass in it, and nothing older than the next claim can use:
 * `DISAGREEING_PASSES` stamps, which with the pass that reads them back is
 * exactly the run being judged. The file is bounded by the claim rather than by
 * a truncation nobody owns.
 */
export const withPass = (raw: string, now: Date): string =>
  `${[...stamps(raw), now]
    .slice(-DISAGREEING_PASSES)
    .map((at) => at.toISOString())
    .join("\n")}\n`;

/**
 * What the sender prints about its own cadence, or nothing. Nothing is the
 * answer to a log too short to hold a run, and to any run with an agreeing gap
 * in it: this line is a claim about the schedule, and a maintainer who reads it
 * on a morning after a sleep would be right to stop reading it.
 *
 * The observed number is the middle of the run, rounded: a host fires on its own
 * clock, so no two gaps are identical and reporting one of them would read as
 * precision the observation does not have. The middle and not the mean, because
 * a sleep inside an otherwise steady run is exactly the thing the threshold
 * already tolerates, and averaged in it would name a cadence nothing ran at.
 */
export const cadenceLine = (raw: string, now: Date): string | undefined => {
  const gaps = gapMinutes([...stamps(raw), now]).slice(-DISAGREEING_PASSES);
  if (gaps.length < DISAGREEING_PASSES) return undefined;
  // A gap of zero or less is a log out of order, which is a clock that moved
  // backwards: the file is append-only, so its order is the order the passes
  // ran in, and it is read in that order rather than sorted. Sorting would turn
  // a clock change into plausible gaps and report a cadence nothing ran at.
  if (gaps.some((gap) => gap <= 0 || agrees(gap))) return undefined;
  const observed = Math.round(middle(gaps));
  return `heartbeat CADENCE: the last ${DISAGREEING_PASSES} gaps between passes were about ${observed} minutes each, and this repo documents ${INTERVAL_PHRASE} (HEARTBEAT_INTERVAL_MINUTES in factory/heartbeat/interval.ts); change the host's schedule or that constant so the two agree`;
};

/** The middle of a run of gaps: the median, taken as the mean of the middle two when the run is even. */
const middle = (gaps: readonly number[]): number => {
  const sorted = [...gaps].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[half - 1]! + sorted[half]!) / 2 : sorted[half]!;
};

/** Whether one gap is the documented interval, inside the band and not on its edge. */
const agrees = (gap: number): boolean =>
  gap > HEARTBEAT_INTERVAL_MINUTES * (1 - AGREEING_BAND) && gap < HEARTBEAT_INTERVAL_MINUTES * (1 + AGREEING_BAND);

/**
 * The timestamps in the log, in the order the passes wrote them, anything that
 * is not one of this module's own stamps dropped. A half-written line from a
 * pass a host killed is not a pass, and dropping it costs one gap rather than
 * the claim.
 *
 * The test is a round trip against `toISOString`, not `Number.isNaN`, because
 * most of the ways a stamp is truncated still parse: a line cut at the final
 * `Z` is read as local time and lands hours out, and one cut back to the date
 * is read as midnight. Either invents a gap no host took, in the direction the
 * host's offset happens to point, which is the one shape of bad line the file
 * can actually hold.
 */
const stamps = (raw: string): Date[] =>
  raw.split("\n").flatMap((line) => {
    const written = line.trim();
    const at = new Date(written);
    return !Number.isNaN(at.getTime()) && at.toISOString() === written ? [at] : [];
  });

/** The gaps between consecutive passes, in minutes. */
const gapMinutes = (at: readonly Date[]): number[] =>
  at.slice(1).map((each, index) => (each.getTime() - at[index]!.getTime()) / 60_000);
