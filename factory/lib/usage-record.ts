/**
 * Where a job's usage records live: `usage.json` in OUTPUT_DIR, appended by
 * every attempt of every `runWithRotation` call in the process, and
 * `usage-<role>.md`, the comment the workflow posts on the PR (#18). Written
 * after each attempt, so a run that then fails still leaves its usage.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { outputDir } from "./run-output";
import { errorMessage } from "./errors";
import { formatUsageComment, type RunUsageRecord, usageMarker } from "./usage";

const RECORDS_FILE = "usage.json";

export const usageCommentFile = (role: string): string => `usage-${role}.md`;

/**
 * The records so far. A missing, unreadable, or malformed file reads as
 * empty, both here and when appending: usage is a report, and a corrupt
 * report must never stop a run or the next record.
 */
export const readUsageRecords = (dir = outputDir()): RunUsageRecord[] => {
  const file = path.join(dir, RECORDS_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`::warning::Ignoring unreadable ${file}: ${errorMessage(error)}`);
    }
    return [];
  }
  return Array.isArray(parsed) ? (parsed as RunUsageRecord[]) : [];
};

export const appendUsageRecord = (
  record: RunUsageRecord,
  context: { readonly runUrl: string; readonly dir?: string },
): RunUsageRecord[] => {
  const dir = context.dir ?? outputDir();
  fs.mkdirSync(dir, { recursive: true });
  const records = [...readUsageRecords(dir), record];
  fs.writeFileSync(path.join(dir, RECORDS_FILE), JSON.stringify(records, null, 2));
  // This file is posted as a comment of its own, so the marker the workflow
  // upserts by goes on top of the table the usage module returns.
  fs.writeFileSync(
    path.join(dir, usageCommentFile(record.role)),
    `${usageMarker(record.role)}\n${formatUsageComment(record.role, records, { runUrl: context.runUrl })}\n`,
  );
  return records;
};
