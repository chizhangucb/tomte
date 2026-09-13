/**
 * Update-branch's entry point (#287): what `update-branch.yml` runs. It reads
 * the env, assembles the run's needs-record from `lib/target-repo.ts`, runs the
 * pass, writes `update-branch.json`, and exits non-zero if a PR's update failed.
 * The decisions and the writes are `update-branch.ts`'s; this file is only the
 * wiring, as `dispatch/sweep-run.ts` is the wiring for the sweep.
 *
 * Env: GH_REPO (owner/repo), GH_TOKEN (FACTORY_PAT, for the update call,
 * comments, labels and commit reads), STATUS_TOKEN (GITHUB_TOKEN, for reading
 * and posting statuses; the key choice lives in `target-repo.ts`), optional
 * BASE_BRANCH (default main), optional RUN_URL, optional OUTPUT_DIR for
 * update-branch.json, optional DRY_RUN=1 to plan without writing.
 *
 * Builtins only, imported with `.ts` extensions, so the job runs on bare
 * `node --experimental-strip-types` and skips installing the engine.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { updateBranchTargetRepo } from "../lib/target-repo.ts";
import { type UpdateBranchConfig, type UpdateBranchNeeds, updateBranch } from "./update-branch.ts";

const repo = process.env.GH_REPO;
if (!repo) {
  console.error("Missing required env var: GH_REPO");
  process.exit(1);
}
const base = process.env.BASE_BRANCH || "main";

const config: UpdateBranchConfig = {
  base,
  dryRun: process.env.DRY_RUN === "1",
  runUrl: process.env.RUN_URL ?? "",
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const needs: UpdateBranchNeeds = updateBranchTargetRepo(repo, base);
const result = await updateBranch(needs, config);

const outputDir = process.env.OUTPUT_DIR;
if (outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, "update-branch.json"),
    JSON.stringify({ repo, base, dryRun: config.dryRun, prs: result.prs, outcomes: result.outcomes }, null, 2),
  );
}

if (result.failed > 0) process.exit(1);
