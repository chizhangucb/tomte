/**
 * Send one pass of the heartbeat (#222). What a host runs on an interval:
 *
 *   GH_TOKEN=<token> node --experimental-strip-types factory/heartbeat/send.ts
 *
 * on the interval `interval.ts` names, with a token that has contents write,
 * issues and pull requests read, and Actions variables read on every target in
 * `targets.ts` and nothing else: the issues read says whether a target has anything
 * waiting and when each subject last changed, which is what is due (#264), and
 * the variables read says whether it is paused (#256) and whether
 * its checks are waived (#244). `DRY_RUN=1` reports the pass without touching
 * a target at all, as `dispatch/sweep-run.ts` reads the same var: no dispatch, and
 * no read either, so every target answers as a running one with work and the
 * pass reports the shape a busy interval takes.
 *
 * It holds one piece of state and no more: the timestamps of the last few
 * passes, so it can say when the cadence it is run at stops agreeing with the
 * documented interval (#265, and `cadence.ts` holds the reason). No lock, and
 * no pass waiting on another. Every outcome is a line on stdout and a failure
 * is a line on stderr,
 * each stamped with the time as the script this replaces stamped its own log,
 * since a host's log keeps the history and cron and launchd timestamp nothing.
 * Its alerting sees the non-zero exit a failed target ends on. Where the whole
 * thing runs is #111.
 *
 * A host that sets `FACTORY_HEARTBEAT_PING_URL` is watched by a dead-man's
 * switch as well: the exit status goes to that check after the pass, so a host
 * that stops running the command at all is noticed by something outside it
 * (#325, and `ping.ts` holds the reason). Unset means no ping, and a ping that
 * fails costs the pass nothing.
 *
 * Builtins only, imported with explicit `.ts`, so it runs with no `npm ci`
 * (`send.test.ts` pins that).
 */
import * as fs from "node:fs";
import * as os from "node:os";

import { parseItems } from "../dispatch/gh-read.ts";
import { errorMessage } from "../lib/errors.ts";
import { GhError, gh } from "../lib/gh.ts";
import { READY_LABEL } from "../lib/labels.ts";
import { cadenceLine, passLogPath, withPass } from "./cadence.ts";
import { type TargetOutcome, sendHeartbeat } from "./heartbeat.ts";
import { PING_URL_ENV, reportPass } from "./ping.ts";
import { TARGET_REPOS } from "./targets.ts";
import { PAUSE, WAIVER, isUnset, variableReadArgs, variablesReadableArgs } from "./variable.ts";
import { type OpenSubject, fromGitHub, openWorkArgs } from "./work.ts";

const dryRun = process.env.DRY_RUN === "1";

/** The time, as the script this replaces stamped its own log lines. */
const at = (): string => new Date().toISOString();

/**
 * The dispatch that is the heartbeat, through the factory's one `gh` call, in
 * the same shape `sweep.ts` sends its own: explicit POST, `--silent` because
 * the answer is 204 and empty. A failed call throws a `GhError` naming the
 * command and the cause, which is what the outcome carries.
 */
const wake = (target: string): void => {
  gh(["api", "--method", "POST", `repos/${target}/dispatches`, "-f", "event_type=factory-sweep", "--silent"]);
};

/** What is open on a target, through the same `gh` call and the same projection the sweep reads. */
const readOpenWork = (target: string): OpenSubject[] => fromGitHub(parseItems(gh(openWorkArgs(target))));

/**
 * Whether a human has paused the target (#256). The variable unset is a 404
 * and means running; every other failure is thrown on, so it fails the target
 * the way an unreadable open-work read already does. The alternative, reading
 * a failure as "not paused", wakes a paused target every interval behind a
 * read nobody noticed was broken, which is the exact cost this is here to
 * stop.
 *
 * That is the one way it differs from `readWaiverReason` below, and the
 * difference is which question the read answers: the waiver read feeds a nag
 * beside the pass, so a failure there is said out loud and fails nothing,
 * while this one decides whether the target is woken.
 */
const readPause = (target: string): string | undefined => {
  try {
    return PAUSE.reason(gh(variableReadArgs(target, PAUSE.variable)));
  } catch (error) {
    // `stderr`, not the rendered message, for the reason `readWaiverReason` gives.
    if (!(error instanceof GhError) || !isUnset(error.stderr)) throw error;
    // The 404 says the variable is not set, or that this token may not read
    // the target's variables at all, and those are the same 404. A token
    // missing the scope would otherwise answer "not paused" for every target
    // it covers, for as long as nobody noticed, which is the silent version of
    // the bill this is here to stop. Throws on a 404 of its own, failing the
    // target, which is what a read nobody can make should do.
    gh(variablesReadableArgs(target));
    return undefined;
  }
};

/** A dry run reads no target, and answers as one with a ready ticket on it. */
const asIfBusy = (): OpenSubject[] => [{ pullRequest: false, labels: [READY_LABEL] }];

/** A dry run reads no target here either, so it answers as one that is running. */
const asIfRunning = (): undefined => undefined;

/**
 * The waiver nag (#244), every run: a target whose factory checks a human took
 * off is named until they are put back, because nothing closes a waiver
 * automatically. A read that fails for any reason other than the variable not
 * being there is said out loud and fails no target: the nag is not the pass.
 * It goes in the digest instead once there is one.
 *
 * A dry run reads no target here either, so it reports no waiver: the nag is
 * about a target's real state, and a dry run that invented one would be the one
 * output a maintainer could not trust.
 */
const nagIfWaived = (target: string): void => {
  if (dryRun) return;
  const line = WAIVER.line(target, readWaiverReason(target));
  if (line) console.log(`${at()} ${line}`);
};

/** One target's waiver reason, or nothing: an unset variable is a 404 and means no waiver. */
const readWaiverReason = (target: string): string | undefined => {
  try {
    return WAIVER.reason(gh(variableReadArgs(target, WAIVER.variable)));
  } catch (error) {
    // `stderr`, not the rendered message: `lib/gh.ts` carries the fields precisely so no
    // caller reads a decision back out of the line it renders.
    if (error instanceof GhError && isUnset(error.stderr)) return undefined;
    console.error(`${at()} could not read ${WAIVER.variable} on ${target}: ${errorMessage(error)}`);
    return undefined;
  }
};

/**
 * The cadence claim (#265), beside the waiver nag: this pass recorded, and one
 * line if the last few passes disagree with the interval this repo documents.
 * The only state the sender holds, and `cadence.ts` carries the reason that was
 * worth it.
 *
 * Every failure is swallowed after a line on stderr: a pass log that cannot be
 * read or written is a claim not made, and never a sweep not sent. A dry run
 * records nothing, because it invents its answers and a pass nobody made would
 * leave a gap no host ever took.
 */
const claimCadence = (): void => {
  if (dryRun) return;
  const file = passLogPath(process.env, os.homedir());
  try {
    // One read, like every other question the pass asks: a missing file is a
    // host with no history, which is the same answer as a log too short to
    // judge.
    const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const now = new Date();
    const line = cadenceLine(before, now);
    if (line) console.log(`${at()} ${line}`);
    fs.writeFileSync(file, withPass(before, now));
  } catch (error) {
    console.error(`${at()} could not keep the pass log at ${file}: ${errorMessage(error)}`);
  }
};

claimCadence();
for (const target of TARGET_REPOS) nagIfWaived(target);

const startedAt = new Date();

const outcomes = sendHeartbeat({
  targets: TARGET_REPOS,
  // One clock for the whole pass rather than one per target (#264): the reads
  // take seconds, and a pass that answered its last target against a later
  // clock than its first would judge two targets by two grids.
  now: () => startedAt,
  readPause: dryRun ? asIfRunning : readPause,
  readOpenWork: dryRun ? asIfBusy : readOpenWork,
  wake: dryRun ? () => {} : wake,
  report: (outcome) => {
    // A plain line, not an `::error::` annotation: the host is not a GitHub
    // runner (a heartbeat on GitHub's own cron is the thing this replaces).
    if (outcome.outcome === "failed") console.error(`${at()} factory-sweep FAILED for ${outcome.target}: ${outcome.error}`);
    else if (outcome.outcome === "paused") console.log(`${at()} ${PAUSE.line(outcome.target, outcome.reason)}`);
    else if (outcome.outcome === "skipped") console.log(`${at()} ${outcome.target} skipped: nothing waiting`);
    else if (outcome.outcome === "nothing-due") console.log(`${at()} ${outcome.target} not woken: work open, nothing due`);
    else console.log(`${at()} factory-sweep dispatched to ${outcome.target}${dryRun ? " (dry run)" : ""}`);
  },
});

// Typed against the outcomes themselves: a member renamed in `heartbeat.ts`
// fails here rather than reporting none of it.
const count = (outcome: TargetOutcome["outcome"]): number => outcomes.filter((each) => each.outcome === outcome).length;
const failed = count("failed");
console.log(
  // The new count goes last so the line reads as the old one with a column
  // added, which is what a host's log history is full of.
  `${at()} ${outcomes.length} target(s), ${count("woken")} woken, ${count("skipped")} skipped, ${count("paused")} paused, ${failed} failed, ${count("nothing-due")} with nothing due${dryRun ? " (dry run)" : ""}.`,
);
const exitStatus = failed > 0 ? 1 : 0;
// `exitCode`, not `process.exit`: stdout is a pipe when a host logs the pass,
// pipe writes are asynchronous, and exiting in place can drop the lines that
// say which target failed.
process.exitCode = exitStatus;

/**
 * The dead-man's switch (#325), last, because it reports how the pass went:
 * one request carrying the exit status, so a failed pass alerts at once and a
 * pass that never happens alerts after the check's period and grace. Unset
 * means the host has no switch and nothing is sent.
 *
 * Whatever it answers, the pass's exit status is already set above and is not
 * touched here: watching the heartbeat may not be what stops it.
 *
 * A dry run tells the switch nothing, for the reason the waiver nag gives:
 * it reads no target and invents its answers, so a maintainer trying the
 * command would otherwise mark the real check up for a pass nothing swept.
 */
if (!dryRun) {
  const failure = await reportPass(process.env[PING_URL_ENV], exitStatus);
  if (failure) console.error(`${at()} ${failure}`);
}
