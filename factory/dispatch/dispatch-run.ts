/**
 * The dispatcher's entry point (#286): what `dispatch.yml` runs. It reads the
 * env, assembles the dispatcher's `DispatchNeeds` record from
 * `lib/target-repo.ts`, runs the pass, writes `dispatch.json`, and exits
 * non-zero if a label failed. The decisions and the writes are `dispatch.ts`'s;
 * this file is only the wiring, as `sweep-run.ts` is the wiring for `sweep.ts`.
 *
 * Env: GH_REPO (owner/repo), FACTORY_PAT (the writing key; the dispatcher's
 * reads all use it, so no READ_TOKEN is needed), optional OUTPUT_DIR for
 * dispatch.json, optional DRY_RUN=1 to select without labeling, optional
 * TRUSTED_AUTHOR_ASSOCIATIONS (default OWNER) naming whose tickets run.
 *
 * Builtins only, imported with `.ts` extensions, so the job runs on bare
 * `node --experimental-strip-types` and skips installing the engine.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { trustPolicyFromEnv } from "../lib/trusted-authors.ts";
import { dispatchNeeds } from "../lib/target-repo.ts";
import { type DispatchConfig, dispatch } from "./dispatch.ts";

const repo = process.env.GH_REPO;
if (!repo) {
  console.error("Missing required env var: GH_REPO");
  process.exit(1);
}

// Built once here and passed down as a required argument, so no selection path
// can fall back to a default policy of its own (#52).
const policy = trustPolicyFromEnv();

const config: DispatchConfig = {
  repo,
  policy,
  dryRun: process.env.DRY_RUN === "1",
};

const result = dispatch(dispatchNeeds(repo), config);

const outputDir = process.env.OUTPUT_DIR;
if (outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, "dispatch.json"),
    JSON.stringify(
      {
        repo,
        dryRun: config.dryRun,
        trustedAuthors: policy.associations,
        issues: result.issues,
        dispatched: result.dispatched,
        labeled: result.labeled,
        skipped: result.skipped,
        failed: result.failed,
      },
      null,
      2,
    ),
  );
}

if (result.failed.length > 0) process.exit(1);
