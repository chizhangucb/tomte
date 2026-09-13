import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { targetRepo } from "./target-repo.ts";

/**
 * The key choice lives here and nowhere else (#281), and #288 is the contract
 * step of its rename: the module reads the two settled names only, `FACTORY_PAT`
 * for writes and `READ_TOKEN` for reads. The old names it replaced (`GH_TOKEN`
 * for writes, `STATUS_TOKEN` and `GH_TOKEN` for reads) are gone: a script wired
 * with only the old names is refused with a clear error naming the key it is
 * missing, rather than handed an empty token. These tests prove which token
 * reaches `gh` for a write and for a read, and that the old names no longer work.
 *
 * A stub `gh` on PATH echoes the token env it was handed, so the observed value
 * is the key the module chose. `factoryLogin` is the write path (its `gh api
 * user` uses the writing key); `jobs` is a read a fine-grained PAT cannot make
 * (Actions jobs), so it uses the reading key. The stub prints each so the
 * function hands it back: `factoryLogin` returns the token, and `jobs` carries
 * it in the one job's name.
 */
let stubDir: string;
let realPath: string | undefined;

const stubGh = (): void => {
  const file = path.join(stubDir, "gh");
  // A write call (`gh api user ...`) prints the token bare; a jobs read prints
  // one job whose name is the token, so parseItems hands it back as JobSummary.
  fs.writeFileSync(
    file,
    [
      "#!/bin/sh",
      "case \"$*\" in",
      "  *jobs*) printf '{\"name\":\"%s\",\"conclusion\":\"success\"}\\n' \"$GH_TOKEN\" ;;",
      "  *) printf '%s' \"$GH_TOKEN\" ;;",
      "esac",
      "",
    ].join("\n"),
  );
  fs.chmodSync(file, 0o755);
};

const KEY_VARS = ["FACTORY_PAT", "READ_TOKEN", "STATUS_TOKEN", "GH_TOKEN"] as const;
let savedKeys: Record<string, string | undefined>;

before(() => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "target-repo-stub-"));
  realPath = process.env.PATH;
  process.env.PATH = `${stubDir}:${realPath ?? ""}`;
  stubGh();
});

after(() => {
  process.env.PATH = realPath;
  fs.rmSync(stubDir, { recursive: true, force: true });
});

afterEach(() => {
  for (const name of KEY_VARS) {
    if (savedKeys[name] === undefined) delete process.env[name];
    else process.env[name] = savedKeys[name];
  }
});

/** Set exactly the given key vars for this case, clearing the rest, restored afterEach. */
const wireKeys = (keys: Partial<Record<(typeof KEY_VARS)[number], string>>): void => {
  savedKeys = Object.fromEntries(KEY_VARS.map((name) => [name, process.env[name]]));
  for (const name of KEY_VARS) {
    if (keys[name] === undefined) delete process.env[name];
    else process.env[name] = keys[name];
  }
};

/**
 * The module reads the env when its factory is built (both keys resolved once at
 * construction), so wire the keys before building it. A build with a missing key
 * throws, so these observe the token by building and calling in one step.
 */
const writeKeyOf = (): string => targetRepo("owner/repo", "main").factoryLogin();
const readKeyOf = (): string => targetRepo("owner/repo", "main").jobs(1)[0]?.name ?? "";

test("wired with only the new names, writes with FACTORY_PAT and reads with READ_TOKEN", () => {
  wireKeys({ FACTORY_PAT: "pat-write", READ_TOKEN: "read" });
  assert.equal(writeKeyOf(), "pat-write");
  assert.equal(readKeyOf(), "read");
});

test("the old names are refused: wired with only GH_TOKEN and STATUS_TOKEN, the missing writing key throws by name", () => {
  wireKeys({ GH_TOKEN: "gh-write", STATUS_TOKEN: "status-read" });
  assert.throws(() => targetRepo("owner/repo", "main"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /FACTORY_PAT/);
    return true;
  });
});

test("the old read names are refused: with the writing key set but only STATUS_TOKEN and GH_TOKEN for reads, the missing reading key throws by name", () => {
  wireKeys({ FACTORY_PAT: "pat-write", STATUS_TOKEN: "status-read", GH_TOKEN: "gh-read" });
  assert.throws(() => targetRepo("owner/repo", "main"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /READ_TOKEN/);
    return true;
  });
});

test("the old names are inert when the new ones are set: FACTORY_PAT and READ_TOKEN win, GH_TOKEN and STATUS_TOKEN are ignored", () => {
  wireKeys({ FACTORY_PAT: "pat-write", GH_TOKEN: "gh-write", READ_TOKEN: "read", STATUS_TOKEN: "status-read" });
  assert.equal(writeKeyOf(), "pat-write");
  assert.equal(readKeyOf(), "read");
});
