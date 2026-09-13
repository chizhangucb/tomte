/**
 * The two shell helpers the scripts share. Were in the vendored
 * `agent-workflows/shared/common.ts` until #313 dissolved it; his functions,
 * unchanged, in a home of their own. `gh.ts` is the one wrapper for the
 * GitHub CLI and does not go through here.
 */
import { execSync } from "node:child_process";

export const sh = (cmd: string): string =>
  execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** The same command where a non-zero exit is an answer ("") rather than a failure. */
export const safeSh = (cmd: string): string => {
  try {
    return sh(cmd);
  } catch {
    return "";
  }
};
