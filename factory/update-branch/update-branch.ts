/**
 * Update-branch: the stand-in for a merge queue (ADR 0006).
 * Runs when main moves and when a factory/verdict passes.
 * Every open PR on main with auto-merge enabled and a stale head gets
 * GitHub's update-branch call, so the target's CI and the merge gate re-run on
 * the new head and auto-merge lands it on the latest main. A passing
 * factory/verdict is carried onto the merge commit GitHub made (see plan.ts);
 * the old head gets a factory/update-branch status the moment the call is
 * accepted, so a later run can tell that merge from one a person made in the
 * web editor. A conflict the API cannot resolve on a PR the factory authored is
 * commented and labeled agent:implement, so agent-implement-pr.yml resolves it
 * on the branch (planConflict in plan.ts, ADR 0003 as amended by #19); on any
 * other PR it is commented and labeled agent:blocked (#180, ADR 0007). No agent
 * runs here.
 *
 * Built the way the sweep is (#287): it takes a needs-record, the reads and
 * writes it makes against the target repo, and is handed it from outside
 * (`update-branch-run.ts` in production, an in-memory target repo in
 * `update-branch.test.ts`). What it plans does not change, only how it is wired:
 * no `gh` call and no status-key env handling live here now; the module behind
 * the record picks the key. docs/pipeline.md, "How a script is wired", carries
 * the pattern.
 *
 * Which failures it may shrug off is still its own policy: the two documented
 * 422s the update call answers with are outcomes, not failures, told apart by
 * reading the `GhError`'s fields (`updateRefusal` in plan.ts), never its
 * message; anything else is counted and the next PR still runs.
 *
 * Builtins only, imported with `.ts` extensions, so the job runs on bare
 * `node --experimental-strip-types` and skips installing the engine.
 */
import { errorMessage } from "../lib/errors.ts";
import { GhError } from "../lib/gh.ts";
import { BLOCKED_LABEL, IMPLEMENT_LABEL } from "../lib/labels.ts";
import {
  type CommitStatus,
  type ConflictPlan,
  type HeadCommit,
  type OpenPr,
  type Plan,
  UPDATE_MARKER_CONTEXT,
  type UpdateRefusal,
  VERDICT_CONTEXT,
  carriedVerdict,
  findVerdict,
  isUpdateMerge,
  planConflict,
  planUpdates,
  updateRefusal,
} from "./plan.ts";

/**
 * A PR as the record lists it: the fields `gh pr list` answers, normalized. Its
 * merge state (behindBy, head commit, verdict) is read per PR below, and only
 * for the PRs the plan could act on.
 */
export type ListedPr = {
  readonly number: number;
  readonly headRef: string;
  readonly headRefOid: string;
  /** Empty on a PR opened with no body; `isFactoryAuthoredPr` reads it as a string. */
  readonly body: string;
  /** GitHub's `autoMergeRequest` is set. GitHub refuses it on drafts, so this also means "not a draft". */
  readonly autoMerge: boolean;
  readonly mergeable: OpenPr["mergeable"];
  readonly labels: readonly string[];
};

/**
 * Everything update-branch needs from the target repo: named domain reads and
 * writes, never a raw `gh` call. Assembled from `lib/target-repo.ts` in
 * production; every function throws `GhError` on failure, and `requestUpdate`
 * throws the two documented 422s the same way (they are read back as outcomes).
 */
export type UpdateBranchNeeds = {
  /** Open PRs on the base, normalized; merge state is read per PR below. */
  readonly openPrs: () => ListedPr[];
  /** How many commits on the base a head lacks. */
  readonly behindBy: (sha: string) => number;
  /** Every commit status on a sha (context, state, description, target_url). */
  readonly statuses: (sha: string) => CommitStatus[];
  /** A commit's sha, parents and committer login, for the update-merge walk. */
  readonly commit: (sha: string) => HeadCommit;
  /** A PR's current head sha, read while waiting for an accepted update to land. */
  readonly headOf: (pr: number) => string;
  /** PUT update-branch. Throws `GhError`; the two documented 422s are read back by `updateRefusal`. */
  readonly requestUpdate: (pr: number, expectedHead: string) => void;
  /** Post a commit status (the update marker, the carried verdict). */
  readonly postStatus: (sha: string, status: CommitStatus) => void;
  readonly comment: (pr: number, body: string) => void;
  readonly addLabel: (pr: number, label: string) => void;
};

/** What one run is measured against. `sleep` is injected so a test drives the wait for the new head. */
export type UpdateBranchConfig = {
  readonly base: string;
  readonly dryRun: boolean;
  readonly runUrl?: string;
  readonly sleep: (ms: number) => Promise<void>;
};

export type Outcome = Plan & {
  oldHead?: string;
  newHead?: string;
  verdictCarried?: boolean;
  note?: string;
  error?: string;
};

export type UpdateBranchResult = {
  readonly prs: readonly OpenPr[];
  readonly outcomes: readonly Outcome[];
  readonly failed: number;
};

type UpdateResult = "accepted" | UpdateRefusal;

/** One run against a target repo: read the PRs, plan, apply, log one line per decision. */
export const updateBranch = async (
  needs: UpdateBranchNeeds,
  config: UpdateBranchConfig,
): Promise<UpdateBranchResult> => {
  const { base, dryRun, runUrl = "" } = config;

  /** The lookups are only worth making for PRs the plan could act on. */
  const toOpenPr = (listed: ListedPr): OpenPr => {
    const active = listed.autoMerge && listed.mergeable !== "CONFLICTING";
    const head = active ? needs.commit(listed.headRefOid) : { sha: listed.headRefOid, parents: [], committerLogin: null };
    return {
      number: listed.number,
      headRef: listed.headRef,
      body: listed.body,
      autoMerge: listed.autoMerge,
      behindBy: active ? needs.behindBy(listed.headRefOid) : 0,
      mergeable: listed.mergeable,
      labels: listed.labels,
      head,
      verdict: active
        ? findVerdict(head, (sha) => needs.statuses(sha), (sha) => needs.commit(sha))
        : { state: "none", sha: head.sha },
    };
  };

  /**
   * Post the passing verdict found on `fromSha` onto `head`; true when one was
   * posted. A carried verdict with no link of its own gets this run's, as it did
   * before the record picked up `postStatus` (the run URL lives here, not there).
   */
  const carryOnto = (head: HeadCommit, fromSha: string): boolean => {
    const verdict = carriedVerdict(needs.statuses(fromSha), fromSha);
    if (!verdict) return false;
    needs.postStatus(head.sha, { ...verdict, target_url: verdict.target_url ?? (runUrl || null) });
    return true;
  };

  /**
   * The two documented 422s are outcomes, not failures, and which one it is
   * comes off the failed call's own fields (`updateRefusal`): the exit status
   * and what gh printed on stderr. Anything else is a failure and is rethrown.
   */
  const requestUpdate = (number: number, expectedHead: string): UpdateResult => {
    try {
      needs.requestUpdate(number, expectedHead);
      return "accepted";
    } catch (error) {
      const refusal = error instanceof GhError ? updateRefusal(error) : undefined;
      if (refusal) return refusal;
      throw error;
    }
  };

  /** The update is asynchronous; wait for the head to move so the verdict can follow it now. */
  const waitForNewHead = async (number: number, oldHead: string): Promise<string | undefined> => {
    for (let attempt = 0; attempt < 24; attempt++) {
      await config.sleep(5000);
      const head = needs.headOf(number).trim();
      if (head && head !== oldHead) return head;
    }
    return undefined;
  };

  /** What every conflict comment opens with; both decisions below answer the same sentence. */
  const CONFLICT_CAUSE = `update-branch could not bring this PR up to date with \`${base}\`: the merge conflicts.`;

  /**
   * Say what the run decided on the PR's own thread, then put the label on that
   * records the decision. Both conflict decisions write the same pair, and the
   * label is what the next run reads (`planConflict`), so neither may be written
   * without the other.
   */
  const commentAndLabel = (number: number, paragraphs: readonly string[], label: string): void => {
    const body = [CONFLICT_CAUSE, ...paragraphs.flatMap((p) => ["", p]), runUrl ? `\nRun: ${runUrl}` : ""].join("\n");
    needs.comment(number, body);
    needs.addLabel(number, label);
  };

  /** No API call resolves a conflict: label the PR for agent-implement-pr.yml, which resolves it on the branch. */
  const handOff = (number: number): void =>
    commentAndLabel(number, [
      `Handing it to the implementer: labeled \`${IMPLEMENT_LABEL}\`. Its run merges \`${base}\` into the branch, resolves the ` +
        "conflicts, and pushes; the review then judges the new head and auto-merge lands it.",
    ], IMPLEMENT_LABEL);

  /**
   * The factory did not open this PR, so the conflict goes back to whoever did:
   * a comment naming the cause and what to do, then `agent:blocked`, which is
   * the one label that means a human must look. No agent touches the branch.
   *
   * The label is what makes the decline stick, and the comment says so, because
   * it is also what the author has to take off to hand the PR back. Every push
   * to main runs this job again and the conflict is still there, so without it
   * the same comment would arrive on every push; and the reconciler re-arms a
   * Factory PR carrying no `agent:*` label at its verdict deadline, so a PR the
   * reviewer had already judged would be enrolled again with the conflict in
   * place (`PARKED_LABELS` in `factory/dispatch/reconcile.ts`).
   *
   * Auto-merge is left exactly as it is, and so is the update half of this run,
   * which never reads a label and never asks who opened a PR. So the branch is
   * brought up to date again the moment the conflict is gone, label or no label.
   */
  const tellAuthor = (number: number): void =>
    commentAndLabel(number, [
      `The factory did not open this PR, so it will not rewrite the branch: merging \`${base}\` in and resolving is yours. ` +
        `Labeled \`${BLOCKED_LABEL}\`, which is this factory's "a human must look".`,
      `Push the resolution and the factory goes back to bringing the branch up to date on its own, since that part never asks ` +
        `who opened a PR. Then remove \`${BLOCKED_LABEL}\`: it is the factory's record that a human is still needed here, and ` +
        `on a PR the reviewer has judged it is also what holds the next review back. Auto-merge, if it is armed, is untouched ` +
        "throughout.",
    ], BLOCKED_LABEL);

  /**
   * Carry out a conflict decision, whether the plan took it from a CONFLICTING
   * scan or it was taken again when GitHub refused the call this run made anyway.
   * One place, so the two routes to the same decision cannot act on it two ways.
   */
  const actOnConflict = ({ number, action, reason }: ConflictPlan): void => {
    if (action === "hand-off") {
      handOff(number);
      console.log(`#${number}: ${reason}; commented and labeled ${IMPLEMENT_LABEL}.`);
      return;
    }
    if (action === "tell-author") {
      tellAuthor(number);
      console.log(`#${number}: ${reason}; commented and labeled ${BLOCKED_LABEL}.`);
      return;
    }
    console.log(`#${number}: ${reason}, left alone.`);
  };

  /** Mark the head the factory asked GitHub to update from; findVerdict trusts only merges made on such a head. */
  const markRequested = (number: number, headSha: string): void => {
    needs.postStatus(headSha, {
      context: UPDATE_MARKER_CONTEXT,
      state: "success",
      description: `update-branch requested for #${number} by the factory`,
      target_url: runUrl || null,
    });
  };

  const outcomes: Outcome[] = [];
  let failed = 0;

  // Each PR's lookups (compare, commit, statuses) fail on their own; one unreadable PR must not stall the rest.
  const listedPrs = needs.openPrs();
  const prs: OpenPr[] = [];
  for (const listed of listedPrs) {
    try {
      prs.push(toOpenPr(listed));
    } catch (error) {
      const message = errorMessage(error);
      outcomes.push({ number: listed.number, action: "skip", carry: false, reason: "could not read the PR", oldHead: listed.headRefOid, error: message });
      console.error(`#${listed.number} (${listed.headRef} @ ${listed.headRefOid.slice(0, 7)}): could not read the PR: ${message}`);
      failed++;
    }
  }
  const plans = planUpdates(prs);

  for (const plan of plans) {
    const pr = prs.find((p) => p.number === plan.number)!;
    const outcome: Outcome = { ...plan, oldHead: pr.head.sha };
    outcomes.push(outcome);
    console.log(`#${plan.number} (${pr.headRef} @ ${pr.head.sha.slice(0, 7)}): ${plan.action}, ${plan.reason}`);
    if (dryRun) continue;
    try {
      if (plan.carry) {
        outcome.verdictCarried = carryOnto(pr.head, pr.verdict.sha);
        console.log(
          outcome.verdictCarried
            ? `#${plan.number}: ${VERDICT_CONTEXT} carried from ${pr.verdict.sha.slice(0, 7)} onto ${pr.head.sha.slice(0, 7)}.`
            : `#${plan.number}: no passing ${VERDICT_CONTEXT} on ${pr.verdict.sha.slice(0, 7)} to carry.`,
        );
      }
      if (plan.action === "skip") continue;
      if (plan.action === "hand-off" || plan.action === "tell-author") {
        actOnConflict({ ...plan, action: plan.action });
        continue;
      }
      const result = requestUpdate(plan.number, pr.head.sha);
      if (result === "conflict") {
        // The same decision the plan takes on a CONFLICTING PR, reached here because
        // the scan read UNKNOWN and GitHub answered with the conflict (plan.ts). That
        // GitHub refused the call is this caller's own fact, so this is where it is said.
        const conflict = planConflict(pr);
        const reason = `update-branch refused: ${conflict.reason}`;
        outcome.action = conflict.action;
        outcome.reason = reason;
        actOnConflict({ ...conflict, reason });
        continue;
      }
      if (result === "head moved") {
        outcome.action = "skip";
        outcome.reason = "head moved since the scan; the next run will see it";
        console.log(`#${plan.number}: ${outcome.reason}.`);
        continue;
      }
      markRequested(plan.number, pr.head.sha);
      console.log(`update-branch accepted for #${plan.number}, ${UPDATE_MARKER_CONTEXT} posted on ${pr.head.sha.slice(0, 7)}; waiting for the new head.`);
      const newHead = await waitForNewHead(plan.number, pr.head.sha);
      if (!newHead) {
        outcome.note = "head did not move within two minutes; the next run carries the verdict";
        console.log(`#${plan.number}: ${outcome.note}.`);
        continue;
      }
      outcome.newHead = newHead;
      const head = needs.commit(newHead);
      if (head.parents[0] !== pr.head.sha || !isUpdateMerge(head)) {
        outcome.note = "new head is not GitHub's merge of the old head; verdict not carried";
        console.log(`#${plan.number}: head ${pr.head.sha.slice(0, 7)} -> ${newHead.slice(0, 7)}; ${outcome.note}.`);
        continue;
      }
      // The verdict now sits on the old head, either the reviewer's or the one carried above.
      outcome.verdictCarried = pr.verdict.state === "success" && carryOnto(head, pr.head.sha);
      console.log(
        `#${plan.number}: head ${pr.head.sha.slice(0, 7)} -> ${newHead.slice(0, 7)}; ` +
          (outcome.verdictCarried ? `${VERDICT_CONTEXT} carried.` : `no passing ${VERDICT_CONTEXT} to carry.`),
      );
    } catch (error) {
      outcome.error = errorMessage(error);
      console.error(`#${plan.number}: ${outcome.error}`);
      failed++;
    }
  }

  const updated = outcomes.filter((o) => o.newHead).length;
  const handedOff = outcomes.filter((o) => o.action === "hand-off").length;
  const toldAuthor = outcomes.filter((o) => o.action === "tell-author").length;
  const carried = outcomes.filter((o) => o.verdictCarried).length;
  console.log(
    `${prs.length} open PR(s) on ${base}, ${updated} updated, ${carried} verdict(s) carried, ${handedOff} handed to the implementer, ` +
      `${toldAuthor} conflict(s) left to their authors, ${failed} failed${dryRun ? " (dry run)" : ""}.`,
  );

  return { prs, outcomes, failed };
};
