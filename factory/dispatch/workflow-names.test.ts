/**
 * The wiring a rename can break. The subject is the repo's own workflow files,
 * so the tree is the fixture: the four workflows that run a model carry
 * sandcastle's `agent-` names and nothing answers to the old ones, the caller
 * template calls files the factory has, the reconciler still reads a role out
 * of each agent workflow's jobs, and every agent job is serialised on its own
 * subject number with no per-account slot left anywhere (#149). Plus the
 * triggers this repo's own CI subscribes to (#223).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

import { type RunRole, roleFromJobs } from "./reconcile.ts";

const repoRoot = new URL("../../", import.meta.url);
const workflowsDir = new URL(".github/workflows/", repoRoot);

/** The workflows that run a model, sandcastle's names, and the role the reconciler must read from each. */
const AGENT_WORKFLOWS: Record<string, RunRole> = {
  "agent-implement.yml": "implement",
  "agent-review.yml": "review",
  "agent-implement-pr.yml": "implement-pr",
  "agent-audit.yml": "audit",
};

/** What those four were called before #61. No file answers to them now. */
const OLD_NAMES = ["implement.yml", "review.yml", "implement-pr.yml", "audit.yml"];

/**
 * The reusable workflows that run no model, and the role the reconciler must read
 * from each. `roleFromJobs` keys on the called job's own name, so a job renamed
 * without its `JOB_ROLES` key reads as no role at all and the run drops out of the
 * reconciler's view silently. #155 renamed the `gate` job to `merge-gate` and this
 * is the wiring that had to move with it.
 */
const JOB_WORKFLOWS: Record<string, RunRole> = {
  "dispatch.yml": "dispatch",
  "merge-gate.yml": "merge-gate",
  "update-branch.yml": "update-branch",
};

/**
 * The group each agent job must be serialised on: its subject, the issue number
 * on the ticket side and the PR number on the PR side (#149). The role is not
 * part of the key, so a review and an implement-pr run on one PR share a group
 * and cannot overlap, while two different subjects never share one at all.
 */
const SUBJECT_KEYS: Record<string, string> = {
  "agent-implement.yml": "factory-issue-${{ github.event.issue.number }}",
  "agent-review.yml": "factory-pr-${{ github.event.pull_request.number }}",
  "agent-implement-pr.yml": "factory-pr-${{ github.event.pull_request.number }}",
  "agent-audit.yml": "factory-pr-${{ github.event.pull_request.number }}",
};

/**
 * The audit's own group, on its `decide` job: the one concurrency group inside an
 * agent workflow that is not an agent job's. It serialises the counter, so two
 * merges landing together cannot both read 19, and it was never the per-account
 * cap, so #149 left it alone.
 */
const AUDIT_COUNTER = { file: "agent-audit.yml", job: "decide", group: "factory-audit-counter" };

const exists = (file: string): boolean => fs.existsSync(new URL(file, workflowsDir));

const workflowFiles = (): string[] => fs.readdirSync(workflowsDir).sort();

const read = (file: string): string => fs.readFileSync(new URL(file, workflowsDir), "utf8");

/** Top-level jobs with their bodies: two-space indented keys, from the `jobs:` line on. */
const jobsOf = (yaml: string): { id: string; body: string }[] => {
  const start = yaml.indexOf("\njobs:");
  assert.ok(start >= 0, "the workflow has a top-level jobs: block");
  const jobs = yaml.slice(start);
  const heads = [...jobs.matchAll(/^ {2}([a-z][a-z0-9_-]*):$/gm)];
  return heads.map((head, i) => ({ id: head[1]!, body: jobs.slice(head.index!, heads[i + 1]?.index ?? jobs.length) }));
};

const jobIdsOf = (yaml: string): string[] => jobsOf(yaml).map((job) => job.id);

/**
 * The triggers a workflow subscribes to: the two-space indented keys of its `on:`
 * block, sorted. Keys read like `jobsOf`'s, without its `$`, so a trigger written
 * with an inline value is still seen.
 */
const triggersOf = (yaml: string): string[] => {
  // Matched at any line start, first line included, so hoisting `on:` above `name:` is not a failure.
  const head = /^on:\n/m.exec(yaml);
  assert.ok(head, "the workflow's `on:` is a block-style mapping, so its triggers can be read");
  const rest = yaml.slice(head.index + head[0].length);
  const next = rest.search(/^\S/m);
  const block = next < 0 ? rest : rest.slice(0, next);
  return [...block.matchAll(/^ {2}([a-z][a-z0-9_-]*):/gm)].map((m) => m[1]!).sort();
};

/**
 * Every job-level concurrency block in the repo's workflows, in file then job
 * order. Comment lines inside the block are skipped: why a job is serialised the
 * way it is belongs next to the key.
 *
 * A block the pattern cannot read is a failure, not a skip: an unread block
 * would drop out of every assertion below and they would pass on a group
 * nobody checked.
 */
const COMMENT_LINES = "(?: {6}#.*\\n)*";
const CONCURRENCY = new RegExp(`^ {4}concurrency:\\n${COMMENT_LINES} {6}group: (.+)\\n${COMMENT_LINES} {6}cancel-in-progress: (.+)$`, "m");
const CONCURRENCY_LINE = /^ {4}concurrency:$/gm;

const concurrencyBlocks = (): { file: string; job: string; group: string; cancelInProgress: string }[] =>
  workflowFiles().flatMap((file) => {
    const yaml = read(file);
    const blocks = jobsOf(yaml).flatMap((job) => {
      const block = job.body.match(CONCURRENCY);
      return block ? [{ file, job: job.id, group: block[1]!, cancelInProgress: block[2]! }] : [];
    });
    const declared = yaml.match(CONCURRENCY_LINE)?.length ?? 0;
    assert.equal(blocks.length, declared, `${file}: a job-level concurrency block is not \`group:\` then \`cancel-in-progress:\`, so it goes unchecked`);
    return blocks;
  });

test("the workflows that run a model carry sandcastle's names and the old ones are gone", () => {
  for (const file of Object.keys(AGENT_WORKFLOWS)) assert.ok(exists(file), `${file} is missing`);
  for (const file of OLD_NAMES) assert.ok(!exists(file), `${file} still exists`);
  // The prefix is the whole point: a reader tells which jobs spend a subscription by the name.
  const prefixed = fs.readdirSync(workflowsDir).filter((f) => f.startsWith("agent-")).sort();
  assert.deepEqual(prefixed, Object.keys(AGENT_WORKFLOWS).sort(), "an agent- prefix means the workflow runs a model");
});

test("the caller template calls workflow files the factory has", () => {
  const template = fs.readFileSync(new URL("templates/factory.yml", repoRoot), "utf8");
  const called = [...template.matchAll(/uses:\s*\S+\/\.github\/workflows\/(\S+?)@/g)].map((m) => m[1]!);
  assert.deepEqual(
    called.filter((file) => !exists(file)),
    [],
    "every workflow the template calls exists",
  );
  for (const file of Object.keys(AGENT_WORKFLOWS)) assert.ok(called.includes(file), `the template never calls ${file}`);
});

test("no workflow picks a slot or declares the per-account cap, and the template does not offer it", () => {
  // The cap is gone (#149). A slot was a job or step that divided the subject
  // number by N, handing an index to an `account-slot-<i>` group; a caller that
  // still passed the input would fail the whole factory workflow at parse time.
  for (const file of workflowFiles()) {
    const yaml = read(file);
    assert.ok(!yaml.includes("per_account_slots"), `${file} still declares per_account_slots`);
    assert.ok(!yaml.includes("account-slot"), `${file} still names an account-slot group`);
    assert.ok(!jobIdsOf(yaml).includes("slot"), `${file} still has a slot job`);
    assert.doesNotMatch(yaml, /^\s*id: slot$/m, `${file} still has a slot step`);
  }
  const template = fs.readFileSync(new URL("templates/factory.yml", repoRoot), "utf8");
  assert.ok(!template.includes("per_account_slots"), "the template still mentions per_account_slots");
});

test("every agent job is serialised on its subject number, and no other group is keyed on a subject", () => {
  // Two runs on one ticket or PR never overlap; unrelated subjects never share a
  // key, so nothing waits behind a run it has nothing to do with (#149).
  const blocks = concurrencyBlocks();
  const agentJobs = Object.entries(AGENT_WORKFLOWS).map(([file, role]) => {
    const block = blocks.find((b) => b.file === file && b.job === role);
    assert.ok(block, `${file}: the ${role} job declares no concurrency group`);
    return block;
  });
  for (const { file, group, cancelInProgress } of agentJobs) {
    assert.equal(group, SUBJECT_KEYS[file], `${file}: the agent job's group is keyed on its subject number`);
    // Never cancel a sibling run on the same subject: the older one is doing real work.
    assert.equal(cancelInProgress, "false", `${file}: the agent job cancels a run on the same subject`);
  }
  // The role is not part of the key, so the three PR-side roles share one group.
  const prSide = agentJobs.filter(({ file }) => file !== "agent-implement.yml").map(({ group }) => group);
  assert.equal(new Set(prSide).size, 1, "review, implement-pr and audit share one group on one PR");
  assert.ok(!prSide.includes(SUBJECT_KEYS["agent-implement.yml"]!), "a PR number and an issue number are different keys");
  // The audit keeps its counter group, which the cap's removal must not take with it.
  const counter = blocks.find((b) => b.file === AUDIT_COUNTER.file && b.job === AUDIT_COUNTER.job);
  assert.equal(counter?.group, AUDIT_COUNTER.group, "the audit's decide job keeps its own group for the counter");
  // Every remaining group names a fixed shared resource. None is computed from a
  // number, which is what a lane was, so nothing can queue behind an unrelated run.
  for (const other of blocks.filter((b) => !agentJobs.includes(b) && b !== counter)) {
    assert.doesNotMatch(other.group, /\$\{\{/, `${other.file}:${other.job} keys its group on an expression, not a fixed resource name`);
  }
});

test("the reconciler reads a role from each model-free workflow's own job", () => {
  for (const [file, role] of Object.entries(JOB_WORKFLOWS)) {
    assert.ok(exists(file), `${file} is missing`);
    const ids = jobIdsOf(read(file));
    assert.equal(
      roleFromJobs(ids.map((name) => ({ name: `caller / ${name}`, conclusion: null }))),
      role,
      `${file} jobs read as ${role}`,
    );
  }
});

test("the reconciler reads a role from each agent workflow's own job", () => {
  for (const [file, role] of Object.entries(AGENT_WORKFLOWS)) {
    const ids = jobIdsOf(read(file));
    assert.ok(!ids.includes("workflow_call"), `${file} job ids come from jobs:, not on:`);
    assert.equal(
      roleFromJobs(ids.map((name) => ({ name: `caller / ${name}`, conclusion: null }))),
      role,
      `${file} jobs read as ${role}`,
    );
  }
});

test("this repo's CI runs on a pull request, on a queued candidate and on demand, never on a push to the default branch", () => {
  // `check` is required on a head up to date with main, so a merge lands the tree the
  // pull request already checked and a push run would say nothing new (#223).
  // `merge_group` is the third way a head gets up to date with main: the merge queue
  // rebases a queued pull request and asks for the required checks on that candidate
  // before it lands, and a required workflow that does not answer it leaves `check`
  // pending forever (#344). No queue is enabled on this repo yet, so it fires on nothing.
  const yaml = read("ci.yml");
  assert.deepEqual(triggersOf(yaml), ["merge_group", "pull_request", "workflow_dispatch"]);
  // A manual run against main does what a pull request run does: one job, nothing
  // conditional, nothing read off the event.
  assert.deepEqual(jobIdsOf(yaml), ["check"]);
  assert.doesNotMatch(yaml, /^\s*if:/m, "ci.yml is conditional, so a manual run may check less than a pull request run");
  assert.doesNotMatch(yaml, /github\.event/, "ci.yml reads the event, so a manual run may check less than a pull request run");
});
