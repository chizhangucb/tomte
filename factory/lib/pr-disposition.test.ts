import assert from "node:assert/strict";
import { test } from "node:test";

import { VERDICT_SECTION_START } from "./factory-pr.ts";
import { prDisposition } from "./pr-disposition.ts";

const agentBranch = { headRef: "agent/issue-7-thing", body: "" };
const notAuthored = { headRef: "maintainer/flaky-login", body: "Fixes the flaky login test." };

test("a PR the factory authored is a hand-off: agent:implement, and the sentence names the base it merges", () => {
  const disp = prDisposition(agentBranch, "main");
  assert.equal(disp.action, "hand-off");
  assert.equal(disp.add, "agent:implement");
  // The one thing the label does, named for the reader: the implementer merges the base in.
  assert.match(disp.sentence, /merges `main`/);
});

test("the base the hand-off names is the one it is given", () => {
  assert.match(prDisposition(agentBranch, "release/2.0").sentence, /merges `release\/2\.0`/);
});

test("a PR the factory did not author is a tell-author: agent:blocked, and the sentence names how the author hands it back", () => {
  const disp = prDisposition(notAuthored, "main");
  assert.equal(disp.action, "tell-author");
  assert.equal(disp.add, "agent:blocked");
  // The label is what makes the decline stick; taking it off is what hands the PR back.
  assert.match(disp.sentence, /take `agent:blocked` off/);
  // Never the implementer's label: no agent of the factory's rewrites this branch.
  assert.doesNotMatch(disp.sentence, /agent:implement/);
});

test("a PR the reviewer judged but the factory did not author is still a tell-author", () => {
  // The verdict section makes it a factory PR the audit and reconciler see, but it
  // is the arm authorship drops: the factory wrote the section, not the branch.
  const judged = { headRef: "maintainer/flaky-login", body: `body\n\n${VERDICT_SECTION_START}\n## Verdict: fail` };
  assert.equal(prDisposition(judged, "main").action, "tell-author");
  // An outside agent's PR is no more the factory's to write to than a person's.
  assert.equal(prDisposition({ headRef: "bot/dependabot-bump", body: "" }, "main").action, "tell-author");
});

test("the tell-author sentence needs no base, so the failing-check path can ask without one", () => {
  const disp = prDisposition(notAuthored);
  assert.equal(disp.action, "tell-author");
  assert.match(disp.sentence, /take `agent:blocked` off/);
});
