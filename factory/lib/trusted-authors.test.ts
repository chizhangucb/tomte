import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

import {
  authorAssociation,
  CHANNELS,
  type Channel,
  DEFAULT_TRUSTED_AUTHORS,
  TRUSTED_AUTHORS_VAR,
  trustPolicy,
  trustPolicyFromEnv,
} from "./trusted-authors";

/** A stranger with no association at all, on whatever channel a test names. */
const outsider = { association: "NONE", login: "stranger" };

/**
 * The identity every workflow in the target posts under with GITHUB_TOKEN: the
 * factory's own reviewer, and equally the target's coverage reporter. GitHub
 * reports `author_association: NONE` for it on every repo.
 */
const actionsBot = { association: "NONE", login: "github-actions[bot]" };

/** The two channels the factory itself writes, and so the only exempt ones. */
const FACTORY_WRITTEN: readonly Channel[] = ["review-summary", "review-thread"];

test("the default trusts the repo owner and nobody else", () => {
  const policy = trustPolicy(undefined);
  assert.deepEqual([...policy.associations], [...DEFAULT_TRUSTED_AUTHORS]);
  assert.equal(policy.trusts("ticket-comment", { association: "OWNER", login: "a-maintainer" }), true);
  assert.equal(policy.trusts("ticket-comment", { association: "COLLABORATOR", login: "a-teammate" }), false);
  assert.equal(policy.trusts("ticket-comment", outsider), false);
});

test("an absent association reads as an outsider", () => {
  const policy = trustPolicy(undefined);
  assert.equal(policy.trusts("pr-comment", { association: undefined, login: undefined }), false);
  assert.equal(policy.trusts("pr-comment", { association: null, login: null }), false);
});

test("a value GitHub never sends reads as NONE, so a strange payload is an outsider", () => {
  assert.equal(authorAssociation("OWNER"), "OWNER");
  assert.equal(authorAssociation("owner"), "OWNER");
  assert.equal(authorAssociation("SOMETHING_NEW"), "NONE");
  assert.equal(authorAssociation(undefined), "NONE");
});

test("a wider list lets in everyone who could already push", () => {
  const policy = trustPolicy("OWNER, member ,collaborator");
  assert.deepEqual([...policy.associations], ["OWNER", "MEMBER", "COLLABORATOR"]);
  assert.equal(policy.trusts("ticket-author", { association: "MEMBER", login: "a-teammate" }), true);
  assert.equal(policy.trusts("ticket-author", { association: "CONTRIBUTOR", login: "drive-by" }), false);
});

test("an empty or missing input falls back to the owner alone", () => {
  assert.deepEqual([...trustPolicy(undefined).associations], ["OWNER"]);
  assert.deepEqual([...trustPolicy("  , ").associations], ["OWNER"]);
});

test("a value GitHub never sends matches nothing, so a typo parks work", () => {
  const typo = trustPolicy("OWNR");
  assert.equal(typo.trusts("ticket-author", { association: "OWNER", login: "a-maintainer" }), false);
  assert.equal(typo.trusts("ticket-author", outsider), false);
});

test("the environment carries the caller's input to the run scripts", () => {
  assert.deepEqual(
    [...trustPolicyFromEnv({ TRUSTED_AUTHOR_ASSOCIATIONS: "owner,member" }).associations],
    ["OWNER", "MEMBER"],
  );
  assert.deepEqual([...trustPolicyFromEnv({}).associations], ["OWNER"]);
});

/**
 * #52's first shipped bug. The reviewer posts its summary and its inline
 * findings with GITHUB_TOKEN, so they arrive as `github-actions` with
 * association NONE. Judged on the association alone they were all dropped,
 * which left implement-pr, whose whole job is to address them, with a count in
 * place of the findings and no thread it was allowed to reply to.
 */
test("the factory's own review survives on the channels it writes, whichever way the API spells the login", () => {
  const policy = trustPolicy("OWNER");
  for (const channel of FACTORY_WRITTEN) {
    assert.equal(policy.trusts(channel, actionsBot), true, `${channel} keeps the factory's own voice`);
    assert.equal(
      policy.trusts(channel, { association: "NONE", login: "github-actions" }),
      true,
      `${channel} accepts gh's spelling as well as REST's`,
    );
    assert.equal(
      policy.trusts(channel, { association: "NONE", login: "github-actions-impostor" }),
      false,
      `${channel} does not accept a lookalike login`,
    );
    assert.equal(policy.trusts(channel, outsider), false, `${channel} still drops a stranger`);
  }
});

/**
 * #52's second shipped bug. `github-actions` is the login EVERY workflow in the
 * target posts under, not just agent-review, and a coverage reporter or
 * size-diff bot routinely quotes a fork PR's branch name, commit message or
 * failing test output. Honouring the login off the factory's own channels
 * laundered a stranger's words straight through this control.
 */
test("the same bot on a channel the factory does not write is judged on its association alone", () => {
  const policy = trustPolicy("OWNER");
  const elsewhere = CHANNELS.filter((channel) => !FACTORY_WRITTEN.includes(channel));
  assert.ok(elsewhere.length > 0, "there are channels the factory does not write");
  for (const channel of elsewhere) {
    assert.equal(policy.trusts(channel, actionsBot), false, `${channel} judges the bot on its association`);
    assert.equal(
      policy.trusts(channel, { association: "OWNER", login: "github-actions[bot]" }),
      true,
      `${channel} still reads the association, whatever the login says`,
    );
  }
});

/**
 * The point of the channel argument: which channels carry the factory's own
 * voice is the policy's answer, not a call site's. A call site names a channel
 * and gets the policy's judgement; it has no way to ask for a different one.
 */
test("the exemption belongs to the two channels the factory writes and to no others", () => {
  const policy = trustPolicy("OWNER");
  const exempt = CHANNELS.filter((channel) => policy.trusts(channel, actionsBot));
  assert.deepEqual([...exempt], [...FACTORY_WRITTEN]);
});

test("every channel the factory reads is on the list, and the list is closed", () => {
  assert.deepEqual(
    [...CHANNELS],
    [
      "pr-comment",
      "review-summary",
      "review-thread",
      "ticket-comment",
      "ticket-author",
      "parent-spec",
      "retry-marker",
    ],
  );
  assert.equal(new Set(CHANNELS).size, CHANNELS.length, "no channel is named twice");
});

test("keep returns what a trusted author wrote and counts what it dropped", () => {
  const comments = [
    { association: "OWNER", login: "a-maintainer", body: "keep" },
    { association: "NONE", login: "stranger", body: "drop" },
    { association: null, login: null, body: "drop too" },
    { association: "COLLABORATOR", login: "a-teammate", body: "maybe" },
  ];
  const author = (c: (typeof comments)[number]) => ({ association: c.association, login: c.login });

  const owner = trustPolicy("OWNER").keep("pr-comment", comments, author);
  assert.deepEqual(owner.kept.map((c) => c.body), ["keep"]);
  assert.equal(owner.dropped, 3);

  const wider = trustPolicy("OWNER,COLLABORATOR").keep("pr-comment", comments, author);
  assert.deepEqual(wider.kept.map((c) => c.body), ["keep", "maybe"]);
  assert.equal(wider.dropped, 2);
});

test("keep judges the same items differently on a channel the factory writes", () => {
  // Same list, same accessor, one word apart: the channel decides, so a caller
  // cannot hand the exemption to a list by describing its authors differently.
  const items = [{ association: "NONE", login: "github-actions[bot]", body: "the factory's own" }];
  const author = (c: (typeof items)[number]) => ({ association: c.association, login: c.login });
  const policy = trustPolicy("OWNER");
  assert.equal(policy.keep("review-thread", items, author).kept.length, 1);
  assert.equal(policy.keep("pr-comment", items, author).kept.length, 0);
});

test("droppedNote names the count and the policy, and is empty when nothing was dropped", () => {
  const policy = trustPolicy("OWNER,MEMBER");
  assert.equal(policy.droppedNote(0, "comment(s) on the PR"), "");
  const note = policy.droppedNote(2, "comment(s) on the PR");
  assert.match(note, /^2 comment\(s\) on the PR from untrusted authors were dropped\./);
  assert.match(note, /OWNER, MEMBER/);
});

/**
 * The wiring a new job or a renamed input would break, in the style of
 * `dispatch/workflow-names.test.ts`: the subject is the repo's own workflow
 * files, so the tree is the fixture. The run scripts read the policy from
 * TRUSTED_AUTHOR_ASSOCIATIONS, so a workflow that runs one of them and does
 * not pass it silently falls back to OWNER whatever the target set.
 */
const workflowsDir = new URL("../../.github/workflows/", import.meta.url);

/** Every workflow whose script builds a trust policy, and the script it runs. */
const POLICY_WORKFLOWS = {
  "dispatch.yml": "dispatch/dispatch-run.ts",
  "agent-implement.yml": "agent-workflows/implement/implement.ts",
  "agent-review.yml": "agent-workflows/review/review.ts",
  "agent-implement-pr.yml": "agent-workflows/implement-pr/implement-pr.ts",
  "agent-audit.yml": "audit/audit.ts",
} as const;

/** A workflow's steps, split on the `- name:` boundary, so an env can be tied to the step it belongs to. */
const stepsOf = (yaml: string): string[] => yaml.split(/\n(?= {6}- name:)/);

test("every workflow that runs a policy-reading script declares and passes the input", () => {
  for (const [file, script] of Object.entries(POLICY_WORKFLOWS)) {
    const yaml = fs.readFileSync(new URL(file, workflowsDir), "utf8");
    assert.match(yaml, new RegExp(String.raw`\n {6}trusted_author_associations:`), `${file} declares the input`);
    assert.match(yaml, /\n {8}default: OWNER\b/, `${file} defaults to OWNER`);
    // On the step that runs the script, not merely somewhere in the file: #51
    // moved the retry handler into a job of its own, and an input wired to the
    // wrong job typechecks fine and silently reads as OWNER at runtime.
    const running = stepsOf(yaml).filter((step) => step.includes(script));
    assert.equal(running.length, 1, `${file} runs ${script} in exactly one step`);
    assert.ok(
      running[0]!.includes(`${TRUSTED_AUTHORS_VAR}: \${{ inputs.trusted_author_associations }}`),
      `${file} passes the input to the step that runs ${script}`,
    );
  }
});

test("the caller template offers the input on every job that takes it", () => {
  const template = fs.readFileSync(new URL("../../templates/factory.yml", import.meta.url), "utf8");
  const offers = template.match(/trusted_author_associations:/g) ?? [];
  assert.equal(offers.length, Object.keys(POLICY_WORKFLOWS).length);
});
