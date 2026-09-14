/**
 * The runnable's wiring (#222). A host runs `send.ts` on bare
 * `node --experimental-strip-types` with no `npm ci`, so every module it
 * reaches has to be imported with an explicit `.ts` specifier and may not pull
 * a package in. Nothing in the type system knows either: the prior art and the
 * same failure mode is `lib/strip-types-cone.test.ts`, whose table covers the
 * five workflow entrypoints this one is not one of.
 *
 * Two checks, because neither catches the other's failure: one pass actually
 * runs the command a host runs, which a bad specifier kills outright, and one
 * walks the imports for a package that resolves here and would not on a host
 * that installs nothing. The three import patterns are the cone test's, whole:
 * keeping one of them was how the first draft of this file passed green on the
 * imports it did not read.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { IMPLEMENT_LABEL } from "../lib/labels.ts";
import { DISAGREEING_PASSES, PASS_LOG_ENV } from "./cadence.ts";
import { HEARTBEAT_INTERVAL_MINUTES, INTERVAL_PHRASE } from "./interval.ts";
import { PING_TIMEOUT_MS, PING_URL_ENV } from "./ping.ts";
import { TARGET_REPOS } from "./targets.ts";
import { PAUSE, WAIVER } from "./variable.ts";

const PAUSE_VARIABLE = PAUSE.variable;
const WAIVER_VARIABLE = WAIVER.variable;

const repoRoot = new URL("../../", import.meta.url);
const ENTRYPOINT = "factory/heartbeat/send.ts";
/** The loop runner, which carries no interval of its own and so is one of the files the scan below owns (#326). */
const LOOP_RUNNER = "scripts/heartbeat-loop.sh";
/** The env var the host passes the token in, which is the one `gh` itself reads. */
const TOKEN_ENV = "GH_TOKEN";
/** The pages a maintainer onboards a target from, named as `dispatch/triggers.test.ts` names its own sites. */
const DOC_PAGES = ["README.md", "docs/pipeline.md"];
/**
 * The jobs a pause deliberately keeps, read off the caller rather than listed:
 * a job that keeps running while paused is one whose condition does not gate
 * on the pause variable, `paused` itself aside, which runs only while it is
 * set. Derived because the names are the point of the assertion below -- a
 * third job joining the set has to reach both pages, and a list spelled here
 * would go on passing while the pages went stale.
 *
 * Which jobs those are and why is `dispatch/triggers.test.ts`'s subject, tied
 * there to the caller's real conditions. Here they are only the names both
 * pages have to carry.
 */
const keepsRunningWhilePaused = (): string[] => {
  const template = fs.readFileSync(new URL("templates/factory.yml", repoRoot), "utf8");
  // Every job minus the gated ones, rather than only the jobs that carry an
  // `if:`: a job with no condition at all is the plainest thing a pause does
  // not stop, and deriving from the conditions alone would leave one out of
  // both pages with this green.
  const block = template.slice(template.indexOf("\njobs:"));
  assert.ok(block.startsWith("\njobs:"), "the caller template has a jobs block");
  const ids = [...block.matchAll(/\n {2}([a-z][a-z0-9_-]*):\n/g)].map(([, id]) => id!);
  assert.ok(ids.length > 0, "the caller template has jobs in it");
  const gated = new Set(
    [...block.matchAll(/\n {2}([a-z][a-z0-9_-]*):\n {4}if:((?:.*)(?:\n {6,}.*)*)/g)]
      .filter(([, , expression]) => expression!.includes(PAUSE_VARIABLE))
      .map(([, id]) => id!),
  );
  return ids.filter((id) => id !== "paused" && !gated.has(id));
};

/** A literal as a regex: a target or a path is matched whole, never as a pattern. */
const literal = (text: string): RegExp => new RegExp(text.replaceAll(/[.*+?^${}()|[\]\\/]/g, "\\$&"));

/** `import "x"`, on its own with no bindings. */
const SIDE_EFFECT_IMPORT = /^\s*import\s+["']([^"']+)["']/gm;
/** The `from "x"` of any import or re-export, including the `} from "x"` that closes a multi-line one. */
const FROM_IMPORT = /^\s*(?:import|export|\})[^'"\n]*\bfrom\s*["']([^"']+)["']/gm;
/** `import("x")`, anywhere on a line. */
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']/g;

/**
 * Every module specifier of every file the entrypoint reaches, transitively.
 * An inline `type` specifier is not skipped: type stripping blanks the keyword
 * and leaves the import, so the module is still loaded at runtime.
 */
const walkFrom = (entrypoint: string): { file: string; specifier: string }[] => {
  const reached = new Set<string>();
  const imports: { file: string; specifier: string }[] = [];
  const queue = [entrypoint];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (reached.has(file)) continue;
    reached.add(file);
    const onDisk = new URL(file, repoRoot);
    assert.ok(fs.existsSync(onDisk), `${entrypoint} reaches ${file}, which does not exist`);
    const source = fs.readFileSync(onDisk, "utf8");
    for (const pattern of [SIDE_EFFECT_IMPORT, FROM_IMPORT, DYNAMIC_IMPORT]) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1]!;
        imports.push({ file, specifier });
        if (specifier.startsWith(".")) queue.push(path.posix.join(path.posix.dirname(file), specifier));
      }
    }
  }
  return imports;
};

test("the command a host runs completes a pass on bare node, with nothing installed", () => {
  // The real command, so a specifier strip-types cannot resolve fails here
  // rather than on the host. DRY_RUN sends no dispatch and an empty PATH means
  // no `gh` to send one with, so a live target is never woken by a test run.
  const stdout = execFileSync(process.execPath, ["--experimental-strip-types", ENTRYPOINT], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { DRY_RUN: "1", PATH: "" },
  });
  for (const target of TARGET_REPOS) assert.match(stdout, literal(`factory-sweep dispatched to ${target} (dry run)`));
  // Every outcome in the summary, so a pass that skipped a target says so
  // rather than reading as a quiet repo.
  assert.match(stdout, literal(`${TARGET_REPOS.length} target(s), ${TARGET_REPOS.length} woken, 0 skipped, 0 paused, 0 failed`));
});

/**
 * A pass against a stub `gh`, the way `factory/waiver/waive-factory-checks.test.ts`
 * runs the script: the stub answers each target's two variable reads from the
 * env and every open-work read with nothing, so no target is woken and no
 * network is touched. A call it does not recognise fails, so a reshaped `gh`
 * line breaks this loudly rather than answering empty.
 *
 * Both variables answer the same way: a value set in the env is the variable's
 * value, an empty one is the 404 GitHub sends for a variable that is not there,
 * and `fail` is a read that genuinely went wrong, which is the case the pause
 * and the waiver deliberately answer differently.
 *
 * `variablesReadable` is the third answer, and the one that tells the first two
 * apart: the list endpoint, which a token that may read variables answers 200
 * even when the target has none. Default true, since that is every target whose
 * token is scoped as README says.
 */
const passAgainstStub = async ({
  waived = "",
  paused = "",
  variablesReadable = true,
  passLog = "",
  unwritablePassLog = false,
  open = "",
  pingUrl = "",
  dryRun = false,
}: {
  waived?: string;
  paused?: string;
  variablesReadable?: boolean;
  /** The pass log the cadence claim reads (#265), always under the temp dir: a test never touches a real host's. */
  passLog?: string;
  /** Point the pass log at a directory that does not exist, which is every way a host cannot keep it. */
  unwritablePassLog?: boolean;
  /** The open-work read's answer: projected items, one JSON line each. Empty is a target with nothing open. */
  open?: string;
  /** The dead-man's switch the pass reports to (#325). Empty is a host with none configured. */
  pingUrl?: string;
  /** Run the pass the way a maintainer trying the command does, which touches no target and pings nothing. */
  dryRun?: boolean;
}): Promise<{ stdout: string; stderr: string; status: number; passLog: string }> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-"));
  const passLogFile = unwritablePassLog ? path.join(dir, "no-such-directory", "passes") : path.join(dir, "passes");
  if (passLog) fs.writeFileSync(passLogFile, passLog);
  fs.writeFileSync(
    path.join(dir, "gh"),
    `#!/usr/bin/env bash
args="$*"
answer() {
  if [ "$1" = "fail" ]; then echo "gh: API rate limit exceeded (HTTP 403)" >&2; exit 1; fi
  if [ -n "$1" ]; then printf '%s\\n' "$1"; else echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi
}
case "$args" in
  *"actions/variables/${WAIVER_VARIABLE}"*) answer "\${GH_WAIVED:-}" ;;
  *"actions/variables/${PAUSE_VARIABLE}"*) answer "\${GH_PAUSED:-}" ;;
  *"actions/variables"*) answer "\${GH_VARS_LIST:-}" ;;
  *"issues?state=open"*) printf '%s' "\${GH_OPEN:-}" ;;
  *) echo "stub gh: unexpected call: $args" >&2; exit 1 ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  const result = await run({
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    DRY_RUN: dryRun ? "1" : "",
    [PASS_LOG_ENV]: passLogFile,
    [PING_URL_ENV]: pingUrl,
    GH_WAIVED: waived,
    GH_PAUSED: paused,
    GH_OPEN: open,
    // The count GitHub answers a list read with, which is "0" for a target
    // that has no variables at all: an answer, and not the absence of one.
    GH_VARS_LIST: variablesReadable ? "0" : "",
  });
  return { ...result, passLog: fs.existsSync(passLogFile) ? fs.readFileSync(passLogFile, "utf8") : "" };
};

/**
 * One run of the real command, awaited rather than blocking. `spawnSync` would
 * hold this process's event loop for the whole pass, and the ping tests below
 * serve the switch the pass reports to from this very process: a blocked loop
 * never accepts that connection, so every one of them would read as an
 * unreachable switch.
 */
const run = async (env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; status: number }> => {
  const child = spawn(process.execPath, ["--experimental-strip-types", ENTRYPOINT], { cwd: fileURLToPath(repoRoot), env });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve([code, signal]));
  });
  // A pass a signal killed has no status to read: say so here rather than
  // asserting against a null stdout further down.
  assert.equal(signal, null, "the pass was not killed");
  return { stdout, stderr, status: code ?? -1 };
};

/**
 * A local HTTP server standing in for healthchecks.io: it records the path of
 * every request the pass makes and answers each 200, so `paths` is exactly what
 * the switch was told. `answer` is what the server does with a request, so a
 * test can make the switch slow without making it unreachable.
 */
const pingServer = async (answer: (respond: () => void) => void = (respond) => respond()) => {
  const paths: string[] = [];
  const server = http.createServer((request, response) => {
    paths.push(request.url!);
    answer(() => response.writeHead(200).end("OK"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/a-check-uuid`;
  return {
    url,
    paths,
    /**
     * Connections destroyed first, then the server closed: `close` does not
     * call back until every connection has ended, so a request the slow-switch
     * test left hanging would hold the teardown open forever the other way
     * round.
     */
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

/** A switch with a server behind it, torn down whatever the assertions do. */
const withPingServer = async <T>(
  use: (server: Awaited<ReturnType<typeof pingServer>>) => Promise<T>,
  answer?: (respond: () => void) => void,
): Promise<T> => {
  const server = await pingServer(answer);
  try {
    return await use(server);
  } finally {
    await server.close();
  }
};

test("a pass names an open waiver, with its reason and the target", async () => {
  const { stdout } = await passAgainstStub({ waived: "PAT expired, see #244" });
  for (const target of TARGET_REPOS) assert.match(stdout, literal(`${target} WAIVED: PAT expired, see #244`));
  assert.match(stdout, literal(WAIVER_VARIABLE));
});

test("a target with no waiver produces no such line", async () => {
  // The variable unset is a 404, which is not a failure and not a nag either.
  const { stdout } = await passAgainstStub({});
  assert.doesNotMatch(stdout, /WAIVED/);
  assert.match(stdout, literal(`${TARGET_REPOS.length} target(s), 0 woken, ${TARGET_REPOS.length} skipped, 0 paused, 0 failed`));
});

test("a paused target is skipped for the pause, and the pass says so rather than calling it idle", async () => {
  // Acceptance criteria 1 and 2 through the real script: the stub fails any
  // call it does not recognise and knows no dispatch, so a pass that wakes a
  // paused target here exits non-zero rather than passing quietly.
  const { stdout, status } = await passAgainstStub({ paused: "runaway sweep, see #123" });
  assert.equal(status, 0, stdout);
  for (const target of TARGET_REPOS) assert.match(stdout, literal(`${target} skipped: paused (runaway sweep, see #123)`));
  assert.doesNotMatch(stdout, /dispatched to/);
  assert.doesNotMatch(stdout, /skipped: nothing waiting/);
  // Counted apart in the summary too, so a pass that skipped every target for
  // a pause does not read as a quiet estate.
  assert.match(stdout, literal(`${TARGET_REPOS.length} target(s), 0 woken, 0 skipped, ${TARGET_REPOS.length} paused, 0 failed`));
  assert.match(stdout, literal(PAUSE_VARIABLE));
});

test("a target with work open and nothing due is not woken, and the pass says that rather than calling it idle", async () => {
  // #264, through the real script: the stub knows no dispatch, so a pass that
  // wakes this target exits non-zero rather than passing quietly. One ticket in
  // a factory state label, untouched for long enough that every deadline on it
  // has been and gone, which is the shape that woke a target every pass.
  const settled = new Date(Date.now() - 90 * 60_000).toISOString();
  const item = JSON.stringify({ number: 7, title: "a ticket", pull_request: false, labels: [{ name: IMPLEMENT_LABEL }], updated_at: settled });
  const { stdout, status } = await passAgainstStub({ open: `${item}\n` });
  assert.equal(status, 0, stdout);
  for (const target of TARGET_REPOS) assert.match(stdout, literal(`${target} not woken: work open, nothing due`));
  assert.doesNotMatch(stdout, /dispatched to/);
  // Not idle and not paused: three reasons a target is left asleep, counted apart.
  assert.doesNotMatch(stdout, /skipped: nothing waiting/);
  assert.match(stdout, literal(`${TARGET_REPOS.length} target(s), 0 woken, 0 skipped, 0 paused, 0 failed, ${TARGET_REPOS.length} with nothing due`));
});

test("a token that cannot read a target's variables fails it, rather than reading every pause as unset", async () => {
  // Acceptance criterion 6 again, against the way the failure actually
  // arrives. A fine-grained PAT holding the repo but not Actions variables
  // read answers this endpoint 404, the same 404 as a variable that is simply
  // not there, so on its own "404 means unset" hands back "not paused" for
  // every target that token covers -- including one a maintainer really did
  // pause, woken every interval with the pass reporting it woken. The list
  // endpoint is what tells them apart: a token that may read variables answers
  // it 200 even when the target has none.
  const { stdout, stderr, status } = await passAgainstStub({ paused: "", variablesReadable: false });
  assert.equal(status, 1, stdout);
  for (const target of TARGET_REPOS) assert.match(stderr, literal(`factory-sweep FAILED for ${target}`));
  assert.doesNotMatch(stdout, /dispatched to/);
  assert.match(stdout, literal(`0 woken, 0 skipped, 0 paused, ${TARGET_REPOS.length} failed`));
});

test("a target that is really paused is never asked whether its variables are readable", async () => {
  // The list read is the 404's second question and nothing more. A pause that
  // answered with a value has already settled it, so making the call anyway
  // would spend a request per target per pass to re-confirm what the answer
  // just proved.
  const { stdout, status } = await passAgainstStub({ paused: "incident", variablesReadable: false });
  assert.equal(status, 0, stdout);
  for (const target of TARGET_REPOS) assert.match(stdout, literal(`${target} skipped: paused (incident)`));
});

test("a pause that cannot be read fails its target rather than being taken for running", async () => {
  // Acceptance criterion 6. The failure is a non-zero exit, which is what the
  // host's alerting sees, and the line names the target and the variable.
  const { stdout, stderr, status } = await passAgainstStub({ paused: "fail" });
  assert.equal(status, 1, stdout);
  for (const target of TARGET_REPOS) assert.match(stderr, literal(`factory-sweep FAILED for ${target}`));
  assert.doesNotMatch(stdout, /dispatched to/);
  assert.match(stdout, literal(`${TARGET_REPOS.length} target(s), 0 woken, 0 skipped, 0 paused, ${TARGET_REPOS.length} failed`));
});

test("the runnable reaches only builtins and .ts files, so it runs with no npm install", () => {
  const imports = walkFrom(ENTRYPOINT);
  // A walk that finds nothing would pass every assertion below vacuously.
  assert.ok(imports.length > 0, `the walk from ${ENTRYPOINT} found no imports at all`);
  for (const { file, specifier } of imports) {
    if (specifier.startsWith(".")) {
      assert.ok(specifier.endsWith(".ts"), `${file} imports ${specifier} with no .ts extension, which strip-types cannot resolve`);
      continue;
    }
    assert.ok(specifier.startsWith("node:"), `${file} imports the package ${specifier}, and the host installs nothing`);
  }
});

test("every import form the cone test reads is read here too", () => {
  // The first draft of this file kept one of the three and enforced a third of
  // the rule it names. Each pattern is checked against the form it is for.
  const source = ['import "./side.ts";', 'import { a } from "./from.ts";', 'await import("./dynamic.ts");'].join("\n");
  const found = [SIDE_EFFECT_IMPORT, FROM_IMPORT, DYNAMIC_IMPORT].map((pattern) => [...source.matchAll(pattern)].map((m) => m[1]));
  assert.deepEqual(found, [["./side.ts"], ["./from.ts"], ["./dynamic.ts"]]);
});

test("both pages a maintainer onboards from name the command and the token", () => {
  for (const page of DOC_PAGES) {
    const text = fs.readFileSync(new URL(page, repoRoot), "utf8");
    assert.match(text, literal(ENTRYPOINT), `${page} names the runnable`);
    assert.match(text, new RegExp(`\\b${TOKEN_ENV}\\b`), `${page} names the env var the token travels in`);
  }
});

test("both pages say how often to run the sender, and say the same thing", () => {
  // #261. A maintainer onboarding a target reads one of these two and has to
  // come away with a number, so neither may defer to the other for it. The
  // phrase comes from `interval.ts`, so the number reaches prose through the
  // rule that picked it rather than by being retyped: it was retyped into
  // twelve files before this, and every one of them was still saying 10 the
  // day the heartbeat moved to 15.
  for (const page of DOC_PAGES) {
    const text = fs.readFileSync(new URL(page, repoRoot), "utf8");
    assert.match(text, literal(INTERVAL_PHRASE), `${page} says how often the sender runs`);
  }
});

/**
 * A cadence written as a number of minutes, in the shapes this repo's prose
 * actually uses. Not just `every N minutes`: the site this test missed on its
 * first pass said "waiting up to ten minutes for the next heartbeat", in a
 * file the same commit edited thirteen lines lower.
 */
const NUMBER = String.raw`(?:\d+|ten|fifteen|twenty|thirty)`;
const STATED_CADENCE = new RegExp(
  // Two fences against the things that are a number of minutes without being
  // a cadence. "after 15 minutes" is a deadline, which is what
  // `retry/decide.test.ts` is full of, so the lead-ins are only the ones that
  // say "repeatedly" or "at worst". And the second form is fenced on its noun,
  // because "the 5 minute dispatcher" in `lib/gh.ts` is that job's own budget.
  String.raw`(?:every|within|up to) ${NUMBER} minutes|\b${NUMBER}[- ]minute (?:sweep|heartbeat|interval)\b`,
  "i",
);
/** The same pattern over a whole sentence, since one sentence can state a cadence more than once. */
const EVERY_STATED_CADENCE = new RegExp(STATED_CADENCE.source, "gi");

/**
 * Prose that is about the heartbeat at all, which is the only cadence this
 * test owns. `sweep` is in the list because that is what most of the repo
 * calls the thing the interval drives: `agent-implement.yml` describes the
 * dispatcher's sweep at length and never uses either of the other two words,
 * so a scope without it skipped that file whole, and the stale cadence in it
 * with the scan green.
 */
const ABOUT_THE_HEARTBEAT = /heartbeat|factory-sweep|\bsweep\b/i;

/** Comment markers and line breaks gone, so a pattern can cross the wrap of a comment block. */
const asProse = (raw: string): string => raw.replace(/^\s*(?:\*|#|\/\/)\s?/gm, " ").replace(/\s+/g, " ");

test("the cadence scanner matches the shapes this repo writes, so it cannot pass by failing to look", () => {
  // The positive control. The first draft of the scan below could not cross a
  // line break, so it was green against all twelve sites it existed to find,
  // and nothing said so. A scan is only evidence if the pattern is known to
  // match what it is hunting.
  // Every shape below is one this repo actually wrote, and each of the last
  // three got past an earlier draft of this pattern.
  const shouldMatch = [
    "the heartbeat, sent from outside GitHub every 10 minutes",
    "* GitHub every 15 minutes; the schedule is\n * the fallback",
    "instead of waiting up to ten minutes for the next heartbeat",
    "the dispatcher's ten minute sweep re-dispatches exactly that shape",
    "so a 10-minute sweep costs seconds",
  ];
  for (const prose of shouldMatch) assert.match(asProse(prose), STATED_CADENCE, `the scanner would miss: ${prose}`);
  // And the things that are a number of minutes without being this cadence.
  const shouldNotMatch = [
    "the heartbeat's interval, which interval.ts names",
    "instead of waiting for the next heartbeat",
    "killing it leaves the 5 minute dispatcher four minutes to finish its sweep",
    "no call outlives 60 seconds",
    '- cron: "4,14,24,34,44,54 * * * *"',
  ];
  for (const prose of shouldNotMatch) assert.doesNotMatch(asProse(prose), STATED_CADENCE, `the scanner would flag: ${prose}`);
  // And every statement in a sentence, not the first. A sentence opening with
  // the allowed phrase would otherwise carry a stale one past the scan.
  assert.deepEqual(
    [...asProse("run it every 15 minutes, and so a 10-minute sweep costs seconds").matchAll(EVERY_STATED_CADENCE)].map(([m]) => m),
    ["every 15 minutes", "10-minute sweep"],
  );
});

test("no other page or module restates the interval, so there is one copy to keep true", () => {
  // The point of the ticket, and the only assertion that keeps it true. Every
  // other site says "the heartbeat interval" and defers, so a change to the
  // number is a change to one page and a constant.
  //
  // Scoped to files that talk about the heartbeat at all. A repo-wide hunt for
  // "N minutes" would fail on any unrelated cadence somebody writes down: a
  // vendored fixture's own cron, a rate-limit note, a target's CI. Those are
  // not this number and this test has no business judging them.
  //
  // Judged per statement and not per file, so the two owner pages are scanned
  // like everything else. An exempt file is a file nothing checks: the draft
  // that exempted them left `docs/pipeline.md` asserting the number is stated
  // "nowhere else" a hundred lines above a second, stale statement of it.
  //
  // A sentence naming `schedule` or `cron` is the one exemption, so a page
  // recording that GitHub's own cron was removed from the caller (#270) or
  // naming the daily recheck's cadence (#267) is not flagged as a second copy
  // of the heartbeat interval, neither being that number.
  const skipped = new Set(["factory/heartbeat/interval.ts", "factory/heartbeat/interval.test.ts", "factory/heartbeat/send.test.ts"]);
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: fileURLToPath(repoRoot), encoding: "utf8" }).split("\0").filter(Boolean);
  assert.ok(tracked.length > 0, "the walk found no tracked files at all");
  const restating: string[] = [];
  const scanned: string[] = [];
  for (const file of tracked) {
    if (skipped.has(file) || !/\.(md|ts|yml|sh)$/.test(file)) continue;
    const text = asProse(fs.readFileSync(new URL(file, repoRoot), "utf8"));
    if (!ABOUT_THE_HEARTBEAT.test(text)) continue;
    scanned.push(file);
    for (const sentence of text.split(/(?<=[.:])\s/)) {
      if (/\bschedule\b|\bcron\b/i.test(sentence)) continue;
      // Every statement in the sentence, not the first one. This repo writes
      // hundred word sentences -- README's step 6 and this page's "Why 15" are
      // each one -- so a sentence that opens with the allowed phrase and
      // restates a stale number sixty words later would pass on the first
      // match alone, which is exactly the drift the test exists to catch.
      for (const stated of sentence.matchAll(EVERY_STATED_CADENCE)) {
        if (stated[0].toLowerCase() === `every ${INTERVAL_PHRASE}`) continue;
        restating.push(`${file} ("${stated[0]}")`);
      }
    }
  }
  // A scope that matched nothing would pass this for the wrong reason, and the
  // heartbeat is named across the caller, the workflows and the dispatcher.
  assert.ok(scanned.length > 5, `only ${scanned.length} files mention the heartbeat, so the scope has stopped reaching them`);
  // The loop runner by name (#326). It is the one file that sleeps the
  // interval rather than describing it, so a number written into it is a host
  // running at a cadence this repo no longer documents -- and a scan that
  // stopped reaching it, by a rename or by prose that stopped naming the
  // heartbeat, would go on passing while that number sat there.
  assert.ok(scanned.includes(LOOP_RUNNER), `the scan no longer reaches ${LOOP_RUNNER}, which sleeps the interval`);
  assert.deepEqual(restating, [], `these state the heartbeat's cadence instead of naming the interval: ${restating.join(", ")}`);
});

test("both pages say what a pause stops, what it does not, and that the heartbeat is what stops waking the target", () => {
  // Acceptance criterion 7. A maintainer reaches for the pause in an incident
  // and reads one of these two pages, so each has to carry the whole shape on
  // its own: which jobs keep running, and that the wake is what the heartbeat
  // withholds. Before #256 both pages described a pause that stopped the work
  // and said nothing about the runs it went on paying for.
  const kept = keepsRunningWhilePaused();
  assert.ok(kept.length > 0, "the caller keeps at least one job running while paused");
  for (const page of DOC_PAGES) {
    const text = fs.readFileSync(new URL(page, repoRoot), "utf8");
    assert.match(text, literal(PAUSE_VARIABLE), `${page} names the pause variable`);
    for (const job of kept) {
      assert.match(text, literal(job), `${page} names ${job}, which a pause does not stop`);
    }
    // All three in one sentence, because each on its own is already all over
    // both pages: the word "heartbeat" appears in the path of the runnable,
    // and "paused" in every bullet about the gate. The claim being pinned is
    // the one that joins them, that a pause is what stops the target being
    // woken, and only a sentence carrying all three makes it.
    const sentences = text.split(/(?<=[.:])\s/);
    assert.ok(
      sentences.some((sentence) => [/heartbeat/i, /\bwak(e|es|ing|en)\b/i, /\bpaused?\b/i].every((part) => part.test(sentence))),
      `${page} says in one sentence that the heartbeat is what stops waking a paused target`,
    );
  }
});

/** A pass log ending one gap before now, every gap the same, long enough to hold a run. */
const recentPasses = (gapMinutes: number): string => {
  const now = Date.now();
  const behind = (passes: number): string => new Date(now - passes * gapMinutes * 60_000).toISOString();
  return `${Array.from({ length: DISAGREEING_PASSES }, (_, index) => behind(DISAGREEING_PASSES - index)).join("\n")}\n`;
};

test("a pass run at a cadence that disagrees with the documented interval says so, once, and fails nothing", async () => {
  // Acceptance criteria 1 and 5 through the real script (#265). The pass log
  // holds a run of gaps at twice the documented interval, which is a host whose
  // schedule moved and a repo that did not, so the line is printed and the pass
  // still exits 0: a cadence nobody noticed is a thing to tell a maintainer
  // about, never a reason to stop sweeping.
  const wrong = HEARTBEAT_INTERVAL_MINUTES * 2;
  const { stdout, status, passLog } = await passAgainstStub({ passLog: recentPasses(wrong) });
  assert.equal(status, 0, stdout);
  assert.equal([...stdout.matchAll(/heartbeat CADENCE:/g)].length, 1, `one claim per pass, not one per target: ${stdout}`);
  assert.match(stdout, literal(String(wrong)), "the line names the cadence observed");
  assert.match(stdout, literal(INTERVAL_PHRASE), "the line names the interval documented");
  // And the pass leaves itself behind, which is the only state this has: the
  // run the next pass judges, and nothing older.
  assert.equal(passLog.trimEnd().split("\n").length, DISAGREEING_PASSES, passLog);
});

test("a pass at the documented cadence prints no cadence line", async () => {
  // Acceptance criterion 2 through the real script. Every pass printing one is
  // how a maintainer learns to skip the pass that matters.
  const { stdout, status } = await passAgainstStub({ passLog: recentPasses(HEARTBEAT_INTERVAL_MINUTES) });
  assert.equal(status, 0, stdout);
  assert.doesNotMatch(stdout, /CADENCE/);
});

test("a first pass claims nothing and still leaves its own timestamp behind", async () => {
  // Acceptance criterion 4: a host onboarded a minute ago has no history, and a
  // pass with nothing to compare against is not evidence of anything.
  const { stdout, status, passLog } = await passAgainstStub({});
  assert.equal(status, 0, stdout);
  assert.doesNotMatch(stdout, /CADENCE/);
  // One line, and a timestamp rather than whatever else: the next pass has a
  // gap to measure only if this one left a stamp it can read back.
  const stamps = passLog.trimEnd().split("\n");
  assert.equal(stamps.length, 1, passLog);
  assert.ok(!Number.isNaN(new Date(stamps[0]!).getTime()), `the pass recorded a timestamp: ${passLog}`);
});

test("a dry run records no pass, so reporting the shape of a pass cannot move the cadence", () => {
  // A dry run reads no target and invents its answers, so counting it as a pass
  // would leave a gap no host ever took in the one file the claim is made from.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-"));
  const passLogFile = path.join(dir, "passes");
  execFileSync(process.execPath, ["--experimental-strip-types", ENTRYPOINT], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { DRY_RUN: "1", PATH: "", [PASS_LOG_ENV]: passLogFile },
  });
  assert.equal(fs.existsSync(passLogFile), false, "a dry run wrote a pass log");
});

test("a pass log that cannot be written costs the pass nothing", async () => {
  // Acceptance criterion 5. The claim is worth less than the sweep, so a pass
  // log the host cannot write is a line on stderr at most. That is the property
  // the sender kept when it started holding state at all: no pass waits on
  // another pass's file.
  const { stdout, status } = await passAgainstStub({ unwritablePassLog: true });
  assert.equal(status, 0, stdout);
  assert.doesNotMatch(stdout, /CADENCE/);
  assert.match(stdout, literal(`${TARGET_REPOS.length} target(s)`), "the pass still reported every target");
});

test("a pass whose targets all succeed tells the dead-man's switch it exited 0", async () => {
  // Acceptance criterion 1 (#325), through the real command against a local
  // server standing in for healthchecks.io. One request, to the configured URL
  // with the pass's exit status on the end, which is how healthchecks.io is
  // told a run succeeded. One and not one per target: the switch watches the
  // pass, and a check that took a request per target would read a shrinking
  // target list as a host going quiet.
  await withPingServer(async (server) => {
    const { stdout, status } = await passAgainstStub({ pingUrl: server.url });
    assert.equal(status, 0, stdout);
    assert.deepEqual(server.paths, ["/a-check-uuid/0"]);
  });
});

test("a pass with a failed target tells the switch the status it failed with", async () => {
  // Acceptance criterion 2 (#325): the exit status and not a bare "alive", so a
  // failed pass alerts at once instead of waiting out the check's grace for a
  // pass that does arrive. An unreadable pause is the failure this reaches for
  // because it is the one a host really sees, a token whose Actions variables
  // read lapsed.
  await withPingServer(async (server) => {
    const { stdout, status } = await passAgainstStub({ paused: "fail", pingUrl: server.url });
    assert.equal(status, 1, stdout);
    assert.deepEqual(server.paths, ["/a-check-uuid/1"]);
  });
});

test("a ping URL pasted with a trailing slash reaches the same check", async () => {
  // healthchecks.io shows the ping URL with no slash and a browser adds one, so
  // both shapes are pasted into a host's config, as is one with the newline a
  // secrets file leaves on the end. `/a-check-uuid//0` is a different path, and
  // the failure it produces is a check that never goes green with nothing in
  // the host's log to say why.
  await withPingServer(async (server) => {
    const { stdout, status } = await passAgainstStub({ pingUrl: `${server.url}/\n` });
    assert.equal(status, 0, stdout);
    assert.deepEqual(server.paths, ["/a-check-uuid/0"]);
  });
});

test("a host with no switch configured sends nothing, and its pass is otherwise unchanged", async () => {
  // Acceptance criterion 3 (#325). Unset is every host until somebody makes a
  // check, so the sender may not require one: the server is up and listening
  // here precisely so that a ping sent to some default would be recorded rather
  // than silently failing to connect.
  await withPingServer(async (server) => {
    // Unset, and a variable a host declared and left blank with it: neither is
    // a request to whatever the empty string resolves against.
    for (const pingUrl of ["", "   "]) {
      const { stdout, status } = await passAgainstStub({ pingUrl });
      assert.equal(status, 0, stdout);
      assert.deepEqual(server.paths, []);
      assert.match(stdout, literal(`${TARGET_REPOS.length} target(s), 0 woken, ${TARGET_REPOS.length} skipped, 0 paused, 0 failed`));
    }
  });
});

test("a dry run tells the switch nothing, so trying the command never marks the check up", async () => {
  // Acceptance criterion 4 (#325). A dry run reads no target and invents its
  // answers, so a maintainer trying the command out would otherwise report a
  // green pass for a sweep that never happened, and a host that had actually
  // died would look alive for as long as somebody kept trying it.
  await withPingServer(async (server) => {
    const { stdout, status } = await passAgainstStub({ dryRun: true, pingUrl: server.url });
    assert.equal(status, 0, stdout);
    assert.deepEqual(server.paths, []);
    assert.match(stdout, literal("(dry run)"));
  });
});

/** A pass's lines with the timestamp off the front of each, so two passes can be compared. */
const outcomeLines = (stdout: string): string[] => stdout.split("\n").filter(Boolean).map((line) => line.replace(/^\S+ /, ""));

/** A URL nothing answers on: a server bound to a free port and then shut, so the port is known and closed. */
const unreachableUrl = async (): Promise<string> => {
  const server = await pingServer();
  await server.close();
  return server.url;
};

test("a switch nothing answers on costs the pass nothing but a line on stderr", async () => {
  // Acceptance criterion 5 (#325), the unreachable half. Watching the heartbeat
  // may not be what stops it: a monitoring outage, a mistyped URL or a
  // healthchecks.io incident leaves the pass exactly as it was without a switch
  // configured at all, which is what the comparison below pins.
  const without = await passAgainstStub({});
  const { stdout, stderr, status } = await passAgainstStub({ pingUrl: await unreachableUrl() });
  assert.equal(status, without.status, stderr);
  assert.deepEqual(outcomeLines(stdout), outcomeLines(without.stdout));
  // Said out loud, and naming the variable to look in, since nothing else will
  // ever mention a switch that is not being reached.
  assert.match(stderr, literal(PING_URL_ENV));
  // And saying which failure it was. `fetch` renders every transport failure as
  // the same "fetch failed" and hangs the reason off `cause`, so a line that
  // stops there tells an operator nothing a refused port, an unknown host and a
  // bad certificate do not all say.
  assert.match(stderr, /fetch failed: \S/, `the line does not say why the switch could not be reached: ${stderr}`);
});

/**
 * How long a pass may wait on a switch and still be said to have cost it
 * nothing. An absolute number and not a multiple of `PING_TIMEOUT_MS`: judged
 * against the constant, a timeout raised to two minutes would move the bound
 * with it and stay green, which is the one regression this is here to catch.
 * Loose enough for a loaded machine, since what it rules out is a pass held
 * open for a meaningful part of an interval rather than a slow second.
 */
const SHORT_ENOUGH_MS = 15_000;

test("the timeout a slow switch is given is short against the interval", () => {
  // The bound the test below measures against, asserted on the constant itself,
  // so raising it past what a pass can afford fails here and says why rather
  // than showing up as one slow test nobody reads.
  assert.ok(PING_TIMEOUT_MS < SHORT_ENOUGH_MS, `a pass may wait ${PING_TIMEOUT_MS}ms on the switch`);
});

test("a switch that never answers gives up quickly and leaves the pass unchanged", async () => {
  // Acceptance criterion 5 (#325), the slow half, and the one that is not the
  // same failure: an unreachable port is refused at once, while a switch that
  // accepts the connection and then says nothing would hold the pass open
  // forever. On a host that runs one pass at a time that is the next pass lost
  // too, so the timeout is what keeps a slow switch from becoming a dead
  // heartbeat.
  const without = await passAgainstStub({});
  await withPingServer(
    async (server) => {
      const startedAt = Date.now();
      const { stdout, stderr, status } = await passAgainstStub({ pingUrl: server.url });
      const elapsed = Date.now() - startedAt;
      assert.equal(status, without.status, stderr);
      assert.deepEqual(outcomeLines(stdout), outcomeLines(without.stdout));
      assert.match(stderr, literal(PING_URL_ENV));
      // The request arrived and was simply never answered, so this is the
      // timeout firing rather than a ping that was never sent.
      assert.deepEqual(server.paths, ["/a-check-uuid/0"]);
      assert.ok(elapsed < SHORT_ENOUGH_MS, `the pass waited ${elapsed}ms on a switch that never answered`);
    },
    // Answered by nothing at all: the request is taken and the response never
    // written, which is the shape a hung server or a black-holed route takes.
    () => {},
  );
});

/** One sentence of a page, so a requirement is pinned as a line an adopter reads rather than as words scattered over a file. */
const sentences = (text: string): string[] => text.split(/(?<=[.:])\s/);

/**
 * What any host needs to run the heartbeat (#325), each as the smallest thing
 * README has to say for an adopter to get the whole contract. This is the list
 * that is true whatever the host is, which is what makes it the one a recipe
 * for a named provider cannot replace: an adopter who already lives somewhere
 * this repo writes no recipe for would otherwise be left to infer the parts a
 * recipe happened to carry.
 *
 * Each is a phrase and not a heading, so README may say them in whatever order
 * its prose runs in; what the test owns is that none is missing.
 */
const HOST_REQUIREMENTS: { needs: string; in: RegExp[] }[] = [
  { needs: "the command to run", in: [literal(ENTRYPOINT)] },
  // A version and not just the word: `node` and `--experimental-strip-types`
  // are both in the command line above, so a pattern taking those would go on
  // passing with the one thing an adopter cannot guess -- which Node is new
  // enough to strip types -- deleted from the page.
  { needs: "which Node it runs on", in: [/\bnode\b/i, /\b\d+ or newer\b/i] },
  { needs: "`gh` on the host's PATH", in: [/\bgh\b/, /\bpath\b/i] },
  { needs: "a checkout of main, not whatever branch a clone was left on", in: [/\bcheckout\b/i, /\bmain\b/] },
  {
    needs: "the token's scopes, on every target and nothing else",
    in: [/contents write/i, /issues[ ,]/i, /pull requests/i, /variables read/i, /nothing else/i],
  },
  { needs: "how often to run it", in: [literal(INTERVAL_PHRASE)] },
  { needs: "the switch to report to, and the check behind it", in: [literal(PING_URL_ENV), /healthchecks\.io/i] },
  { needs: "the check's period, which is the interval plus a grace", in: [/\bperiod\b/i, /\bgrace\b/i] },
];

test("README says what any host needs, so an adopter on any provider has the whole contract", () => {
  // Acceptance criterion 8 (#325). Before this, README's whole answer was "a
  // host that runs the heartbeat", and every other part of the contract -- the
  // token's scopes, the checkout, the switch -- lived in a comment in the
  // sender or in nobody's head. Each requirement is asserted in one sentence,
  // because a reader who finds the command on one page and the token four
  // screens down has not been told what a host needs, they have been told to
  // go and assemble it.
  const text = fs.readFileSync(new URL("README.md", repoRoot), "utf8");
  const said = sentences(text);
  for (const requirement of HOST_REQUIREMENTS) {
    assert.ok(
      said.some((sentence) => requirement.in.every((part) => part.test(sentence))),
      `README does not say, in one sentence, ${requirement.needs}`,
    );
  }
});
