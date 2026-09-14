/**
 * The cloud recipe's two files, and what a test reads out of them (#327).
 *
 * The recipe is `render.yaml` and the image it builds: a blueprint telling
 * Render to run one pass of the sender on a schedule, and a Dockerfile
 * carrying Node, `gh` and this repo. Neither is built or deployed by anything
 * in this repo, so the only thing that ever reads them here is a test, and
 * this module is where both of those tests read them from. `lib/repo-files.ts`
 * is the prior art: a module in the tree that only the tests use, because the
 * thing it reads is not code.
 *
 * It lives here rather than in either test because two tests read the same
 * file for two different reasons -- `send.test.ts` holds the schedule to the
 * interval constant beside every other copy of that number, and
 * `recipe.test.ts` holds the rest of the recipe's shape -- and a second copy
 * of the reader is a second thing to keep true about a file neither of them
 * writes.
 *
 * Read as text rather than parsed: the repo installs no YAML reader, the
 * blueprint is a dozen flat lines, and what the assertions are about is what a
 * maintainer's eye would find in it.
 */
import * as fs from "node:fs";

const repoRoot = new URL("../../", import.meta.url);

/** The blueprint Render reads, at the root of the repo because that is the only place it looks for one. */
export const BLUEPRINT = "render.yaml";

/** The image the blueprint builds, which is the whole of what the host is. */
export const IMAGE = "deploy/render/Dockerfile";

/**
 * The Render environment group a maintainer creates before deploying, and the
 * blueprint's only source of values: the token and the check's ping URL live
 * in it, so neither has anywhere in the repo to be typed into.
 */
export const ENV_GROUP = "tomte-heartbeat";

/** The blueprint's text, which is the whole of what Render is told. */
export const blueprint = (): string => fs.readFileSync(new URL(BLUEPRINT, repoRoot), "utf8");

/** The image's text, which is the whole of what a host is built from. */
export const image = (): string => fs.readFileSync(new URL(IMAGE, repoRoot), "utf8");

/**
 * What the blueprint sets a key to, by the key's name: `plan`, `branch`,
 * `dockerfilePath`. The leading dash of a list item is allowed, since the one
 * service is a list item and its first key carries one; a quoted value is
 * unquoted and a trailing comment dropped, so `plan: starter # ...` reads as
 * the plan a maintainer is billed under.
 *
 * Undefined when the key is absent, so a test names the key it wanted rather
 * than failing on a parse, and a throw when the blueprint sets it more than
 * once, which is a file no single answer is true about.
 */
export const blueprintSetting = (key: string, text: string = blueprint()): string | undefined => {
  const found = [...text.matchAll(new RegExp(String.raw`^\s*-?\s*${key}:\s*"?([^"\n#]+?)"?\s*(?:#.*)?$`, "gm"))];
  if (found.length > 1) throw new Error(`${BLUEPRINT} states ${key} ${found.length} times`);
  return found[0]?.[1];
};

/**
 * The schedule the blueprint's one cron job is set to. One cron job and one
 * schedule or nothing: a blueprint that grew a second of either would have its
 * reader answering for whichever one it happened to reach first.
 */
export const blueprintSchedule = (text: string = blueprint()): string => {
  const jobs = [...text.matchAll(/^\s*-?\s*type:\s*cron\s*$/gm)];
  if (jobs.length !== 1) throw new Error(`${BLUEPRINT} declares ${jobs.length} cron jobs`);
  const schedule = blueprintSetting("schedule", text);
  if (schedule === undefined) throw new Error(`${BLUEPRINT} states no schedule`);
  return schedule;
};

/**
 * Every minute of the hour a cron minute field fires on, sorted, or undefined
 * for a field this cannot read. `*`, `a`, `a,b`, `a-b` and a `/n` step on any
 * of those are the shapes a blueprint is written in; anything else (a name, a
 * `?`, a range end on a wildcard, a minute outside the hour) is not read
 * rather than guessed at, because a guess here would be a schedule nobody
 * checked.
 *
 * A step with no range of its own runs to the end of the hour, which is how
 * every cron reads it: `0/30` fires at 0 and 30, not once at 0. Reading it as
 * its start alone would call a schedule half as slow as it runs, which on an
 * hourly interval is a blueprint running twice as often as the repo documents
 * and passing anyway.
 */
const cronMinutes = (field: string): number[] | undefined => {
  const fired = new Set<number>();
  for (const term of field.split(",")) {
    const match = /^(?:(\*)|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(term);
    if (!match) return undefined;
    const [, star, from, to, step] = match;
    const first = star ? 0 : Number(from);
    const last = to !== undefined ? Number(to) : star || step !== undefined ? 59 : first;
    const by = step === undefined ? 1 : Number(step);
    if (by < 1 || last < first || last > 59) return undefined;
    for (let minute = first; minute <= last; minute += by) fired.add(minute);
  }
  return [...fired].sort((a, b) => a - b);
};

/**
 * How many minutes a five-field cron expression leaves between its runs, or
 * undefined when it does not run at one fixed gap the clock round.
 *
 * The gaps are measured rather than read off the step, because a step of seven
 * is not every seven minutes -- it fires at 0 and again at 56 and then waits
 * four -- and `0,45` is not every 45. Both are schedules a maintainer writes
 * meaning the interval, and a reader that took the step at its word would call
 * each of them what it is not.
 */
export const minutesBetweenRuns = (schedule: string): number | undefined => {
  const fields = schedule.trim().split(/\s+/);
  // Anything below the hour that is not a wildcard is a schedule that skips
  // hours, days or weekdays, which is not an interval however its minutes read.
  if (fields.length !== 5 || !fields.slice(1).every((field) => field === "*")) return undefined;
  const minutes = cronMinutes(fields[0]!);
  if (!minutes || minutes.length === 0) return undefined;
  // Round the clock, so the wrap past the hour is a gap like any other: a
  // schedule whose last run of the hour is far from the first one is not
  // running at that gap, whatever its runs inside the hour look like.
  const gaps = minutes.map((minute, index) => (index + 1 < minutes.length ? minutes[index + 1]! - minute : 60 - minute + minutes[0]!));
  return gaps.every((gap) => gap === gaps[0]) ? gaps[0] : undefined;
};
