/**
 * One repository variable, read, and the two switches a human sets on a target
 * through one: `PAUSE` (#256) and `WAIVER` (#244). They sit in the same place,
 * answer the same way and fail the same way, so the shape of the read lives
 * here once and each switch supplies only its own name, how it reads its
 * value, and the line it prints. They were `pause.ts` and `waiver.ts`, two
 * mirror modules over this read whose interface was as wide as their bodies;
 * folded in here, the read plumbing has one home and each switch is a few
 * lines beside it.
 *
 * One copy of the read because the two switches have to agree about the one
 * case that is not a failure: an unset variable is a 404. Two copies of that
 * predicate is two places for a target to be read as running while GitHub was
 * refusing the call.
 *
 * The switches do not fully merge: they read the same kind of value and
 * disagree on one case. A pause set to whitespace is still a pause, because the
 * caller's gate is a literal `vars.FACTORY_PAUSED == ''` string test; a waiver
 * set to whitespace is no waiver. So each keeps its own `reason`.
 *
 * Only a human ever writes either, never the factory: `FACTORY_PAT` cannot
 * write repository variables, which is what stops the factory pausing, resuming
 * or waiving itself.
 *
 * Builtins only and explicit `.ts`, so `send.ts` reaches it on bare
 * `node --experimental-strip-types`.
 */

/**
 * A GET of one variable's value, with no `--method`, so asking a target about
 * its own settings cannot start a job on it.
 */
export const variableReadArgs = (target: string, name: string): string[] => [
  "api",
  `repos/${target}/actions/variables/${name}`,
  "--jq",
  ".value",
];

/**
 * The value, or nothing: `gh` prints a trailing newline, and a variable set to
 * blank carries nothing to act on. Both switches take the value as the reason,
 * and a reason nobody can read is not one.
 */
export const variableValue = (raw: string): string | undefined => raw.trim() || undefined;

/**
 * Is this failed read the variable simply not being there? True of a read that
 * a token without Actions variables read made, too, which is why a caller that
 * turns on the answer asks `variablesReadableArgs` next.
 */
export const isUnset = (error: string): boolean => error.includes("HTTP 404");

/**
 * The second question a 404 raises: may this token read the target's variables
 * at all? A fine-grained token holding the repo but not Actions variables read
 * is answered 404 on a single variable, exactly as GitHub answers one that is
 * not set, so the one code cannot tell a missing variable from a missing
 * permission.
 *
 * The list tells them apart because it has an empty answer: a token that may
 * read gets 200 and a count of zero on a target with no variables, where one
 * that may not gets the same 404 as before. So a 404 here is the permission.
 *
 * A GET, like the read it disambiguates, and unpaginated: the count is the
 * whole of what is being asked for, and no page of it is read.
 */
export const variablesReadableArgs = (target: string): string[] => [
  "api",
  `repos/${target}/actions/variables`,
  "--jq",
  ".total_count",
];

/**
 * What the pause line says when the variable is set but its value is only
 * whitespace. The target is paused, because the caller stops for it; what is
 * missing is the reason, and `paused ()` names nothing a maintainer can act on.
 */
const NO_REASON = "no reason given";

/** The two repository variables, named once so the read and the line agree. */
const PAUSE_VARIABLE = "FACTORY_PAUSED";
const WAIVER_VARIABLE = "FACTORY_CHECKS_WAIVED";

/**
 * The pause (#256): a human's declaration that one target's factory starts and
 * advances no work. The caller gates every such job on the same variable, so
 * waking a paused target creates a run whose every work job is skipped: a
 * billed minute per interval to be told nothing is happening. Reading the pause
 * before the wake is what makes the brake stop metering. It never stops
 * `merge-gate` or `audit`, because neither is driven by the heartbeat.
 */
export const PAUSE = {
  /** The repository variable holding the reason, beside `FACTORY_CHECKS_WAIVED`. */
  variable: PAUSE_VARIABLE,

  /**
   * Whether the target is paused, and why: the reason, or nothing when it is
   * running.
   *
   * The test for paused is the caller's own, `vars.FACTORY_PAUSED == ''`, a
   * string comparison: the empty value runs and everything else pauses,
   * whitespace included. So only the newline `gh` adds is taken off before that
   * question is asked. Trimming first and calling a whitespace value no pause is
   * how the two halves of one pause come apart, and it comes apart the expensive
   * way: every gated job on the target is skipped while the heartbeat goes on
   * waking it every interval, with the pass reporting it woken.
   *
   * The reason is then the trimmed value a human can read, and a value with
   * nothing left after the trim keeps the pause and loses only the reason.
   */
  reason: (raw: string): string | undefined => {
    const value = raw.replace(/\n$/, "");
    if (value === "") return undefined;
    return value.trim() || NO_REASON;
  },

  /**
   * What the sender prints for a target it did not wake. It says why, so a pause
   * left on by accident is visible in the pass rather than looking like an idle
   * target, which is how a forgotten pause goes unnoticed.
   */
  line: (target: string, reason: string): string =>
    `${target} skipped: paused (${reason}); resume with \`gh variable delete ${PAUSE_VARIABLE} --repo ${target}\``,
};

/**
 * The waiver (#244): a human's declaration that the factory cannot run, so its
 * checks are not required on one target. Nothing clears one automatically, so
 * the heartbeat names an open one every run until a human closes it: a waiver
 * nobody is reminded of is the failure mode the nag exists to prevent. Written
 * only by `scripts/waive-factory-checks.sh` and a human, never this: a broken
 * factory restoring its own required checks is how a silent green happens.
 */
export const WAIVER = {
  /** The repository variable holding the reason, beside `FACTORY_PAUSED`. */
  variable: WAIVER_VARIABLE,

  /** The variable's value, or nothing: a variable set to blank carries no reason to act on. */
  reason: (raw: string): string | undefined => variableValue(raw),

  /**
   * What the sender prints for one target, or nothing when it is not waived. It
   * says the variable is set and no more: the ruleset is not read here, and a
   * half-failed `on` or an `onboard.sh` re-run leaves the variable set with the
   * factory's checks required after all.
   */
  line: (target: string, reason: string | undefined): string | undefined =>
    reason === undefined
      ? undefined
      : `${target} WAIVED: ${reason} (${WAIVER_VARIABLE} is set on the target; close it with \`scripts/waive-factory-checks.sh ${target} off\`)`,
};
