/**
 * Runs the two factory merge gate checks on a PR and writes their verdicts to
 * OUTPUT_DIR/merge-gate.json. The workflow turns that file into the
 * `factory/red-green` and `factory/test-integrity` commit statuses.
 *
 * Runs in the target checkout at the PR head with `origin/<base>` fetched.
 * The decisions live in pure modules next to this file; this script only
 * gathers inputs (diff, linked ticket number) and runs tests.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import { required } from "../lib/env";
import { gh } from "../lib/gh";
import { writeJson, writeText } from "../lib/run-output";
import { safeSh, sh } from "../lib/sh";
import { linkedIssueNumber } from "../lib/linked-issue";
import { parseNameStatus, type ChangedFile } from "./changed-files";
import { redGreenPlan, redGreenVerdict, type FileRun, type TestResult } from "./red-green";
import { checkTestIntegrity } from "./test-integrity";
import type { WorkflowFile } from "./unrequired-jobs";
import { DEFAULT_TEST_COMMAND, reportArgs, runnability } from "./unrunnable";

const prNumber = required("PR_NUMBER");
const baseRef = required("BASE_REF");
// The fallback is the one command `runnability` can read, taken from there:
// a second copy that drifts leaves detection silently off.
const testCommand = process.env.TEST_COMMAND?.trim() || DEFAULT_TEST_COMMAND;
const installCommand = process.env.INSTALL_COMMAND?.trim() ?? "npm ci";

const linkedIssue = (): string => linkedIssueNumber(gh(["pr", "view", prNumber, "--json", "body", "--jq", ".body"]));

const run = (cwd: string, cmd: string, args: string[] = []): TestResult => {
  const proc = spawnSync("sh", ["-c", `${cmd} "$@"`, "sh", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20 * 60 * 1000,
    // the PR's own tests run here: no GitHub credentials in their reach
    env: { ...process.env, CI: "1", GH_TOKEN: "", GITHUB_TOKEN: "" },
  });
  return { exitCode: proc.status ?? 1, output: `${proc.stdout ?? ""}${proc.stderr ?? ""}` };
};

const install = (cwd: string): void => {
  if (!installCommand) return;
  const result = run(cwd, installCommand);
  if (result.exitCode !== 0) {
    console.error(result.output);
    throw new Error(`install command failed in ${cwd}: ${installCommand}`);
  }
};

/**
 * Each file in its own invocation, so a failure belongs to the file that
 * failed rather than to every file that shared a batch with it. Install is the
 * worktree's, not the file's, and stays outside this loop.
 *
 * The report is asked for here rather than kept in a variable of its own,
 * because `runnability` judges by the command the caller gave: handed the
 * reporting form instead, it would read every file as a command it cannot
 * understand and quietly stop detecting anything.
 */
const runEach = (cwd: string, testFiles: readonly string[]): TestResult[] => {
  const reporting = [testCommand, ...reportArgs(testCommand)].join(" ");
  return testFiles.map((file) => run(cwd, reporting, [file]));
};

/** Checks out the base tip, overlays the head's test files, runs each of them alone. */
const runOnBase = (testFiles: readonly string[]): TestResult[] => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-gate-base-"));
  sh(`git worktree add --detach "${baseDir}" "origin/${baseRef}"`);
  try {
    for (const file of testFiles) {
      fs.mkdirSync(path.join(baseDir, path.dirname(file)), { recursive: true });
      fs.copyFileSync(file, path.join(baseDir, file));
    }
    install(baseDir);
    return runEach(baseDir, testFiles);
  } finally {
    safeSh(`git worktree remove --force "${baseDir}"`);
  }
};

/**
 * One side's runs as one log, in plan order, except that the head's failures
 * are written last: a retry marker quotes this log's tail, so whichever file
 * broke is the output the implementer reads. The base keeps plan order,
 * because its own failure is every file passing, which singles out no file.
 *
 * A file the merge gate could not run sits between the two: after the files
 * that passed, because its output is worth reading, and before the ones that
 * genuinely failed, because it is nobody's failure to fix and the tail belongs
 * to the file the retry is meant to send an implementer at. When every file
 * was passed over the tail is theirs, which is the only output there is.
 */
const headRank = (run: FileRun): number =>
  run.runnability === "unrunnable" ? 1 : run.head.exitCode !== 0 ? 2 : 0;

const sideLog = (runs: readonly FileRun[], side: "base" | "head"): string => {
  const ordered = side === "head" ? [...runs].sort((a, b) => headRank(a) - headRank(b)) : runs;
  return ordered.map((r) => `=== ${r.path} (exit ${r[side].exitCode}) ===\n${r[side].output}`).join("\n");
};

const summarize = (name: string, ok: boolean, reasons: readonly string[], detail: string): string =>
  [`### ${name}: ${ok ? "pass" : "fail"}`, detail, ...reasons.map((r) => `- ${r}`), ""].join("\n");

const WORKFLOW_DIR = ".github/workflows";

/**
 * Single quotes, because the name comes from the pull request: a workflow file
 * named with a backtick or `$(...)` would otherwise run in this job, which
 * holds the factory's token.
 */
const quoteArg = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** Every workflow file at the head, with its merge-base content where it had one. */
const workflowFiles = (mergeBase: string): WorkflowFile[] => {
  if (!fs.existsSync(WORKFLOW_DIR)) return [];
  return fs
    .readdirSync(WORKFLOW_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && (e.name.endsWith(".yml") || e.name.endsWith(".yaml")))
    .map((e) => {
      const p = `${WORKFLOW_DIR}/${e.name}`;
      const base = safeSh(`git show ${quoteArg(`${mergeBase}:${p}`)}`);
      return { path: p, head: fs.readFileSync(p, "utf8"), ...(base ? { base } : {}) };
    });
};

/**
 * What the base branch's merge rule requires, read at runtime: the rule is the
 * only source of truth for it, and a caller input would be a second place to
 * keep in sync. A read that fails leaves the list empty, which turns the
 * unrequired-job rule off rather than refusing on a guess.
 *
 * The branch's effective rules, not `scripts/onboard.sh`'s `factory` ruleset:
 * what gates the merge is every rule that applies, org rulesets and classic
 * protection included, and a job wired to any of them is required in fact.
 */
const requiredContexts = (): string[] => {
  try {
    const out = gh([
      "api",
      `repos/{owner}/{repo}/rules/branches/${encodeURIComponent(baseRef)}`,
      "--jq",
      '.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context',
    ]);
    return out.split("\n").map((c) => c.trim()).filter((c) => c.length > 0);
  } catch (error) {
    console.error(`required contexts could not be read, so no job is judged unrequired: ${String(error)}`);
    return [];
  }
};

const main = (): void => {
  const mergeBase = sh(`git merge-base "origin/${baseRef}" HEAD`).trim();
  const files: ChangedFile[] = parseNameStatus(sh(`git diff --name-status -M "${mergeBase}" HEAD`));
  const testPaths = files.filter((f) => f.kind === "test").map((f) => f.path);
  const diff = testPaths.length
    ? sh(`git diff "${mergeBase}" HEAD -- ${testPaths.map((p) => `"${p}"`).join(" ")}`)
    : "";
  const issueNumber = linkedIssue();

  const requiredNames = requiredContexts();
  const integrity = checkTestIntegrity({
    files,
    diff,
    workflows: workflowFiles(mergeBase),
    requiredContexts: requiredNames,
  });

  const plan = redGreenPlan(files);
  let runs: FileRun[] | undefined;
  if (plan.run) {
    const base = runOnBase(plan.testFiles);
    install(process.cwd());
    const head = runEach(process.cwd(), plan.testFiles);
    // The head decides, per FileRun.runnability, and its answer holds on the base side too.
    runs = plan.testFiles.map((file, i) => ({
      path: file,
      base: base[i],
      head: head[i],
      runnability: runnability(testCommand, head[i]),
    }));
    writeText("red-green-base.log", sideLog(runs, "base"));
    writeText("red-green-head.log", sideLog(runs, "head"));
  }
  const redGreen = redGreenVerdict(plan, runs);

  writeJson("merge-gate.json", {
    prNumber,
    baseRef,
    mergeBase,
    issueNumber,
    requiredContexts: requiredNames,
    files,
    redGreen: {
      ...redGreen,
      plan,
      runs: runs?.map((r) => ({
        path: r.path,
        baseExit: r.base.exitCode,
        headExit: r.head.exitCode,
        runnability: r.runnability,
      })),
    },
    testIntegrity: integrity,
  });

  const summary = [
    summarize(
      "factory/red-green",
      redGreen.ok,
      redGreen.reasons,
      redGreen.detail,
    ),
    summarize(
      "factory/test-integrity",
      integrity.ok,
      integrity.reasons,
      [
        issueNumber ? `ticket #${issueNumber}` : "no linked ticket (`Closes #N` missing from the PR body)",
        integrity.deletedTests.length
          ? `deleted test files, for the reviewer and the audit to judge against the ticket: ${integrity.deletedTests.join(", ")}`
          : "no test file deleted",
        // Said out loud: a rule that is off because no required name could be
        // read looks exactly like a rule that found nothing.
        requiredNames.length
          ? `required checks read from the branch's rules: ${requiredNames.join(", ")}`
          : "no required check could be read, so no job was judged unrequired",
      ].join("; "),
    ),
  ].join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
};

main();
