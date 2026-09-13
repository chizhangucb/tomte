/**
 * The pipeline doc is split so an agent loads one topic, not the whole manual
 * (#297). `docs/pipeline.md` is a router: a short intro, one pointer per topic,
 * and the test-pinned constants. Each topic's mechanics live in one file under
 * `docs/factory/`, so a meaning sits in exactly one place.
 *
 * The three number/text pins have their own tests (`onboard/token-scope`,
 * `heartbeat/send`, `dispatch/triggers`); this one pins the split itself, so a
 * stage's prose cannot silently drift back into the router.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

/** A repo file by its path from the root. */
const read = (file: string): string => fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
const exists = (file: string): boolean => fs.existsSync(new URL(`../../${file}`, import.meta.url));

const ROUTER = "docs/pipeline.md";

/** Every topic file the router points at, one per current H2 (some merged). */
const TOPIC_FILES = [
  "onboarding",
  "caller-inputs",
  "pause",
  "waiver",
  "dispatcher",
  "trust-policy",
  "implementer-run",
  "merge-gate",
  "reviewer-verdict",
  "merge",
  "retry-escalation",
  "audit",
  "usage-rotation",
  "engine",
  "layout",
].map((name) => `docs/factory/${name}.md`);

/**
 * A distinctive sentence from a stage's prose, and the one topic file it now
 * belongs to. Each was an H2 body in the old monolith; if any still reads out
 * of the router, the split has regressed.
 */
const STAGE_PROSE: ReadonlyArray<readonly [string, string]> = [
  ["Why a skipped job and not a disabled workflow", "docs/factory/pause.md"],
  ["The write order is the interface", "docs/factory/waiver.md"],
  ["Why the caller drops its own namespaces", "docs/factory/dispatcher.md"],
  ["An untrusted parent spec is named by number alone", "docs/factory/trust-policy.md"],
  ["One ticket, one branch, one PR", "docs/factory/implementer-run.md"],
  ["The per-file split protects every target for free", "docs/factory/merge-gate.md"],
  ["The reviewer is read-only", "docs/factory/reviewer-verdict.md"],
  ["No merge queue", "docs/factory/merge.md"],
  ["A run fails when the implementer run failed", "docs/factory/retry-escalation.md"],
  ["the first 20 merges are each re-reviewed", "docs/factory/audit.md"],
  ["Every factory PR carries one usage comment per role", "docs/factory/usage-rotation.md"],
  ["Sandcastle 0.12.0 pinned exactly", "docs/factory/engine.md"],
  ["an `agent-` prefix means the workflow runs a model", "docs/factory/layout.md"],
];

test("every topic file exists under docs/factory/", () => {
  for (const file of TOPIC_FILES) {
    assert.ok(exists(file), `${file} is missing`);
  }
});

test("docs/pipeline.md is a router: short, and pointing at every topic file", () => {
  const router = read(ROUTER);
  // A router, not the manual. The monolith was 286 lines; a router that keeps
  // one pointer per topic plus the pins is a fraction of that.
  const lines = router.split("\n").length;
  assert.ok(lines < 120, `${ROUTER} is ${lines} lines, too long for a router`);
  // Every topic is reachable from the router by name. The router lives in
  // docs/, so its links are relative (`factory/<name>.md`).
  for (const file of TOPIC_FILES) {
    const pointer = file.replace(/^docs\//, "");
    assert.ok(router.includes(pointer), `${ROUTER} does not point at ${pointer}`);
  }
});

test("no stage's prose is left in the router; each lives in its own topic file", () => {
  const router = read(ROUTER);
  for (const [sentence, home] of STAGE_PROSE) {
    assert.ok(!router.includes(sentence), `${ROUTER} still carries stage prose: "${sentence}"`);
    assert.ok(read(home).includes(sentence), `${home} is missing its prose: "${sentence}"`);
  }
});

test("each stage's prose sits in exactly one doc file, not duplicated across the split", () => {
  const docs = [ROUTER, ...TOPIC_FILES];
  for (const [sentence] of STAGE_PROSE) {
    const homes = docs.filter((file) => read(file).includes(sentence));
    assert.deepEqual(homes.length, 1, `"${sentence}" appears in ${homes.join(", ")}, not one file`);
  }
});

test("dispatcher.md names both spec signals: the Spec: title and sub-issues (#296, #304)", () => {
  // `select.ts` refuses a spec on title OR sub-issues; the doc must name both,
  // or a reader learns only half the rule.
  const dispatcher = read("docs/factory/dispatcher.md");
  assert.match(dispatcher, /`Spec:`/, "dispatcher.md does not name the Spec: title signal");
  assert.match(dispatcher, /sub-issues of its own/, "dispatcher.md does not name the sub-issue signal");
});
