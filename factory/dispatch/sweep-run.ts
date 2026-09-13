/**
 * The sweep's entry point (#281): what `dispatch.yml` runs. It reads the env,
 * assembles the sweep's `Needs` record from `lib/target-repo.ts`, runs the
 * pass, writes `sweep.json`, and exits non-zero if a repair failed or a read
 * aborted the pass. The decisions and the writes are `sweep.ts`'s; this file is
 * only the wiring, as `heartbeat/send.ts` is the wiring for `heartbeat.ts`.
 *
 * Env: GH_REPO (owner/repo), FACTORY_PAT (the writing key), READ_TOKEN (the
 * reading key, GITHUB_TOKEN), optional BASE_BRANCH (main),
 * STUCK_MINUTES, VERDICT_MINUTES, UPDATE_MINUTES (see DEFAULT_DEADLINES),
 * TRUSTED_AUTHOR_ASSOCIATIONS (default OWNER), RUN_URL, OUTPUT_DIR for
 * sweep.json, DRY_RUN=1 to decide without writing.
 *
 * Builtins only, imported with `.ts` extensions, so the job runs on bare
 * `node --experimental-strip-types` and skips installing the engine.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { trustPolicyFromEnv } from "../lib/trusted-authors.ts";
import { targetRepo } from "../lib/target-repo.ts";
import { DEFAULT_DEADLINES, type Deadlines } from "./reconcile.ts";
import { type SweepConfig, sweep } from "./sweep.ts";

const repo = process.env.GH_REPO;
if (!repo) {
  console.error("Missing required env var: GH_REPO");
  process.exit(1);
}
const base = process.env.BASE_BRANCH || "main";

const minutesInput = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) return n;
  console.log(`::warning::${name} must be a positive integer, got '${raw}'; using ${fallback}.`);
  return fallback;
};

const deadlines: Deadlines = {
  stuckMinutes: minutesInput("STUCK_MINUTES", DEFAULT_DEADLINES.stuckMinutes),
  verdictMinutes: minutesInput("VERDICT_MINUTES", DEFAULT_DEADLINES.verdictMinutes),
  updateMinutes: minutesInput("UPDATE_MINUTES", DEFAULT_DEADLINES.updateMinutes),
};

// Built once here and passed down as a required argument, so no read path has a
// policy of its own to fall back to (#52). It judges who opened the ticket a PR
// that is not a factory PR closes, on the channel the reviewer judges it on (#179, #182).
const policy = trustPolicyFromEnv();

const config: SweepConfig = {
  repo,
  base,
  deadlines,
  policy,
  now: new Date(),
  dryRun: process.env.DRY_RUN === "1",
  runUrl: process.env.RUN_URL,
};

const result = sweep(targetRepo(repo, base), config);

const outputDir = process.env.OUTPUT_DIR;
if (outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, "sweep.json"),
    JSON.stringify(
      { repo, dryRun: config.dryRun, deadlines, trusted: policy.associations, snapshot: result.snapshot ?? null, decisions: result.decisions, applied: result.applied, refused: result.refused, failed: result.failed },
      null,
      2,
    ),
  );
}

if (result.aborted || result.failed.length > 0) process.exit(1);
