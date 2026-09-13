/**
 * What the retry run assembles from its reads (#315): the failure a failed
 * implementer attempt becomes, and the record the wait for a head's checks
 * reads through. Every read it makes comes through the `RunNeeds` record it is
 * handed, so this assembly is rehearsed against an in-memory stand-in
 * (`assemble.test.ts`) rather than against a live `gh`; `retry-run.ts` hands it
 * the real `gh`/fs reads from `run-needs.ts`. The pattern is `target-repo.ts`'s
 * and the record is CONTEXT.md's **Needs record**.
 *
 * Nothing is decided here. What the handler does with the failure is
 * `decide.ts`'s and `plan.ts`'s, and what the wait does with the checks is
 * `retry.ts`'s `waitForChecks`; this only builds what each of them consumes.
 *
 * Which reads may fail softly is this assembly's own policy, as the handler's
 * soft-fail policy is its: the record throws on any read it cannot make, and a
 * read that only adds detail to an output (a run's workflow name, a failing
 * run's log, a merge gate artifact) is logged and shrugged off, so a read the
 * run cannot make costs the detail rather than the retry.
 */
import { errorMessage } from "../lib/errors.ts";
import { SECTION_END, SECTION_START, boundOutput } from "../lib/verdict.ts";
import {
  type CheckFailure,
  type CheckRun,
  type CheckState,
  type CommitStatus,
  type MergeGateArtifact,
  evaluateChecks,
  renderMergeGateOutput,
  runIdFromUrl,
} from "./checks.ts";
import { type Mergeability, RATE_LIMITED_REASON, missingFailureReason } from "./decide.ts";
import { type ChecksNeeds, type Failure, type OpenPr, type PrMergeability } from "./retry.ts";

/** The head and tail kept of any log an output carries, so a marker comment stays bounded. */
const LOG_LIMITS = { head: 2_000, tail: 8_000 };
const LOG_TAIL_LINES = 120;

/** The merge gate run's uploaded output: the artifact's own JSON, and the red-green logs beside it. */
export interface MergeGateFiles {
  readonly mergeGate: MergeGateArtifact;
  readonly baseLog?: string;
  readonly headLog?: string;
}

/**
 * Everything the retry run reads, as named domain reads rather than `gh`
 * commands or file paths: the job's own output on disk, and the target repo's
 * runs, artifacts and checks. Handed in from outside, `run-needs.ts` in
 * production and an in-memory stand-in in a test. A read that cannot be made
 * throws, as `target-repo.ts`'s do; which of those the assembly shrugs off is
 * its own policy, above.
 *
 * A **needs record** in CONTEXT.md's sense, with one widening it names here: a
 * retry run is described from the job's own output as much as from the target
 * repo, so both are in the one record the run is handed.
 *
 * Its own record, not the handler's `RetryNeeds` and not the PR-context reads:
 * these are the reads one failed attempt is described from, and a record over
 * more than that would be a bag nobody's caller uses the whole of.
 */
export interface RunNeeds {
  /** What the implementer wrote as the reason it ended badly, or undefined when it wrote none. */
  readonly failureReason: () => string | undefined;
  /** Whether every account was rate limited, from the marker the rotation leaves behind. */
  readonly rateLimited: () => boolean;
  /** The newest run log this job wrote, whole, or undefined when it wrote none. */
  readonly newestRunLog: () => { readonly name: string; readonly text: string } | undefined;
  /** The PR body this job's reviewer wrote, verdict section and all, or undefined when it wrote none. */
  readonly verdictPrBody: () => string | undefined;
  /** The summary this job's reviewer wrote, or undefined when it wrote none. */
  readonly verdictSummary: () => string | undefined;
  /** Another run's failed steps, as its log. Throws when the log cannot be read. */
  readonly failedRunLog: (runId: string) => string;
  /**
   * A merge gate run's uploaded output; undefined when the run uploaded no
   * merge-gate.json. Throws when the download fails. Async because the artifact
   * lands a few seconds after the statuses, so the read waits for it.
   */
  readonly mergeGateArtifact: (runId: string) => Promise<MergeGateFiles | undefined>;
  /** The Actions workflow a run belongs to. Throws when it cannot be read. */
  readonly workflowName: (runId: string) => string;
  /** The statuses posted on a head. */
  readonly commitStatuses: (sha: string) => CommitStatus[];
  /** The check runs on a head. */
  readonly checkRuns: (sha: string) => CheckRun[];
  /** A PR's state, mergeability and base branch, as GitHub reports them right now. */
  readonly prView: (number: string) => { state: string; mergeable: Mergeability; baseRefName: string };
}

/**
 * What the run was started with rather than reads: its own identity, and the
 * clock the wait runs on. The shape `update-branch.ts`'s `UpdateBranchConfig`
 * has, a `sleep` among it for the same reason: injected, so a test's wait costs
 * no wall-clock time.
 */
export interface RunConfig {
  /** This run's own workflow and id, so the factory's own check runs are not read as the target's CI. */
  readonly own: { readonly workflowName: string; readonly runId: string };
  /** When the wait is running, injected rather than read here so a test advances it. */
  readonly now: () => Date;
  /** Wait one poll. */
  readonly sleep: (ms: number) => Promise<void>;
}

/** Why a read the run could not make left an output short of its detail, in one sentence for every such read. */
const unreadable = (what: string, runId: string, error: unknown): string =>
  `(could not read ${what} of run ${runId}: ${errorMessage(error)})`;

/** A read that only adds detail to an output: its failure is logged and shrugged off. */
const tryRead = <T>(read: () => T): T | undefined => {
  try {
    return read();
  } catch (error) {
    console.log(errorMessage(error));
    return undefined;
  }
};

/** The newest run log, tailed and headed with which log it was: what a marker comment carries. */
const runLogTail = (needs: RunNeeds): string => {
  const log = needs.newestRunLog();
  if (!log) return "";
  const lines = log.text.split("\n");
  return `Log tail (${log.name}, last ${Math.min(LOG_TAIL_LINES, lines.length)} lines):\n${lines.slice(-LOG_TAIL_LINES).join("\n")}`;
};

/** The verdict this job just produced, as the reviewer wrote it: the PR body's section, then the summary. */
const verdictOutput = (needs: RunNeeds): string => {
  const body = needs.verdictPrBody() ?? "";
  const start = body.indexOf(SECTION_START);
  const end = body.indexOf(SECTION_END);
  const section = start !== -1 && end !== -1 ? body.slice(start + SECTION_START.length, end).trim() : "";
  const summary = needs.verdictSummary()?.trim() ?? "";
  return [section, summary].filter(Boolean).join("\n\n") || "(the verdict files were not found)";
};

/**
 * The retry run's assembly over one set of needs. Built per run, so a read it
 * would repeat within one run (a run's workflow name, a merge gate run's
 * artifact) is made once and answered from memory after that.
 */
export const assembleRun = (needs: RunNeeds, config: RunConfig) => {
  const workflowNames = new Map<string, string | undefined>();
  const mergeGateOutputs = new Map<string, string>();

  /** The failed steps' log of another run, bounded, or why it could not be read. */
  const failedLog = (url: string | null): string => {
    const runId = runIdFromUrl(url);
    if (!runId) return `(no run log: ${url ?? "no url"})`;
    try {
      return boundOutput(needs.failedRunLog(runId).trim() || "(the run has no failed step log)", LOG_LIMITS);
    } catch (error) {
      return unreadable("the log", runId, error);
    }
  };

  /** The merge gate run's artifact rendered, or its log when the run uploaded none or the download failed. */
  const mergeGateOutput = async (url: string | null): Promise<string> => {
    const runId = runIdFromUrl(url);
    if (!runId) return `(no merge gate run: ${url ?? "no url"})`;
    const cached = mergeGateOutputs.get(runId);
    if (cached !== undefined) return cached;
    let output: string;
    try {
      const files = await needs.mergeGateArtifact(runId);
      output = files
        ? renderMergeGateOutput(files.mergeGate, { base: files.baseLog, head: files.headLog })
        : `(the merge gate run ${runId} uploaded no merge-gate.json)\n${failedLog(url)}`;
    } catch (error) {
      output = `${unreadable("the merge gate artifact", runId, error)}\n${failedLog(url)}`;
    }
    mergeGateOutputs.set(runId, output);
    return output;
  };

  const failureOutput = async (f: CheckFailure): Promise<string> => {
    const detail =
      f.kind === "verdict" ? verdictOutput(needs) : f.kind === "merge-gate" ? await mergeGateOutput(f.url) : failedLog(f.url);
    return `## ${f.name}: ${f.kind} failure${f.description ? ` (${f.description})` : ""}\n${f.url ?? ""}\n\n${detail}`;
  };

  /** The Actions workflow a check run belongs to, read once per run and shrugged off when it cannot be read. */
  const workflowNameOf = (run: CheckRun): string | undefined => {
    const runId = runIdFromUrl(run.html_url);
    if (!runId) return undefined;
    if (!workflowNames.has(runId)) workflowNames.set(runId, tryRead(() => needs.workflowName(runId))?.trim());
    return workflowNames.get(runId);
  };

  const readChecks = (sha: string): CheckState =>
    evaluateChecks({
      statuses: needs.commitStatuses(sha),
      checkRuns: needs.checkRuns(sha).map((run) => ({ ...run, workflowName: workflowNameOf(run) })),
      own: config.own,
    });

  /**
   * An open PR's mergeability and base. Undefined when the PR closed or merged
   * as the handler waited: nothing is handed off or labeled on a PR no longer open.
   */
  const prMergeability = (pr: OpenPr): PrMergeability | undefined => {
    const view = needs.prView(pr.number);
    return view.state === "OPEN" ? { pr, mergeable: view.mergeable, base: view.baseRefName } : undefined;
  };

  return {
    /**
     * The failure a failed implementer attempt becomes: its own reason (or how
     * it ended, when it wrote none), the tail of the log it left, and the
     * requeue a rate-limited attempt asks for, since no account was reached (#17).
     */
    implementFailure: (outcome: string): Failure => {
      const reason = needs.failureReason()?.trim() || missingFailureReason(outcome);
      return {
        kind: "implement",
        summary: `implement: ${reason.split("\n")[0]}`,
        output: [`Reason: ${reason}`, boundOutput(runLogTail(needs), LOG_LIMITS)].filter(Boolean).join("\n\n"),
        requeue: needs.rateLimited() ? RATE_LIMITED_REASON : undefined,
      };
    },

    /**
     * The wait's own record (#285): the head's checks, the open PR's
     * mergeability, the failing output, and the clock the run was built with.
     * The loop and the decision stay `retry.ts`'s `waitForChecks`.
     */
    checksNeeds: (): ChecksNeeds => ({
      now: config.now,
      sleep: config.sleep,
      readChecks,
      prMergeability,
      /** Every failing check's output, joined the way a retry marker comment carries it. */
      failuresOutput: async (failures) => {
        const parts: string[] = [];
        for (const f of failures) parts.push(await failureOutput(f));
        return parts.join("\n\n");
      },
    }),
  };
};
