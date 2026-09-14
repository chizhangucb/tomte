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
const RECORD = String.raw`record() { printf '%s\t' "$@" >> "$CALLS"; printf '\n' >> "$CALLS"; }`;

const stubGit = `#!/usr/bin/env bash
${RECORD}
record git "$@"
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
${RECORD}
case "$*" in
  *send.ts*)
    record node "$@"
    printf '%s\\t%s\\n' "\${GH_TOKEN-}" "\${${PING_URL_ENV}-}" >> "$PASS_ENV"
    passes=$(wc -l < "$PASS_ENV")
    if [ "$passes" -le "\${PASS_FAILS:-0}" ]; then echo "stub pass failed" >&2; exit 1; fi ;;
  *)
    record read-interval
    if [ -n "\${INTERVAL_READ_FAILS:-}" ] && [ "$(grep -c '^read-interval' "$CALLS")" -gt "\${INTERVAL_READS_OK:-0}" ]; then
      echo "$INTERVAL_READ_FAILS" >&2; exit 1
    fi
    if [ -n "\${INTERVAL_READ_JUNK:-}" ] && [ "$(grep -c '^read-interval' "$CALLS")" -gt "\${INTERVAL_READS_OK:-0}" ]; then
      printf '%s' "$INTERVAL_READ_JUNK"; exit 0
    fi
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
${RECORD}
record sleep "$@"
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
  /** How many interval reads answer before `intervalReadFails` starts failing them. */
  intervalReadsOk?: number;
  /** When set, the interval read exits 0 having printed this instead of a number of seconds. */
  intervalReadJunk?: string;
  /** The token and ping URL the host has in the loop's environment. */
  env?: Record<string, string>;
};

const run = (options: Options = {}) => {
  const { passes = 2, gitFails, passFails = 0, intervalReadFails, intervalReadsOk = 0, intervalReadJunk, env = {} } = options;
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
    // Anywhere but the clone. A keep-alive starts the loop from the root
    // directory or from the maintainer's home, never from the checkout, so a
    // script that read `./factory/...` out of whatever directory it inherited
    // would work in this test and nowhere a host runs it.
    cwd: dir,
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
      INTERVAL_READS_OK: String(intervalReadsOk),
      INTERVAL_READ_JUNK: intervalReadJunk ?? "",
    },
  });
  const calls: string[][] = fs
    .readFileSync(callsFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t").slice(0, -1));
  return {
    status: result.status,
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

/** The calls one whole pass makes, in the order the loop makes them. */
const PASS = ["git", "read-interval", "node", "sleep"];

test("a pass is a pull, then the sender, then a sleep of the repo's interval, over and over", () => {
  // Acceptance criteria 1 and 2, and the whole shape of the thing: the loop
  // takes no arguments, and what it does is the same three calls forever.
  // Asserted as one ordered shape rather than as three tallies, because "pulls
  // before every pass" is a claim about order and a tally cannot tell it from
  // a script that pulled twice and then passed twice.
  const { shape, calls } = run({ passes: 3 });
  assert.deepEqual(shape, [...PASS, ...PASS, ...PASS]);
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

test("a pass that fails is said out loud and the next pass runs anyway", () => {
  // Acceptance criterion 3, the half that matters most: a target unreadable
  // for one pass, or a token rate limited for a minute, must not be the end of
  // the heartbeat for every target. The loop is the only thing sweeping them.
  const { shape, stderr } = run({ passes: 2, passFails: 1 });
  assert.deepEqual(shape, [...PASS, ...PASS], "the pass after a failed one is a whole pass");
  assert.match(stderr, /pass FAILED/, `the failure is on stderr, where the sender puts its own: ${stderr}`);
});

test("a pull that fails is said out loud and the pass runs on the clone as it stands", () => {
  // The other half of criterion 3. A clone that could not reach GitHub is
  // still `main` as merged, one pass behind, so the pass is worth running:
  // skipping it would mean a network blip on the host stopped every target
  // sweeping, which is the failure the loop exists to survive.
  const { shape, stderr } = run({ passes: 2, gitFails: "fatal: unable to access 'https://github.com/': could not resolve host" });
  assert.deepEqual(shape, [...PASS, ...PASS], "a failed pull costs neither the pass nor the loop");
  assert.match(stderr, /pull failed/, `the failure is on stderr: ${stderr}`);
});

test("the token and the ping URL reach the sender exactly as the host set them", () => {
  // Acceptance criterion 4. The loop is a host's whole interface to the
  // sender, so anything it rewrote on the way through would be a setting a
  // maintainer set on the host and the pass never saw: a scoped token, and the
  // dead-man's switch that says whether the pass happened at all (#325).
  const env = { GH_TOKEN: "github_pat_stub_not_a_real_token", [PING_URL_ENV]: "https://hc-ping.test/2b0d1a1e-stub" };
  const { passEnv } = run({ passes: 2, env });
  assert.deepEqual(passEnv, [
    [env.GH_TOKEN, env[PING_URL_ENV]],
    [env.GH_TOKEN, env[PING_URL_ENV]],
  ]);
});

test("an interval that cannot be read leaves the loop sleeping the last one it read", () => {
  // The interval is read after every pull, which is what lets a moved constant
  // reach the host. A read that fails is the same kind of thing as a failed
  // pass -- one bad pass, not the end -- so the loop keeps the number the repo
  // last gave it rather than guessing or spinning.
  const { shape, calls, stderr } = run({ passes: 2, intervalReadFails: "node: bad flag", intervalReadsOk: 1 });
  assert.deepEqual(shape, [...PASS, ...PASS]);
  assert.deepEqual(
    calls.filter(([command]) => command === "sleep"),
    [
      ["sleep", INTERVAL_SECONDS],
      ["sleep", INTERVAL_SECONDS],
    ],
    "the second pass sleeps the interval the first one read",
  );
  assert.match(stderr, /sleeping the last one read/, stderr);
});

test("a clone that answers no interval at all stops, rather than looping with nothing to sleep", () => {
  // The one case there is no last-read interval to fall back on. A loop that
  // carried on here would run passes back to back at whatever speed the sender
  // returns, which bills every target far harder than a stopped heartbeat
  // does. Stopping hands it to the keep-alive, which restarts it throttled.
  const { status, shape, stderr } = run({ passes: 2, intervalReadFails: "node: no such file" });
  assert.equal(status, 1, stderr);
  assert.deepEqual(shape, ["git", "read-interval"], "nothing is slept and no pass is run");
  assert.match(stderr, /could not read the heartbeat interval/, stderr);
});

const readme = (): string => fs.readFileSync(new URL("../../README.md", import.meta.url), "utf8");

/** The body of every fenced block on a page, which is what a maintainer copies out of it. */
const fencedBlocks = (page: string): string[] => [...page.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map(([, body]) => body!);

/** A literal as a regex, so a path or a key is matched whole and never as a pattern. */
const literal = (text: string): RegExp => new RegExp(text.replaceAll(/[.*+?^${}()|[\]\\/]/g, "\\$&"));

test("README's own-machine recipe runs the loop from a clone of its own, with the token and the switch in its environment", () => {
  // Acceptance criterion 6. An adopter with an always-on machine reads this
  // page and nothing else, so the three things that make the recipe work
  // rather than merely run have to be on it: the clone is the loop's and not
  // one anybody works in, the scoped token and the ping URL are the
  // environment's, and the machine does not go to sleep under it.
  const page = readme();
  assert.match(page, literal("scripts/heartbeat-loop.sh"), "README names the loop runner");
  const sentences = page.split(/(?<=[.:])\s/);
  assert.ok(
    sentences.some((sentence) => /\bclone\b/i.test(sentence) && /working checkout/i.test(sentence)),
    "README says in one sentence that the loop wants a clone of its own and never a working checkout",
  );
  for (const variable of ["GH_TOKEN", PING_URL_ENV]) {
    assert.match(page, new RegExp(`\\b${variable}\\b`), `README says the loop takes ${variable} from its environment`);
  }
  // Sleep, because a host asleep runs no pass at all, and a recipe that left
  // it out would be a machine that looked always-on and was not.
  assert.ok(
    sentences.some((sentence) => /\bsleep(?:ing)?\b/i.test(sentence) && /pmset/.test(sentence) && /sleep\.target|suspend/.test(sentence)),
    "README says how to stop the machine sleeping, on a Mac and on Linux",
  );
});

test("the keep-alive examples carry no interval, because the host is not what schedules the pass", () => {
  // The other half of criterion 6, and the point of the whole ticket: launchd
  // and systemd are each given one job, restarting the loop, and neither is
  // given a number. The host that carries an interval is the host that drifts
  // from the repo's, and the loop is what leaves it no second copy to drift
  // with: the sender itself remembers nothing about the passes before this one
  // (#328).
  const blocks = fencedBlocks(readme());
  for (const [scheduler, key] of [
    ["launchd", "KeepAlive"],
    ["systemd", "Restart=always"],
  ] as const) {
    const examples = blocks.filter((block) => block.includes(key));
    assert.equal(examples.length, 1, `README has one ${scheduler} example, keyed on ${key}`);
    const example = examples[0]!;
    assert.match(example, literal("scripts/heartbeat-loop.sh"), `the ${scheduler} example keeps the loop alive and runs nothing else`);
    // Every way each of the two knows to say "on an interval". A recipe
    // reaching for one of these is a host that schedules passes itself, which
    // is what the loop replaced.
    assert.doesNotMatch(
      example,
      /StartInterval|StartCalendarInterval|OnCalendar|OnUnitActiveSec|OnBootSec|OnActiveSec|\bcron\b|\btimer\b/i,
      `the ${scheduler} example schedules nothing`,
    );
    for (const number of [String(HEARTBEAT_INTERVAL_MINUTES), INTERVAL_SECONDS]) {
      assert.doesNotMatch(example, literal(number), `the ${scheduler} example does not restate the interval`);
    }
  }
});

test("a read that answers anything but a number of seconds is a failed read, not something to sleep", () => {
  // A `node` that exits 0 having printed a warning, a stray line, or nothing
  // at all is the failure that reads as a success. Passing what it said
  // straight to `sleep` makes every sleep fail instantly, and a loop that
  // never sleeps runs passes back to back on every target it covers, which is
  // the one failure here that costs money rather than coverage.
  const { shape, calls } = run({ passes: 2, intervalReadJunk: "(node:1) ExperimentalWarning: stripping types\n", intervalReadsOk: 1 });
  assert.deepEqual(shape, [...PASS, ...PASS]);
  assert.deepEqual(
    calls.filter(([command]) => command === "sleep"),
    [
      ["sleep", INTERVAL_SECONDS],
      ["sleep", INTERVAL_SECONDS],
    ],
    "the junk is refused and the interval the first pass read is slept instead",
  );
});
