/**
 * The shell every agent workflow runs inside (#313). Four workflows used to
 * carry a copy-adapted version of it; the tests here pin what the one module
 * does with the pieces, with the rotation, the plugin install and the two run
 * calls handed in, so the shell is proven without spending a subscription.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentProvider, RunResult } from "@ai-hero/sandcastle";
import type { RunLog } from "./run-log";
import { runAgentWorkflow } from "./run-agent-workflow";
import { standardSchema } from "./coerce";

/** A workflow folder on disk: the prompt file convention is what resolves against it. */
const workflowDir = (files: Record<string, string>): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workflow-"));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
};

const agent = (configDir: string): AgentProvider =>
  ({ name: "claude-code", env: { CLAUDE_CONFIG_DIR: configDir } }) as unknown as AgentProvider;

const log = { logging: { type: "file", path: "/dev/null" } } as unknown as RunLog;

const runResult = (): RunResult => ({ commits: [], iterations: [] }) as unknown as RunResult;

/** Rotation, scripted: it hands the run the agent of the account it picked. */
const rotation = (configDir = "/tmp/claude-config-2") => {
  const calls: { name: string; model: string; role: string }[] = [];
  return {
    calls,
    rotate: async <R,>(
      name: string,
      model: string,
      run: (a: AgentProvider, l: RunLog) => Promise<R>,
      options: { role: string },
    ): Promise<R> => {
      calls.push({ name, model, role: options.role });
      return run(agent(configDir), log);
    },
  };
};

test("the agent run goes through rotation under the workflow's name, model and role", async () => {
  const dir = workflowDir({ "prompt.md": "prompt" });
  const { calls, rotate } = rotation();
  await runAgentWorkflow(
    { name: "review-7", runName: "review-pr-7", role: "reviewer", dir, plugins: false, rotate, produce: async () => runResult() },
    async (run) => {
      await run({ model: "claude-opus-5", promptArgs: { PR_NUMBER: "7" } });
    },
  );
  assert.deepEqual(calls, [{ name: "review-7", model: "claude-opus-5", role: "reviewer" }]);
});

test("the prompt file is the workflow folder's prompt.md, run unsandboxed under the attempt's log", async () => {
  const dir = workflowDir({ "prompt.md": "prompt" });
  const seen: Record<string, unknown>[] = [];
  await runAgentWorkflow(
    {
      name: "implement-3",
      runName: "implement-#3",
      role: "implementer",
      dir,
      plugins: false,
      idleTimeoutSeconds: 1800,
      rotate: rotation().rotate,
      produce: async (options) => {
        seen.push(options as unknown as Record<string, unknown>);
        return runResult();
      },
    },
    async (run) => {
      await run({ model: "claude-opus-5", promptArgs: { BRANCH: "agent/3" } });
    },
  );
  const [options] = seen;
  assert.equal(options!.name, "implement-#3");
  assert.equal(options!.promptFile, path.join(dir, "prompt.md"));
  assert.deepEqual(options!.promptArgs, { BRANCH: "agent/3" });
  assert.equal(options!.logging, log.logging);
  assert.equal(options!.idleTimeoutSeconds, 1800);
  // The runner is the workflow's own machine: nothing is sandboxed away from it.
  assert.equal((options!.sandbox as { name?: string }).name, "no-sandbox");
});

test("a workflow with no idle timeout leaves the library's own default in place", async () => {
  const dir = workflowDir({ "prompt.md": "prompt" });
  let options: Record<string, unknown> | undefined;
  await runAgentWorkflow(
    {
      name: "review-7",
      runName: "review-pr-7",
      role: "reviewer",
      dir,
      plugins: false,
      rotate: rotation().rotate,
      produce: async (o) => {
        options = o as unknown as Record<string, unknown>;
        return runResult();
      },
    },
    async (run) => {
      await run({ model: "m", promptArgs: {} });
    },
  );
  assert.ok(!("idleTimeoutSeconds" in options!), "the shell sets no timeout of its own");
});

test("a workflow that extracts runs its folder's extraction.md against its own schema", async () => {
  const dir = workflowDir({ "prompt.md": "prompt", "extraction.md": "emit the tag" });
  const schema = standardSchema((value) => value as { summary: string });
  let options: Record<string, unknown> | undefined;
  let produced = 0;
  const result = await runAgentWorkflow(
    {
      name: "audit-9",
      runName: "audit-pr-9",
      role: "audit",
      dir,
      plugins: false,
      extract: schema,
      rotate: rotation().rotate,
      produce: async () => {
        produced += 1;
        return runResult();
      },
      extractOutput: async (o) => {
        options = o as unknown as Record<string, unknown>;
        return { ...runResult(), output: { summary: "judged" } };
      },
    },
    async (run) => {
      const run1 = await run({ model: "m", promptArgs: { PR_NUMBER: "9" } });
      assert.equal(run1.output.summary, "judged");
    },
  );
  assert.equal(produced, 0, "the extraction run owns the produce call");
  assert.equal(options!.extractionPrompt, "emit the tag");
  assert.equal(options!.promptFile, path.join(dir, "prompt.md"));
  const output = options!.output as { tag: string; schema: unknown };
  assert.equal(output.tag, "output");
  assert.equal(output.schema, schema);
  assert.equal(result, undefined);
});

test("a workflow that does not extract needs no extraction.md and makes no extraction run", async () => {
  // implement/ has none: its prompt file is the whole run.
  const dir = workflowDir({ "prompt.md": "prompt" });
  let extracted = 0;
  await runAgentWorkflow(
    {
      name: "implement-3",
      runName: "implement-#3",
      role: "implementer",
      dir,
      plugins: false,
      rotate: rotation().rotate,
      produce: async () => runResult(),
      extractOutput: async () => {
        extracted += 1;
        return { ...runResult(), output: undefined as never };
      },
    },
    async (run) => {
      await run({ model: "m", promptArgs: {} });
    },
  );
  assert.equal(extracted, 0);
});

test("the plugins go into the config dir of the account the attempt drew", async () => {
  const dir = workflowDir({ "prompt.md": "prompt" });
  const installed: (string | undefined)[] = [];
  await runAgentWorkflow(
    {
      name: "implement-3",
      runName: "implement-#3",
      role: "implementer",
      dir,
      plugins: true,
      rotate: rotation("/tmp/claude-config-2").rotate,
      installPlugins: (configDir) => installed.push(configDir),
      produce: async () => runResult(),
    },
    async (run) => {
      await run({ model: "m", promptArgs: {} });
    },
  );
  assert.deepEqual(installed, ["/tmp/claude-config-2"]);
});

test("a workflow whose prompt names no skill installs no plugins", async () => {
  const dir = workflowDir({ "prompt.md": "prompt" });
  let installs = 0;
  await runAgentWorkflow(
    {
      name: "review-7",
      runName: "review-pr-7",
      role: "reviewer",
      dir,
      plugins: false,
      rotate: rotation().rotate,
      installPlugins: () => {
        installs += 1;
      },
      produce: async () => runResult(),
    },
    async (run) => {
      await run({ model: "m", promptArgs: {} });
    },
  );
  assert.equal(installs, 0);
});

test("the prompt args a workflow builds from the harness in hand see the attempt's agent", async () => {
  // implement/ renders its bundled-review step off the provider the run drew.
  const dir = workflowDir({ "prompt.md": "prompt" });
  let options: Record<string, unknown> | undefined;
  await runAgentWorkflow(
    {
      name: "implement-3",
      runName: "implement-#3",
      role: "implementer",
      dir,
      plugins: false,
      rotate: rotation().rotate,
      produce: async (o) => {
        options = o as unknown as Record<string, unknown>;
        return runResult();
      },
    },
    async (run) => {
      await run({ model: "m", promptArgs: (a) => ({ HARNESS: a.name }) });
    },
  );
  assert.deepEqual(options!.promptArgs, { HARNESS: "claude-code" });
});

test("anything the workflow throws becomes the run's failure reason", async () => {
  const dir = workflowDir({ "prompt.md": "prompt" });
  const failures: string[] = [];
  await runAgentWorkflow(
    {
      name: "review-7",
      runName: "review-pr-7",
      role: "reviewer",
      dir,
      plugins: false,
      rotate: rotation().rotate,
      produce: async () => {
        throw new Error("the library gave up");
      },
      onFailure: ((message: string) => {
        failures.push(message);
      }) as (message: string) => never,
    },
    async (run) => {
      await run({ model: "m", promptArgs: {} });
      assert.fail("the run threw, so nothing after it runs");
    },
  );
  assert.deepEqual(failures, ["the library gave up"]);
});

test("a failure that is not an Error still names itself in the reason", async () => {
  const dir = workflowDir({ "prompt.md": "prompt" });
  const failures: string[] = [];
  await runAgentWorkflow(
    {
      name: "review-7",
      runName: "review-pr-7",
      role: "reviewer",
      dir,
      plugins: false,
      rotate: rotation().rotate,
      produce: async () => runResult(),
      onFailure: ((message: string) => {
        failures.push(message);
      }) as (message: string) => never,
    },
    async () => {
      throw "gh exited 1";
    },
  );
  assert.deepEqual(failures, ["gh exited 1"]);
});
