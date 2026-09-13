/**
 * The grab-bag is gone (#313). `agent-workflows/shared/common.ts` held sixteen
 * unrelated exports behind one import path; each now lives in the module that
 * owns what it does, and `gh` is imported from `lib/gh.ts` rather than
 * re-exported. Nothing in the type system says a helper cannot drift back into
 * a shared bag, so the subject here is the tree itself, in the style of
 * `strip-types-cone.test.ts` and `dispatch/workflow-names.test.ts`.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const repoRoot = new URL("../../", import.meta.url);

/** Each rehomed helper and the module that owns it now. */
const HELPER_HOMES: Record<string, readonly string[]> = {
  "factory/lib/run-output.ts": ["outputDir", "fail", "writeJson", "writeText"],
  "factory/lib/env.ts": ["required"],
  "factory/lib/sh.ts": ["sh", "safeSh"],
  "factory/lib/coerce.ts": [
    "standardSchema",
    "asRecord",
    "asString",
    "asOptionalString",
    "asArray",
  ],
  "factory/lib/claude-agent.ts": ["claudeConfigDir", "claudeAgent"],
  "factory/lib/gh.ts": ["gh"],
};

/** An import of the module the grab-bag used to be, by every specifier that could name it. */
const DISSOLVED = /(?:\bfrom|\bimport\()\s*["'][^"']*\bcommon(?:\.ts)?["']/;

/** Every `.ts` file under `factory/`, `plugins/` aside: that subtree is a vendored plugin. */
const factorySources = (dir = "factory"): string[] => {
  const entries = fs.readdirSync(new URL(dir, repoRoot), { withFileTypes: true });
  return entries.flatMap((entry) => {
    const file = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "plugins" ? [] : factorySources(file);
    return entry.name.endsWith(".ts") ? [file] : [];
  });
};

test("every helper the grab-bag held is exported from the module that owns what it does", () => {
  for (const [home, helpers] of Object.entries(HELPER_HOMES)) {
    const onDisk = new URL(home, repoRoot);
    assert.ok(fs.existsSync(onDisk), `${home} exists`);
    const source = fs.readFileSync(onDisk, "utf8");
    for (const helper of helpers) {
      assert.match(
        source,
        new RegExp(String.raw`^export (?:const|function|interface) ${helper}\b`, "m"),
        `${home} exports ${helper}`,
      );
    }
  }
});

test("no module imports the dissolved grab-bag, and it is not on disk", () => {
  assert.equal(
    fs.existsSync(new URL("factory/agent-workflows/shared/common.ts", repoRoot)),
    false,
    "shared/common.ts is dissolved, not still sitting there",
  );
  for (const file of factorySources()) {
    const source = fs.readFileSync(new URL(file, repoRoot), "utf8");
    assert.ok(!DISSOLVED.test(source), `${file} imports the dissolved shared/common`);
  }
});

test("gh is imported from its own module, never re-exported by another", () => {
  for (const file of factorySources()) {
    if (file === "factory/lib/gh.ts") continue;
    const source = fs.readFileSync(new URL(file, repoRoot), "utf8");
    assert.ok(
      !/^export \{[^}]*\bgh\b[^}]*\} from/m.test(source),
      `${file} re-exports gh instead of leaving callers to import lib/gh.ts`,
    );
  }
});
