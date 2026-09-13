import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentStreamEvent, LoggingOption } from "@ai-hero/sandcastle";
import { fail, outputDir } from "./run-output";
import { errorMessage } from "./errors";

/**
 * Claude's final `result` event from stream-json, kept raw.
 *
 * sandcastle's parser drops `is_error` and `subtype` from this line and the
 * orchestrator only fails on a nonzero exit code, but `claude -p` exits 0 on a
 * rate limit or a refused request. So every factory run logs to a file with
 * the stream event hook, keeps each raw `result` line, and decides success
 * from those, never from the library's return value.
 */
export interface ResultEvent {
  readonly type: "result";
  readonly is_error?: boolean;
  readonly subtype?: string;
  readonly result?: string;
  /** Set when the final turn ended in an API error; 429 is a rate limit. */
  readonly api_error_status?: number | null;
  /** Error messages on the error_* subtypes. */
  readonly errors?: readonly string[];
  readonly [key: string]: unknown;
}

/** Parse one raw stdout line; undefined unless it is a `result` event. */
export const parseResultEvent = (line: string): ResultEvent | undefined => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { type?: unknown }).type !== "result"
  ) {
    return undefined;
  }
  return parsed as ResultEvent;
};

export interface SkillInvocation {
  readonly skill: string;
  readonly args: string;
}

/**
 * Skill invocations on one raw stdout line. sandcastle's parser only surfaces
 * Bash, WebSearch, WebFetch, and Agent tool calls, so the review skills the
 * implementer must run would be invisible in the job log without this.
 */
export const parseSkillInvocations = (line: string): SkillInvocation[] => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const content = (parsed as { type?: unknown; message?: { content?: unknown } })
    ?.message?.content;
  if ((parsed as { type?: unknown }).type !== "assistant" || !Array.isArray(content)) {
    return [];
  }
  const invocations: SkillInvocation[] = [];
  for (const block of content as Array<{ type?: unknown; name?: unknown; input?: unknown }>) {
    if (block.type !== "tool_use" || block.name !== "Skill") continue;
    const input = block.input as { skill?: unknown; args?: unknown } | undefined;
    if (typeof input?.skill !== "string") continue;
    invocations.push({
      skill: input.skill,
      args: typeof input.args === "string" ? input.args : "",
    });
  }
  return invocations;
};

export const NO_RESULT_EVENT_FAILURE =
  "No result event was observed; the agent did not finish a turn.";

/**
 * The reason a run failed, or undefined when its last result event reports
 * success. Only the last event judges the run: the library retries a turn
 * whose output was malformed, so an errored attempt can be followed by one
 * that succeeded. Earlier events stay in the list for rate-limit detection.
 * Zero result events is a failure too: the agent never reached its final
 * message.
 */
export const runFailure = (
  events: readonly ResultEvent[],
): string | undefined => {
  const last = events[events.length - 1];
  if (!last) return NO_RESULT_EVENT_FAILURE;
  if (last.is_error !== true) return undefined;
  // A budget stop puts its message in `errors`, not `result`.
  const errors = Array.isArray(last.errors)
    ? last.errors.filter((e): e is string => typeof e === "string" && e.trim().length > 0)
    : [];
  const detail =
    typeof last.result === "string" && last.result.trim().length > 0
      ? last.result.trim()
      : errors.length > 0
        ? errors.join("; ")
        : JSON.stringify(last);
  return `Agent reported an error (${last.subtype ?? "unknown"}): ${detail}`;
};

export interface RunLog {
  readonly logging: LoggingOption;
  readonly logPath: string;
  /** Every result event seen so far, in order; `record` is the only writer. */
  readonly resultEvents: readonly ResultEvent[];
  /** Keep a result event: appended to the list and to the events file at once. */
  record(event: ResultEvent): void;
  /** Wall time of the attempt so far, or until finish() was called. Usage reporting (#18). */
  wallMs(): number;
  /** Close the attempt and return the run failure, if any. Idempotent. */
  finish(): string | undefined;
}

/**
 * File logging for one factory run. Text, tool-call, and skill-invocation
 * events are echoed to stdout so the job log shows progress; raw `result`
 * lines are captured for the success decision and for rotation, each one
 * appended to `<name>.result-events.jsonl` as it arrives so the file
 * survives the job timeout killing the process.
 */
export const createRunLog = (name: string): RunLog => {
  const logsDir = path.join(outputDir(), "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, `${name}.log`);
  const eventsPath = path.join(logsDir, `${name}.result-events.jsonl`);
  const resultEvents: ResultEvent[] = [];
  const startedAt = Date.now();
  let finishedAt: number | undefined;
  let failure: string | undefined;

  const record = (event: ResultEvent): void => {
    resultEvents.push(event);
    fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
  };

  const onAgentStreamEvent = (event: AgentStreamEvent): void => {
    if (event.type === "raw") {
      const parsed = parseResultEvent(event.line);
      if (parsed) record(parsed);
      for (const { skill, args } of parseSkillInvocations(event.line)) {
        console.log(`[${name}] skill ${skill} ${args}`);
      }
      return;
    }
    if (event.type === "toolCall") {
      console.log(`[${name}] tool ${event.name} ${event.formattedArgs}`);
      return;
    }
    console.log(`[${name}] ${event.message}`);
  };

  return {
    logging: { type: "file", path: logPath, onAgentStreamEvent },
    logPath,
    resultEvents,
    record,
    wallMs: () => (finishedAt ?? Date.now()) - startedAt,
    finish() {
      if (finishedAt !== undefined) return failure;
      finishedAt = Date.now();
      failure = runFailure(resultEvents);
      console.log(
        `[${name}] ${resultEvents.length} result event(s); ` +
          (failure ? `FAILED: ${failure}` : "last one reported success") +
          `; ${Math.round((finishedAt - startedAt) / 1000)}s wall; log at ${logPath}`,
      );
      return failure;
    },
  };
};

export type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: string };

/**
 * Run the agent and always settle the log, whether the library returned or
 * threw. A last result event carrying `is_error` is the reason that gets
 * reported, since the library's own error (a missing output tag, say) is
 * usually the symptom of it. When no result event arrived at all, the
 * library's error is the only information there is (an auth failure, a
 * nonzero exit), so that is what gets reported.
 */
export const settleRun = async <T>(
  log: RunLog,
  runAgent: () => Promise<T>,
): Promise<Settled<T>> => {
  let result: T | undefined;
  let thrown: unknown;
  let didThrow = false;
  try {
    result = await runAgent();
  } catch (error) {
    thrown = error;
    didThrow = true;
  }
  const failure = log.finish();
  if (failure) {
    if (didThrow && log.resultEvents.length === 0) {
      return { ok: false, failure: `${errorMessage(thrown)} (${NO_RESULT_EVENT_FAILURE})` };
    }
    return { ok: false, failure };
  }
  if (didThrow) return { ok: false, failure: errorMessage(thrown) };
  return { ok: true, value: result as T };
};

/**
 * `settleRun`, then exit the process on failure. Scripts should go through
 * `runWithRotation` (accounts.ts), which adds account rotation on top of
 * this; call this directly only for a run that must not rotate.
 */
export const runOrFail = async <T>(
  log: RunLog,
  runAgent: () => Promise<T>,
): Promise<T> => {
  const settled = await settleRun(log, runAgent);
  return settled.ok ? settled.value : fail(settled.failure);
};
