/**
 * One repository variable, read, and the two switches a human sets on a target
 * through one: `PAUSE` (#256) and `WAIVER` (#244). `pause.ts` and `waiver.ts`
 * were two mirror modules over this read; they are folded in here, so their
 * assertions live here too.
 *
 * Each switch's variable name is pinned against the thing that writes it (the
 * caller template for the pause, `waive-factory-checks.sh` for the waiver): the
 * gate a human sets and the read that finds it have to name the same variable,
 * and a test that quoted it would pass while they drifted.
 *
 * The one predicate the module exists to keep single, `isUnset`, is tested
 * here rather than through either consumer, because a rule pinned only through
 * one of the two is a rule the other can be changed out from under.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { PAUSE, WAIVER, isUnset, variableReadArgs, variableValue, variablesReadableArgs } from "./variable.ts";

test("the read is a GET, so asking a target about its own settings cannot start a job on it", () => {
  const args = variableReadArgs("owner/repo", "SOME_VARIABLE");
  assert.ok(!args.includes("--method"), "the read writes nothing");
  assert.deepEqual(args, ["api", "repos/owner/repo/actions/variables/SOME_VARIABLE", "--jq", ".value"]);
});

test("the value is what a human typed, trimmed of the newline gh prints", () => {
  assert.equal(variableValue("runaway sweep, see #123\n"), "runaway sweep, see #123");
  // Trimmed at both ends, and the inner spacing left alone: the value is a
  // sentence a human wrote and the whole of it is the reason.
  assert.equal(variableValue("  PAT expired,  see #244  \n"), "PAT expired,  see #244");
});

test("a variable set to blank carries nothing to act on", () => {
  assert.equal(variableValue("   \n"), undefined);
  assert.equal(variableValue(""), undefined);
});

test("the readable check is a GET of the collection, not of a variable in it", () => {
  const args = variablesReadableArgs("owner/repo");
  assert.ok(!args.includes("--method"), "the read writes nothing");
  // The collection itself: a path ending in a variable's name would be the
  // read it exists to disambiguate, and would answer 404 in both of the cases
  // it has to tell apart.
  assert.deepEqual(args, ["api", "repos/owner/repo/actions/variables", "--jq", ".total_count"]);
  assert.notDeepEqual(args, variableReadArgs("owner/repo", PAUSE.variable));
});

test("an unset variable is a 404, and no other failure is one", () => {
  // The one case that is not a failure. Both switches turn on it and they turn
  // opposite ways: a 404 means "not paused", so the heartbeat wakes the target,
  // and it means "not waived", so the nag stays quiet. Anything else is a read
  // that went wrong, and neither may take it for an answer.
  assert.equal(isUnset("gh: Not Found (HTTP 404)"), true);
  assert.equal(isUnset("gh: API rate limit exceeded (HTTP 403)"), false);
  assert.equal(isUnset("gh: Bad credentials (HTTP 401)"), false);
  assert.equal(isUnset(""), false);
});

// --- Pause (#256), folded from pause.test.ts ---

test("the pause read is a GET of one repository variable, so asking whether a target is paused cannot start a job on it", () => {
  const args = variableReadArgs("owner/repo", PAUSE.variable);
  assert.ok(!args.includes("--method"), "the read writes nothing");
  assert.deepEqual(args, ["api", `repos/owner/repo/actions/variables/${PAUSE.variable}`, "--jq", ".value"]);
});

test("the pause variable is the one the caller's jobs gate on", () => {
  // The heartbeat's skip and the caller's gate are two halves of one pause. A
  // heartbeat reading a name the caller does not gate on would stop waking a
  // target that was never paused.
  const template = fs.readFileSync(new URL("../../templates/factory.yml", import.meta.url), "utf8");
  assert.match(template, new RegExp(`vars\\.${PAUSE.variable}`), "the caller gates on the variable the heartbeat reads");
});

test("the pause value is the reason, trimmed of the newline gh prints", () => {
  assert.equal(PAUSE.reason("runaway sweep, see #123\n"), "runaway sweep, see #123");
  assert.equal(PAUSE.reason("  runaway sweep, see #123  \n"), "runaway sweep, see #123");
});

test("only the empty value is no pause, exactly as the caller reads it", () => {
  // The caller's gate is `vars.FACTORY_PAUSED == ''`, a string comparison, so
  // the empty value is the whole of what runs. A heartbeat that read more than
  // that as running would stop waking a target no job on it is willing to work
  // for, which is the bill #256 removes, still being paid behind a pass that
  // reports the target as woken.
  assert.equal(PAUSE.reason("\n"), undefined);
  assert.equal(PAUSE.reason(""), undefined);
});

test("a pause set to whitespace is still a pause, because the caller stops for it", () => {
  // `gh variable set FACTORY_PAUSED --body " "` is not the empty string, so
  // every gated job on the target is skipped. Trimming first and calling the
  // result no pause is how the two halves of one pause come apart.
  assert.notEqual(PAUSE.reason(" \n"), undefined);
  assert.notEqual(PAUSE.reason("\t\n"), undefined);
});

test("a pause with no readable reason says so, rather than printing a blank one", () => {
  // The line is what a maintainer acts on, and `paused ()` names nothing. The
  // target is still paused: what is missing is the reason, not the pause.
  const line = PAUSE.line("owner/repo", PAUSE.reason(" \n")!);
  assert.match(line, /paused \(\S/, "the line carries something a maintainer can read");
  assert.doesNotMatch(line, /undefined/, "and a word, not a missing value rendered");
  assert.ok(line.includes(PAUSE.variable), "and still names the variable to clear");
});

test("a paused target's line carries the reason and the variable to clear", () => {
  const line = PAUSE.line("owner/repo", "runaway sweep, see #123");
  assert.ok(line.includes("owner/repo"), "the line names the target");
  assert.ok(line.includes("runaway sweep, see #123"), "the line carries the reason");
  assert.ok(line.includes(PAUSE.variable), "the line names the variable to clear");
});

// --- Waiver (#244), folded from waiver.test.ts ---

test("the waiver read is a GET of one repository variable, so it cannot start a job on the target", () => {
  const args = variableReadArgs("owner/repo", WAIVER.variable);
  assert.ok(!args.includes("--method"), "the read writes nothing");
  assert.deepEqual(args, ["api", `repos/owner/repo/actions/variables/${WAIVER.variable}`, "--jq", ".value"]);
});

test("the waiver variable is the one the script writes", () => {
  const script = fs.readFileSync(fileURLToPath(new URL("../../scripts/waive-factory-checks.sh", import.meta.url)), "utf8");
  assert.match(script, new RegExp(WAIVER.variable), "the script sets the variable the heartbeat reads");
});

test("the waiver value is the reason, trimmed of the newline gh prints", () => {
  assert.equal(WAIVER.reason("PAT expired, see #244\n"), "PAT expired, see #244");
});

test("an empty waiver value is no waiver", () => {
  // A variable set to nothing is not a reason, and nagging with no reason is
  // the one line a maintainer cannot act on.
  assert.equal(WAIVER.reason("   \n"), undefined);
  assert.equal(WAIVER.reason(""), undefined);
});

test("an open waiver is one line naming the target and the reason", () => {
  const line = WAIVER.line("owner/repo", "PAT expired, see #244");
  assert.ok(line?.includes("owner/repo"), "the line names the target");
  assert.ok(line?.includes("PAT expired, see #244"), "the line carries the reason");
  assert.ok(line?.includes(WAIVER.variable), "the line names the variable to clear");
});

test("a target with no waiver produces no line", () => {
  assert.equal(WAIVER.line("owner/repo", undefined), undefined);
});
