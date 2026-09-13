/**
 * The factory's Claude provider and the config dir each account runs in, the
 * one auth seam every agent run goes through (ADR 0001). Was in the vendored
 * `agent-workflows/shared/common.ts` until #313 dissolved it; it sits beside
 * the account code that picks the account (`accounts.ts`) and the plugin
 * install that fills the config dir this names (`plugins.ts`).
 *
 * Forced differences from sandcastle 0.12.0, each named (#47): `claudeAgent()`
 * takes the model and the account instead of hardcoding `claude-opus-4-8` and
 * one token (stories 17, 20, ADR 0004).
 */
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { required } from "./env";
import { outputDir } from "./run-output";

/**
 * Each account gets its own config dir so tokens never share state. The dir
 * is also where `plugins.ts` installs the skills the prompts invoke by name.
 */
export const claudeConfigDir = (account?: number): string => {
  const base =
    process.env.CLAUDE_CONFIG_DIR ?? path.join(outputDir(), "claude-config");
  return account === undefined ? base : `${base}-${account}`;
};

export interface AgentAccount {
  readonly index: number;
  readonly token: string;
}

/**
 * The model is a workflow input resolved by the calling script (see
 * `model.ts`); the token comes from the account the script picked
 * (`accounts.ts`), or from CLAUDE_CODE_OAUTH_TOKEN when none is given.
 * sandcastle is told to look for sessions under the account's config dir,
 * since resume (used by review extraction) otherwise searches $HOME. API-key
 * vars are blanked so a stray key can never outrank the subscription token
 * (ADR 0001). The agent gets no GitHub credentials: the scripts fetch context
 * before the run, and the workflow alone pushes, labels, and opens PRs.
 */
export const claudeAgent = (model: string, account?: AgentAccount) => {
  const configDir = claudeConfigDir(account?.index);
  return sandcastle.claudeCode(model, {
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: account?.token ?? required("CLAUDE_CODE_OAUTH_TOKEN"),
      CLAUDE_CONFIG_DIR: configDir,
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
    },
    sessionStorage: {
      hostProjectsDir: path.join(configDir, "projects"),
    },
  });
};
