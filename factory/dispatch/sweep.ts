/**
 * Sweep (#35): build the reconciler's snapshot from the target repo, decide
 * with `reconcile.ts`, apply the repairs, log one line per decision.
 *
 * Built the way the heartbeat is (#281): it takes a `Needs` record, the shape
 * of the heartbeat's `Pass`, and is handed it from outside (`sweep-run.ts` in
 * production, an in-memory target repo in `sweep.test.ts`). What it decides
 * does not change, only how it is wired: no `gh` call lives here now.
 * docs/factory/layout.md, "How a script is wired", carries the pattern.
 *
 * A failed hard read aborts the pass with one `::error::` line and repairs
 * nothing from a partial snapshot. Which reads may fail softly is still this
 * script's own policy and stays here: a ticket's author (#182), a run's jobs,
 * a PR's comments and the factory's own login (#230). Each of those the module
 * throws `GhError` for, and each the sweep catches, warns about, and leaves the
 * subject alone for, since an unknown fact is one the reconciler does less on.
 *
 * Builtins only, imported with `.ts` extensions, so the dispatch job runs it on
 * bare `node --experimental-strip-types` and skips installing the engine.
 */
import { errorMessage } from "../lib/errors.ts";
import { GhError } from "../lib/gh.ts";
import { type Author, type TrustPolicy } from "../lib/trusted-authors.ts";
import { escalationLabels } from "../retry/escalation.ts";
import {
  type Deadlines,
  type Decision,
  type MergeReads,
  type PrComment,
  type PrState,
  type RoleReader,
  type Run,
  type RunRole,
  type Snapshot,
  type Subject,
  type TicketState,
  type VerdictState,
  reconcile,
  roleFromJobs,
  toldNoTicketIn,
} from "./reconcile.ts";

/** A run's jobs, as much of each as `roleFromJobs` reads. */
export type JobSummary = { name: string; conclusion: string | null };

/** A PR as `openPrs` hands it out: its label state resolved, its merge state (verdict, head, ...) still unread. */
export type OpenPr = { pr: PrState; createdAt: string };

/**
 * Everything the sweep needs from the target repo, the shape of the
 * heartbeat's `Pass`: named domain reads and writes, never a raw `gh` call.
 * Every function throws `GhError` on failure; the sweep decides which throws it
 * shrugs off and which abort the pass.
 */
export type Needs = {
  /** Open tickets with their label state (the state label's `since` and the sweep marks). */
  readonly openTickets: () => TicketState[];
  /** Open pull requests on the base with their label state; merge state is read per PR below. */
  readonly openPrs: () => OpenPr[];
  /** Runs completed within the lookback or still live; their roles are read from their jobs. */
  readonly recentRuns: (since: string) => Run[];
  /** One run's jobs, for its role. A read the sweep lets fail softly (the run then counts as covering while live). */
  readonly jobs: (runId: number) => JobSummary[];
  /** The `factory/verdict` on a head. */
  readonly verdict: (sha: string) => VerdictState;
  /** When a head commit was committed, for how long its PR has carried it. */
  readonly commitDate: (sha: string) => string;
  /** How many commits on the base a head lacks. */
  readonly behindBy: (sha: string) => number;
  /** Whoever opened a ticket. A read the sweep lets fail softly (an unread author leaves the PR alone). */
  readonly ticketAuthor: (ticket: number) => Author;
  /** A PR's own comments, for #230's marker. A read the sweep lets fail softly (it then says nothing). */
  readonly prComments: (pr: number) => PrComment[];
  /** The account the sweep writes as, whose #230 marker is its own. A read the sweep lets fail softly. */
  readonly factoryLogin: () => string;
  /** A subject's labels right now, read at apply time because the snapshot may be stale by then. */
  readonly currentLabels: (subject: number) => string[];
  readonly addLabel: (subject: Subject, label: string) => void;
  readonly removeLabel: (subject: Subject, label: string) => void;
  readonly comment: (subject: Subject, body: string) => void;
  readonly dispatch: (eventType: string, pr: number) => void;
  readonly armAutoMerge: (pr: number) => void;
};

/** What one pass is measured and decided against. `now` is injected so a test drives the clock. */
export type SweepConfig = {
  readonly repo: string;
  readonly base: string;
  readonly deadlines: Deadlines;
  readonly policy: TrustPolicy;
  readonly now: Date;
  readonly dryRun: boolean;
  readonly runUrl?: string;
};

export type SweepResult = {
  /** Set when a hard read failed: the snapshot was partial, so nothing was repaired. */
  readonly aborted?: string;
  readonly snapshot?: Snapshot;
  readonly decisions: readonly Decision[];
  readonly applied: readonly string[];
  /** Re-arms GitHub refused: warned, not failed, but recorded so a standing refusal is visible. */
  readonly refused: readonly { log: string; error: string }[];
  readonly failed: readonly { log: string; error: string }[];
};

const later = (a: string, b: string): string => (Date.parse(a) >= Date.parse(b) ? a : b);

/** One pass of the sweep against a target repo: read, decide, apply, log. */
export const sweep = (needs: Needs, config: SweepConfig): SweepResult => {
  const { repo, base, deadlines, policy, now, dryRun, runUrl } = config;

  /** When the PR's current head appeared: the later of the PR's creation and its head commit. */
  const headSince = (pr: PrState, createdAt: string): string => {
    const committed = needs.commitDate(pr.headSha).trim();
    return later(createdAt, committed || createdAt);
  };

  /**
   * Whoever opened the ticket a PR that is not a factory PR closes (#179, #182).
   * A failed read leaves the author unknown rather than aborting: one PR closing
   * a mistyped number would otherwise stop every repair on the target, and an
   * unknown author is one the reconciler leaves the PR alone for.
   */
  const ticketAuthorOf = (ticket: number): Author | undefined => {
    try {
      return needs.ticketAuthor(ticket);
    } catch (error) {
      if (!(error instanceof GhError)) throw error;
      console.log(`::warning::Could not read who opened #${ticket}; leaving the PRs that close it alone: ${error.message}`);
      return undefined;
    }
  };

  /**
   * The account the write token belongs to, which is the only one whose #230
   * marker means the factory has spoken. Read once per pass, and only if a PR
   * needs it. Unknown on a failed read, which leaves the factory unable to
   * recognise its own comment and therefore silent, as `toldNoTicketIn` says.
   */
  let login: { known: string | undefined } | undefined;
  const factoryLogin = (): string | undefined => {
    if (login) return login.known;
    try {
      login = { known: needs.factoryLogin().trim() || undefined };
    } catch (error) {
      if (!(error instanceof GhError)) throw error;
      console.log(`::warning::Could not read the account this sweep writes as; saying nothing about a PR's missing closing keyword: ${error.message}`);
      login = { known: undefined };
    }
    return login.known;
  };

  /**
   * Whether the factory has already told this PR it closes no ticket (#230).
   * A failed read leaves the answer unknown rather than aborting, and unknown
   * means told, so the sweep stays quiet rather than repeating itself on a PR
   * whose comments it could not see.
   */
  const toldNoTicketOn = (pr: number): boolean | undefined => {
    try {
      return toldNoTicketIn(needs.prComments(pr), factoryLogin());
    } catch (error) {
      if (!(error instanceof GhError)) throw error;
      console.log(`::warning::Could not read the comments on PR #${pr}; saying nothing about its missing closing keyword: ${error.message}`);
      return undefined;
    }
  };

  /**
   * The costly merge-state facts the reconciler asks for, backed by the Needs
   * record and lazy: each fires only when the reconciler reaches the branch that
   * consults it (#302), so pre-walking which PRs to read for is no longer this
   * script's job. A PR left alone before that branch reads nothing.
   *
   * The soft-fail reads keep this script's policy behind them: an unreadable
   * ticket author (#182) or comment thread (#230) leaves the fact unknown, the
   * direction the reconciler does less on, rather than aborting. The hard reads
   * (verdict, behind-by, and the head commit date behind `headSince`) throw
   * `GhError`, which the abort path below turns into one aborted pass.
   */
  const mergeReads = (createdAt: ReadonlyMap<number, string>): MergeReads => ({
    verdict: (pr) => needs.verdict(pr.headSha),
    behindBy: (pr) => needs.behindBy(pr.headSha),
    headSince: (pr) => {
      // Every open PR is in the map, so `created` is defined for any PR the
      // reconciler passes in. An unknown head date reads as undefined, which the
      // reconciler treats as overdue, rather than as "now", which is within every
      // deadline and would hide a lost date instead of surfacing it.
      const created = createdAt.get(pr.number);
      return created === undefined ? undefined : headSince(pr, created);
    },
    ticketAuthor: (pr) => (pr.closes === undefined ? undefined : ticketAuthorOf(pr.closes)),
    toldNoTicket: (pr) => toldNoTicketOn(pr.number),
  });

  const lookbackMinutes = Math.max(deadlines.stuckMinutes, deadlines.verdictMinutes, deadlines.updateMinutes) + 30;

  /**
   * A run's role, backed by the Needs record and lazy: the reconciler asks for
   * one at the branch that filters a subject's runs (#307), so a subject a
   * decision leaves alone before that branch reads no run's jobs. Pre-walking
   * which runs to read for is no longer this script's job.
   *
   * The soft-fail policy stays here, as it did when `readRuns` set the role: a
   * run whose jobs cannot be read has an unread role and, being undefined,
   * counts as covering while live, exactly as before. Read once per run.
   */
  const roleReader = (): RoleReader => {
    const cache = new Map<number, RunRole | undefined>();
    return (run) => {
      if (cache.has(run.id)) return cache.get(run.id);
      let role: RunRole | undefined;
      try {
        role = roleFromJobs(needs.jobs(run.id));
      } catch (error) {
        console.log(`::warning::Could not read the jobs of run ${run.id}; treating it as covering while live: ${errorMessage(error)}`);
      }
      cache.set(run.id, role);
      return role;
    };
  };

  const readSnapshot = (): { snapshot: Snapshot; createdAt: Map<number, string> } => {
    const issues = needs.openTickets();
    const open = needs.openPrs();
    const prs = open.map((o) => o.pr);
    const createdAt = new Map(open.map((o) => [o.pr.number, o.createdAt]));
    const since = new Date(now.getTime() - lookbackMinutes * 60_000).toISOString();
    return { snapshot: { now: now.toISOString(), base, issues, prs, runs: needs.recentRuns(since), sweepUrl: runUrl }, createdAt };
  };

  /* A failed hard read aborts the pass: a partial snapshot, or a costly read the
     reconciler could not make, would read as stranded subjects and repair them
     wrongly. The reconciler's own merge-state reads run inside this try too, so a
     hard one that throws aborts here rather than crashing mid-decision. */
  let snapshot: Snapshot;
  let decisions: readonly Decision[];
  try {
    const read = readSnapshot();
    snapshot = read.snapshot;
    decisions = reconcile(snapshot, deadlines, policy, mergeReads(read.createdAt), roleReader());
  } catch (error) {
    if (!(error instanceof GhError)) throw error;
    const aborted = `Sweep of ${repo} aborted before repairing anything: ${error.message}`;
    console.error(`::error::${aborted}`);
    return { aborted, decisions: [], applied: [], refused: [], failed: [] };
  }

  console.log(
    `Sweep of ${repo} at ${snapshot.now}: ${snapshot.issues.length} open issue(s), ${snapshot.prs.length} open PR(s) on ${base}, ${snapshot.runs.length} run(s) in the last ${lookbackMinutes} min or live; deadlines stuck ${deadlines.stuckMinutes}, verdict ${deadlines.verdictMinutes}, update ${deadlines.updateMinutes} min.`,
  );
  for (const d of decisions) console.log(d.log);

  const apply = (d: Decision): void => {
    const { action, subject } = d;
    switch (action.type) {
      case "none":
        return;
      case "relabel":
        for (const label of action.remove) needs.removeLabel(subject, label);
        needs.addLabel(subject, action.add);
        if (d.comment) needs.comment(subject, d.comment);
        return;
      case "escalate":
        for (const label of action.remove) needs.removeLabel(subject, label);
        needs.addLabel(subject, action.add);
        if (d.comment) needs.comment(subject, d.comment);
        if (action.ticket !== undefined) {
          // Escalating the PR parks its ticket on the same label set (#50). The ticket's
          // labels are read here, not taken from the snapshot: an earlier repair in this
          // same pass may have changed them, and the ticket may be closed and unlisted.
          const ticket: Subject = { kind: "issue", number: action.ticket };
          const ticketLabels = escalationLabels(needs.currentLabels(action.ticket));
          for (const label of ticketLabels.remove) needs.removeLabel(ticket, label);
          needs.addLabel(ticket, ticketLabels.add);
          needs.comment(
            ticket,
            `PR #${subject.number} was escalated by the reconciler: ${d.log}\n\nLabels here: ${ticketLabels.remove.length > 0 ? `\`${ticketLabels.remove.join("`, `")}\` removed, ` : ""}\`${ticketLabels.add}\` added. To hand it back, remove \`${ticketLabels.add}\` and add \`ready-for-agent\` again.${runUrl ? `\n\nSweep: ${runUrl}` : ""}`,
          );
        }
        return;
      case "comment":
        // The comment is the whole repair (#230), posted with the write token so
        // nothing but the factory can write the marker that turns it off (ADR 0002).
        if (d.comment) needs.comment(subject, d.comment);
        return;
      case "dispatch":
        needs.dispatch(action.eventType, action.pr);
        return;
      case "arm-auto-merge":
        needs.armAutoMerge(action.pr);
        return;
    }
  };

  const applied: string[] = [];
  const failed: { log: string; error: string }[] = [];
  const refused: { log: string; error: string }[] = [];
  for (const d of decisions) {
    if (d.action.type === "none" || dryRun) continue;
    try {
      apply(d);
      applied.push(d.log);
      console.log(`Applied: ${d.log}`);
    } catch (error) {
      const message = errorMessage(error);
      // A refused re-arm is the target's setup, not a broken sweep: GitHub refuses
      // auto-merge on a repo that allows none and on a main whose ruleset requires
      // nothing. So warn and carry on: one unonboarded target must not turn every
      // sweep red forever (#83).
      if (d.action.type === "arm-auto-merge") {
        refused.push({ log: d.log, error: message });
        console.log(`::warning::Could not re-arm auto-merge on PR #${d.action.pr} of ${repo}: ${message}. If the target refuses auto-merge, run scripts/onboard.sh there.`);
        continue;
      }
      failed.push({ log: d.log, error: message });
      console.error(`::error::Could not apply "${d.log}": ${message}`);
    }
  }

  const repairs = decisions.filter((d) => d.action.type !== "none").length;
  console.log(`${decisions.length} decision(s), ${repairs} repair(s), ${applied.length} applied, ${refused.length} refused, ${failed.length} failed${dryRun ? " (dry run)" : ""}.`);

  return { snapshot, decisions, applied, refused, failed };
};
