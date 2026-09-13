/**
 * The shell every agent workflow runs inside, and the only place it is
 * written (#313). Four workflows carried a copy-adapted version of it:
 * rotation over the accounts, one config dir per account, `noSandbox()`, the
 * prompt file beside the script, the plugin install before each attempt, and
 * the `try`/`catch` that turns anything thrown into a failure reason the
 * workflow can post.
 *
 * What stays per-workflow is what the prompt says: `prompt.md`, the
 * `promptArgs` filled into it, `extraction.md` and the schema the tag is
 * validated against. The workflow's body is a callback, so the context it
 * fetches, the model it resolves from that context, and the files it writes
 * afterwards are all inside the one `try`.
 *
 * `runWithExtraction` is untouched and still vendored: this wraps it rather
 * than reaching inside it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import type { AgentProvider, RunOptions, RunResult } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  runWithExtraction,
  type RunWithExtractionOptions,
} from "../agent-workflows/shared/run-with-extraction";
import { runWithRotation } from "./accounts";
import { errorMessage } from "./errors";
import { installPluginsForAttempt } from "./plugins";
import type { Role } from "./model";
import { fail } from "./run-output";
import type { RunLog } from "./run-log";

/** One agent run, as a workflow asks for it once it has read its context. */
export interface AgentRunRequest {
  /** Resolved by the calling script (`model.ts`), so a `model:` label can move it. */
  readonly model: string;
  /**
   * The prompt's placeholders. A function when one of them is built from the
   * harness in hand, which is the attempt's own agent (implement renders its
   * bundled-review step off it).
   */
  readonly promptArgs:
    | Record<string, string>
    | ((agent: AgentProvider) => Record<string, string>);
}

export type RunAgent<T> = (request: AgentRunRequest) => Promise<RunResult & { output: T }>;

export interface AgentWorkflowOptions<T> {
  /** Rotation's name for the run: its log prefix and its usage record. */
  readonly name: string;
  /** sandcastle's name for the run, as the agent log carries it. */
  readonly runName: string;
  /** Names the usage comment, and is the role `model.ts` resolved the model for. */
  readonly role: Role;
  /** The workflow's own folder: `prompt.md`, and `extraction.md` when it extracts. */
  readonly dir: string;
  /**
   * Whether the vendored plugins go into the attempt's config dir. True for a
   * prompt that invokes a skill by name, which is the two implementer runs;
   * the reviewer and the audit invoke none and install none.
   */
  readonly plugins: boolean;
  /** The tag's schema, when the run ends in an extraction pass over its session. */
  readonly extract?: StandardSchemaV1<unknown, T>;
  /**
   * Over the library's 10 minute default, for a prompt whose sub-agents can
   * leave this stream silent for longer than that.
   */
  readonly idleTimeoutSeconds?: number;

  /**
   * The four calls the shell makes and the exit it takes, defaulted to the
   * real ones and overridable so a test can prove the shell without spending
   * a subscription, the way `runOnAccounts` takes its log and its restore.
   */
  readonly rotate?: <R>(
    name: string,
    model: string,
    run: (agent: AgentProvider, log: RunLog) => Promise<R>,
    options: { role: string },
  ) => Promise<R>;
  readonly installPlugins?: (configDir: string | undefined) => void;
  readonly produce?: (options: RunOptions) => Promise<RunResult>;
  readonly extractOutput?: (
    options: RunWithExtractionOptions<T>,
  ) => Promise<RunResult & { output: T }>;
  readonly onFailure?: (message: string) => never;
}

/**
 * Run one agent workflow: `body` does the workflow's own work and calls `run`
 * for the agent run itself, as many times as it has runs to make (a reviewer
 * with no criteria to tick makes none). Nothing is returned: what a workflow
 * produces it writes, and a failure ends the process rather than the call.
 */
export const runAgentWorkflow = async <T = never>(
  options: AgentWorkflowOptions<T>,
  body: (run: RunAgent<T>) => Promise<void>,
): Promise<void> => {
  const {
    rotate = runWithRotation,
    installPlugins = installPluginsForAttempt,
    produce = sandcastle.run,
    extractOutput = runWithExtraction,
    onFailure = fail,
  } = options;

  const run: RunAgent<T> = ({ model, promptArgs }) =>
    rotate(
      options.name,
      model,
      (agent, log) => {
        // Each account runs in its own config dir, so the skills the prompt
        // invokes by name go into the dir of the account this attempt drew.
        if (options.plugins) installPlugins(agent.env.CLAUDE_CONFIG_DIR);
        const runOptions: RunOptions = {
          name: options.runName,
          agent,
          sandbox: noSandbox(),
          logging: log.logging,
          promptFile: path.join(options.dir, "prompt.md"),
          promptArgs: typeof promptArgs === "function" ? promptArgs(agent) : promptArgs,
          ...(options.idleTimeoutSeconds === undefined
            ? {}
            : { idleTimeoutSeconds: options.idleTimeoutSeconds }),
        };
        if (!options.extract) {
          // No tag to extract: the prompt run is the whole run, and its
          // caller reads the commits rather than an output.
          return produce(runOptions) as Promise<RunResult & { output: T }>;
        }
        return extractOutput({
          ...runOptions,
          output: sandcastle.Output.object({ tag: "output", schema: options.extract }),
          extractionPrompt: fs.readFileSync(path.join(options.dir, "extraction.md"), "utf8"),
        });
      },
      { role: options.role },
    );

  try {
    await body(run);
  } catch (error) {
    onFailure(errorMessage(error));
  }
};
