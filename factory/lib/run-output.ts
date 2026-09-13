/**
 * Everything a script writes for the workflow to read: OUTPUT_DIR, the two
 * writers into it, and `fail`, which puts the reason there and exits. Were in
 * the vendored `agent-workflows/shared/common.ts` until #313 dissolved it;
 * his functions, unchanged, grouped by the directory they all write to.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const outputDir = (): string => process.env.OUTPUT_DIR ?? "/tmp";

/**
 * End the run with a reason the workflow can post: `failure_reason.txt` in
 * OUTPUT_DIR, then exit 1. Returns `never`, so a caller can `return fail(...)`.
 */
export const fail = (message: string): never => {
  console.error(`\nFAILED: ${message}`);
  fs.mkdirSync(outputDir(), { recursive: true });
  fs.writeFileSync(path.join(outputDir(), "failure_reason.txt"), message);
  process.exit(1);
};

export const writeJson = (filename: string, value: unknown): void => {
  fs.mkdirSync(outputDir(), { recursive: true });
  fs.writeFileSync(
    path.join(outputDir(), filename),
    JSON.stringify(value, null, 2),
  );
};

export const writeText = (filename: string, value: string): void => {
  fs.mkdirSync(outputDir(), { recursive: true });
  fs.writeFileSync(path.join(outputDir(), filename), value);
};
