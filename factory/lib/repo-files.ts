/**
 * The files of this repo a text fixture scans, for the tests that hold a page or a copied line to
 * what it agreed to say (`onboard/judged-path-instruction.test.ts`, `onboard/token-scope.test.ts`,
 * `lib/agent-docs.test.ts`).
 *
 * Named roots rather than a walk from the top, because a checkout of this repo holds other
 * sessions' worktrees under `.claude/`. `repoFiles` leaves test files out, since the agreed literal
 * a fixture compares against lives in one; `allRepoFiles` keeps them, for a test whose subject is
 * every file in the tree.
 */
import * as fs from "node:fs";
import * as nodePath from "node:path";

/** The roots worth scanning: the pages a maintainer or an agent reads, what a target copies, the code. */
const REPO_ROOTS = ["README.md", "CONTEXT.md", "AGENTS.md", "CLAUDE.md", "docs", "templates", "scripts", "factory", ".github"];

/** Every file under `entry` that `keep` accepts, by its path from the repo root. A missing root contributes none. */
const walk = (entry: string, keep: (file: string) => boolean): string[] => {
  const url = new URL(`../../${entry}`, import.meta.url);
  if (!fs.existsSync(url)) return [];
  if (!fs.statSync(url).isDirectory()) return keep(entry) ? [entry] : [];
  return fs.readdirSync(url).flatMap((name) => (name === "node_modules" ? [] : walk(`${entry}/${name}`, keep)));
};

/** Every non-test file under the roots. */
export const repoFiles = (): string[] => REPO_ROOTS.flatMap((root) => walk(root, (file) => !file.endsWith(".test.ts")));

/** Every file under the roots, test files included. */
export const allRepoFiles = (): string[] => REPO_ROOTS.flatMap((root) => walk(root, () => true));

/** Every TypeScript module under `factory/`, repo-relative; the `.test.ts` files only when `tests` asks for them. */
export const factoryModules = ({ tests }: { tests: boolean }): string[] =>
  (tests ? allRepoFiles() : repoFiles()).filter((file) => file.startsWith("factory/") && file.endsWith(".ts"));

/**
 * A module's source with its comments blanked, so a doc comment that names a
 * function is not read as a call to it and one that names a label is not read
 * as the module spelling that label.
 */
export const codeOf = (module: string): string =>
  fs
    .readFileSync(new URL(`../../${module}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");

/** The repo-relative module `module` imports `name` from, by that name and unaliased, or undefined. */
export const importedFrom = (module: string, name: string): string | undefined => {
  for (const [, names, from] of codeOf(module).matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
    if (names!.split(",").some((n) => n.trim().replace(/^type\s+/, "") === name)) {
      return nodePath.posix.join(nodePath.posix.dirname(module), from!);
    }
  }
  return undefined;
};
