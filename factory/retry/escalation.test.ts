import assert from "node:assert/strict";
import { test } from "node:test";

import { VERDICT_SECTION_START } from "../lib/factory-pr.ts";
import { escalationLabels, prEscalation } from "./escalation.ts";

const agentBranch = { headRef: "agent/issue-7-thing", body: "" };
const notAuthored = { headRef: "maintainer/flaky-login", body: "Fixes the flaky login test." };

test("an escalated ticket is left carrying needs-human and nothing else of the factory's", () => {
  assert.deepEqual(
    escalationLabels(["ready-for-agent", "agent:in-progress", "agent:blocked", "factory:retry-1"]),
    { remove: ["ready-for-agent", "agent:in-progress", "agent:blocked"], add: "needs-human" },
  );
});

test("escalationLabels names only labels the subject carries", () => {
  assert.deepEqual(escalationLabels([]), { remove: [], add: "needs-human" });
  assert.deepEqual(escalationLabels(["bug", "factory:retry-1"]), { remove: [], add: "needs-human" });
});

test("a PR the factory closes keeps no agent:* label", () => {
  assert.deepEqual(prEscalation({ ...agentBranch, labels: ["agent:review", "agent:blocked", "enhancement"] }), {
    remove: ["agent:review", "agent:blocked"],
    add: undefined,
    close: true,
  });
  assert.deepEqual(prEscalation({ ...agentBranch, labels: [] }), { remove: [], add: undefined, close: true });
});

test("escalating a PR touches nothing but the factory's own labels", () => {
  // ready-for-agent is the ticket's intent, never the PR's, so a stray one is left alone.
  assert.deepEqual(prEscalation({ ...agentBranch, labels: ["ready-for-agent", "factory:retry-1"] }), {
    remove: [],
    add: undefined,
    close: true,
  });
});

test("escalation never closes a PR the factory did not author", () => {
  // #174: a PR the factory did not author closes no ticket, so labelling it
  // agent:review gets it a verdict that fails for want of acceptance criteria,
  // which is unretryable, which escalates. Closing it here throws away work
  // nothing can recreate.
  assert.equal(prEscalation({ ...notAuthored, labels: ["agent:review"] }).close, false);
  // An outside agent's PR is no more the factory's to close than a person's.
  assert.equal(prEscalation({ headRef: "bot/dependabot-bump", body: "", labels: [] }).close, false);
});

test("a PR the reviewer judged is still not the factory's to close", () => {
  // The verdict section makes it a factory PR, so the audit and the reconciler
  // see it. It is the one arm authorship drops: the factory wrote the section,
  // not the branch.
  const judged = { headRef: "maintainer/flaky-login", body: `body\n\n${VERDICT_SECTION_START}\n## Verdict: fail` };
  assert.equal(prEscalation({ ...judged, labels: ["agent:review"] }).close, false);
});

test("escalation stands a PR down whether or not it closes it", () => {
  // The agent:* labels come off either way. A label left on is a run that picks
  // the PR up again, and escalation is the factory saying it is done with it.
  assert.deepEqual(prEscalation({ ...notAuthored, labels: ["agent:review", "bug"] }).remove, ["agent:review"]);
});

test("a PR left open is parked, not just stripped: removals alone are repaired back", () => {
  // The reconciler reads a factory PR with no agent:* label as one to arm and
  // judge, and re-adds agent:review at its verdict deadline: the step that
  // escalated this PR. needs-human is what it parks on, so the label that
  // records the escalation is what makes the stand-down stick.
  assert.equal(prEscalation({ ...notAuthored, labels: ["agent:review"] }).add, "needs-human");
  // A closed PR is in no listing the reconciler reads, so it needs no parking label.
  assert.equal(prEscalation({ ...agentBranch, labels: ["agent:review"] }).add, undefined);
});
