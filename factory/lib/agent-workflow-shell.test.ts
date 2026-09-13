/**
 * One shell, four workflows (#313). The subject is the repo's own scripts, so
 * the tree is the fixture, in the style of `strip-types-cone.test.ts`: nothing
 * in the type system says a workflow cannot grow its own rotation, its own
 * `noSandbox()` and its own `try`/`catch` again, which is how the four came to
 * carry a copy-adapted shell each.
 *
 * The pinned rows are the run each workflow produced before the shell was
 * extracted: same rotation name, same run name, same role, same plugin set,
 * same prompt placeholders.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

const repoRoot = new URL("../../", import.meta.url);

interface WorkflowShell {
  readonly name: string;
  readonly runName: string;
  readonly role: string;
  readonly plugins: string;
  readonly extract?: string;
  readonly idleTimeoutSeconds?: string;
  readonly promptArgs: readonly string[];
}

/** Every agent workflow, and the run it makes. */
const WORKFLOWS: Record<string, WorkflowShell> = {
  "factory/agent-workflows/implement/implement.ts": {
    name: "`implement-${ISSUE_NUMBER}`",
    runName: "`implement-#${ISSUE_NUMBER}`",
    role: '"implementer"',
    plugins: "true",
    idleTimeoutSeconds: "30 * 60",
    promptArgs: [
      "ISSUE_NUMBER",
      "ISSUE_TITLE",
      "BRANCH",
      "ISSUE_CONTEXT",
      "TICKET_FILE",
      "RETRY_SECTION",
      "BUNDLED_REVIEW_STEP",
    ],
  },
  "factory/agent-workflows/implement-pr/implement-pr.ts": {
    name: "`implement-pr-${PR_NUMBER}`",
    runName: "`implement-pr-${PR_NUMBER}`",
    role: '"implementer"',
    plugins: "true",
    extract: "implementPrOutputSchema",
    promptArgs: [
      "PR_NUMBER",
      "BRANCH",
      "PR_TITLE",
      "ISSUE_NUMBER",
      "ISSUE_TITLE",
      "LINKED_ISSUE",
      "DIFF_TO_MAIN",
      "PR_COMMENTS_JSON",
      "RETRY_SECTION",
      "CONFLICT_SECTION",
    ],
  },
  "factory/agent-workflows/review/review.ts": {
    name: "`review-${PR_NUMBER}`",
    runName: "`review-pr-${PR_NUMBER}`",
    role: '"reviewer"',
    plugins: "false",
    extract: "reviewOutputSchema",
    promptArgs: [
      "PR_NUMBER",
      "BRANCH",
      "PR_TITLE",
      "ISSUE_NUMBER",
      "ISSUE_TITLE",
      "ACCEPTANCE_CRITERIA",
      "LINKED_ISSUE",
      "DIFF_TO_MAIN",
      "TEST_OUTPUT",
      "PR_COMMENTS_JSON",
    ],
  },
  "factory/audit/audit.ts": {
    name: "`audit-${PR_NUMBER}`",
    runName: "`audit-pr-${PR_NUMBER}`",
    role: '"audit"',
    plugins: "false",
    extract: "auditOutputSchema",
    promptArgs: [
      "PR_NUMBER",
      "MERGE_SHA",
      "PR_TITLE",
      "ISSUE_NUMBER",
      "ISSUE_TITLE",
      "ACCEPTANCE_CRITERIA",
      "LINKED_ISSUE",
      "MERGED_DIFF",
      "TEST_OUTPUT",
    ],
  },
};

/**
 * The pieces of the shell the module owns now. A workflow naming one of these
 * is carrying a copy of the shell again, whatever else it also calls.
 */
const SHELL_PIECES = [
  "runWithRotation",
  "noSandbox",
  "installPluginsForAttempt",
  "runWithExtraction",
  "sandcastle.run(",
  "promptFile",
  "extractionPrompt",
];

const sourceOf = (file: string): string => fs.readFileSync(new URL(file, repoRoot), "utf8");

/**
 * The file with its comments taken out. The provenance headers name the shell
 * and what it now owns, which is prose about the rule rather than a breach of
 * it, so the check below reads code alone.
 */
const codeOf = (file: string): string =>
  sourceOf(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

/** The object literal starting at `from`, brace-matched so a nested one stays inside it. */
const literalAt = (source: string, from: number): string => {
  const open = source.indexOf("{", from);
  assert.ok(open >= 0, "an object literal follows");
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  assert.fail("the object literal closes");
};

/** Where the workflow hands itself to the shell. */
const shellCallAt = (source: string, file: string): number => {
  const at = source.indexOf("runAgentWorkflow(");
  assert.ok(at >= 0, `${file} calls runAgentWorkflow`);
  return at;
};

/** The options a workflow hands `runAgentWorkflow`. */
const shellOptions = (source: string, file: string): string =>
  literalAt(source, shellCallAt(source, file));

/** A `key: value,` of the shell options, value as written. */
const field = (literal: string, key: string): string | undefined =>
  literal.match(new RegExp(String.raw`^ {4}${key}: (.+?),?$`, "m"))?.[1];

test("every agent workflow makes its run through the one shell", () => {
  for (const [file, shell] of Object.entries(WORKFLOWS)) {
    const options = shellOptions(sourceOf(file), file);
    assert.equal(field(options, "name"), shell.name, `${file} rotation name`);
    assert.equal(field(options, "runName"), shell.runName, `${file} run name`);
    assert.equal(field(options, "role"), shell.role, `${file} role`);
    assert.equal(field(options, "dir"), "import.meta.dirname", `${file} prompt folder`);
    assert.equal(field(options, "plugins"), shell.plugins, `${file} plugin set`);
    assert.equal(field(options, "extract"), shell.extract, `${file} output schema`);
    assert.equal(
      field(options, "idleTimeoutSeconds"),
      shell.idleTimeoutSeconds,
      `${file} idle timeout`,
    );
  }
});

test("every agent workflow fills its prompt with the placeholders it always did", () => {
  for (const [file, shell] of Object.entries(WORKFLOWS)) {
    const source = sourceOf(file);
    // From the shell call on, so the placeholders are the ones the shell runs with.
    const at = source.indexOf("promptArgs:", shellCallAt(source, file));
    assert.ok(at >= 0, `${file} passes promptArgs to the shell`);
    const args = literalAt(source, at);
    const keys = [...args.matchAll(/^\s*([A-Z_]+)[,:]/gm)].map((m) => m[1]!);
    assert.deepEqual(keys, [...shell.promptArgs], `${file} prompt placeholders`);
  }
});

test("no agent workflow carries a piece of the shell of its own", () => {
  for (const file of Object.keys(WORKFLOWS)) {
    const source = codeOf(file);
    for (const piece of SHELL_PIECES) {
      assert.ok(!source.includes(piece), `${file} still names ${piece}, which the shell owns`);
    }
    assert.ok(!/\n} catch \(/.test(source), `${file} still wraps itself in a try/catch`);
  }
});
