/**
 * The retry handler's entry point (#284): what the agent workflows run when an
 * attempt fails. It reads the env, assembles the handler's `RetryNeeds` record
 * from `lib/target-repo.ts` and the run's own reads from `run-reads.ts`,
 * resolves the target, builds the failure through `assemble.ts`, and hands both
 * to `retry.ts`'s `main`, which decides and writes. The decisions and the writes
 * are `retry.ts`'s, what is assembled from a read is `assemble.ts`'s; this file
 * is the wiring, as `sweep-run.ts` is for the sweep.
 *
 * Two records, because they read for two different purposes (#315): the
 * handler's `RetryNeeds` is what it writes the outcome through, and the run's
 * `RunReads` is what one failed attempt is described from (the job's own output
 * on disk, another run's log, a merge gate artifact, a head's checks). Each has
 * a production adapter and an in-memory stand-in, so `retry.test.ts` rehearses
 * the handler and `assemble.test.ts` rehearses the assembly, neither on `gh`.
 *
 * Two keys (#282, #288): the `RetryNeeds` record's reads (a PR, the open PR
 * list, labels, the branch, the artifact) use the reading key (READ_TOKEN),
 * which needs checks: read and actions: read from the caller; its writes
 * (labels, comments, closing the PR) use the writing key (FACTORY_PAT) so the
 * labels fire events. The choice lives in `target-repo.ts` (`resolveKeys`); the
 * run's own reads still use the job's GH_TOKEN directly through the shared `gh`,
 * their own token choice left to a later ticket.
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
 * itself is `retry.ts`'s `waitForChecks`, driven through the `ChecksNeeds`
 * record `assemble.ts` builds from the run's reads and this file's clock (#285).
 */
import { required } from "../lib/env";
import { errorMessage } from "../lib/errors";
import { retryTargetRepo } from "../lib/target-repo.ts";
import { assembleRun } from "./assemble.ts";
import { runReads } from "./run-reads.ts";
import { isImplementerFailure } from "./decide.ts";
import {
  type ChecksWait,
  type Failure,
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

/** The head and the clock bounds of the wait, the workflow's `HEAD_SHA` and timeout. */
const checksWait = (): ChecksWait => ({ sha: required("HEAD_SHA"), timeoutMs: CHECKS_TIMEOUT_MS, pollMs: POLL_MS });

const run = async (): Promise<void> => {
  const needs: RetryNeeds = retryTargetRepo(REPO, BRANCH);
  const config: RetryConfig = { branch: BRANCH, runUrl: RUN_URL, failureKind: FAILURE_KIND as "implement" | "checks" };
  // The run's own reads, wired to `gh` and the disk, and the assembly over them:
  // the wall clock and this run's identity are what it cannot read (#315).
  const assembly = assembleRun(runReads(REPO), {
    own: { workflowName: WORKFLOW, runId: RUN_ID },
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

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
    failure = assembly.implementFailure(outcome);
  } else if (FAILURE_KIND === "checks") {
    failure = await waitForChecks(assembly.checksNeeds(), checksWait(), openPr);
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
