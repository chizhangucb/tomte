/**
 * Which open subjects mean a target has something waiting (#212), which of
 * those a sweep would act on this pass (#264), and the one read that answers
 * both.
 *
 * The clock is driven and never waited on: a subject is placed at an age and
 * the pass is placed at a time, so what is due is read off arithmetic rather
 * than off the machine's own clock.
 *
 * The label sets are imported, never quoted: a test that spelled `hold` here
 * would pass while the heartbeat and the reconciler disagreed. Same tie, same
 * reason as `dispatch/triggers.test.ts` pinning the caller's prefixes to
 * `lib/labels.ts`.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

import { PROJECTIONS } from "../dispatch/gh-read.ts";
import { DEFAULT_DEADLINES } from "../dispatch/reconcile.ts";
import { FACTORY_STATE_LABELS } from "../dispatch/select.ts";
import { HOLD_LABELS, IMPLEMENT_LABEL, PARKED_LABELS, READY_LABEL } from "../lib/labels.ts";
import { HEARTBEAT_INTERVAL_MINUTES } from "./interval.ts";
import { type OpenSubject, fromGitHub, openWorkArgs, sweepNeed } from "./work.ts";

/**
 * The pass's clock. Every subject is placed against it rather than against the
 * real time, because what is due (#264) is a question about when the subject
 * last changed.
 */
const NOW = new Date("2026-09-12T12:00:00Z");

/** The same subject, last changed this many minutes before the pass. */
const changed = (minutes: number, subject: OpenSubject): OpenSubject => ({
  ...subject,
  changedAt: new Date(NOW.getTime() - minutes * 60_000).toISOString(),
});

/**
 * An open ticket carrying these labels, changed just before the pass, so the
 * label rules are read on a subject that is due either way. What is due has its
 * own section below.
 */
const ticket = (...labels: string[]): OpenSubject => changed(0, { pullRequest: false, labels });
const pullRequest = (...labels: string[]): OpenSubject => changed(0, { pullRequest: true, labels });

/**
 * A subject nothing has touched since well past every deadline, which is the
 * measured shape: open work a sweep has already done everything it can for.
 */
const settled = (subject: OpenSubject): OpenSubject => changed(90, subject);

test("the read is one paginated GET, projected as the sweep's own issue read", () => {
  const args = openWorkArgs("owner/repo");
  // No `--method`, so the read cannot be the thing that starts a job on the
  // target it is asking about.
  assert.ok(!args.includes("--method"), "the read writes nothing");
  assert.deepEqual(args, ["api", "--paginate", "repos/owner/repo/issues?state=open&per_page=100", "--jq", PROJECTIONS.issues]);
});

test("a projected item becomes the subject the rules read, pull requests included", () => {
  // The shape `PROJECTIONS.issues` prints, one line per item.
  const raw = [
    { number: 7, title: "a ticket", pull_request: false, labels: [{ name: READY_LABEL }], updated_at: "2026-09-12T11:00:00Z" },
    { number: 8, title: "a PR", pull_request: true, labels: [], updated_at: "2026-09-12T11:30:00Z" },
  ];
  assert.deepEqual(fromGitHub(raw), [
    { pullRequest: false, labels: [READY_LABEL], changedAt: "2026-09-12T11:00:00Z" },
    { pullRequest: true, labels: [], changedAt: "2026-09-12T11:30:00Z" },
  ]);
});

test("GitHub's own shape reads the same, where the flag is an object rather than a boolean", () => {
  // Unprojected, `pull_request` is an object of URLs. Read against `true` it
  // would make every pull request a ticket, and a target whose only open work
  // is one would be skipped.
  const raw = [{ number: 8, title: "a PR", pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/8" }, labels: [] }];
  // No `updated_at` either, which is the other half of an unprojected read: a
  // subject whose clock was not read is due rather than skipped.
  assert.deepEqual(fromGitHub(raw), [{ pullRequest: true, labels: [], changedAt: undefined }]);
});

test("nothing open is nothing waiting", () => {
  assert.equal(sweepNeed([], NOW), "nothing-waiting");
});

test("a ready ticket is work, and every label that holds one takes it back off", () => {
  assert.equal(sweepNeed([ticket(READY_LABEL)], NOW), "waiting");
  for (const held of HOLD_LABELS) {
    assert.equal(sweepNeed([ticket(READY_LABEL, held)], NOW), "nothing-waiting", `${held} holds the ticket, so there is nothing to start`);
  }
});

test("a ticket in a factory state label is work, unless the factory has parked it", () => {
  for (const state of FACTORY_STATE_LABELS) {
    const parked = PARKED_LABELS.some((label) => label === state);
    assert.equal(sweepNeed([ticket(state)], NOW), parked ? "nothing-waiting" : "waiting", `${state} on a ticket`);
  }
});

test("a hold takes a ticket back off whatever state label it carries", () => {
  // The reconciler leaves a held ticket alone at every deadline and the
  // dispatcher skips it as held, so a target whose only open subject is one has
  // nothing waiting. Reading the hold against the ready label alone woke it
  // every interval for a ticket no sweep repairs.
  for (const state of FACTORY_STATE_LABELS) {
    for (const held of HOLD_LABELS) assert.equal(sweepNeed([ticket(state, held)], NOW), "nothing-waiting", `${held} beside ${state}`);
  }
});

test("a hold on a pull request leaves it work, since it never withholds the merge path", () => {
  // #210: the reconciler still re-arms auto-merge on a held PR and still brings
  // a stale one up to date, so skipping it would strand the merge.
  for (const held of HOLD_LABELS) assert.equal(sweepNeed([pullRequest(held)], NOW), "waiting", `${held} on a PR`);
});

test("any open pull request is work, whoever produced it, unless it is parked", () => {
  // No factory label on it at all: the reconciler asks for a verdict on an
  // unjudged PR from any producer, so a target whose only open work is
  // somebody else's PR is still swept.
  assert.equal(sweepNeed([pullRequest()], NOW), "waiting");
  for (const label of PARKED_LABELS) assert.equal(sweepNeed([pullRequest(label)], NOW), "nothing-waiting", `${label} on a PR`);
});

test("a parked ticket is nothing waiting even while a human's ready label is still on it", () => {
  // `agent:blocked` takes nothing off (ADR 0005), so a blocked ticket keeps
  // `ready-for-agent`. Reading the ready rule without the parked one would wake
  // the target every interval for a subject no sweep repairs.
  for (const label of PARKED_LABELS) assert.equal(sweepNeed([ticket(READY_LABEL, label)], NOW), "nothing-waiting", `${label} beside ${READY_LABEL}`);
});

test("one subject waiting is enough, whatever else is open", () => {
  assert.equal(sweepNeed([ticket(), ticket(READY_LABEL, ...HOLD_LABELS), ticket(READY_LABEL)], NOW), "waiting");
  assert.equal(sweepNeed([ticket(), ticket(READY_LABEL, ...HOLD_LABELS)], NOW), "nothing-waiting");
});

test("the rules name no label of their own", () => {
  // The sets come from the factory's definitions or they drift. A label spelled
  // here is that drift, whatever the tests above say today.
  const source = fs.readFileSync(new URL("./work.ts", import.meta.url), "utf8");
  for (const label of [READY_LABEL, ...HOLD_LABELS, ...PARKED_LABELS, ...FACTORY_STATE_LABELS]) {
    assert.doesNotMatch(source, new RegExp(`["'\`]${label.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), `${label} is quoted in work.ts rather than imported`);
  }
});

test("a ticket the factory holds, open and unchanged long past every deadline, is not waiting", () => {
  // The measured shape: one subject sitting open for hours, swept every pass,
  // with nothing for the sweep to do since the first one.
  assert.equal(sweepNeed([changed(90, ticket(IMPLEMENT_LABEL))], NOW), "nothing-due");
});

test("a subject that crosses a deadline is waiting on the first pass after it, so no repair is lost", () => {
  // The clock is driven, never waited on: the subject changed once and the
  // passes walk forward from it.
  const changedAt = new Date(NOW.getTime() - 60 * 60_000).toISOString();
  const at = (minutes: number): Date => new Date(Date.parse(changedAt) + minutes * 60_000);
  const ticketSubject: OpenSubject = { pullRequest: false, labels: [IMPLEMENT_LABEL], changedAt };
  const prSubject: OpenSubject = { pullRequest: true, labels: [], changedAt };
  // Every deadline the reconciler has, whichever kind of subject it judges by
  // it, so a deadline added to the set is covered here without an edit.
  for (const [name, deadline] of Object.entries(DEFAULT_DEADLINES)) {
    const subject = deadline === DEFAULT_DEADLINES.stuckMinutes ? ticketSubject : prSubject;
    assert.equal(sweepNeed([subject], at(deadline)), "waiting", `${name} falls at ${deadline}, and that pass is the repair's`);
    assert.equal(sweepNeed([subject], at(deadline + HEARTBEAT_INTERVAL_MINUTES - 1)), "waiting", `the whole interval after ${name} is that pass`);
  }
  // Once that pass has had it, asking again buys nothing: the sweep either
  // repaired the subject, which changes it and starts the next deadline, or it
  // found nothing to do and would find nothing again. Read on the ticket, whose
  // only deadline is the tightest one; a pull request has later ones to cross.
  assert.equal(
    sweepNeed([ticketSubject], at(DEFAULT_DEADLINES.stuckMinutes + HEARTBEAT_INTERVAL_MINUTES)),
    "nothing-due",
    "the pass after the deadline is not the repair's pass",
  );
  // Nothing below the tightest deadline is skipped either, since a change that
  // recent is due in its own right: the interval is the tightest deadline
  // (`interval.ts`), so the two windows meet rather than leaving a gap.
  assert.equal(sweepNeed([ticketSubject], at(DEFAULT_DEADLINES.stuckMinutes - 1)), "waiting", "a change one minute old is due");
});

test("a ticket a human marked ready that the factory has not picked up is waiting whatever its age", () => {
  // No deadline is running on it: the dispatcher dispatches a ready ticket on
  // the sweep it sees it, so nothing new waits on a clock that never started.
  assert.equal(sweepNeed([settled(ticket(READY_LABEL))], NOW), "waiting");
  // And it stops being due the moment the factory has it, which is where the
  // reconciler's deadline takes over.
  assert.equal(sweepNeed([settled(ticket(READY_LABEL, IMPLEMENT_LABEL))], NOW), "nothing-due");
});

test("a subject whose clock was not read is waiting, rather than skipped on an age nobody knows", () => {
  // The reconciler treats a state whose age it does not know as overdue, and an
  // unprojected read is where that arrives: the field is absent, not stale.
  assert.equal(sweepNeed([{ pullRequest: false, labels: [IMPLEMENT_LABEL] }], NOW), "waiting");
  assert.equal(sweepNeed([{ pullRequest: true, labels: [] }], NOW), "waiting");
  // And a timestamp that is there but says nothing is the same answer, not the
  // opposite one: an unparseable age is past no deadline and inside no window,
  // so reading it as arithmetic would leave the subject asleep for good.
  assert.equal(sweepNeed([{ pullRequest: false, labels: [IMPLEMENT_LABEL], changedAt: "" }], NOW), "waiting");
  assert.equal(sweepNeed([{ pullRequest: true, labels: [], changedAt: "yesterday" }], NOW), "waiting");
});

test("a subject that changed since the last pass is waiting, whatever its deadlines say", () => {
  // A change is what releases a subject a sweep was leaving alone, a hold taken
  // off a ticket the reconciler still holds being the case CONTEXT.md promises
  // resumes on the first sweep. It is also what every deadline runs from.
  assert.equal(sweepNeed([changed(1, ticket(IMPLEMENT_LABEL))], NOW), "waiting");
  assert.equal(sweepNeed([changed(HEARTBEAT_INTERVAL_MINUTES - 1, ticket(IMPLEMENT_LABEL))], NOW), "waiting");
});

test("a pull request is judged by every reconciler deadline and a ticket by the stuck one", () => {
  // The reconciler judges a ticket by stuckMinutes alone and a PR by all three:
  // the label states and the auto-merge re-arm, the verdict, the update. All
  // three deadlines are 30 today (#271), so a PR and a ticket of the same age
  // cross together; the PR still samples the whole set, so a later deadline
  // added to it would keep a PR due past a ticket without an edit here.
  const later = Math.max(...Object.values(DEFAULT_DEADLINES));
  assert.equal(sweepNeed([changed(later, pullRequest())], NOW), "waiting");
  // Past its stuck window a ticket is done, whatever a PR of the same age still
  // has ahead of it.
  assert.equal(sweepNeed([changed(later + HEARTBEAT_INTERVAL_MINUTES, ticket(IMPLEMENT_LABEL))], NOW), "nothing-due");
});

test("a subject open and untouched for two hours is woken twice, not on every pass", () => {
  // The measurement in #264: one subject sitting open for about two hours was
  // swept on every consecutive pass. With the interval at 30 minutes two hours
  // is four passes, and with one deadline (#271: stuck, verdict and update are all 30) a
  // subject that changed once is due on the change's pass and again on the
  // deadline's, and on no pass after. The grid is offset from the change, which
  // is the case that costs the most: a pass lands on the change as well as on
  // the deadline.
  const wakes = (subject: OpenSubject): number => {
    const changedAt = Date.parse(subject.changedAt!);
    let count = 0;
    for (let minutes = 5; minutes <= 120; minutes += HEARTBEAT_INTERVAL_MINUTES) {
      if (sweepNeed([subject], new Date(changedAt + minutes * 60_000)) === "waiting") count += 1;
    }
    return count;
  };
  const passes = Math.floor(120 / HEARTBEAT_INTERVAL_MINUTES);
  assert.ok(passes >= 4, `two hours is ${passes} passes, and every one of them woke the target before this`);
  // One pass for the change, one for the stuck deadline.
  assert.equal(wakes(changed(0, ticket(IMPLEMENT_LABEL))), 2);
  // A pull request samples every reconciler deadline, but all of them are 30
  // today, so it wakes on the same two passes a ticket does rather than more.
  assert.equal(wakes(changed(0, pullRequest())), 2);
});

test("an untouched subject a sweep could act on is rechecked once a day, in the pass just after each whole day and in no pass between", () => {
  // #267: a repair that failed without changing its subject (GitHub refusing to
  // arm auto-merge, an update-branch that hit a conflict) leaves the subject
  // settled, so `due` would sleep on it forever after its deadline windows. The
  // daily clause wakes it one pass per whole day so the sweep retries.
  const changedAt = NOW.toISOString();
  const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000);
  // A ticket in a factory state, past its stuck window, is otherwise nothing-due.
  const subject: OpenSubject = { pullRequest: false, labels: [IMPLEMENT_LABEL], changedAt };
  const DAY = 1440;
  for (const day of [1, 2, 3]) {
    const start = day * DAY;
    assert.equal(sweepNeed([subject], at(start)), "waiting", `day ${day} boundary is the recheck pass`);
    assert.equal(sweepNeed([subject], at(start + HEARTBEAT_INTERVAL_MINUTES - 1)), "waiting", `the rest of day ${day}'s pass is still the recheck`);
    assert.equal(sweepNeed([subject], at(start + HEARTBEAT_INTERVAL_MINUTES)), "nothing-due", `the pass after day ${day}'s window is not a recheck`);
    assert.equal(sweepNeed([subject], at(start - HEARTBEAT_INTERVAL_MINUTES)), "nothing-due", `the pass before day ${day}'s boundary is not a recheck`);
    assert.equal(sweepNeed([subject], at(start + DAY / 2)), "nothing-due", `mid-day ${day} is not a recheck`);
  }
});

test("the daily recheck wakes a held pull request but never a held ticket, a parked subject, or an empty target", () => {
  // #267: the recheck rides on the same `waiting` filter, so held PRs (whose
  // merge path is never withheld, #210) are rechecked while held tickets and
  // parked subjects stay excluded, and a target with nothing open is untouched.
  // Placed at the pass's clock, the subjects changed just before it, so a whole
  // day has passed by `day` and the PR lands in the first daily window.
  const DAY = 1440;
  const day = new Date(NOW.getTime() + DAY * 60_000);
  assert.equal(sweepNeed([pullRequest(...HOLD_LABELS)], day), "waiting", "a held PR is rechecked daily");
  for (const held of HOLD_LABELS) {
    for (const state of FACTORY_STATE_LABELS) {
      assert.equal(sweepNeed([ticket(state, held)], day), "nothing-waiting", `${held} beside ${state} is never rechecked`);
    }
  }
  for (const parked of PARKED_LABELS) {
    assert.equal(sweepNeed([ticket(parked)], day), "nothing-waiting", `${parked} is never rechecked`);
  }
  assert.equal(sweepNeed([], day), "nothing-waiting", "an empty target is never rechecked");
});

test("the deadlines are the reconciler's own, restated nowhere here", () => {
  // The tie `PARKED_LABELS` already travels, for the same reason: a heartbeat
  // carrying its own copy of a deadline would agree with itself forever while
  // the reconciler moved.
  const source = fs.readFileSync(new URL("./work.ts", import.meta.url), "utf8");
  for (const [name, value] of Object.entries(DEFAULT_DEADLINES)) {
    assert.doesNotMatch(source, new RegExp(`\\b${value}\\b`), `${name} is ${value}, which is written out in work.ts rather than imported`);
  }
  assert.match(source, /DEFAULT_DEADLINES/, "the deadlines come from the reconciler");
});
