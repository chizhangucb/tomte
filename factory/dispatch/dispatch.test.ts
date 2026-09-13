/**
 * The dispatcher driven through its needs-record with an in-memory target repo
 * and no network, in the style of `sweep.test.ts` and `heartbeat.test.ts`.
 * `select.ts` decides which tickets are dispatchable; this proves the dispatcher
 * carries that decision out: the label it adds, the one comment it posts, the
 * ticket it re-reads and skips when the listing went stale, and that a dry run
 * writes nothing.
 *
 * What `select.ts` decides is `select.test.ts`'s subject and is not re-checked
 * here; these are the writes those decisions produce and the reads the
 * dispatcher makes on the way. It asserts on what the dispatcher wrote back
 * (labels, comments), never on which `gh` command would have run.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { type Subject } from "./reconcile.ts";
import {
  DISPATCH_LABEL,
  type DispatchIssue,
  NO_CRITERIA_REASON,
  noCriteriaComment,
} from "./select.ts";
import { type DispatchConfig, type DispatchNeeds, dispatch } from "./dispatch.ts";
import { trustPolicy } from "../lib/trusted-authors.ts";

/** The shape a ticket has to have to be dispatched at all: a checklist under the heading. */
const CRITERIA = "## Acceptance criteria\n\n- [ ] the thing works\n";

/** What one recorded write was, so a test asserts on what the dispatcher wrote and never on a `gh` command. */
type Recorded =
  | { op: "addLabel"; subject: Subject; label: string }
  | { op: "comment"; subject: Subject; body: string };

/** An in-memory target repo: the reads a test prepares, and every write recorded rather than sent. */
const inMemory = (
  overrides: Partial<DispatchNeeds> = {},
): { needs: DispatchNeeds; writes: Recorded[] } => {
  const writes: Recorded[] = [];
  const needs: DispatchNeeds = {
    openIssues: () => [],
    openPrs: () => [],
    readIssue: () => undefined,
    comments: () => [],
    addLabel: (subject, label) => writes.push({ op: "addLabel", subject, label }),
    comment: (subject, body) => writes.push({ op: "comment", subject, body }),
    ...overrides,
  };
  return { needs, writes };
};

const config = (overrides: Partial<DispatchConfig> = {}): DispatchConfig => ({
  repo: "owner/repo",
  policy: trustPolicy("OWNER"),
  dryRun: false,
  ...overrides,
});

const ticket = (number: number, overrides: Partial<DispatchIssue> = {}): DispatchIssue => ({
  number,
  title: "A leaf ticket",
  body: CRITERIA,
  labels: ["ready-for-agent"],
  assigned: false,
  openBlockers: 0,
  hasOpenPr: false,
  authorAssociation: "OWNER",
  ...overrides,
});

const issue = (number: number): Subject => ({ kind: "issue", number });

test("a dispatchable ticket is labeled agent:implement, once its re-read confirms it", () => {
  const { needs, writes } = inMemory({ openIssues: () => [ticket(1)], readIssue: () => ticket(1) });
  const result = dispatch(needs, config());
  assert.deepEqual(writes, [{ op: "addLabel", subject: issue(1), label: DISPATCH_LABEL }]);
  assert.deepEqual(result.labeled, [1]);
  assert.deepEqual(result.dispatched, [1]);
});

test("a ticket that changed between the listing and the re-read is skipped, not labeled", () => {
  // The listing is eventually consistent (#19): dispatchable when listed, closed
  // by the time it is re-read right before labeling. The re-read is what counts.
  const { needs, writes } = inMemory({
    openIssues: () => [ticket(1)],
    readIssue: () => ticket(1, { state: "closed" }),
  });
  const result = dispatch(needs, config());
  assert.deepEqual(writes, []);
  assert.deepEqual(result.labeled, []);
  assert.deepEqual(result.skipped, [{ number: 1, reason: "closed since the snapshot" }]);
});

test("a ticket with no acceptance criteria is commented on once", () => {
  const unshaped = ticket(1, { body: "## What to build\n\nMake it good.\n" });
  const { needs, writes } = inMemory({
    openIssues: () => [unshaped],
    readIssue: () => unshaped,
    comments: () => [],
  });
  const result = dispatch(needs, config());
  assert.deepEqual(writes, [{ op: "comment", subject: issue(1), body: noCriteriaComment() }]);
  // Held, not dispatched: no label goes on.
  assert.deepEqual(result.labeled, []);
  assert.deepEqual(result.dispatched, []);
});

test("the no-criteria ticket is silent the second time: the marker on it stops the next comment", () => {
  const unshaped = ticket(1, { body: "## What to build\n\nMake it good.\n" });
  const { needs, writes } = inMemory({
    openIssues: () => [unshaped],
    readIssue: () => unshaped,
    // The comment the last sweep posted is already on the ticket.
    comments: () => [{ body: noCriteriaComment() }],
  });
  dispatch(needs, config());
  assert.deepEqual(writes, []);
});

test("a dry run selects but writes nothing", () => {
  const shaped = ticket(1);
  const unshaped = ticket(2, { body: "no criteria here" });
  const { needs, writes } = inMemory({
    openIssues: () => [shaped, unshaped],
    readIssue: (n) => (n === 1 ? shaped : unshaped),
  });
  const result = dispatch(needs, config({ dryRun: true }));
  assert.deepEqual(writes, []);
  // It still selected: the dispatchable ticket is in the result, it was simply not labeled.
  assert.deepEqual(result.dispatched, [1]);
  assert.equal(NO_CRITERIA_REASON, "no acceptance criteria");
});
