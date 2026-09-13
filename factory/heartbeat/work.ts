/**
 * Whether a target has anything waiting, so the heartbeat can skip a target a
 * sweep would find nothing to do on (#212). Waking one costs a billed Actions
 * minute whatever the sweep decides; asking costs API calls, which are free.
 *
 * One subject is waiting when a sweep would act on it:
 * - a ticket a human marked ready that nothing holds, which the dispatcher
 *   would dispatch,
 * - a ticket in a factory state label, which the reconciler would repair,
 * - any open pull request, whoever produced it, because the reconciler asks for
 *   a verdict on an unjudged one and updates a judged one that has fallen
 *   behind.
 * Never a parked subject, and never a held ticket: nothing sweeps either until a
 * human acts. A held pull request is still work, since a hold withholds the
 * reviewer and never the merge path (#210).
 *
 * That much says a sweep could act on the subject. Whether it would act now is
 * the second question and the one that decides the bill (#264): `due` below is
 * that rule, and #264 and `docs/factory/dispatcher.md` carry the argument for it.
 *
 * Every label set is imported from the module that owns it, so a change to any
 * of them reaches the heartbeat with it, and the deadlines travel the same
 * route. Nothing here spells a label or restates a deadline (`work.test.ts`
 * pins both).
 *
 * Builtins only and explicit `.ts`, so `send.ts` reaches it on bare
 * `node --experimental-strip-types`.
 */
import { PROJECTIONS } from "../dispatch/gh-read.ts";
import { DEFAULT_DEADLINES, PARKED_LABELS } from "../dispatch/reconcile.ts";
import { FACTORY_STATE_LABELS } from "../dispatch/select.ts";
import { HOLD_LABELS, READY_LABEL } from "../lib/labels.ts";
import { HEARTBEAT_INTERVAL_MINUTES } from "./interval.ts";

/** One open ticket or pull request, reduced to what the rules read. */
export type OpenSubject = {
  /** The open-issues endpoint lists pull requests too; this is which one it is. */
  readonly pullRequest: boolean;
  readonly labels: readonly string[];
  /**
   * When the subject last changed, GitHub's `updated_at`; undefined when it was
   * not read, which counts as due, the way the reconciler counts a state whose
   * age it does not know as overdue.
   */
  readonly changedAt?: string;
};

/**
 * The one read the heartbeat makes per target: the sweep's own open-issues
 * call, which lists pull requests alongside tickets and whose projection
 * already carries the flag telling them apart and the timestamp `due` reads, so
 * one paginated read answers every rule below. Paginated and projected for the
 * reason `gh-read.ts` gives: a target with many issues would otherwise blow the
 * process buffers. A GET with no `--method`, so asking a target what is open
 * cannot itself start a job on it.
 */
export const openWorkArgs = (target: string): string[] => [
  "api",
  "--paginate",
  `repos/${target}/issues?state=open&per_page=100`,
  "--jq",
  PROJECTIONS.issues,
];

/**
 * `PROJECTIONS.issues` output, one item per line, reduced to the subjects. The
 * flag is read for truth rather than against `true`, as `sweep.ts` reads it:
 * the projection prints a boolean, GitHub's own JSON puts an object there, and
 * a reader that took the object for a ticket would skip a target whose only
 * work is a pull request.
 */
export const fromGitHub = (raw: readonly unknown[]): OpenSubject[] =>
  raw.map((item) => {
    const r = item as Record<string, any>;
    return {
      pullRequest: Boolean(r.pull_request),
      labels: (r.labels ?? []).map((label: { name: string }) => label.name),
      changedAt: typeof r.updated_at === "string" ? r.updated_at : undefined,
    };
  });

/**
 * The deadlines a sweep judges this kind of subject by, from the reconciler's
 * own defaults rather than restated: `decideTicket` judges a ticket by
 * `stuckMinutes` alone, and every rule on a pull request by one of the three. A
 * deadline added to the set reaches a pull request here with no edit; one meant
 * for a ticket needs this line, and `interval.test.ts` fails on a new key until
 * a human has looked at both.
 *
 * A target can override all three in its own caller and the factory cannot read
 * a target's caller, so the heartbeat reasons from the defaults whatever a
 * target runs. Deliberately: an override earlier than a default costs a wasted
 * wake, one later leaves that repair to the daily recheck below, the catch for
 * a missed pass either way, and waking on the defaults beats waking always
 * (#264).
 */
const DEADLINES = {
  /** Built once: the set is the same for every subject of a kind, and a pass reads it per subject. */
  pullRequest: [...new Set(Object.values(DEFAULT_DEADLINES))],
  ticket: [...new Set([DEFAULT_DEADLINES.stuckMinutes])],
} as const;

const deadlinesFor = (pullRequest: boolean): readonly number[] => (pullRequest ? DEADLINES.pullRequest : DEADLINES.ticket);

/**
 * Would a sweep act on this subject now? A deadline is only ever checked when a
 * sweep runs, so the pass that matters is the first one after it falls, and the
 * repair then changes the subject and starts the next deadline. Asking whether
 * the subject is *past* a deadline is what woke a target every pass, because it
 * stays true forever.
 *
 * - Clock never read, or read and unparseable: due, as the reconciler treats a
 *   state whose age it does not know as overdue. An age of `NaN` is past no
 *   deadline and inside no window, so a timestamp nobody can parse would
 *   otherwise read as a subject to leave alone forever.
 * - A ready ticket the factory has not picked up: due whatever its age, since
 *   the dispatcher has no deadline and no clock has started. That is the one
 *   subject this rule still wakes a target for on every pass, and it is the
 *   shape of a ticket the dispatcher refuses for good, no acceptance criteria
 *   or an assignee, which nothing else here can tell from one it would
 *   dispatch.
 * - Changed since the last pass: due. Every deadline runs from the change, and
 *   a hold taken off is the release CONTEXT.md promises on the first sweep.
 * - A deadline fell during the last interval: due, that being the repair's pass.
 * - At least a whole day past the last change: due in the one pass landing in
 *   the interval after each whole day (#267). A repair can fail without changing
 *   its subject, GitHub refusing to arm auto-merge or an update-branch that hit
 *   a conflict, and a check the host missed leaves nothing to run it again. This
 *   retries once a day off the same clock, adding no field to the read and no
 *   persisted state.
 *
 * The clock is `updated_at`, the only one in the read the heartbeat already
 * makes. The reconciler's own run from a label event or a head commit, both
 * changes to the subject and so at or before this one, and its own reads answer
 * those exactly.
 *
 * The windows assume the passes are on the grid, so a deadline that fell during
 * passes the host never ran is reached by the daily recheck below rather than by
 * the next pass. The daily recheck rides the same grid: it is one pass per whole
 * day and nothing between.
 */
/** One whole day in minutes, the recheck's cadence (#267). */
const DAY_MINUTES = 24 * 60;

const due = (subject: OpenSubject, now: Date): boolean => {
  if (subject.changedAt === undefined) return true;
  if (!subject.pullRequest && subject.labels.includes(READY_LABEL) && !FACTORY_STATE_LABELS.some((label) => subject.labels.includes(label))) return true;
  const age = (now.getTime() - Date.parse(subject.changedAt)) / 60_000;
  if (Number.isNaN(age)) return true;
  if (age < HEARTBEAT_INTERVAL_MINUTES) return true;
  if (age >= DAY_MINUTES && age % DAY_MINUTES < HEARTBEAT_INTERVAL_MINUTES) return true;
  return deadlinesFor(subject.pullRequest).some((deadline) => age >= deadline && age < deadline + HEARTBEAT_INTERVAL_MINUTES);
};

/** Would a sweep act on this subject at all, at any deadline? */
const waiting = ({ pullRequest, labels }: OpenSubject): boolean => {
  const has = (label: string) => labels.includes(label);
  if (PARKED_LABELS.some(has)) return false;
  // Before the hold, because a hold withholds the reviewer and never the merge
  // path (#210): the reconciler still re-arms auto-merge on a held PR and still
  // brings it up to date, so a held PR is work.
  if (pullRequest) return true;
  // A held ticket is not, whatever state label it carries: the dispatcher skips
  // it as held and the reconciler leaves it alone rather than re-stamping it.
  if (HOLD_LABELS.some(has)) return false;
  if (has(READY_LABEL)) return true;
  return FACTORY_STATE_LABELS.some(has);
};

/**
 * What one target's open subjects mean for this pass (#264). Three answers, one
 * call, so no caller can ask them in an order that contradicts itself:
 * - `waiting`: a sweep would act on something now, so the target is woken.
 * - `nothing-due`: work is open and every subject of it is between deadlines.
 * - `nothing-waiting`: nothing open that any sweep would act on at any deadline,
 *   the target being empty or everything on it parked or held.
 */
export type SweepNeed = "waiting" | "nothing-due" | "nothing-waiting";

export const sweepNeed = (open: readonly OpenSubject[], now: Date): SweepNeed => {
  const couldAct = open.filter(waiting);
  if (couldAct.length === 0) return "nothing-waiting";
  return couldAct.some((subject) => due(subject, now)) ? "waiting" : "nothing-due";
};
