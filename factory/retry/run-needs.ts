/**
 * The retry run's reads, wired to `gh` and the disk (#315): the production
 * adapter behind `assemble.ts`'s `RunNeeds` record, the way
 * `lib/target-repo.ts` is the production adapter behind the handler's
 * `RetryNeeds`. `retry-run.ts` builds one and hands it to the assembly; a test
 * hands the assembly an in-memory stand-in instead, so what the run assembles
 * is rehearsed with no live `gh`.
 *
 * Its own module rather than a fourth factory in `target-repo.ts`: half of what
 * it reads is the job's own output on disk (the reason the implementer wrote,
 * the log it left, the verdict this job just posted) rather than anything of
 * the target repo's, and `target-repo.ts` is the module named after CONTEXT.md's
 * **Target repo** and reached by the dispatch job's bare-node cone.
 *
 * Every read throws on failure, as `target-repo.ts`'s do, and the token choice
 * is the one these reads had before the seam: the job's own `GH_TOKEN` through
 * the shared `gh`, left to a later ticket as the pre-seam comment said.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { RATE_LIMITED_FILE } from "../lib/accounts.ts";
import { gh } from "../lib/gh.ts";
import { outputDir } from "../lib/run-output.ts";
import { type CheckRun, type CommitStatus, type MergeGateArtifact } from "./checks.ts";
import { type MergeGateFiles, type RunConfig, type RunNeeds } from "./assemble.ts";

/** How many times, and how long apart, the artifact of a merge gate run is asked for. */
const ARTIFACT_TRIES = 6;
const ARTIFACT_WAIT_MS = 10_000;

/** Wait, the run's own: the entry point hands the same one to the assembly, so one run has one clock. */
type Sleep = RunConfig["sleep"];

const readIf = (file: string): string | undefined => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined);

const inOutputDir = (name: string): string => path.join(outputDir(), name);

const ghJson = <T>(args: string[]): T => JSON.parse(gh(args)) as T;

/** The newest `.log` the job wrote, by modification time. */
const newestRunLog = (): { name: string; text: string } | undefined => {
  const logsDir = path.join(outputDir(), "logs");
  if (!fs.existsSync(logsDir)) return undefined;
  const newest = fs
    .readdirSync(logsDir)
    .filter((name) => name.endsWith(".log"))
    .map((name) => ({ name, mtime: fs.statSync(path.join(logsDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  if (!newest) return undefined;
  return { name: newest.name, text: fs.readFileSync(path.join(logsDir, newest.name), "utf8") };
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

/** The artifact lands a few seconds after the statuses: try a few times, then throw as `gh` threw. */
const downloadArtifacts = async (repo: string, runId: string, dir: string, sleep: Sleep): Promise<void> => {
  for (let attempt = 1; ; attempt++) {
    try {
      gh(["run", "download", runId, "--repo", repo, "--dir", dir]);
      return;
    } catch (error) {
      if (attempt >= ARTIFACT_TRIES) throw error;
      console.log(`Artifact of run ${runId} not downloadable yet (try ${attempt}); waiting.`);
      await sleep(ARTIFACT_WAIT_MS);
    }
  }
};

/**
 * The GitHub- and disk-backed reads of one retry run, against one target repo.
 * The wait between tries for a merge gate artifact is the caller's `sleep`,
 * the one the run was built with.
 */
export const runNeeds = (repo: string, sleep: Sleep): RunNeeds => ({
  failureReason: () => readIf(inOutputDir("failure_reason.txt")),
  rateLimited: () => fs.existsSync(inOutputDir(RATE_LIMITED_FILE)),
  newestRunLog,
  verdictPrBody: () => readIf(inOutputDir("pr_body.md")),
  verdictSummary: () => readIf(inOutputDir("summary.md")),

  failedRunLog: (runId) => gh(["run", "view", runId, "--repo", repo, "--log-failed"]),

  /**
   * Throws when the download fails, and when no temp dir can be made for it:
   * the assembly shrugs both off, so a merge gate output nothing can be read
   * for costs the retry marker that detail rather than the run (the pre-seam
   * entry point failed the run on the second of those).
   */
  mergeGateArtifact: async (runId): Promise<MergeGateFiles | undefined> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-gate-artifact-"));
    try {
      await downloadArtifacts(repo, runId, dir, sleep);
      const mergeGateFile = findFile(dir, "merge-gate.json");
      if (!mergeGateFile) return undefined;
      const beside = (name: string) => readIf(path.join(path.dirname(mergeGateFile), name));
      return {
        mergeGate: JSON.parse(fs.readFileSync(mergeGateFile, "utf8")) as MergeGateArtifact,
        baseLog: beside("red-green-base.log"),
        headLog: beside("red-green-head.log"),
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },

  workflowName: (runId) => gh(["api", `repos/${repo}/actions/runs/${runId}`, "--jq", ".name"]),

  commitStatuses: (sha) => ghJson<{ statuses: CommitStatus[] }>(["api", `repos/${repo}/commits/${sha}/status`]).statuses,
  checkRuns: (sha) => ghJson<{ check_runs: CheckRun[] }>(["api", `repos/${repo}/commits/${sha}/check-runs?per_page=100`]).check_runs,

  prView: (number) =>
    ghJson(["pr", "view", number, "--repo", repo, "--json", "state,mergeable,baseRefName"]),
});
