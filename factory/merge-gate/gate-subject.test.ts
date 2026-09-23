import assert from "node:assert/strict";
import { test } from "node:test";

import { gateSubject } from "./gate-subject";

/** A `pull_request` payload as GitHub sends it, cut down to what the gate reads. */
const pullRequest = (overrides: Record<string, unknown> = {}) => ({
  pull_request: { number: 344, head: { sha: "f00dcafe" }, base: { ref: "main" } },
  ...overrides,
});

/**
 * A `merge_group` payload as GitHub sends it. Both refs are full refs, and the
 * queue branch's name is where the pull request number is: the payload carries
 * no `pull_request` object at all.
 */
const mergeGroup = (headRef: string, baseRef = "refs/heads/main") => ({
  merge_group: {
    head_sha: "f00dcafe",
    head_ref: headRef,
    base_sha: "0ddba11",
    base_ref: baseRef,
  },
});

test("a pull request event names its own head, base branch and number", () => {
  assert.deepEqual(gateSubject({ name: "pull_request", payload: pullRequest() }), {
    prNumber: "344",
    headSha: "f00dcafe",
    baseRef: "main",
  });
});

test("a merge group event names the queued candidate's head and the branch it is queued for", () => {
  // The same three answers off a payload that shares no field name with a pull
  // request's: this is what lets one gate judge both events.
  assert.deepEqual(
    gateSubject({
      name: "merge_group",
      payload: mergeGroup("refs/heads/gh-readonly-queue/main/pr-344-0ddba11"),
    }),
    { prNumber: "344", headSha: "f00dcafe", baseRef: "main" },
  );
});

test("a queue branch for a base branch with slashes in its name still yields the pull request number", () => {
  // `gh-readonly-queue/<base>/pr-<n>-<sha>`, so the base's own slashes sit
  // between the two halves a reader might anchor on.
  assert.deepEqual(
    gateSubject({
      name: "merge_group",
      payload: mergeGroup("refs/heads/gh-readonly-queue/release/1.x/pr-7-0ddba11", "refs/heads/release/1.x"),
    }),
    { prNumber: "7", headSha: "f00dcafe", baseRef: "release/1.x" },
  );
});

test("a merge group whose queue branch carries no pull request number is refused, not guessed at", () => {
  // The number is what fetches the linked ticket. Guessing one would judge the
  // candidate against somebody else's acceptance criteria.
  assert.throws(
    () => gateSubject({ name: "merge_group", payload: mergeGroup("refs/heads/gh-readonly-queue/main/nonsense") }),
    /gh-readonly-queue\/main\/nonsense/,
  );
});

test("an event the gate cannot read is refused by name", () => {
  // A caller that wires the gate to a third event gets a failing job that says
  // which event it was, rather than a run against an empty base ref.
  assert.throws(() => gateSubject({ name: "push", payload: { ref: "refs/heads/main" } }), /push/);
});
