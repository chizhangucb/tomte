import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_DEADLINES,
  type Decision,
  leftAlone,
  NO_TICKET_MARK,
  onMergePath,
  type PrState,
  type Run,
  type Snapshot,
  type SweepMark,
  type TicketState,
  marksFromTimeline,
  prFromGitHub,
  reconcile,
  roleFromJobs,
  runFromGitHub,
  runsFor,
  stateSinceFromTimeline,
  ticketFromGitHub,
  toldNoTicketIn,
} from "./reconcile.ts";
import { PARKED_LABELS } from "../lib/labels.ts";
import { trustPolicy } from "../lib/trusted-authors.ts";

const NOW = "2026-09-07T20:00:00Z";
/** The default policy, the repo owner alone: the same object every entrypoint builds (#52, #179). */
const POLICY = trustPolicy(undefined);
const minutesAgo = (m: number): string => new Date(Date.parse(NOW) - m * 60_000).toISOString();

const ticket = (number: number, overrides: Partial<TicketState> = {}): TicketState => ({
  number,
  title: `Ticket ${number}`,
  labels: ["ready-for-agent", "agent:in-progress"],
  stateSince: minutesAgo(40),
  marks: [],
  ...overrides,
});

const pr = (number: number, overrides: Partial<PrState> = {}): PrState => ({
  number,
  title: `Fix #${number - 10}: thing`,
  headRef: `agent/issue-${number - 10}-thing`,
  headSha: "abcdef1234567890",
  labels: [],
  autoMerge: true,
  factory: true,
  closes: number - 10,
  verdict: "success",
  behindBy: 0,
  headSince: minutesAgo(60),
  draft: false,
  fork: false,
  stateSince: undefined,
  marks: [],
  ...overrides,
});

/**
 * A PR the factory never touched: a person's or an outside agent's branch in the
 * target, closing a ticket the repo owner opened, with no verdict on its head.
 */
const unjudged = (number: number, overrides: Partial<PrState> = {}): PrState =>
  pr(number, {
    title: "Tidy the parser",
    headRef: "someone/tidy-parser",
    factory: false,
    autoMerge: false,
    verdict: "none",
    behindBy: undefined,
    headSince: minutesAgo(45),
    ticketAuthor: { association: "OWNER", login: "maintainer" },
    ...overrides,
  });

/** One of those whose body names no ticket, which is the one reason #230 tells its author about. */
const noTicket = (number: number, overrides: Partial<PrState> = {}): PrState =>
  unjudged(number, { closes: undefined, ticketAuthor: undefined, ...overrides });

const run = (id: number, overrides: Partial<Run> = {}): Run => ({
  id,
  event: "issues",
  title: "Ticket 1",
  headBranch: "main",
  status: "completed",
  conclusion: "success",
  createdAt: minutesAgo(10),
  updatedAt: overrides.createdAt ?? minutesAgo(10),
  role: "implement",
  ...overrides,
});

const snapshot = (overrides: Partial<Snapshot> = {}): Snapshot => ({
  now: NOW,
  base: "main",
  issues: [],
  prs: [],
  runs: [],
  ...overrides,
});

const repairs = (decisions: readonly Decision[]): Decision[] =>
  decisions.filter((d) => d.action.type !== "none");

const only = (decisions: readonly Decision[]): Decision => {
  assert.equal(decisions.length, 1, decisions.map((d) => d.log).join("\n"));
  return decisions[0]!;
};

test("a healthy snapshot produces no repairs, and a second pass over it none either", () => {
  const healthy = snapshot({
    issues: [ticket(1, { labels: ["ready-for-agent"] }), ticket(2, { labels: [] })],
    prs: [pr(11, { autoMerge: false, factory: false }), pr(12, { verdict: "success", behindBy: 0 })],
    runs: [run(100, { role: "dispatch", event: "repository_dispatch", title: "factory" })],
  });
  assert.deepEqual(repairs(reconcile(healthy, DEFAULT_DEADLINES, POLICY)), []);
  assert.deepEqual(repairs(reconcile(healthy, DEFAULT_DEADLINES, POLICY)), []);
});

test("every reconciler deadline defaults to 30 minutes (#271)", () => {
  // Stuck moved from 15 to 30; verdict and update were already 30 and stay 30.
  assert.deepEqual(DEFAULT_DEADLINES, { stuckMinutes: 30, verdictMinutes: 30, updateMinutes: 30 });
});

test("a ticket in agent:in-progress with no run past the deadline is re-dispatched as miss 1", () => {
  const d = only(reconcile(snapshot({ issues: [ticket(1)] }), DEFAULT_DEADLINES, POLICY));
  assert.deepEqual(d.subject, { kind: "issue", number: 1 });
  assert.equal(d.action.type, "relabel");
  assert.deepEqual(d.action.type === "relabel" && d.action.remove, ["agent:in-progress"]);
  assert.equal(d.action.type === "relabel" && d.action.add, "agent:implement");
  assert.equal(d.action.type === "relabel" && d.action.miss, 1);
  assert.match(d.log, /#1 \(issue\) agent:in-progress since .*40 min ago, deadline 30 min, no implement run: re-add agent:implement \(miss 1, re-dispatch 1 of 2\)/);
  assert.match(d.comment ?? "", /^<!-- factory:sweep miss=1 tries=1 -->/);
});

test("a ticket in agent:implement with no run past the deadline gets the label removed and added again so the event fires", () => {
  const d = only(reconcile(snapshot({ issues: [ticket(1, { labels: ["ready-for-agent", "agent:implement"] })] }), DEFAULT_DEADLINES, POLICY));
  assert.deepEqual(d.action, { type: "relabel", remove: ["agent:implement"], add: "agent:implement", miss: 1 });
});

test("the second miss on the same stranding escalates to needs-human with a comment, and the ticket is left carrying it alone", () => {
  const stranded = ticket(1, { stateSince: minutesAgo(40), marks: [{ miss: 1, tries: 1, at: minutesAgo(19) }] });
  const d = only(reconcile(snapshot({ issues: [stranded] }), DEFAULT_DEADLINES, POLICY));
  assert.equal(d.action.type, "escalate");
  assert.equal(d.action.type === "escalate" && d.action.add, "needs-human");
  // Same label set as the retry handler's escalation: ready-for-agent goes with the agent:* labels.
  assert.deepEqual(d.action.type === "escalate" && d.action.remove, ["ready-for-agent", "agent:in-progress"]);
  assert.match(d.log, /second miss: escalate to needs-human/);
  assert.match(d.comment ?? "", /needs-human/);
  assert.match(d.comment ?? "", /add `ready-for-agent` back/);
});

test("a mark from an older stranding does not count: the label was re-applied after it", () => {
  const stranded = ticket(1, { stateSince: minutesAgo(40), marks: [{ miss: 1, tries: 1, at: minutesAgo(200) }] });
  const d = only(reconcile(snapshot({ issues: [stranded] }), DEFAULT_DEADLINES, POLICY));
  assert.equal(d.action.type, "relabel");
  assert.equal(d.action.type === "relabel" && d.action.miss, 1);
});

test("a ticket within its deadline is left alone", () => {
  const d = only(reconcile(snapshot({ issues: [ticket(1, { stateSince: minutesAgo(5) })] }), DEFAULT_DEADLINES, POLICY));
  assert.equal(d.action.type, "none");
  assert.match(d.log, /5 min ago, deadline 30 min: within deadline/);
});

test("deadlines are inputs: a shorter stuck deadline repairs sooner", () => {
  const d = only(reconcile(snapshot({ issues: [ticket(1, { stateSince: minutesAgo(5) })] }), { ...DEFAULT_DEADLINES, stuckMinutes: 2 }, POLICY));
  assert.equal(d.action.type, "relabel");
  assert.match(d.log, /deadline 2 min/);
});

test("a live implement run for the ticket covers it", () => {
  const live = run(100, { status: "in_progress", conclusion: null, createdAt: minutesAgo(25) });
  const d = only(reconcile(snapshot({ issues: [ticket(1)], runs: [live] }), DEFAULT_DEADLINES, POLICY));
  assert.equal(d.action.type, "none");
  assert.match(d.log, /run 100 live/);
});

test("a queued run counts as live, and a run for another ticket does not cover this one", () => {
  const queued = run(100, { status: "queued", conclusion: null, title: "Ticket 1" });
  const other = run(101, { status: "in_progress", conclusion: null, title: "Ticket 2" });
  const d1 = only(reconcile(snapshot({ issues: [ticket(1)], runs: [queued] }), DEFAULT_DEADLINES, POLICY));
  assert.equal(d1.action.type, "none");
  const d2 = only(reconcile(snapshot({ issues: [ticket(1)], runs: [other] }), DEFAULT_DEADLINES, POLICY));
  assert.equal(d2.action.type, "relabel");
});

test("a dispatch run on the same issue title is not an implement run", () => {
  const dispatch = run(100, { status: "in_progress", conclusion: null, role: "dispatch" });
  const d = only(reconcile(snapshot({ issues: [ticket(1)], runs: [dispatch] }), DEFAULT_DEADLINES, POLICY));
  assert.equal(d.action.type, "relabel");
});

test("a run whose jobs could not be read is treated as covering while live", () => {
  const unknown = run(100, { status: "in_progress", conclusion: null, role: undefined });
  const d = only(reconcile(snapshot({ issues: [ticket(1)], runs: [unknown] }), DEFAULT_DEADLINES, POLICY));
  assert.equal(d.action.type, "none");
});

test("a cancelled run is an ordinary lost event: it is re-dispatched and it spends a miss, whatever cancelled it", () => {
  // No cancel is read as contention any more (#149): the per-account slots that
  // cancelled a third run queued for a full one are gone, so every cancel left is
  // a lost event, and every one of them counts.
  const cancelled = run(100, { conclusion: "cancelled", createdAt: minutesAgo(19) });
  const stranded = ticket(1, { labels: ["ready-for-agent", "agent:implement"] });
  const d = only(reconcile(snapshot({ issues: [stranded], runs: [cancelled] }), DEFAULT_DEADLINES, POLICY));
  assert.equal(d.action.type, "relabel");
  assert.equal(d.action.type === "relabel" && d.action.miss, 1);
  assert.match(d.log, /run 100 cancelled: re-add agent:implement \(miss 1, re-dispatch 1 of 2\)/);
  assert.match(d.comment ?? "", /Miss 1 of 2/);
});

/**
 * One stranding swept until the reconciler stops re-dispatching. Each sweep
 * feeds back what the last one left on the subject: the relabel re-applies
 * the state label, so `stateSince` moves to the sweep that wrote it, and the
 * mark comes back through `marksFromTimeline` exactly as `sweep.ts` reads it.
 * The relabel moving `stateSince` is why the counts have to be carried in the
 * marker's value; counting markers instead only ever finds the last one.
 */
const sweepUntilItStops = (limit = 6): Decision[] => {
  const decisions: Decision[] = [];
  let since = Date.parse(NOW);
  let marks: readonly SweepMark[] = [];
  for (let i = 0; i < limit; i++) {
    const now = since + 40 * 60_000;
    const cancelled = run(100 + i, {
      conclusion: "cancelled",
      createdAt: new Date(since + 60_000).toISOString(),
      updatedAt: new Date(since + 60_000).toISOString(),
    });
    const stranded = ticket(1, { labels: ["ready-for-agent", "agent:implement"], stateSince: new Date(since).toISOString(), marks });
    const d = only(reconcile({ now: new Date(now).toISOString(), base: "main", issues: [stranded], prs: [], runs: [cancelled] }, DEFAULT_DEADLINES, POLICY));
    decisions.push(d);
    if (d.action.type !== "relabel") break;
    since = now;
    marks = marksFromTimeline([{ event: "commented", body: d.comment ?? "", created_at: new Date(now).toISOString() }]);
  }
  return decisions;
};

test("a ticket cancelled every sweep escalates on the second miss, one sweep before the re-dispatch cap", () => {
  const ds = sweepUntilItStops();
  assert.deepEqual(ds.map((d) => d.action.type), ["relabel", "escalate"]);
  assert.match(ds[0]!.comment ?? "", /^<!-- factory:sweep miss=1 tries=1 -->/);
  assert.match(ds[1]!.log, /run 101 cancelled, second miss: escalate to needs-human/);
});

test("the re-dispatch cap still ends a stranding whose markers were written as miss=0, which is all the slot cap ever wrote", () => {
  // The cap counts re-dispatches whatever their cause, and every miss is counted
  // now, so the miss path is the one a fresh stranding reaches. The cap is what
  // ends a stranding carrying markers from before the slots went (#149).
  const cancelled = run(100, { conclusion: "cancelled", createdAt: minutesAgo(19) });
  const stranded = ticket(1, { labels: ["ready-for-agent", "agent:implement"], marks: [{ miss: 0, tries: 2, at: minutesAgo(19) }] });
  const d = only(reconcile(snapshot({ issues: [stranded], runs: [cancelled] }), DEFAULT_DEADLINES, POLICY));
  assert.equal(d.action.type, "escalate");
  assert.match(d.log, /run 100 cancelled, 2 re-dispatches: escalate to needs-human/);
  assert.match(d.comment ?? "", /The same after 2 re-dispatches/);
});

test("re-dispatches from an older stranding do not use up the cap", () => {
  const cancelled = run(100, { conclusion: "cancelled", createdAt: minutesAgo(19) });
  const old = ticket(1, { labels: ["ready-for-agent", "agent:implement"], marks: [{ miss: 0, tries: 2, at: minutesAgo(200) }] });
  const d = only(reconcile(snapshot({ issues: [old], runs: [cancelled] }), DEFAULT_DEADLINES, POLICY));
  assert.equal(d.action.type, "relabel");
});

test("a marker written before tries existed reads its miss value as the try count", () => {
  assert.deepEqual(marksFromTimeline([{ event: "commented", body: "<!-- factory:sweep miss=1 -->\nReconciler: ...", created_at: NOW }]), [
    { miss: 1, tries: 1, at: NOW },
  ]);
  // The old code wrote miss=0 for a cancelled run, which is the loop the cap is
  // for; that marker is still one re-dispatch, so it back-fills as one, not none.
  assert.deepEqual(marksFromTimeline([{ event: "commented", body: "<!-- factory:sweep miss=0 -->\nReconciler: ...", created_at: NOW }]), [
    { miss: 0, tries: 1, at: NOW },
  ]);
});

test("a completed run that left the label behind counts as a miss", () => {
  const failed = run(100, { conclusion: "failure", createdAt: minutesAgo(40) });
  const d = only(reconcile(snapshot({ issues: [ticket(1, { labels: ["agent:implement"] })], runs: [failed] }), DEFAULT_DEADLINES, POLICY));
  assert.equal(d.action.type, "relabel");
  assert.equal(d.action.type === "relabel" && d.action.miss, 1);
  assert.match(d.log, /run 100 ended failure and left agent:implement/);
});

test("a run that finished moments ago is still settling, not a miss", () => {
  const fresh = run(100, { conclusion: "success", createdAt: minutesAgo(3) });
  const d = only(reconcile(snapshot({ issues: [ticket(1, { labels: ["agent:implement"] })], runs: [fresh] }), DEFAULT_DEADLINES, POLICY));
  assert.equal(d.action.type, "none");
  assert.match(d.log, /run 100 ended success 3 min ago, settling/);
});

test("a ticket whose state label time is unknown is treated as overdue", () => {
  const d = only(reconcile(snapshot({ issues: [ticket(1, { stateSince: undefined })] }), DEFAULT_DEADLINES, POLICY));
  assert.equal(d.action.type, "relabel");
  assert.match(d.log, /since unknown/);
});

test("parked tickets (agent:blocked, needs-human) are never touched", () => {
  const blocked = ticket(1, { labels: ["agent:implement", "agent:blocked"] });
  const human = ticket(2, { labels: ["agent:in-progress", "needs-human"] });
  const ds = reconcile(snapshot({ issues: [blocked, human] }), DEFAULT_DEADLINES, POLICY);
  assert.deepEqual(repairs(ds), []);
  assert.match(ds[0]!.log, /parked: agent:blocked/);
  assert.match(ds[1]!.log, /parked: needs-human/);
});

test("a held ticket past its stuck deadline is left alone", () => {
  // #185: re-adding `agent:implement` starts an agent, and a person said not to.
  for (const state of ["agent:implement", "agent:in-progress"]) {
    const held = ticket(1, { labels: ["ready-for-agent", state, "hold"], stateSince: minutesAgo(60) });
    const d = only(reconcile(snapshot({ issues: [held] }), DEFAULT_DEADLINES, POLICY));
    assert.equal(d.action.type, "none", state);
    assert.match(d.log, new RegExp(`#1 \\(issue\\) ${state}, deadline 30 min: held: hold$`));
  }
});

test("a held PR is left alone, and so is a PR whose ticket is held", () => {
  // The retry handler keeps a stood-down PR in agent:in-progress. Re-adding
  // agent:review to it would start the reviewer on work a person is holding,
  // whose failure the handler stands down on again, and the second such miss
  // escalates: exactly the needs-human #185 says a hold never reaches.
  const own = pr(11, { labels: ["agent:in-progress", "hold"], stateSince: minutesAgo(60) });
  const viaTicket = pr(12, { labels: ["agent:in-progress"], stateSince: minutesAgo(60), closes: 2 });
  const heldTicket = ticket(2, { labels: ["ready-for-agent", "hold"] });
  const ds = reconcile(snapshot({ issues: [heldTicket], prs: [own, viaTicket] }), DEFAULT_DEADLINES, POLICY);
  assert.deepEqual(repairs(ds), []);
  assert.match(ds.find((d) => d.subject.number === 11)!.log, /#11 \(pr\) agent:in-progress, deadline 30 min: held: hold$/);
  assert.match(ds.find((d) => d.subject.number === 12)!.log, /#12 \(pr\) agent:in-progress, deadline 30 min: held: hold on #2$/);
});

// #210: a hold stops the factory starting work, never a merge. Stopping a
// started ticket is closing its PR.
/** Two factory PRs in the same state: #11 held on its own label, #12 through its ticket, #3. */
const heldPrs = (state: Partial<PrState>): Decision[] =>
  reconcile(
    snapshot({ issues: [ticket(3, { labels: ["ready-for-agent", "hold"] })], prs: [pr(11, { ...state, labels: ["hold"] }), pr(12, { ...state, closes: 3 })] }),
    DEFAULT_DEADLINES,
    POLICY,
  );

test("a held factory PR with auto-merge off, past the stuck deadline, is re-armed", () => {
  const ds = heldPrs({ autoMerge: false, headSince: minutesAgo(45) });
  assert.deepEqual(ds.map((d) => d.action), [{ type: "arm-auto-merge", pr: 11 }, { type: "arm-auto-merge", pr: 12 }]);
});

test("a held factory PR with a passing verdict, behind main past the update deadline, gets an update-branch dispatch", () => {
  assert.deepEqual(heldPrs({ behindBy: 2 }).map((d) => d.action), [
    { type: "dispatch", eventType: "factory-update-branch", pr: 11 },
    { type: "dispatch", eventType: "factory-update-branch", pr: 12 },
  ]);
});

test("the sweep reads a held PR's merge state: only an agent label or a parked one takes a PR off the merge path", () => {
  // The sweep and `decidePrMerge` share this, so the snapshot the two tests above hand in is one the sweep builds.
  assert.equal(onMergePath(["hold"]), true);
  for (const label of ["agent:review", ...PARKED_LABELS]) assert.equal(onMergePath([label]), false, label);
});

test("a held factory PR with no verdict, past the verdict deadline, gets no agent:review, and the log names the hold", () => {
  const ds = heldPrs({ verdict: "none", headSince: minutesAgo(45) });
  assert.deepEqual(repairs(ds), []);
  assert.match(ds[0]!.log, /^#11 \(pr\) auto-merge armed, no factory\/verdict on abcdef1 since .*, deadline 30 min: held: hold$/);
  assert.match(ds[1]!.log, /^#12 \(pr\) .*, deadline 30 min: held: hold on #3$/);
});

test("removing the hold resumes a held subject through the stuck path, on the first sweep after", () => {
  // #185's fifth criterion. Nothing is reconstructed by hand: the start label
  // is still on, so the next sweep past the deadline re-adds it. That deadline
  // runs from when the start label went on, not from when the hold came off,
  // so a subject held for longer than it is resumed by the first sweep after.
  const held = { ticket: ticket(1, { labels: ["ready-for-agent", "agent:implement", "hold"], stateSince: minutesAgo(90) }), pr: pr(11, { labels: ["agent:in-progress", "hold"], stateSince: minutesAgo(90) }) };
  assert.deepEqual(repairs(reconcile(snapshot({ issues: [held.ticket], prs: [held.pr] }), DEFAULT_DEADLINES, POLICY)), []);

  const released = {
    ticket: { ...held.ticket, labels: held.ticket.labels.filter((l) => l !== "hold") },
    pr: { ...held.pr, labels: held.pr.labels.filter((l) => l !== "hold") },
  };
  const [onTicket, onPr] = repairs(reconcile(snapshot({ issues: [released.ticket], prs: [released.pr] }), DEFAULT_DEADLINES, POLICY));
  assert.deepEqual(onTicket!.action, { type: "relabel", remove: ["agent:implement"], add: "agent:implement", miss: 1 });
  assert.deepEqual(onPr!.action, { type: "relabel", remove: ["agent:in-progress"], add: "agent:review", miss: 1 });

  // Held for less than the deadline: released, it still waits for the deadline, as any stuck subject does.
  const brief = { ...released.ticket, stateSince: minutesAgo(5) };
  assert.equal(only(reconcile(snapshot({ issues: [brief] }), DEFAULT_DEADLINES, POLICY)).action.type, "none");
});

test("parked stays the factory's own pair: a hold is left alone without becoming parked", () => {
  // CONTEXT.md's **Parked** is "always the factory's own doing, which is what
  // separates it from a hold", and ADR 0005 has PARKED_LABELS as exactly the
  // pair. The reconciler reads `hold` beside it rather than inside it.
  assert.deepEqual([...PARKED_LABELS], ["agent:blocked", "needs-human"]);
  for (const label of [...PARKED_LABELS, "hold"]) assert.equal(leftAlone(["agent:in-progress", label]), true, label);
  assert.equal(leftAlone(["ready-for-agent", "agent:in-progress", "factory:retry-1"]), false);
});

test("a PR carrying agent:review with no review run past the deadline gets the label again", () => {
  const stuck = pr(11, { labels: ["agent:review"], stateSince: minutesAgo(40) });
  const d = only(reconcile(snapshot({ prs: [stuck] }), DEFAULT_DEADLINES, POLICY));
  assert.deepEqual(d.subject, { kind: "pr", number: 11 });
  assert.deepEqual(d.action, { type: "relabel", remove: ["agent:review"], add: "agent:review", miss: 1 });
  assert.match(d.log, /#11 \(pr\) agent:review since .*no review run: re-add agent:review \(miss 1, re-dispatch 1 of 2\)/);
});

test("a live review run on the PR's head branch covers it; one on another branch does not", () => {
  const stuck = pr(11, { labels: ["agent:review"], stateSince: minutesAgo(40) });
  const mine = run(100, { event: "pull_request_target", headBranch: stuck.headRef, role: "review", status: "in_progress", conclusion: null });
  const other = run(101, { event: "pull_request_target", headBranch: "agent/issue-9-x", role: "review", status: "in_progress", conclusion: null });
  assert.equal(only(reconcile(snapshot({ prs: [stuck], runs: [mine] }), DEFAULT_DEADLINES, POLICY)).action.type, "none");
  assert.equal(only(reconcile(snapshot({ prs: [stuck], runs: [other] }), DEFAULT_DEADLINES, POLICY)).action.type, "relabel");
});

test("a PR's second miss escalates the PR and names the ticket to park with it", () => {
  const stuck = pr(11, { labels: ["agent:review"], stateSince: minutesAgo(40), marks: [{ miss: 1, tries: 1, at: minutesAgo(19) }] });
  const d = only(reconcile(snapshot({ prs: [stuck] }), DEFAULT_DEADLINES, POLICY));
  assert.equal(d.action.type, "escalate");
  // The PR carries no ready-for-agent of its own, so only its agent:* labels go.
  assert.deepEqual(d.action.type === "escalate" && d.action.remove, ["agent:review"]);
  assert.equal(d.action.type === "escalate" && d.action.ticket, 1);
});

test("a PR in agent:in-progress with no live run is sent back to review; a live implement-pr run covers it", () => {
  const stale = pr(11, { labels: ["agent:in-progress"], stateSince: minutesAgo(40) });
  const d = only(reconcile(snapshot({ prs: [stale] }), DEFAULT_DEADLINES, POLICY));
  assert.deepEqual(d.action, { type: "relabel", remove: ["agent:in-progress"], add: "agent:review", miss: 1 });
  const live = run(100, { event: "pull_request_target", headBranch: stale.headRef, role: "implement-pr", status: "in_progress", conclusion: null });
  assert.equal(only(reconcile(snapshot({ prs: [stale], runs: [live] }), DEFAULT_DEADLINES, POLICY)).action.type, "none");
});

test("a PR carrying agent:implement expects an implement-pr run", () => {
  const stuck = pr(11, { labels: ["agent:implement"], stateSince: minutesAgo(40) });
  const d = only(reconcile(snapshot({ prs: [stuck] }), DEFAULT_DEADLINES, POLICY));
  assert.deepEqual(d.action, { type: "relabel", remove: ["agent:implement"], add: "agent:implement", miss: 1 });
});

test("an auto-merge factory PR with no verdict past the deadline gets agent:review", () => {
  const unjudged = pr(11, { verdict: "none", headSince: minutesAgo(45) });
  const d = only(reconcile(snapshot({ prs: [unjudged] }), DEFAULT_DEADLINES, POLICY));
  assert.deepEqual(d.action, { type: "relabel", remove: [], add: "agent:review" });
  assert.match(d.log, /#11 \(pr\) auto-merge armed, no factory\/verdict on abcdef1 since .*45 min ago, deadline 30 min: add agent:review/);
});

test("an unjudged PR within the verdict deadline, or with a pending or failed verdict, is left alone", () => {
  const young = pr(11, { verdict: "none", headSince: minutesAgo(10) });
  const pending = pr(12, { verdict: "pending", headSince: minutesAgo(45) });
  const failed = pr(13, { verdict: "failure", headSince: minutesAgo(45) });
  const ds = reconcile(snapshot({ prs: [young, pending, failed] }), DEFAULT_DEADLINES, POLICY);
  assert.deepEqual(repairs(ds), []);
  assert.match(ds[0]!.log, /within deadline/);
  assert.match(ds[1]!.log, /verdict pending/);
  assert.match(ds[2]!.log, /verdict failure/);
});

test("the merge rules skip a PR carrying an agent label, whoever opened it and armed or not", () => {
  const reviewing = pr(13, { verdict: undefined, headSince: minutesAgo(45), autoMerge: false, labels: ["agent:review"], stateSince: minutesAgo(1) });
  const theirs = unjudged(14, { labels: ["agent:review"], stateSince: minutesAgo(1) });
  const ds = reconcile(snapshot({ prs: [reviewing, theirs] }), DEFAULT_DEADLINES, POLICY);
  assert.deepEqual(repairs(ds), []);
  assert.equal(ds.filter((d) => d.subject.number === 13).length, 1, "only the review-label rule sees #13");
  assert.equal(ds.filter((d) => d.subject.number === 14).length, 1, "only the review-label rule sees #14");
});

test("a PR that is not a factory PR gets agent:review at the verdict deadline, armed or not, and this decision never arms it", () => {
  const unarmed = unjudged(21);
  const armed = unjudged(22, { autoMerge: true });
  const ds = reconcile(snapshot({ prs: [unarmed, armed] }), DEFAULT_DEADLINES, POLICY);
  assert.deepEqual(ds.map((d) => d.action), [
    { type: "relabel", remove: [], add: "agent:review" },
    { type: "relabel", remove: [], add: "agent:review" },
  ]);
  assert.match(ds[0]!.log, /^#21 \(pr\) not a factory PR, no factory\/verdict on abcdef1 since .*45 min ago, deadline 30 min: add agent:review$/);
});

test("a PR that is not a factory PR is left alone within the verdict deadline, and once a verdict is on its head", () => {
  const young = unjudged(21, { headSince: minutesAgo(10) });
  const pending = unjudged(22, { verdict: "pending" });
  const notRead = unjudged(23, { verdict: undefined });
  const ds = reconcile(snapshot({ prs: [young, pending, notRead] }), DEFAULT_DEADLINES, POLICY);
  assert.deepEqual(repairs(ds), []);
  assert.match(ds[0]!.log, /#21 \(pr\) not a factory PR, no factory\/verdict .*deadline 30 min: within deadline/);
  assert.match(ds[1]!.log, /#22 \(pr\) not a factory PR, factory\/verdict pending on abcdef1, deadline 30 min: judged or being judged/);
  assert.match(ds[2]!.log, /#23 \(pr\) not a factory PR, factory\/verdict on abcdef1 not read, deadline 30 min: skip/);
});

// Each reason is a case where labelling would do something the PR's author never
// agreed to (#182), so each is proved on a PR that would otherwise be labelled.
test("a draft is left alone, and the log says so by name", () => {
  const d = only(reconcile(snapshot({ prs: [unjudged(21, { draft: true })] }), DEFAULT_DEADLINES, POLICY));
  assert.deepEqual(d.action, { type: "none" });
  assert.match(d.log, /^#21 \(pr\) not a factory PR, deadline 30 min: left alone \(draft\): /);
});

test("a PR from a fork is left alone rather than labelled for agent-review.yml to refuse, and the log says so by name", () => {
  const d = only(reconcile(snapshot({ prs: [unjudged(21, { fork: true })] }), DEFAULT_DEADLINES, POLICY));
  assert.deepEqual(d.action, { type: "none" });
  assert.match(d.log, /^#21 \(pr\) not a factory PR, deadline 30 min: left alone \(fork\): /);
});

test("a PR closing no ticket is left alone, since its verdict would be a mechanical fail, and the log says so by name", () => {
  const d = only(reconcile(snapshot({ prs: [noTicket(21, { toldNoTicket: true })] }), DEFAULT_DEADLINES, POLICY));
  assert.deepEqual(d.action, { type: "none" });
  assert.match(d.log, /^#21 \(pr\) not a factory PR, deadline 30 min: left alone \(no-ticket\): /);
});

// #230: the one left-alone reason the producer can fix, and the one nobody can
// supply on their behalf, so the sweep says so on the PR instead of only in its log.
test("a PR closing no ticket, not told yet, is told on the PR: what happened and the one thing to do", () => {
  const d = only(reconcile(snapshot({ prs: [noTicket(21, { toldNoTicket: false })] }), DEFAULT_DEADLINES, POLICY));
  assert.deepEqual(d.action, { type: "comment", pr: 21 });
  assert.match(d.log, /^#21 \(pr\) not a factory PR, deadline 30 min: left alone \(no-ticket\): .*: comment$/);
  assert.match(d.comment!, NO_TICKET_MARK);
  assert.match(d.comment!, /Closes #/);
});

test("the other three left-alone reasons comment on nothing, told or not", () => {
  const prs = [
    unjudged(21, { draft: true, toldNoTicket: false }),
    unjudged(22, { fork: true, toldNoTicket: false }),
    unjudged(23, { closes: 5, ticketAuthor: { association: "CONTRIBUTOR", login: "passer-by" }, toldNoTicket: false }),
  ];
  for (const d of reconcile(snapshot({ prs }), DEFAULT_DEADLINES, POLICY)) {
    assert.deepEqual(d.action, { type: "none" });
    assert.equal(d.comment, undefined);
  }
});

test("a second sweep over the same unfixed PR comments nothing, and so does the tenth", () => {
  // The factory's own earlier comment is what `toldNoTicket` reports, so every
  // sweep after the first sees it and stays quiet.
  const told = noTicket(21, { toldNoTicket: true });
  for (let sweep = 0; sweep < 10; sweep++) {
    assert.deepEqual(only(reconcile(snapshot({ prs: [told] }), DEFAULT_DEADLINES, POLICY)).action, { type: "none" });
  }
});

test("a PR whose comments were not read is told nothing: the sweep never comments on a fact it did not read", () => {
  const d = only(reconcile(snapshot({ prs: [noTicket(21, { toldNoTicket: undefined })] }), DEFAULT_DEADLINES, POLICY));
  assert.deepEqual(d.action, { type: "none" });
});

// Faking the marker would switch the factory off on that PR for good, so the
// marker counts only from an author the target's trust policy acts on. The
// factory posts it with FACTORY_PAT, which arrives as the owner, exactly as the
// retry marker does (#52); a stranger on a public target is NONE and is dropped.
test("only the factory's own account suppresses the next comment: nobody else can forge the marker", () => {
  const marked = (login: string, association: string) => ({ body: "<!-- factory:no-ticket -->\nLeft alone", author: { association, login } });
  const chatter = { body: "nice work", author: { association: "OWNER", login: "factory-bot" } };
  assert.equal(toldNoTicketIn([marked("factory-bot", "MEMBER"), chatter], "factory-bot"), true);
  // A stranger, and the two the association alone would have let through: a
  // collaborator on a target that widened its trust policy, and the repo owner.
  for (const forged of [marked("passer-by", "NONE"), marked("collaborator", "COLLABORATOR"), marked("maintainer", "OWNER")]) {
    assert.equal(toldNoTicketIn([forged, chatter], "factory-bot"), false);
  }
  assert.equal(toldNoTicketIn([], "factory-bot"), false);
  // GitHub spells an app's login two ways; the marker is the factory's either way.
  assert.equal(toldNoTicketIn([marked("Factory-Bot[bot]", "NONE")], "factory-bot"), true);
});

test("an unknown factory identity tells nothing: the sweep would not recognise its own comment", () => {
  const d = only(reconcile(snapshot({ prs: [noTicket(21, { toldNoTicket: undefined })] }), DEFAULT_DEADLINES, POLICY));
  assert.deepEqual(d.action, { type: "none" });
  assert.equal(toldNoTicketIn([{ body: "<!-- factory:no-ticket -->", author: { association: "OWNER", login: "maintainer" } }], undefined), true);
});

test("a PR fixed after being told proceeds normally: the earlier comment is no obstacle", () => {
  const fixed = unjudged(21, { closes: 5, toldNoTicket: true, ticketAuthor: { association: "OWNER", login: "owner" } });
  const d = only(reconcile(snapshot({ prs: [fixed] }), DEFAULT_DEADLINES, POLICY));
  assert.deepEqual(d.action, { type: "relabel", remove: [], add: "agent:review" });
});

// #179's definition, not a second one: the trust policy the target configured,
// asked on the ticket-author channel the reviewer and the audit are asked on.
test("a PR whose ticket an untrusted author opened is left alone, and the log says so by name", () => {
  const stranger = unjudged(21, { closes: 5, ticketAuthor: { association: "CONTRIBUTOR", login: "passer-by" } });
  const d = only(reconcile(snapshot({ prs: [stranger] }), DEFAULT_DEADLINES, POLICY));
  assert.deepEqual(d.action, { type: "none" });
  assert.match(d.log, /^#21 \(pr\) not a factory PR, deadline 30 min: left alone \(untrusted-ticket-author\): #5 was opened by CONTRIBUTOR, and the trust policy acts on OWNER$/);
});

test("untrusted-ticket-author is the target's own trust policy: a widened one lets its member's ticket be judged", () => {
  const member = unjudged(21, { ticketAuthor: { association: "MEMBER", login: "colleague" } });
  assert.deepEqual(only(reconcile(snapshot({ prs: [member] }), DEFAULT_DEADLINES, POLICY)).action, { type: "none" });
  assert.deepEqual(only(reconcile(snapshot({ prs: [member] }), DEFAULT_DEADLINES, trustPolicy("OWNER,MEMBER"))).action, { type: "relabel", remove: [], add: "agent:review" });
});

test("a ticket author the sweep could not read is not a trusted one: the PR is left alone, even under a policy that trusts NONE", () => {
  const unread = unjudged(21, { closes: 5, ticketAuthor: undefined });
  for (const policy of [POLICY, trustPolicy("OWNER,NONE")]) {
    const d = only(reconcile(snapshot({ prs: [unread] }), DEFAULT_DEADLINES, policy));
    assert.deepEqual(d.action, { type: "none" });
    assert.match(d.log, /left alone \(untrusted-ticket-author\): #5's author was not read$/);
  }
});

// The regression bar for #182: a factory PR reaches exactly today's decision on every
// branch of the merge rules, whatever the four reasons to leave a PR alone would say.
test("no reason to leave a PR alone reaches a factory PR: every merge rule decides as before, draft, fork, ticketless and untrusted alike", () => {
  const today: [PrState, Decision["action"]][] = [
    [pr(11, { autoMerge: false, verdict: undefined, behindBy: undefined, headSince: minutesAgo(45) }), { type: "arm-auto-merge", pr: 11 }],
    [pr(12, { autoMerge: false, verdict: undefined, behindBy: undefined, headSince: minutesAgo(5) }), { type: "none" }],
    [pr(13, { verdict: "none", headSince: minutesAgo(45) }), { type: "relabel", remove: [], add: "agent:review" }],
    [pr(14, { verdict: "none", headSince: minutesAgo(10) }), { type: "none" }],
    [pr(15, { verdict: undefined }), { type: "none" }],
    [pr(16, { verdict: "pending" }), { type: "none" }],
    [pr(17, { verdict: "failure" }), { type: "none" }],
    [pr(18, { verdict: "success", behindBy: 2 }), { type: "dispatch", eventType: "factory-update-branch", pr: 18 }],
    [pr(19, { verdict: "success", behindBy: 0 }), { type: "none" }],
  ];
  const worst = (p: PrState): PrState => ({ ...p, draft: true, fork: true, closes: undefined, ticketAuthor: { association: "NONE", login: "passer-by" } });
  const before = reconcile(snapshot({ prs: today.map(([p]) => p) }), DEFAULT_DEADLINES, POLICY);
  const after = reconcile(snapshot({ prs: today.map(([p]) => worst(p)) }), DEFAULT_DEADLINES, POLICY);
  assert.deepEqual(before.map((d) => d.action), today.map(([, action]) => action));
  assert.deepEqual(after, before);
  for (const d of after) assert.doesNotMatch(d.log, /left alone|not a factory PR/);
});

// #182 meets #185: labelling starts the reviewer, and a hold is a person saying
// not yet, so the hold is read before any reason to leave a PR alone.
test("a PR that is not a factory PR is left alone as held when its ticket is held, or it is, however judgeable otherwise", () => {
  const viaTicket = unjudged(21, { closes: 5 });
  // The sweep reads nothing more for a PR carrying its own hold (`leftAlone`), so its verdict is unread.
  const own = unjudged(22, { labels: ["hold"], verdict: undefined, headSince: undefined, ticketAuthor: undefined });
  const draftHeld = unjudged(23, { closes: 5, draft: true });
  const ds = reconcile(snapshot({ issues: [ticket(5, { labels: ["ready-for-agent", "hold"] })], prs: [viaTicket, own, draftHeld] }), DEFAULT_DEADLINES, POLICY);
  assert.deepEqual(repairs(ds), []);
  assert.match(ds.find((d) => d.subject.number === 21)!.log, /^#21 \(pr\) not a factory PR, deadline 30 min: held: hold on #5$/);
  assert.match(ds.find((d) => d.subject.number === 22)!.log, /^#22 \(pr\) not a factory PR, deadline 30 min: held: hold$/);
  assert.match(ds.find((d) => d.subject.number === 23)!.log, /: held: hold on #5$/);
  // Released, the same PR is judged at its deadline like any other.
  assert.deepEqual(only(reconcile(snapshot({ issues: [ticket(5, { labels: ["ready-for-agent"] })], prs: [viaTicket] }), DEFAULT_DEADLINES, POLICY)).action, { type: "relabel", remove: [], add: "agent:review" });
});

test("a parked PR that is not a factory PR is never labelled: a tell-author's agent:blocked sticks", () => {
  const told = unjudged(21, { labels: ["agent:blocked"] });
  const escalated = unjudged(22, { labels: ["needs-human"] });
  assert.deepEqual(reconcile(snapshot({ prs: [told, escalated] }), DEFAULT_DEADLINES, POLICY), []);
});

// The update-branch plan skips a PR with no auto-merge forever (plan.test.ts covers that
// skip). The re-arm is what makes the skip temporary for a factory PR.
test("a factory PR with auto-merge not enabled past the deadline is re-armed", () => {
  const unarmed = pr(11, { autoMerge: false, verdict: undefined, behindBy: undefined, headSince: minutesAgo(45) });
  const d = only(reconcile(snapshot({ prs: [unarmed] }), DEFAULT_DEADLINES, POLICY));
  assert.deepEqual(d.action, { type: "arm-auto-merge", pr: 11 });
  assert.match(d.log, /#11 \(pr\) factory PR with auto-merge not enabled since .*45 min ago, deadline 30 min: re-arm auto-merge/);
  assert.equal(d.log.split("\n").length, 1);
});

test("a factory PR whose auto-merge is still within the deadline is left alone, and an armed one is not re-armed", () => {
  const young = pr(11, { autoMerge: false, verdict: undefined, behindBy: undefined, headSince: minutesAgo(5) });
  const armed = pr(12, { verdict: "success", behindBy: 0 });
  const ds = reconcile(snapshot({ prs: [young, armed] }), DEFAULT_DEADLINES, POLICY);
  assert.deepEqual(repairs(ds), []);
  assert.match(ds[0]!.log, /auto-merge not enabled since .*5 min ago, deadline 30 min: within deadline/);
});

test("a parked factory PR is not re-armed: needs-human means a maintainer owns it", () => {
  const parked = pr(11, { autoMerge: false, labels: ["needs-human"], verdict: undefined, headSince: minutesAgo(45) });
  assert.deepEqual(repairs(reconcile(snapshot({ prs: [parked] }), DEFAULT_DEADLINES, POLICY)), []);
});

test("a merge-ready PR behind main with no update-branch run in the window gets one dispatched", () => {
  const stale = pr(11, { verdict: "success", behindBy: 2 });
  const d = only(reconcile(snapshot({ prs: [stale] }), DEFAULT_DEADLINES, POLICY));
  assert.deepEqual(d.action, { type: "dispatch", eventType: "factory-update-branch", pr: 11 });
  assert.match(d.log, /#11 \(pr\) 2 behind main with factory\/verdict success, deadline 30 min, no update-branch run in the window: dispatch factory-update-branch/);
});

test("a recent or live update-branch run (push to main, or the review's dispatch) covers a stale PR", () => {
  const stale = pr(11, { verdict: "success", behindBy: 2 });
  const push = run(100, { event: "push", headBranch: "main", title: "merge something", role: undefined, createdAt: minutesAgo(5) });
  const dispatched = run(101, { event: "repository_dispatch", title: "factory-update-branch", role: undefined, status: "in_progress", conclusion: null, createdAt: minutesAgo(90) });
  const old = run(102, { event: "push", headBranch: "main", role: undefined, createdAt: minutesAgo(40) });
  assert.equal(only(reconcile(snapshot({ prs: [stale], runs: [push] }), DEFAULT_DEADLINES, POLICY)).action.type, "none");
  assert.equal(only(reconcile(snapshot({ prs: [stale], runs: [dispatched] }), DEFAULT_DEADLINES, POLICY)).action.type, "none");
  assert.equal(only(reconcile(snapshot({ prs: [stale], runs: [old] }), DEFAULT_DEADLINES, POLICY)).action.type, "dispatch");
});

test("every decision names its subject, state, deadline, and action in one log line", () => {
  const ds = reconcile(
    snapshot({
      issues: [ticket(1)],
      prs: [pr(11, { labels: ["agent:review"], stateSince: minutesAgo(1) }), pr(12, { verdict: "none", headSince: minutesAgo(45) })],
    }),
    DEFAULT_DEADLINES,
    POLICY,
  );
  assert.equal(ds.length, 3);
  for (const d of ds) {
    assert.match(d.log, /^#\d+ \((issue|pr)\) .*deadline \d+ min.*: /);
    assert.equal(d.log.split("\n").length, 1);
  }
});

test("runsFor matches issues runs by title and pull_request_target runs by head branch", () => {
  const runs = [
    run(1, { event: "issues", title: "Ticket 1" }),
    run(2, { event: "issues", title: "Ticket 1 " }),
    run(3, { event: "pull_request_target", headBranch: "agent/issue-1-thing", title: "Fix #1: thing" }),
    run(4, { event: "pull_request", headBranch: "agent/issue-1-thing", title: "Fix #1: thing" }),
  ];
  assert.deepEqual(runsFor({ kind: "issue", title: "Ticket 1" }, runs).map((r) => r.id), [1, 2]);
  assert.deepEqual(runsFor({ kind: "pr", headRef: "agent/issue-1-thing" }, runs).map((r) => r.id), [3]);
});

test("roleFromJobs reads the called job's name and ignores skipped caller jobs", () => {
  assert.equal(roleFromJobs([{ name: "implement / retry", conclusion: "success" }, { name: "implement / implement", conclusion: null }, { name: "dispatch", conclusion: "skipped" }]), "implement");
  assert.equal(roleFromJobs([{ name: "review / refuse-fork", conclusion: "success" }, { name: "review / review", conclusion: "success" }]), "review");
  assert.equal(roleFromJobs([{ name: "implement-pr / implement-pr", conclusion: "cancelled" }]), "implement-pr");
  assert.equal(roleFromJobs([{ name: "dispatch / dispatch", conclusion: "success" }, { name: "implement", conclusion: "skipped" }]), "dispatch");
  assert.equal(roleFromJobs([{ name: "implement", conclusion: "skipped" }, { name: "review", conclusion: "skipped" }]), "none");
  assert.equal(roleFromJobs([{ name: "update-branch / update", conclusion: "success" }]), "update-branch");
});

test("runFromGitHub maps the REST run shape", () => {
  assert.deepEqual(
    runFromGitHub({ id: 5, event: "pull_request_target", display_title: "Fix #1", head_branch: "agent/x", status: "queued", conclusion: null, created_at: "2026-09-07T19:00:00Z", updated_at: "2026-09-07T19:01:00Z" }),
    { id: 5, event: "pull_request_target", title: "Fix #1", headBranch: "agent/x", status: "queued", conclusion: null, createdAt: "2026-09-07T19:00:00Z", updatedAt: "2026-09-07T19:01:00Z" },
  );
});

test("ticketFromGitHub and prFromGitHub map the tracker shapes and detect factory PRs", () => {
  assert.deepEqual(ticketFromGitHub({ number: 3, title: "T", labels: [{ name: "agent:implement" }] }), { number: 3, title: "T", labels: ["agent:implement"], stateSince: undefined, marks: [] });
  const raw = {
    number: 11, title: "Fix #3: T", headRefName: "agent/issue-3-t", headRefOid: "abc", labels: [{ name: "agent:review" }],
    autoMergeRequest: { mergeMethod: "SQUASH" }, body: "Closes #3\n\nImplemented by the software factory. Run: x",
  };
  const mapped = prFromGitHub(raw);
  assert.equal(mapped.autoMerge, true);
  assert.equal(mapped.factory, true);
  assert.equal(mapped.closes, 3);
  assert.equal(prFromGitHub({ ...raw, headRefName: "feature/x", body: "hand made", autoMergeRequest: null }).factory, false);
  assert.equal(prFromGitHub({ ...raw, headRefName: "feature/x", body: "hand made", autoMergeRequest: null }).autoMerge, false);
  // A human opened it and implement-pr worked on it; the reviewer's verdict section is the record.
  const worked = { ...raw, headRefName: "maintainer/flaky-login", body: "Fixes it.\n\n<!-- factory:verdict -->\n## Verdict: pass\n<!-- /factory:verdict -->" };
  assert.equal(prFromGitHub(worked).factory, true);
});

test("prFromGitHub reads the draft and fork facts, and a payload missing either reads as the one left alone", () => {
  const raw = { number: 21, title: "Tidy", headRefName: "someone/tidy", headRefOid: "abc", labels: [], autoMergeRequest: null, body: "Closes #5" };
  const ready = prFromGitHub({ ...raw, isDraft: false, isCrossRepository: false });
  assert.equal(ready.draft, false);
  assert.equal(ready.fork, false);
  assert.equal(prFromGitHub({ ...raw, isDraft: true, isCrossRepository: false }).draft, true);
  assert.equal(prFromGitHub({ ...raw, isDraft: false, isCrossRepository: true }).fork, true);
  const unread = prFromGitHub(raw);
  assert.equal(unread.draft, true);
  assert.equal(unread.fork, true);
  assert.equal(unread.ticketAuthor, undefined);
});

test("stateSinceFromTimeline finds the latest labeled event; marksFromTimeline reads sweep comments", () => {
  const timeline = [
    { event: "labeled", label: { name: "agent:implement" }, created_at: "2026-09-07T10:00:00Z" },
    { event: "unlabeled", label: { name: "agent:implement" }, created_at: "2026-09-07T10:01:00Z" },
    { event: "commented", body: "<!-- factory:sweep miss=1 -->\nReconciler: ...", created_at: "2026-09-07T10:02:00Z" },
    { event: "commented", body: "just a comment", created_at: "2026-09-07T10:03:00Z" },
    { event: "labeled", label: { name: "agent:implement" }, created_at: "2026-09-07T11:00:00Z" },
  ];
  assert.equal(stateSinceFromTimeline(timeline, "agent:implement"), "2026-09-07T11:00:00Z");
  assert.equal(stateSinceFromTimeline(timeline, "agent:review"), undefined);
  assert.deepEqual(marksFromTimeline(timeline), [{ miss: 1, tries: 1, at: "2026-09-07T10:02:00Z" }]);
});
