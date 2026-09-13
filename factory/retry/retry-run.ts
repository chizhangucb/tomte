/**
 * The retry handler's entry point (#284): what the agent workflows run when an
 * attempt fails. It reads the env, assembles the handler's `RetryNeeds` record
 * from `lib/target-repo.ts`, resolves the target, builds the failure, and hands
 * both to `retry.ts`'s `main`, which decides and writes. The decisions and the
 * writes are `retry.ts`'s; this file is the wiring, as `sweep-run.ts` is for the
 * sweep.
 *
 * Two keys (#282, #288): the record's reads (a PR, the open PR list, labels, the
 * branch, the artifact) use the reading key (READ_TOKEN), which needs checks:
 * read and actions: read from the caller; its writes (labels, comments, closing
 * the PR) use the writing key (FACTORY_PAT) so the labels fire events. The choice
 * lives in `target-repo.ts` (`resolveKeys`); the checks wait's own reads below
 * still use the job's GH_TOKEN directly through the shared `gh`, their own token
 * choice left to a later ticket.
 *
 * Env: GH_REPO, READ_TOKEN, FACTORY_PAT, BRANCH, RUN_URL,
 * OUTPUT_DIR, one of ISSUE_NUMBER or PR_NUMBER, and FAILURE_KIND:
 * - `implement`: the implementer's attempt ended badly; the output is
 *   OUTPUT_DIR/failure_reason.txt plus the tail of the newest run log.
 *   OUTPUT_DIR/rate_limited.txt present means every account was rate limited.
 *   IMPLEMENTER_OUTCOME is how the attempt ended; only a failed or killed
 *   attempt spends a retry, anything else exits 1 so the calling job posts its
 *   blocked comment (#51).
 * - `checks`: a verdict was just posted on HEAD_SHA; wait for the head's other
 *   checks to settle (CHECKS_TIMEOUT_MINUTES, default 15), or for GitHub to
 *   report the PR conflicting, then fail on any failing status or check run.
 * Optional: ARTIFACT_NAME for the log link, GITHUB_RUN_ID and GITHUB_WORKFLOW
 * (set by the runner) to ignore the factory's own check runs. The wait loop
 * itself is `retry.ts`'s `waitForChecks`, driven through a `ChecksNeeds` record
 * this file assembles from the reads and clock below (#285); the log and
 * artifact reads that build a failure's output stay here.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { RATE_LIMITED_FILE } from "../lib/accounts";
import { required } from "../lib/env";
import { gh } from "../lib/gh";
import { outputDir } from "../lib/run-output";
import { errorMessage } from "../lib/errors";
import { SECTION_END, SECTION_START, boundOutput } from "../lib/verdict";
import { retryTargetRepo } from "../lib/target-repo.ts";
import {
  type CheckFailure,
  type CheckRun,
  type CommitStatus,
  evaluateChecks,
  type MergeGateArtifact,
  renderMergeGateOutput,
  runIdFromUrl,
} from "./checks";
import {
  isImplementerFailure,
  type Mergeability,
  missingFailureReason,
  RATE_LIMITED_REASON,
} from "./decide.ts";
import {
  type ChecksNeeds,
  type ChecksWait,
  type Failure,
  type OpenPr,
  type PrMergeability,
  type RetryConfig,
  type RetryNeeds,
  main,
  resolveTarget,
  waitForChecks,
} from "./retry.ts";

const REPO = required("GH_REPO");
required("FACTORY_PAT"); // The record's writes need it; assert it here where the env is read.
const BRANCH = required("BRANCH");
const RUN_URL = required("RUN_URL");
const FAILURE_KIND = required("FAILURE_KIND");
const RUN_ID = process.env.GITHUB_RUN_ID ?? "";
const WORKFLOW = process.env.GITHUB_WORKFLOW ?? "";
const CHECKS_TIMEOUT_MS = Number(process.env.CHECKS_TIMEOUT_MINUTES || 15) * 60_000;
const POLL_MS = 20_000;

const LOG_TAIL_LINES = 120;
const LOG_LIMITS = { head: 2_000, tail: 8_000 };

const readIf = (file: string): string | undefined => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const ghJson = <T>(args: string[]): T => JSON.parse(gh(args)) as T;

/** A read whose failure is logged and shrugged off (a log link, a workflow name): no failure is built for it. */
const tryGh = (args: string[]): string | undefined => {
  try {
    return gh(args);
  } catch (error) {
    console.log(errorMessage(error));
    return undefined;
  }
};

/** The newest run log the job wrote, tail only. */
const runLogTail = (): string => {
  const logsDir = path.join(outputDir(), "logs");
  if (!fs.existsSync(logsDir)) return "";
  const newest = fs
    .readdirSync(logsDir)
    .filter((name) => name.endsWith(".log"))
    .map((name) => ({ name, mtime: fs.statSync(path.join(logsDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  if (!newest) return "";
  const lines = fs.readFileSync(path.join(logsDir, newest.name), "utf8").split("\n");
  return `Log tail (${newest.name}, last ${Math.min(LOG_TAIL_LINES, lines.length)} lines):\n${lines.slice(-LOG_TAIL_LINES).join("\n")}`;
};

const implementFailure = (outcome: string): Failure => {
  const reason = readIf(path.join(outputDir(), "failure_reason.txt"))?.trim() || missingFailureReason(outcome);
  return {
    kind: "implement",
    summary: `implement: ${reason.split("\n")[0]}`,
    output: [`Reason: ${reason}`, boundOutput(runLogTail(), LOG_LIMITS)].filter(Boolean).join("\n\n"),
    requeue: fs.existsSync(path.join(outputDir(), RATE_LIMITED_FILE)) ? RATE_LIMITED_REASON : undefined,
  };
};

/** The verdict this job just produced, as the reviewer wrote it. */
const verdictOutput = (): string => {
  const body = readIf(path.join(outputDir(), "pr_body.md")) ?? "";
  const start = body.indexOf(SECTION_START);
  const end = body.indexOf(SECTION_END);
  const section = start !== -1 && end !== -1 ? body.slice(start + SECTION_START.length, end).trim() : "";
  const summary = readIf(path.join(outputDir(), "summary.md"))?.trim() ?? "";
  return [section, summary].filter(Boolean).join("\n\n") || "(the verdict files were not found)";
};

/** The failed steps' log of another run, bounded. */
const failedLog = (url: string | null): string => {
  const runId = runIdFromUrl(url);
  if (!runId) return `(no run log: ${url ?? "no url"})`;
  try {
    const log = gh(["run", "view", runId, "--repo", REPO, "--log-failed"]);
    return boundOutput(log.trim() || "(the run has no failed step log)", LOG_LIMITS);
  } catch (error) {
    return `(could not read the log of run ${runId}: ${errorMessage(error)})`;
  }
};

const findFile = (dir: string, name: string): string | undefined => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return full;
    }
  }
  return undefined;
};

const mergeGateOutputs = new Map<string, string>();

/** The merge gate run's artifact (merge-gate.json plus the red-green logs), or its log when that fails. */
const mergeGateOutput = async (url: string | null): Promise<string> => {
  const runId = runIdFromUrl(url);
  if (!runId) return `(no merge gate run: ${url ?? "no url"})`;
  const cached = mergeGateOutputs.get(runId);
  if (cached) return cached;
  const output = await readMergeGateArtifact(runId, url);
  mergeGateOutputs.set(runId, output);
  return output;
};

/** The artifact lands a few seconds after the statuses: try a few times. */
const downloadArtifacts = async (runId: string, dir: string): Promise<void> => {
  for (let attempt = 1; ; attempt++) {
    try {
      gh(["run", "download", runId, "--repo", REPO, "--dir", dir]);
      return;
    } catch (error) {
      if (attempt >= 6) throw error;
      console.log(`Artifact of run ${runId} not downloadable yet (try ${attempt}); waiting.`);
      await sleep(10_000);
    }
  }
};

const readMergeGateArtifact = async (runId: string, url: string | null): Promise<string> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-gate-artifact-"));
  try {
    await downloadArtifacts(runId, dir);
    const mergeGateFile = findFile(dir, "merge-gate.json");
    if (!mergeGateFile)
      return `(the merge gate run ${runId} uploaded no merge-gate.json)
${failedLog(url)}`;
    const next = (name: string) => readIf(path.join(path.dirname(mergeGateFile), name));
    const mergeGate = JSON.parse(fs.readFileSync(mergeGateFile, "utf8")) as MergeGateArtifact;
    return renderMergeGateOutput(mergeGate, { base: next("red-green-base.log"), head: next("red-green-head.log") });
  } catch (error) {
    return `(could not read the merge gate artifact of run ${runId}: ${errorMessage(error)})
${failedLog(url)}`;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const workflowNames = new Map<string, string | undefined>();
const workflowNameOf = (run: { html_url?: string | null }): string | undefined => {
  const runId = runIdFromUrl(run.html_url);
  if (!runId) return undefined;
  if (!workflowNames.has(runId)) {
    workflowNames.set(runId, tryGh(["api", `repos/${REPO}/actions/runs/${runId}`, "--jq", ".name"])?.trim());
  }
  return workflowNames.get(runId);
};

const headChecks = (sha: string) => {
  const statuses = ghJson<{ statuses: CommitStatus[] }>(["api", `repos/${REPO}/commits/${sha}/status`]).statuses;
  const runs = ghJson<{ check_runs: CheckRun[] }>(["api", `repos/${REPO}/commits/${sha}/check-runs?per_page=100`]).check_runs.map((run) => ({
    ...run,
    workflowName: workflowNameOf(run),
  }));
  return evaluateChecks({ statuses, checkRuns: runs, own: { workflowName: WORKFLOW, runId: RUN_ID } });
};

/**
 * An open PR's mergeability and base. Undefined when the PR closed or merged as
 * the handler waited: nothing is handed off or labeled on a PR no longer open.
 */
const mergeabilityOf = (pr: OpenPr): PrMergeability | undefined => {
  const view = ghJson<{ state: string; mergeable: Mergeability; baseRefName: string }>([
    "pr", "view", pr.number, "--repo", REPO, "--json", "state,mergeable,baseRefName",
  ]);
  return view.state === "OPEN" ? { pr, mergeable: view.mergeable, base: view.baseRefName } : undefined;
};

const failureOutput = async (f: CheckFailure): Promise<string> => {
  const detail =
    f.kind === "verdict" ? verdictOutput() : f.kind === "merge-gate" ? await mergeGateOutput(f.url) : failedLog(f.url);
  return `## ${f.name}: ${f.kind} failure${f.description ? ` (${f.description})` : ""}\n${f.url ?? ""}\n\n${detail}`;
};

/** Every failing check's output, joined the way a retry marker comment carries it. */
const failuresOutput = async (failures: readonly CheckFailure[]): Promise<string> => {
  const parts: string[] = [];
  for (const f of failures) parts.push(await failureOutput(f));
  return parts.join("\n\n");
};

/**
 * The wait for a head's checks, wired to GitHub (#285): the head's checks, the
 * open PR's mergeability, the failing output, and the real clock and sleep. The
 * loop and the decision are `retry.ts`'s `waitForChecks`; this is only what it
 * reads through, so a test drives the same wait against an in-memory record.
 */
const checksNeeds = (): ChecksNeeds => ({
  now: () => new Date(),
  sleep,
  readChecks: (sha) => headChecks(sha),
  prMergeability: (pr) => mergeabilityOf(pr),
  failuresOutput,
});

/** The head and the clock bounds of the wait, the workflow's `HEAD_SHA` and timeout. */
const checksWait = (): ChecksWait => ({ sha: required("HEAD_SHA"), timeoutMs: CHECKS_TIMEOUT_MS, pollMs: POLL_MS });

const run = async (): Promise<void> => {
  const needs: RetryNeeds = retryTargetRepo(REPO, BRANCH);
  const config: RetryConfig = { branch: BRANCH, runUrl: RUN_URL, failureKind: FAILURE_KIND as "implement" | "checks" };

  const resolved = resolveTarget(needs);
  if ("unresolved" in resolved) console.log(`${resolved.unresolved} Branch ${BRANCH}.`);
  else console.log(`Ticket #${resolved.issue ?? "(none)"}, open PR #${resolved.pr?.number ?? "(none)"}, branch ${BRANCH}.`);
  const openPr = "unresolved" in resolved ? undefined : resolved.pr;

  let failure: Failure | undefined;
  if (FAILURE_KIND === "implement") {
    const outcome = process.env.IMPLEMENTER_OUTCOME ?? "";
    if (!isImplementerFailure(outcome)) {
      console.log(`The implementer ended '${outcome || "(it never started)"}', so the failure is not the implementer's own: no retry is spent.`);
      process.exit(1);
    }
    failure = implementFailure(outcome);
  } else if (FAILURE_KIND === "checks") {
    failure = await waitForChecks(checksNeeds(), checksWait(), openPr);
  } else {
    throw new Error(`FAILURE_KIND must be implement or checks, got ${FAILURE_KIND}`);
  }
  if (!failure) {
    console.log("Every check on the head passed; nothing to retry.");
    return;
  }
  // Only now is a subject needed: a passing head writes nothing, and a PR with no
  // ticket that merged as its verdict posted is that case, not a failure (#133).
  if ("unresolved" in resolved) throw new Error(resolved.unresolved);

  main(needs, config, resolved, failure);
};

run().catch((error) => {
  console.error(`Retry handler failed: ${errorMessage(error)}`);
  process.exit(1);
});
