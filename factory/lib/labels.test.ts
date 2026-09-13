/**
 * The label vocabulary: what the docs say holds a ticket back, and which
 * strings the dispatcher may decide on at all (ADR 0005).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import {
  BLOCKED_LABEL,
  DISPATCH_LABEL,
  ESCALATION_LABEL,
  FACTORY_STATE_LABELS,
  HANDED_OFF_LABELS,
  HOLD_LABEL,
  HOLD_LABELS,
  IMPLEMENT_LABEL,
  PARKED_LABELS,
  READY_LABEL,
  REVIEW_LABEL,
} from "./labels.ts";

/**
 * A module's source with its comments taken out. Prose may name a label, since
 * a comment explaining a transition has to spell the label it is about; code
 * may not, because a spelling in code is a second home the first cannot reach.
 */
const codeOf = (file: string): string =>
  fs
    .readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

test("`agent:review` is spelled once, in REVIEW_LABEL, and every module that writes it reads it from there", () => {
  // It was the one label with no constant: the reconciler re-added it, the
  // target repo read it as a PR's state label, and HANDED_OFF_LABELS listed
  // it, each from its own literal, so renaming it anywhere renamed it nowhere
  // else and the reviewer would be started by a label nothing else recognised.
  assert.equal(REVIEW_LABEL, "agent:review");
  assert.ok(HANDED_OFF_LABELS.includes(REVIEW_LABEL), "a PR carrying it is handed off to the reviewer");
  for (const file of ["factory/dispatch/reconcile.ts", "factory/lib/target-repo.ts"]) {
    assert.doesNotMatch(codeOf(file), /agent:review/, `${file} spells agent:review instead of reading REVIEW_LABEL`);
  }
});

/** Every module in the tree, tests included: the readers a label set can be imported from the wrong home by. */
const modules = (dir = "factory"): string[] =>
  fs.readdirSync(new URL(`../../${dir}`, import.meta.url), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? modules(`${dir}/${entry.name}`) : entry.name.endsWith(".ts") ? [`${dir}/${entry.name}`] : [],
  );

/**
 * Where each `import { ... NAME ... } from "x"` in the tree reads that name
 * from, as a repo-relative path, so a sibling's `./labels.ts` and a
 * neighbour's `../lib/labels.ts` are the one home they name.
 */
const importersOf = (name: string): { file: string; from: string }[] =>
  modules().flatMap((file) =>
    [...fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8").matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g)]
      .filter((match) => match[1]!.split(",").some((binding) => binding.trim().replace(/^type\s+/, "") === name))
      .map((match) => ({ file, from: path.posix.join(path.posix.dirname(file), match[2]!) })),
  );

test("PARKED_LABELS is the label module's, read from there by the reconciler and everyone else", () => {
  // It was the reconciler's own, and the heartbeat imported it from there, so
  // the parked pair was defined by the module that acts on it rather than by
  // the vocabulary every actor shares. CONTEXT.md calls it the factory's own
  // pair, and ADR 0005 has it as exactly those two.
  assert.deepEqual([...PARKED_LABELS], [BLOCKED_LABEL, ESCALATION_LABEL]);
  assert.deepEqual([...PARKED_LABELS], ["agent:blocked", "needs-human"]);
  const elsewhere = importersOf("PARKED_LABELS").filter(({ from }) => from !== "factory/lib/labels.ts");
  assert.deepEqual(elsewhere, [], "every reader imports it from lib/labels.ts");
});

test("the factory state labels are the handed-off set plus the escalation, and the dispatcher writes one of them", () => {
  // The dispatcher spelled both of these itself, so `HANDED_OFF_LABELS` and
  // `FACTORY_STATE_LABELS` were two hand-written lists of the same labels: a
  // label added to one and not the other would leave update-branch and the
  // dispatcher disagreeing about whether an agent already holds the subject.
  // The five of ADR 0005, in the order the dispatcher reports them.
  assert.deepEqual(
    [...FACTORY_STATE_LABELS],
    ["agent:implement", "agent:in-progress", "agent:review", "agent:blocked", "needs-human"],
  );
  for (const label of HANDED_OFF_LABELS) {
    assert.ok(FACTORY_STATE_LABELS.includes(label), `${label} hands the subject to an agent, so the factory is on it`);
  }
  assert.ok(FACTORY_STATE_LABELS.includes(ESCALATION_LABEL), "an escalated ticket is still the factory's state");
  // The dispatcher's name for the start label is that label, not a second spelling of it.
  assert.equal(DISPATCH_LABEL, IMPLEMENT_LABEL);
  for (const name of ["DISPATCH_LABEL", "FACTORY_STATE_LABELS"]) {
    const elsewhere = importersOf(name).filter(({ from }) => from !== "factory/lib/labels.ts");
    assert.deepEqual(elsewhere, [], `every reader imports ${name} from lib/labels.ts`);
  }
});

/** The markdown a reader meets: everything under `docs/`, plus the front door and the glossary. */
const docPages = (dir = "docs"): string[] => [
  ...(dir === "docs" ? ["README.md", "CONTEXT.md"] : []),
  ...fs.readdirSync(new URL(`../../${dir}`, import.meta.url), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? docPages(`${dir}/${entry.name}`) : entry.name.endsWith(".md") ? [`${dir}/${entry.name}`] : [],
  ),
];

test("no doc names a hold set: `hold` alone holds a ticket back (#210)", () => {
  // A page still naming `needs-triage` or `ready-for-human` beside it tells a
  // triager they hold, and the dispatcher would dispatch the ticket anyway.
  const naming = docPages().filter((page) => /hold set/i.test(fs.readFileSync(new URL(`../../${page}`, import.meta.url), "utf8")));
  assert.deepEqual(naming, []);
});

test("the hold label is unprefixed, so it reads as a human's instruction rather than factory state", () => {
  // `agent:` means factory state in this vocabulary (`isAgentLabel`), and a
  // hold is a human talking to the factory, not the factory reporting on
  // itself. Being unprefixed is also what makes it collidable: `hold` is an
  // ordinary English word a target may already use for its own meaning, and
  // `onboard.sh` creates labels with `--force`, so onboarding rewrites such a
  // label in place and turns every issue already carrying it into a dispatch
  // veto. `docs/factory/onboarding.md` says to check for that before onboarding.
  assert.equal(HOLD_LABEL, "hold");
  assert.deepEqual(HOLD_LABELS, [HOLD_LABEL]);
});

/**
 * The nine labels GitHub creates on every new repository, whether anyone asks
 * for them or not. A target carries all nine before `scripts/onboard.sh`
 * writes one label of the factory's own.
 */
const GITHUB_DEFAULT_LABELS = [
  "bug",
  "documentation",
  "duplicate",
  "enhancement",
  "good first issue",
  "help wanted",
  "invalid",
  "question",
  "wontfix",
];

test("every label the dispatcher decides on is one this repo defines, never one GitHub ships", () => {
  // ADR 0005 is the reasoning; this is the part of it a test can hold. A
  // default in any of these lists would give a meaning GitHub publishes and
  // this repo does not control a private effect on a target's queue, so the
  // people using that label as it reads would be stopping the factory without
  // knowing. `wontfix` is how close it already runs: a GitHub default and one
  // of the five triage roles in `docs/agents/triage-labels.md`, which the
  // dispatcher happens not to read.
  // Both homes of the factory state strings, not just one: `dispatch/select.ts`
  // still keeps its own `DISPATCH_LABEL` and `FACTORY_STATE_LABELS` while
  // `lib/labels.ts` is where they land (#122), and update-branch and the retry
  // handler read `HANDED_OFF_LABELS` and `ESCALATION_LABEL` rather than either
  // of those. Naming all of them means the guard holds whichever list a new
  // label is added to, and survives the repointing that deletes the duplicates.
  const read = [
    READY_LABEL,
    ...HOLD_LABELS,
    ...HANDED_OFF_LABELS,
    ESCALATION_LABEL,
    DISPATCH_LABEL,
    ...FACTORY_STATE_LABELS,
  ];
  // Case-insensitively: GitHub's label names are unique without regard to case,
  // so `Bug` is not a second label beside the default `bug`, it is that label
  // reached by a different spelling, and `onboard.sh --force` would rewrite the
  // default in place exactly as the lowercase spelling would.
  const defaults = new Set(GITHUB_DEFAULT_LABELS.map((label) => label.toLowerCase()));
  for (const label of read) {
    assert.ok(
      !defaults.has(label.toLowerCase()),
      `${label} is one of GitHub's default labels, so a target carries it whether or not anyone means it as an instruction`,
    );
  }
});
