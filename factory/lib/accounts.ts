/**
 * The run path around `rotation.ts`: read the accounts the workflow
 * enumerated, pick one, run, and re-run once on the next account when the
 * result event says rate limited. Logs name accounts by index, never by
 * token and never by label (#126).
 */
import * as fs from "node:fs";
import type { AgentProvider } from "@ai-hero/sandcastle";
import { claudeAgent } from "./claude-agent";
import { asArray, asOptionalString, asRecord, asString } from "./coerce";
import { required } from "./env";
import { fail, writeText } from "./run-output";
import { sh } from "./sh";
import { errorMessage } from "./errors";
import { createRunLog, type RunLog, settleRun } from "./run-log";
import { type AccountToken, isRateLimited, pickToken } from "./rotation";
import { summarizeResultEvents } from "./usage";
import { appendUsageRecord } from "./usage-record";

/** Path of the JSON file the workflow writes: `[{ index, label, token }]`. */
export const ACCOUNTS_FILE_VAR = "FACTORY_ACCOUNTS_FILE";

/** Attempts per run: the first, plus one re-run on the next account. */
const MAX_ATTEMPTS = 2;

export const parseAccounts = (value: unknown): AccountToken[] =>
  asArray(value, "accounts")
    .map((entry, i) => {
      const record = asRecord(entry, `accounts[${i}]`);
      const index = Number(record.index);
      if (!Number.isInteger(index) || index < 1) {
        throw new Error(`accounts[${i}].index must be a positive integer`);
      }
      return {
        index,
        label: asOptionalString(record.label) ?? `account-${index}`,
        token: asString(record.token, `accounts[${i}].token`),
      };
    })
    .sort((a, b) => a.index - b.index);

/**
 * Read the accounts file and delete it, so the tokens live only in this
 * process and in the env of the one agent run that uses each of them.
 *
 * Nothing is masked here. Every workflow that writes the file has already
 * masked every token in its `Enumerate accounts` step, before anything else
 * in the job prints, so a second `::add-mask::` would only re-state a
 * decision the workflow already took.
 */
export const loadAccounts = (file = required(ACCOUNTS_FILE_VAR)): AccountToken[] => {
  let accounts: AccountToken[];
  try {
    accounts = parseAccounts(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    return fail(`Could not read the accounts file: ${errorMessage(error)}`);
  } finally {
    fs.rmSync(file, { force: true });
  }
  if (accounts.length === 0) {
    return fail(
      "No CLAUDE_CODE_OAUTH_TOKEN_<n> secret is available. Pass secrets: inherit from the caller.",
    );
  }
  return accounts;
};

export interface RunOnAccountsOptions<A, T> {
  readonly name: string;
  readonly accounts: readonly AccountToken[];
  readonly agentFor: (account: AccountToken) => A;
  readonly run: (agent: A, log: RunLog) => Promise<T>;
  readonly createLog?: (name: string, account: AccountToken, attempt: number) => RunLog;
  readonly log?: (line: string) => void;
  /** Called before the re-run: put the working tree back where the first attempt found it. */
  readonly restore?: () => void;
}

export type RunOnAccountsOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly account: AccountToken }
  | {
      readonly ok: false;
      readonly reason: string;
      /** Every account tried was rate limited: a quota problem, not the ticket's. */
      readonly rateLimited: boolean;
    };

/**
 * How a log line names an account: by index, never by its
 * `CLAUDE_ACCOUNT_<n>` label (#126). The label is free text an operator
 * chose, often their own address, and these lines reach two published
 * surfaces: a public target's Actions log, and the escalation comment the
 * retry handler posts, which attaches the failed run's step log.
 */
const describe = (account: AccountToken): string => `account ${account.index}`;

/**
 * Pick, run, and rotate once. Rate limits are read from the raw result
 * events the run log captured, never from an exit code. Any other failure
 * stays on the account it happened on, and an attempt whose last result
 * event succeeded is a success whatever an earlier event said: the library
 * retries a turn, and the retry can land on quota the first turn lacked.
 */
export const runOnAccounts = async <A, T>(
  options: RunOnAccountsOptions<A, T>,
): Promise<RunOnAccountsOutcome<T>> => {
  const {
    name,
    accounts,
    createLog = createRunLog,
    log = console.log,
    restore = () => {},
  } = options;
  const rateLimited = new Set<number>();
  const limits: string[] = [];
  log(
    `[${name}] ${accounts.length} account(s) configured: ` +
      accounts.map((a) => a.index).join(", "),
  );

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const account = pickToken(accounts, undefined, rateLimited);
    if (!account) break;
    if (attempt > 1) restore();
    log(`[${name}] attempt ${attempt} on ${describe(account)}`);
    const runLog = createLog(`${name}.account-${account.index}`, account, attempt);

    const settled = await settleRun(runLog, () =>
      options.run(options.agentFor(account), runLog),
    );

    const limit = settled.ok ? undefined : runLog.resultEvents.find(isRateLimited);
    if (limit) {
      rateLimited.add(account.index);
      limits.push(`${describe(account)}: ${limit.result ?? limit.subtype}`);
      log(
        `[${name}] ${describe(account)} rate-limited; detected from the result event ` +
          `(is_error=${limit.is_error}, subtype=${limit.subtype}, api_error_status=${limit.api_error_status ?? "none"}), ` +
          `not from the exit code: ${limit.result ?? JSON.stringify(limit.errors ?? [])}`,
      );
      continue;
    }
    if (!settled.ok) {
      log(`[${name}] failed on ${describe(account)}`);
      return { ok: false, reason: settled.failure, rateLimited: false };
    }
    log(`[${name}] finished on ${describe(account)}`);
    return { ok: true, value: settled.value, account };
  }

  return {
    ok: false,
    rateLimited: true,
    reason:
      `Rate limited on every account tried (${limits.length} of ${accounts.length} configured; one re-run allowed): ` +
      limits.join("; "),
  };
};

/**
 * Reset the target repo (the cwd) to the commit the run started on, dropping
 * anything a rate-limited first attempt left behind, so the re-run starts
 * from the same tree and its commit count means what the scripts think.
 */
const restoreWorkingTree = (startSha: string) => (): void => {
  sh(`git reset --hard ${startSha}`);
  sh("git clean -fd");
  console.log(`Working tree reset to ${startSha.slice(0, 12)} before the re-run.`);
};

export interface RunWithRotationOptions {
  /** Names the usage comment: implementer, reviewer, audit. */
  readonly role: string;
}

/**
 * Every attempt's usage goes to OUTPUT_DIR the moment its log is settled
 * (#18), so a run that fails afterwards still reports what it used. The
 * finish() call is what the rotation loop makes after each attempt, so the
 * record is taken there rather than after the whole run. Only the usage
 * write is guarded: the log's own finish() runs unguarded, since its
 * failure verdict is the run's, not a report.
 */
const recordingLog = (
  role: string,
  model: string,
): ((name: string, account: AccountToken, attempt: number) => RunLog) => {
  const runUrl = process.env.RUN_URL ?? "";
  return (logName, account, attempt) => {
    const log = createRunLog(logName);
    return {
      ...log,
      finish() {
        const failure = log.finish();
        try {
          appendUsageRecord(
            {
              role,
              name: logName.replace(/\.account-\d+$/, ""),
              model,
              account: account.label,
              attempt,
              wallMs: log.wallMs(),
              ...summarizeResultEvents(log.resultEvents),
              ...(failure ? { failure } : {}),
            },
            { runUrl },
          );
        } catch (error) {
          // Usage is a report, never a reason to fail the run.
          console.warn(`::warning::Could not record usage for ${logName}: ${errorMessage(error)}`);
        }
        return failure;
      },
    };
  };
};

/** Written next to failure_reason.txt when every account was rate limited; the retry handler reads it (#16). */
export const RATE_LIMITED_FILE = "rate_limited.txt";

/**
 * The scripts' entry point: accounts from the workflow's file, the factory's
 * Claude provider per account. Exits the process on failure, like
 * `runOrFail`. Rate limits on every account leave a marker so the failure is
 * not charged to the ticket.
 */
export const runWithRotation = async <T>(
  name: string,
  model: string,
  run: (agent: AgentProvider, log: RunLog) => Promise<T>,
  options: RunWithRotationOptions = { role: "agent" },
): Promise<T> => {
  const outcome = await runOnAccounts({
    name,
    accounts: loadAccounts(),
    agentFor: (account) => claudeAgent(model, account),
    run,
    createLog: recordingLog(options.role, model),
    restore: restoreWorkingTree(sh("git rev-parse HEAD").trim()),
  });
  if (outcome.ok) return outcome.value;
  if (outcome.rateLimited) writeText(RATE_LIMITED_FILE, outcome.reason);
  return fail(outcome.reason);
};
