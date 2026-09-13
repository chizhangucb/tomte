/**
 * The factory's address is written in one constant and checked everywhere
 * else (#116).
 *
 * Two checks, because neither catches the other's failure. One holds the seven
 * `factory_repo` defaults to the constant, which is the copy that breaks a
 * target's jobs when it is wrong. One hunts the old name across every tracked
 * file, which is the copy that breaks nothing and is therefore never noticed:
 * GitHub redirects a renamed repo, so a missed reference keeps working right
 * up until someone else takes the name.
 *
 * The second check exempts dated records rather than rewriting them. A research
 * page and a recorded API fixture each say what was true when they were
 * written, and #261 settled that a record is amended and not rewritten.
 *
 * The hunt is for the qualified `owner/repo` address only, which is the form
 * that addresses the factory. The bare words are left to prose: "factory" is a
 * common noun all over this repo, and `docs/adr/0003` names the old fixture in
 * an argument it made before the rename, which is an amendment's job.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { FACTORY_REPO, FORMER_FACTORY_REPO } from "./factory-repo.ts";

const repoRoot = new URL("../../", import.meta.url);

/** Every tracked file, the way `heartbeat/send.test.ts` walks them. */
const tracked = (): readonly string[] => {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: fileURLToPath(repoRoot), encoding: "utf8" }).split("\0").filter(Boolean);
  assert.ok(files.length > 0, "the walk found no tracked files at all");
  return files;
};

const read = (file: string): string => fs.readFileSync(new URL(file, repoRoot), "utf8");

/**
 * Files that name the old repo as a matter of record, not as an address.
 *
 * Each one is dated evidence: two research pages written against the old name,
 * and the dispatcher's recorded GitHub pages, which are a capture of real API
 * responses and would be a forgery if they were edited to say otherwise. Plus
 * `factory-repo.ts` itself, which has to spell the old name out to give the
 * hunt something to look for.
 */
const RECORDS = new Set([
  // The page that tells the rename's own story, and cannot tell it without
  // naming what the repo was called: the procedure that answers a rename being
  // an outage on every target. Split out of docs/pipeline.md into the waiver
  // topic file (#297), the outage being a waiver window.
  "docs/factory/waiver.md",
  "docs/research/sandcastle-inventory-2026-09.md",
  "docs/research/sandcastle-peers-2026-09.md",
  "factory/dispatch/fixtures/pages/issues.json",
  "factory/dispatch/fixtures/pages/jobs.json",
  "factory/dispatch/fixtures/pages/runs.json",
  "factory/dispatch/fixtures/pages/status.json",
  "factory/dispatch/fixtures/pages/timeline.json",
  "factory/lib/factory-repo.ts",
]);

test("every workflow that checks the factory out defaults to the factory's name", () => {
  // The copy that fails loudly, for the reason `factory-repo.ts` gives.
  const withInput = tracked().filter((f) => f.startsWith(".github/workflows/") && read(f).includes("factory_repo:"));
  assert.ok(withInput.length > 0, "no workflow declares a factory_repo input, so this test is checking nothing");
  for (const file of withInput) {
    // Scoped to the input's own block, and not to the next `default:` anywhere
    // below it: a `factory_repo` declared with no default would otherwise read
    // the following input's default, so the missing-default case could never
    // fire and the failure would name another input's value.
    const block = /^([ \t]*)factory_repo:[^\n]*\n((?:\1[ \t]+[^\n]*\n)*)/m.exec(read(file));
    assert.ok(block, `${file} mentions factory_repo but declares no such input`);
    const declared = /^[ \t]*default:[ \t]*(.+?)[ \t]*$/m.exec(block[2]!);
    assert.ok(declared, `${file} declares factory_repo with no default, so a caller that omits it checks out nothing`);
    // Unquoted in every workflow today, and YAML lets either, so a quoted
    // default is a pass and not a spurious red.
    assert.equal(declared[1]!.replace(/^(['"])(.*)\1$/, "$2"), FACTORY_REPO, `${file} defaults factory_repo to ${declared[1]}`);
  }
});

test("the caller template calls the factory by name, and calls only this factory", () => {
  // Asserted positively, not just left to the old-name hunt. The template is
  // what every new target's caller is copied from, so a third name there --
  // neither the current one nor the one being hunted -- would reach a target
  // and fail at checkout with nothing here having gone red.
  const uses = [...read("templates/factory.yml").matchAll(/^\s*uses:\s*(\S+?)\/\.github\/workflows\/\S+$/gm)].map((m) => m[1]);
  assert.ok(uses.length > 0, "the template calls no reusable workflow at all, so this test is checking nothing");
  assert.deepEqual([...new Set(uses)], [FACTORY_REPO], `the template calls ${[...new Set(uses)].join(", ")}`);
});

test("the caller-inputs table documents the default the workflows actually carry", () => {
  // The caller-inputs table moved to its own topic file (#297). It is checked
  // here so the `factory_repo` row's live copy of the default cannot drift from
  // what the workflows carry.
  const page = "docs/factory/caller-inputs.md";
  const row = /\|\s*`factory_repo`\s*\|[^|]*\|\s*`([^`]+)`\s*\|/.exec(read(page));
  assert.ok(row, `${page} has no factory_repo row in its caller inputs table`);
  assert.equal(row[1], FACTORY_REPO, `${page} documents the default as ${row[1]}`);
});

test("no file still addresses the factory by the name it has left behind", () => {
  // The copy that fails silently, which is why it is worth a test at all. A
  // stale reference keeps working on GitHub's rename redirect, so nothing goes
  // red and nobody looks, until the old name is taken by someone else and the
  // redirect starts pointing somewhere the factory does not control.
  const stale = tracked().filter((file) => !RECORDS.has(file) && read(file).includes(FORMER_FACTORY_REPO));
  assert.deepEqual(stale, [], `these still name ${FORMER_FACTORY_REPO}: ${stale.join(", ")}`);
});

test("every file exempted as a record exists and still names the old repo", () => {
  // An exemption list is a list that rots: a file renamed or cleaned up leaves
  // an entry behind that silently exempts nothing, and the next real drift in
  // a file added to this set passes unnoticed. So each entry has to earn its
  // place on every run.
  const all = new Set(tracked());
  for (const file of RECORDS) {
    assert.ok(all.has(file), `${file} is exempted as a record but is not tracked`);
    assert.ok(read(file).includes(FORMER_FACTORY_REPO), `${file} is exempted as a record but no longer names ${FORMER_FACTORY_REPO}`);
  }
});
