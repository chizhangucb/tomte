import { fail } from "./run-output";
import { sh } from "./sh";

/** `git status --porcelain` lines that are not sandcastle's own byproducts. */
export const worktreeState = (): string[] =>
  sh("git status --porcelain")
    .split("\n")
    .filter((line) => line.trim().length > 0 && !line.includes(".sandcastle/"));

/**
 * The reviewer and the audit are read-only. They judge the sha the workflow
 * gave them; any commit, any file they dirtied, or any moved HEAD fails the
 * run before a verdict is written, so nothing they touched can reach the
 * branch. The baseline is taken after the workflow's own test run, whose
 * byproducts are not the agent's doing.
 */
export const assertReadOnly = (
  who: string,
  judgedSha: string,
  commits: number,
  baseline: readonly string[],
): void => {
  const head = sh("git rev-parse HEAD").trim();
  if (commits > 0 || head !== judgedSha) {
    fail(
      `${who} must not commit: ${commits} commit(s) made, HEAD ${head.slice(0, 7)} vs judged ${judgedSha.slice(0, 7)}.`,
    );
  }
  const before = new Set(baseline);
  const dirty = worktreeState().filter((line) => !before.has(line));
  if (dirty.length > 0) {
    fail(`${who} must not edit files: ${dirty.join("; ")}`);
  }
};
