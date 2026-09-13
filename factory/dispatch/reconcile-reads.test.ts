/**
 * The reconciler owns which costly reads a candidate needs (#302).
 *
 * `reconcile.test.ts` drives the reconciler off a fully-read snapshot and is the
 * subject for what it decides; this file drives it off a snapshot whose costly
 * merge-state facts are unread and supplied through the `reads` object instead,
 * and proves two things `reconcile.test.ts` cannot:
 *
 * - the reconciler, not the sweep, asks for each costly read, and only at the
 *   branch that consults it (so a left-alone PR reads nothing);
 * - reading a fact lazily reaches the same decision as reading it up front.
 *
 * Before #302 the sweep pre-walked the reconciler's branching to fill those
 * fields, and `reconcile` took no `reads`; this file is red on that revision.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { type Author, trustPolicy } from "../lib/trusted-authors.ts";
import {
  DEFAULT_DEADLINES,
  type MergeReads,
  type PrState,
  type RoleReader,
  type Run,
  type RunRole,
  type Snapshot,
  type TicketState,
  type VerdictState,
  reconcile,
} from "./reconcile.ts";

const NOW = "2026-09-12T20:00:00Z";
const POLICY = trustPolicy(undefined);
const minutesAgo = (m: number): string => new Date(Date.parse(NOW) - m * 60_000).toISOString();

/** The costly facts a PR would have, keyed by number: exactly what the reader returns, undefined when a case leaves it out. */
type Facts = { verdict?: VerdictState; behindBy?: number; headSince?: string; ticketAuthor?: Author; toldNoTicket?: boolean };

/**
 * A `reads` object that records every call, so a test asserts on what the
 * reconciler asked for and in what order. It returns each fact exactly as the
 * case supplied it, with no default of its own, so a decision reached lazily
 * here and reached from a pre-filled snapshot see the identical value.
 */
const countingReads = (log: string[], facts: Record<number, Facts>): MergeReads => ({
  verdict: (pr) => (log.push(`verdict:${pr.number}`), facts[pr.number]?.verdict),
  behindBy: (pr) => (log.push(`behindBy:${pr.number}`), facts[pr.number]?.behindBy),
  headSince: (pr) => (log.push(`headSince:${pr.number}`), facts[pr.number]?.headSince),
  ticketAuthor: (pr) => (log.push(`ticketAuthor:${pr.number}`), facts[pr.number]?.ticketAuthor),
  toldNoTicket: (pr) => (log.push(`toldNoTicket:${pr.number}`), facts[pr.number]?.toldNoTicket),
});

/** A PR the way `openPrs` hands it out: label state resolved, every merge-state fact still unread. */
const pr = (number: number, overrides: Partial<PrState> = {}): PrState => ({
  number,
  title: `Fix #${number - 10}`,
  headRef: `agent/issue-${number - 10}`,
  headSha: "abcdef1234567890",
  labels: [],
  autoMerge: true,
  factory: true,
  closes: number - 10,
  draft: false,
  fork: false,
  stateSince: undefined,
  marks: [],
  ...overrides,
});

const snapshot = (prs: readonly PrState[], issues: readonly TicketState[] = []): Snapshot => ({
  now: NOW,
  base: "main",
  issues,
  prs,
  runs: [],
});

/** Drive the reconciler over one PR with a recording reader, returning what it asked for and what it decided. */
const decideWithReads = (p: PrState, facts: Facts, issues: readonly TicketState[] = []): { log: string[]; ds: ReturnType<typeof reconcile> } => {
  const log: string[] = [];
  const ds = reconcile(snapshot([p], issues), DEFAULT_DEADLINES, POLICY, countingReads(log, { [p.number]: facts }));
  return { log, ds };
};

test("an unjudged PR reads its ticket author, then the verdict, then the head age, and gets agent:review", () => {
  const { log, ds } = decideWithReads(pr(21, { factory: false, autoMerge: false, closes: 5 }), {
    ticketAuthor: { association: "OWNER", login: "maintainer" },
    verdict: "none",
    headSince: minutesAgo(45),
  });
  assert.deepEqual(log, ["ticketAuthor:21", "verdict:21", "headSince:21"]);
  assert.deepEqual(ds.map((d) => d.action), [{ type: "relabel", remove: [], add: "agent:review" }]);
});

test("an unjudged PR whose ticket an untrusted author opened stops at the author read: no verdict is asked for", () => {
  const { log, ds } = decideWithReads(pr(21, { factory: false, autoMerge: false, closes: 5 }), {
    ticketAuthor: { association: "CONTRIBUTOR", login: "passer-by" },
  });
  assert.deepEqual(log, ["ticketAuthor:21"]);
  assert.equal(ds[0]!.action.type, "none");
  assert.match(ds[0]!.log, /left alone \(untrusted-ticket-author\)/);
});

test("a PR closing no ticket reads only whether it was told already, never its author or verdict", () => {
  const { log, ds } = decideWithReads(pr(22, { factory: false, autoMerge: false, closes: undefined }), { toldNoTicket: false });
  assert.deepEqual(log, ["toldNoTicket:22"]);
  assert.deepEqual(ds.map((d) => d.action), [{ type: "comment", pr: 22 }]);
});

test("an armed factory PR reads the verdict, then the behind-count only once it is a success, and never the head age or author", () => {
  const { log, ds } = decideWithReads(pr(11, { factory: true, autoMerge: true }), { verdict: "success", behindBy: 2 });
  assert.deepEqual(log, ["verdict:11", "behindBy:11"]);
  assert.deepEqual(ds.map((d) => d.action), [{ type: "dispatch", eventType: "factory-update-branch", pr: 11 }]);
});

test("an unarmed factory PR reads only its head age, never a verdict", () => {
  const { log, ds } = decideWithReads(pr(11, { factory: true, autoMerge: false }), { headSince: minutesAgo(45) });
  assert.deepEqual(log, ["headSince:11"]);
  assert.deepEqual(ds.map((d) => d.action), [{ type: "arm-auto-merge", pr: 11 }]);
});

test("a candidate a decision leaves alone before any costly branch reads nothing", () => {
  // A draft (a listing reason), a PR carrying an agent label (off the merge path),
  // a parked one, and a held one: each is decided without a single costly read.
  const log: string[] = [];
  const reads = countingReads(log, {});
  const prs = [
    pr(21, { factory: false, autoMerge: false, closes: 5, draft: true }),
    pr(31, { labels: ["agent:review"], stateSince: minutesAgo(1) }),
    pr(41, { labels: ["needs-human"] }),
    pr(51, { factory: false, autoMerge: false, closes: undefined, labels: ["hold"] }),
  ];
  const ds = reconcile(snapshot(prs), DEFAULT_DEADLINES, POLICY, reads);
  assert.deepEqual(log, []);
  assert.deepEqual(ds.filter((d) => d.action.type !== "none"), []);
});

/**
 * A run's role is the same kind of costly, per-candidate fact (#307): the
 * reconciler asks for it at the point it filters a subject's runs, so a subject
 * a decision leaves alone before that point has its runs' roles left unread.
 * Before #307 the sweep pre-walked the labelled subjects and `runsFor` to fill
 * `run.role`, and `reconcile` had no role reader; these are red on that revision.
 */
const countingRole = (log: string[], roles: Record<number, RunRole>): RoleReader => (run) => {
  log.push(`role:${run.id}`);
  return roles[run.id];
};

const stuckTicket = (number: number, overrides: Partial<TicketState> = {}): TicketState => ({
  number,
  title: `Ticket ${number}`,
  labels: ["ready-for-agent", "agent:in-progress"],
  stateSince: minutesAgo(40),
  marks: [],
  ...overrides,
});

const issueRun = (id: number, title: string, overrides: Partial<Run> = {}): Run => ({
  id,
  event: "issues",
  title,
  headBranch: "main",
  status: "completed",
  conclusion: "failure",
  createdAt: minutesAgo(35),
  updatedAt: minutesAgo(35),
  role: undefined,
  ...overrides,
});

test("the reconciler reads a run's role at the run filter, and not for a subject it leaves alone", () => {
  const stuck = stuckTicket(1);
  const parked = stuckTicket(2, { labels: ["needs-human", "agent:in-progress"] });
  const snap: Snapshot = {
    now: NOW,
    base: "main",
    issues: [stuck, parked],
    prs: [],
    runs: [issueRun(100, "Ticket 1"), issueRun(200, "Ticket 2")],
  };
  const log: string[] = [];
  const ds = reconcile(snap, DEFAULT_DEADLINES, POLICY, undefined, countingRole(log, { 100: "implement", 200: "implement" }));
  // The parked ticket's run (200) is never role-read; only the stuck ticket's (100).
  assert.deepEqual(log, ["role:100"]);
  assert.deepEqual(
    ds.filter((d) => d.action.type !== "none").map((d) => d.action),
    [{ type: "relabel", remove: ["agent:in-progress"], add: "agent:implement", miss: 1 }],
  );
});

test("a run's role read lazily reaches the same decision as one already on the snapshot", () => {
  const cases: { role: RunRole; conclusion: string }[] = [
    { role: "implement", conclusion: "failure" },
    { role: "review", conclusion: "failure" },
    { role: "none", conclusion: "success" },
  ];
  for (const { role, conclusion } of cases) {
    const t = stuckTicket(1);
    const runs = [issueRun(100, "Ticket 1", { conclusion })];
    const base: Omit<Snapshot, "runs"> = { now: NOW, base: "main", issues: [t], prs: [] };
    const lazy = reconcile({ ...base, runs }, DEFAULT_DEADLINES, POLICY, undefined, countingRole([], { 100: role }));
    const eager = reconcile({ ...base, runs: [{ ...runs[0]!, role }] }, DEFAULT_DEADLINES, POLICY);
    assert.deepEqual(lazy, eager, role);
  }
});

test("reading a fact lazily reaches the same decision as reading it up front", () => {
  // The read mechanism must not change the decision: for each PR, the decision
  // reached through the reader equals the one reached from a snapshot pre-filled
  // with the identical facts (the path `reconcile.test.ts` exercises).
  const cases: { p: PrState; facts: Facts }[] = [
    { p: pr(11, { factory: true, autoMerge: true }), facts: { verdict: "success", behindBy: 2 } },
    { p: pr(12, { factory: true, autoMerge: true }), facts: { verdict: "success", behindBy: 0 } },
    { p: pr(13, { factory: true, autoMerge: true }), facts: { verdict: "pending" } },
    { p: pr(14, { factory: true, autoMerge: false }), facts: { headSince: minutesAgo(45) } },
    { p: pr(21, { factory: false, autoMerge: false, closes: 5 }), facts: { ticketAuthor: { association: "OWNER", login: "m" }, verdict: "none", headSince: minutesAgo(45) } },
    { p: pr(22, { factory: false, autoMerge: false, closes: undefined }), facts: { toldNoTicket: false } },
    { p: pr(23, { factory: false, autoMerge: false, closes: 5 }), facts: { ticketAuthor: { association: "CONTRIBUTOR", login: "x" } } },
  ];
  for (const { p, facts } of cases) {
    const lazy = reconcile(snapshot([p]), DEFAULT_DEADLINES, POLICY, countingReads([], { [p.number]: facts }));
    const eager = reconcile(snapshot([{ ...p, ...facts }]), DEFAULT_DEADLINES, POLICY);
    assert.deepEqual(lazy, eager, `#${p.number}`);
  }
});
