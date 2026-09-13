/**
 * The sweep driven through its needs-record with an in-memory target repo and
 * no network, in the style of `heartbeat.test.ts` (`sendHeartbeat` with fakes
 * for `readPause`, `readOpenWork`, `wake`, `report` and `now`). The reconciler
 * decides what to do; this proves the sweep carries those decisions out: the
 * labels, comments, dispatches and re-arms it writes, and that a read allowed
 * to fail softly leaves the subject alone rather than aborting.
 *
 * What the reconciler decides is `reconcile.test.ts`'s subject and is not
 * re-checked here; these are the writes those decisions produce, and the reads
 * the sweep chooses to make on the way.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { GhError } from "../lib/gh.ts";
import { type Author, trustPolicy } from "../lib/trusted-authors.ts";
import {
  DEFAULT_DEADLINES,
  type PrComment,
  type PrState,
  type Run,
  type Subject,
  type TicketState,
  type VerdictState,
} from "./reconcile.ts";
import { type Needs, type OpenPr, type SweepConfig, sweep } from "./sweep.ts";

const NOW = "2026-09-12T20:00:00Z";
const minutesAgo = (m: number): string => new Date(Date.parse(NOW) - m * 60_000).toISOString();

/** What one recorded write was, so a test asserts on what the sweep wrote and never on a `gh` command. */
type Recorded =
  | { op: "addLabel"; subject: Subject; label: string }
  | { op: "removeLabel"; subject: Subject; label: string }
  | { op: "comment"; subject: Subject; body: string }
  | { op: "dispatch"; eventType: string; pr: number }
  | { op: "armAutoMerge"; pr: number };

/** An in-memory target repo: the reads a test prepares, and every write recorded rather than sent. */
const inMemory = (
  overrides: Partial<Needs> = {},
): { needs: Needs; writes: Recorded[] } => {
  const writes: Recorded[] = [];
  const needs: Needs = {
    openTickets: () => [],
    openPrs: () => [],
    recentRuns: () => [],
    jobs: () => [],
    verdict: () => "none",
    commitDate: () => "",
    behindBy: () => 0,
    ticketAuthor: () => ({ association: "OWNER", login: "owner" }),
    prComments: () => [],
    factoryLogin: () => "factory-bot",
    currentLabels: () => [],
    addLabel: (subject, label) => writes.push({ op: "addLabel", subject, label }),
    removeLabel: (subject, label) => writes.push({ op: "removeLabel", subject, label }),
    comment: (subject, body) => writes.push({ op: "comment", subject, body }),
    dispatch: (eventType, pr) => writes.push({ op: "dispatch", eventType, pr }),
    armAutoMerge: (pr) => writes.push({ op: "armAutoMerge", pr }),
    ...overrides,
  };
  return { needs, writes };
};

const config = (overrides: Partial<SweepConfig> = {}): SweepConfig => ({
  repo: "owner/repo",
  base: "main",
  deadlines: DEFAULT_DEADLINES,
  policy: trustPolicy(undefined),
  now: new Date(NOW),
  dryRun: false,
  runUrl: undefined,
  ...overrides,
});

const ticket = (number: number, overrides: Partial<TicketState> = {}): TicketState => ({
  number,
  title: `Ticket ${number}`,
  labels: ["ready-for-agent", "agent:in-progress"],
  stateSince: minutesAgo(40),
  marks: [],
  ...overrides,
});

/** A PR as `openPrs` hands it out: label state resolved, merge state (verdict, headSince, ...) still unread. */
const openPr = (number: number, pr: Partial<PrState> = {}, createdAt = minutesAgo(60)): OpenPr => ({
  createdAt,
  pr: {
    number,
    title: `Fix #${number - 10}`,
    headRef: `agent/issue-${number - 10}`,
    headSha: "abcdef1234567890",
    labels: [],
    autoMerge: false,
    factory: false,
    closes: undefined,
    draft: false,
    fork: false,
    stateSince: undefined,
    marks: [],
    ...pr,
  },
});

const run = (id: number, overrides: Partial<Run> = {}): Run => ({
  id,
  event: "issues",
  title: "Ticket 1",
  headBranch: "main",
  status: "completed",
  conclusion: "success",
  createdAt: minutesAgo(10),
  updatedAt: minutesAgo(10),
  role: undefined,
  ...overrides,
});

const throws = (): never => {
  throw new GhError(["api", "some/read"], new Error("HTTP 403: Resource not accessible by personal access token"));
};

/* Writer scenarios: the reconciler decides, the sweep writes (acceptance criterion 4). */

test("a stuck ticket: the state label is removed and re-added, and the miss is recorded on the ticket", () => {
  const { needs, writes } = inMemory({ openTickets: () => [ticket(1)] });
  const result = sweep(needs, config());
  assert.equal(result.aborted, undefined);
  assert.deepEqual(writes, [
    { op: "removeLabel", subject: { kind: "issue", number: 1 }, label: "agent:in-progress" },
    { op: "addLabel", subject: { kind: "issue", number: 1 }, label: "agent:implement" },
    writes.find((w) => w.op === "comment")!,
  ]);
  const comment = writes.find((w) => w.op === "comment")!;
  assert.equal(comment.op === "comment" && comment.subject.number, 1);
  assert.match(comment.op === "comment" ? comment.body : "", /^<!-- factory:sweep miss=1 tries=1 -->/);
});

test("a stuck PR: the review label is removed and re-added on the PR", () => {
  const stuck = openPr(11, { labels: ["agent:review"], stateSince: minutesAgo(40) });
  const { needs, writes } = inMemory({ openPrs: () => [stuck] });
  sweep(needs, config());
  assert.deepEqual(
    writes.filter((w) => w.op !== "comment"),
    [
      { op: "removeLabel", subject: { kind: "pr", number: 11 }, label: "agent:review" },
      { op: "addLabel", subject: { kind: "pr", number: 11 }, label: "agent:review" },
    ],
  );
});

test("an escalation on a PR parks the ticket it closes, on the ticket's current labels read at apply time", () => {
  const stuck = openPr(11, {
    labels: ["agent:review"],
    stateSince: minutesAgo(40),
    marks: [{ miss: 1, tries: 1, at: minutesAgo(19) }],
    closes: 1,
  });
  // The ticket's labels are read at apply time, not taken from the snapshot (#50).
  const { needs, writes } = inMemory({ openPrs: () => [stuck], currentLabels: () => ["ready-for-agent"] });
  sweep(needs, config());
  const labelWrites = writes.filter((w) => w.op === "addLabel" || w.op === "removeLabel");
  assert.deepEqual(labelWrites, [
    { op: "removeLabel", subject: { kind: "pr", number: 11 }, label: "agent:review" },
    { op: "addLabel", subject: { kind: "pr", number: 11 }, label: "needs-human" },
    { op: "removeLabel", subject: { kind: "issue", number: 1 }, label: "ready-for-agent" },
    { op: "addLabel", subject: { kind: "issue", number: 1 }, label: "needs-human" },
  ]);
  // A comment on the PR and one on the parked ticket.
  assert.deepEqual(
    writes.filter((w) => w.op === "comment").map((w) => (w.op === "comment" ? w.subject : null)),
    [{ kind: "pr", number: 11 }, { kind: "issue", number: 1 }],
  );
});

test("an unjudged PR past the verdict deadline gets agent:review, after reading its ticket's author and its head's verdict", () => {
  const reads: string[] = [];
  const unjudged = openPr(21, { closes: 5 }, minutesAgo(45));
  const { needs, writes } = inMemory({
    openPrs: () => [unjudged],
    ticketAuthor: (t) => {
      reads.push(`ticketAuthor:${t}`);
      return { association: "OWNER", login: "maintainer" };
    },
    verdict: (sha) => {
      reads.push(`verdict:${sha.slice(0, 7)}`);
      return "none";
    },
  });
  sweep(needs, config());
  assert.deepEqual(reads, ["ticketAuthor:5", "verdict:abcdef1"]);
  assert.deepEqual(writes, [{ op: "addLabel", subject: { kind: "pr", number: 21 }, label: "agent:review" }]);
});

test("a merge-ready PR behind main is sent an update-branch dispatch", () => {
  const ready = openPr(11, { factory: true, autoMerge: true }, minutesAgo(60));
  const { needs, writes } = inMemory({
    openPrs: () => [ready],
    verdict: () => "success" as VerdictState,
    behindBy: () => 2,
  });
  sweep(needs, config());
  assert.deepEqual(writes, [{ op: "dispatch", eventType: "factory-update-branch", pr: 11 }]);
});

test("a factory PR with auto-merge off past the deadline is re-armed", () => {
  const unarmed = openPr(11, { factory: true, autoMerge: false }, minutesAgo(45));
  const { needs, writes } = inMemory({ openPrs: () => [unarmed] });
  sweep(needs, config());
  assert.deepEqual(writes, [{ op: "armAutoMerge", pr: 11 }]);
});

test("a left-alone PR is decided without a single costly read (frugality, #302)", () => {
  // The reconciler drives the reads, and it reaches a costly one only past the
  // branches that would leave a PR alone. A draft PR and one carrying an agent
  // label are each decided with no verdict, behind-by, commit-date or author read.
  const reads: string[] = [];
  const draft = openPr(21, { closes: 5, draft: true }, minutesAgo(45));
  const labeled = openPr(31, { labels: ["agent:review"], stateSince: minutesAgo(1) }, minutesAgo(45));
  const { needs, writes } = inMemory({
    openPrs: () => [draft, labeled],
    verdict: (sha) => (reads.push(`verdict:${sha.slice(0, 7)}`), "none" as VerdictState),
    behindBy: () => (reads.push("behindBy"), 0),
    commitDate: () => (reads.push("commitDate"), ""),
    ticketAuthor: () => (reads.push("ticketAuthor"), { association: "OWNER", login: "owner" }),
  });
  const result = sweep(needs, config());
  assert.equal(result.aborted, undefined);
  assert.deepEqual(reads, []);
  assert.deepEqual(writes, []);
});

test("a dry run decides but writes nothing", () => {
  const { needs, writes } = inMemory({ openTickets: () => [ticket(1)] });
  const result = sweep(needs, config({ dryRun: true }));
  assert.equal(writes.length, 0);
  // It still decided: the repair is in the result, it was simply not applied.
  assert.equal(result.decisions.filter((d) => d.action.type !== "none").length, 1);
});

/* Soft-fail scenarios: each read the sweep allows to fail leaves the subject alone (acceptance criterion 3). */

test("a ticket author that cannot be read leaves the PR alone rather than aborting the sweep", () => {
  const unjudged = openPr(21, { closes: 5 }, minutesAgo(45));
  const { needs, writes } = inMemory({ openPrs: () => [unjudged], ticketAuthor: throws });
  const result = sweep(needs, config());
  assert.equal(result.aborted, undefined);
  assert.equal(result.failed.length, 0);
  assert.deepEqual(writes, []);
});

test("a run whose jobs cannot be read counts as covering while live, so the ticket is left alone", () => {
  const live = run(100, { status: "in_progress", conclusion: null, title: "Ticket 1", createdAt: minutesAgo(25) });
  const { needs, writes } = inMemory({
    openTickets: () => [ticket(1)],
    recentRuns: () => [live],
    jobs: throws,
  });
  const result = sweep(needs, config());
  assert.equal(result.aborted, undefined);
  assert.deepEqual(writes, []);
});

test("a PR whose comments cannot be read is told nothing, so a ticketless PR gets no comment", () => {
  const noTicket = openPr(21, { closes: undefined }, minutesAgo(45));
  const { needs, writes } = inMemory({ openPrs: () => [noTicket], prComments: throws });
  const result = sweep(needs, config());
  assert.equal(result.aborted, undefined);
  assert.deepEqual(writes, []);
});

test("a factory login that cannot be read leaves the sweep unable to recognise its own marker, so it stays silent", () => {
  const noTicket = openPr(21, { closes: undefined }, minutesAgo(45));
  const { needs, writes } = inMemory({
    openPrs: () => [noTicket],
    prComments: () => [{ body: "<!-- factory:no-ticket -->", author: { association: "OWNER", login: "someone" } } as PrComment],
    factoryLogin: throws,
  });
  const result = sweep(needs, config());
  assert.equal(result.aborted, undefined);
  assert.deepEqual(writes, []);
});
