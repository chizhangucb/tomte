/**
 * The label vocabulary: what the docs say holds a ticket back, and which
 * strings the dispatcher may decide on at all (ADR 0005).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

import { DISPATCH_LABEL, FACTORY_STATE_LABELS } from "../dispatch/select.ts";
import { ESCALATION_LABEL, HANDED_OFF_LABELS, HOLD_LABEL, HOLD_LABELS, READY_LABEL } from "./labels.ts";

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
