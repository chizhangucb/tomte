/**
 * `scripts/heartbeat-loop.sh` seen the way an always-on machine sees it
 * (#326): what it runs, in what order, and what it does when one of those
 * runs fails. The script is bash and drives `git`, `node` and `sleep`, so the
 * one honest test runs it with all three stubbed first on PATH, the same
 * harness `factory/waiver/waive-factory-checks.test.ts` uses for its own
 * script.
 *
 * Every call goes to one ordered log rather than three, because the claims
 * here are claims about order -- a pull before every pass, a sleep after each
 * one -- which a per-command tally cannot settle.
 *
 * The interval read is the one call the stub `node` hands to the real one, so
 * the sleep this test asserts on comes from `interval.ts` through the script
 * rather than from a number the test fed in and read back out.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { HEARTBEAT_INTERVAL_MINUTES } from "./interval.ts";
import { PING_URL_ENV } from "./ping.ts";

const script = fileURLToPath(new URL("../../scripts/heartbeat-loop.sh", import.meta.url));

/** What one pass sleeps for: the repo's interval, in the seconds `sleep` takes. */
const INTERVAL_SECONDS = String(HEARTBEAT_INTERVAL_MINUTES * 60);

/**
 * A stub `git` recording every call, one tab-separated argv per line in the
 * shared log. `GIT_FAILS` makes the pull fail the way an unreachable remote
 * does, which is the failure the loop has to survive.
 */
const stubGit = `#!/usr/bin/env bash
printf '%s\\t' git "$@" >> "$CALLS"; printf '\\n' >> "$CALLS"
if [ -n "\${GIT_FAILS:-}" ]; then echo "$GIT_FAILS" >&2; exit 1; fi
exit 0
`;

/**
 * A stub `node` that stands in for the pass and hands the interval read to the
 * real `node`. The pass is what a test can afford to fake: it talks to GitHub.
 * The interval read is what it must not, since the number it answers with is
 * the thing under assertion. `PASS_FAILS` is how many opening passes exit
 * non-zero, and `INTERVAL_READ_FAILS` makes the read fail without reaching a
 * real `node` at all.
 */
const stubNode = `#!/usr/bin/env bash
case "$*" in
  *send.ts*)
    printf '%s\\t' node "$@" >> "$CALLS"; printf '\\n' >> "$CALLS"
    printf '%s\\t%s\\n' "\${GH_TOKEN-}" "\${${PING_URL_ENV}-}" >> "$PASS_ENV"
    passes=$(wc -l < "$PASS_ENV")
    if [ "$passes" -le "\${PASS_FAILS:-0}" ]; then echo "stub pass failed" >&2; exit 1; fi ;;
  *)
    printf '%s\\t' read-interval >> "$CALLS"; printf '\\n' >> "$CALLS"
    if [ -n "\${INTERVAL_READ_FAILS:-}" ]; then echo "$INTERVAL_READ_FAILS" >&2; exit 1; fi
    exec "$REAL_NODE" "$@" ;;
esac
exit 0
`;

/**
 * A stub `sleep` recording what it was asked to wait, and the thing that ends
 * the run: the script loops forever by design, so the test bounds it by having
 * the last sleep kill the script rather than by any argument the script takes.
 * A bound the script knew about would be a bound the real host runs with too.
 */
const stubSleep = `#!/usr/bin/env bash
printf '%s\\t' sleep "$@" >> "$CALLS"; printf '\\n' >> "$CALLS"
if [ "$(grep -c '^sleep' "$CALLS")" -ge "$MAX_SLEEPS" ]; then kill "$PPID"; fi
exit 0
`;

type Options = {
  /** How many passes the loop is allowed before the stub `sleep` kills it. */
  passes?: number;
  /** When set, every pull fails with this text. */
  gitFails?: string;
  /** How many opening passes exit non-zero. */
  passFails?: number;
  /** When set, the interval read fails with this text rather than answering. */
  intervalReadFails?: string;
  /** The token and ping URL the host has in the loop's environment. */
  env?: Record<string, string>;
};

const run = (options: Options = {}) => {
  const { passes = 2, gitFails, passFails = 0, intervalReadFails, env = {} } = options;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-loop-"));
  for (const [name, source] of [
    ["git", stubGit],
    ["node", stubNode],
    ["sleep", stubSleep],
  ] as const) {
    fs.writeFileSync(path.join(dir, name), source, { mode: 0o755 });
  }
  const callsFile = path.join(dir, "calls.tsv");
  const passEnvFile = path.join(dir, "pass-env.tsv");
  fs.writeFileSync(callsFile, "");
  fs.writeFileSync(passEnvFile, "");
  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      ...env,
      PATH: `${dir}:${process.env.PATH}`,
      REAL_NODE: process.execPath,
      CALLS: callsFile,
      PASS_ENV: passEnvFile,
      MAX_SLEEPS: String(passes),
      GIT_FAILS: gitFails ?? "",
      PASS_FAILS: String(passFails),
      INTERVAL_READ_FAILS: intervalReadFails ?? "",
    },
  });
  const calls: string[][] = fs
    .readFileSync(callsFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t").slice(0, -1));
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    /** Every call the script made, in order, argv and all. */
    calls,
    /** The command of each call in order, which is what the loop's shape is made of. */
    shape: calls.map(([command]) => command),
    /** The token and ping URL each pass was handed, one row per pass. */
    passEnv: fs
      .readFileSync(passEnvFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t")),
  };
};

test("a pass is a pull, then the sender, then a sleep of the repo's interval, over and over", () => {
  // Acceptance criteria 1 and 2, and the whole shape of the thing: the loop
  // takes no arguments, and what it does is the same three calls forever.
  // Asserted as one ordered shape rather than as three tallies, because "pulls
  // before every pass" is a claim about order and a tally cannot tell it from
  // a script that pulled twice and then passed twice.
  const { shape, calls } = run({ passes: 3 });
  assert.deepEqual(shape, ["git", "read-interval", "node", "sleep", "git", "read-interval", "node", "sleep", "git", "read-interval", "node", "sleep"]);
  // The pull is fast-forward only and names `main`: a loop that could merge
  // would run whatever the merge produced, and one that pulled a branch would
  // be the working checkout this recipe exists to replace.
  for (const call of calls.filter(([command]) => command === "git")) {
    assert.deepEqual(call, ["git", "pull", "--ff-only", "origin", "main"]);
  }
  // The sender, as both onboarding pages tell a host to run it.
  for (const call of calls.filter(([command]) => command === "node")) {
    assert.deepEqual(call, ["node", "--experimental-strip-types", "factory/heartbeat/send.ts"]);
  }
  // And the sleep is the interval the repo carries, in seconds, which reached
  // the script from `interval.ts` through the real `node` the stub delegated
  // to. A number the script restated would survive the constant moving.
  for (const call of calls.filter(([command]) => command === "sleep")) {
    assert.deepEqual(call, ["sleep", INTERVAL_SECONDS]);
  }
});
