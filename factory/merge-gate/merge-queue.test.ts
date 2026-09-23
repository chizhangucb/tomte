/**
 * The required gates answer GitHub's merge-queue event (#344).
 *
 * A merge queue rebases a queued pull request onto the latest default branch
 * and asks for the required checks on that candidate before it lands. It asks
 * by sending `merge_group`, and a workflow that does not subscribe to it never
 * reports, so every required name stays pending and the queue stalls forever.
 * This file is the tie between that rule and the files that have to follow it,
 * because none of them is reachable from a unit test: the subject is the
 * workflow files, so the tree is the fixture, the way
 * `factory/dispatch/workflow-names.test.ts` makes it one.
 *
 * Until a repo turns its queue on GitHub sends no `merge_group` at all, so
 * every assertion here is about a gate that is ready rather than a behaviour
 * that changed. The no-op half is asserted too: the same events wake the same
 * jobs as before.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

import { HEAD_SHA_PATHS } from "./gate-subject";

const repoRoot = new URL("../../", import.meta.url);

const read = (file: string): string => fs.readFileSync(new URL(file, repoRoot), "utf8");

/**
 * The triggers a workflow subscribes to: the two-space indented keys of its
 * `on:` block, sorted. Same reading as `workflow-names.test.ts`'s, so a
 * trigger written with an inline value is still seen.
 */
const triggersOf = (yaml: string): string[] => {
  const head = /^on:\n/m.exec(yaml);
  assert.ok(head, "the workflow's `on:` is a block-style mapping, so its triggers can be read");
  const rest = yaml.slice(head.index + head[0].length);
  const next = rest.search(/^\S/m);
  const block = next < 0 ? rest : rest.slice(0, next);
  return [...block.matchAll(/^ {2}([a-z][a-z0-9_-]*):/gm)].map((m) => m[1]!).sort();
};

/**
 * The caller's top-level jobs, each with its body: two-space indented keys from
 * the `jobs:` line on, read the way `workflow-names.test.ts` reads them.
 */
const jobsOf = (yaml: string): { id: string; body: string }[] => {
  const start = yaml.indexOf("\njobs:");
  assert.ok(start >= 0, "the workflow has a top-level jobs: block");
  const jobs = yaml.slice(start);
  const heads = [...jobs.matchAll(/^ {2}([a-z][a-z0-9_-]*):$/gm)];
  return heads.map((head, i) => ({ id: head[1]!, body: jobs.slice(head.index!, heads[i + 1]?.index ?? jobs.length) }));
};

/** GitHub's name for the merge-queue event. One spelling, named once. */
const MERGE_QUEUE_EVENT = "merge_group";

/**
 * Every file in this repo that publishes a check a merge rule requires, or
 * that a target copies to publish one. Each has to answer the queue as well as
 * the pull request, or the name it publishes never reports on a candidate.
 *
 * `merge-gate.yml` is not here and needs no trigger of its own: it is a
 * `workflow_call` workflow, so it runs on whatever event reached the caller
 * that called it. That is what "defined once and reused" buys -- the gate is
 * one job either way, and the caller below is the only place the event list
 * is written.
 */
const REQUIRED_GATES = [
  // This repo's own `check`, required on a head up to date with main (#223).
  ".github/workflows/ci.yml",
  // The roll-up a target with no CI of its own is onboarded with; `scripts/onboard.sh`
  // writes it and requires the `check` it publishes.
  "templates/rollup-check.yml",
];

/** The caller a target carries, and this repo's own copy of it. */
const CALLERS = ["templates/factory.yml", ".github/workflows/factory.yml"];

/**
 * Where the one-line trigger a target adds is written down, so rolling the
 * queue out to groats and the targets after it is mechanical rather than
 * archaeological. Same shape as `triggers.test.ts`'s TRIGGER_SET_SITES: prose
 * tied to the thing it describes.
 */
const ROLLOUT_DOCS = ["docs/factory/onboarding.md", "docs/factory/merge-gate.md"];

/** The one of them that holds the block to paste, rather than pointing at it. */
const SNIPPET_DOC = "docs/factory/merge-gate.md";

test("every required gate in this repo answers the merge-queue event as well as the pull request", () => {
  for (const file of REQUIRED_GATES) {
    const triggers = triggersOf(read(file));
    assert.ok(triggers.includes("pull_request"), `${file} publishes a required check on a pull request`);
    assert.ok(
      triggers.includes(MERGE_QUEUE_EVENT),
      `${file} does not answer ${MERGE_QUEUE_EVENT}, so a queued candidate would wait on it forever`,
    );
  }
});

test("the caller subscribes to the merge-queue event, and the merge gate is the one job that answers it", () => {
  for (const file of CALLERS) {
    const caller = read(file);
    assert.ok(
      triggersOf(caller).includes(MERGE_QUEUE_EVENT),
      `${file} does not subscribe to ${MERGE_QUEUE_EVENT}`,
    );
    // The gate is reused, not copied: one `merge-gate` job, calling the one
    // reusable workflow, whatever event it is answering. A second job wired to
    // the queue would be a second definition of green.
    const gateJobs = jobsOf(caller).filter((job) => /\n {4}uses: \S+\/merge-gate\.yml@/.test(job.body));
    assert.deepEqual(gateJobs.map((job) => job.id), ["merge-gate"], `${file} calls the merge gate from exactly one job`);
  }
});

test("the merge gate reads the candidate's head from the merge-queue payload as well as the pull request's", () => {
  // The workflow needs the head sha before anything is checked out, to mark
  // both checks pending, so that one value is read in YAML rather than by
  // `gateSubject`. The paths come from `gate-subject.ts` so the two cannot
  // drift: a payload field renamed there without being renamed here would
  // leave the gate posting its statuses on an empty sha.
  const gate = read(".github/workflows/merge-gate.yml");
  const headSha = gate.match(/^ {6}HEAD_SHA: (.+)$/m)?.[1];
  assert.ok(headSha, "the merge gate names the head it judges once, in HEAD_SHA");
  for (const path of Object.values(HEAD_SHA_PATHS)) {
    assert.ok(headSha.includes(`github.event.${path}`), `HEAD_SHA does not read github.event.${path}`);
  }
  // And nothing else reads a pull request off the event: on a merge_group run
  // every one of those is empty, so a step still reading one would silently
  // check out nothing or upload an artifact named after no pull request.
  const strays = [...gate.matchAll(/^.*github\.event\.pull_request.*$/gm)].map((m) => m[0].trim());
  assert.deepEqual(strays, [`HEAD_SHA: ${headSha}`], "a step still reads the pull request off the event");
});

test("the one line a target adds to its own required workflows is written down", () => {
  // Criterion 4: rollout to groats and the targets after it has to be
  // mechanical, and the line is only mechanical if it is written somewhere a
  // maintainer finds it. Same shape as `triggers.test.ts`'s TRIGGER_SET_SITES:
  // prose tied to the thing it describes, so a renamed event fails here rather
  // than leaving a doc telling a reader to paste a line GitHub ignores.
  for (const site of ROLLOUT_DOCS) {
    assert.match(read(site), new RegExp(`\`?${MERGE_QUEUE_EVENT}:?\`?`), `${site} does not name the merge-queue event`);
  }
  // And one of them shows the line to paste, exactly as the templates declare
  // it: `merge_group:`, valueless, under `on:` beside `pull_request:`.
  const snippet = read(SNIPPET_DOC).match(/```yaml\non:\n((?: {2}\S.*\n)+)```/);
  assert.ok(snippet, `${SNIPPET_DOC} shows no \`on:\` block for a target to paste`);
  assert.deepEqual(
    snippet[1]!.trimEnd().split("\n").map((line) => line.trim()),
    ["pull_request:", `${MERGE_QUEUE_EVENT}:`],
    `${SNIPPET_DOC} shows a trigger block that is not the one a target adds`,
  );
  // The pasted block is the templates' own: a doc that drifted from them would
  // hand a maintainer a line the factory's own files do not carry.
  for (const file of REQUIRED_GATES) {
    assert.ok(
      triggersOf(read(file)).includes(MERGE_QUEUE_EVENT),
      `${file} does not carry the trigger ${SNIPPET_DOC} tells a target to paste`,
    );
  }
});
