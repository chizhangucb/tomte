/**
 * The wiring an import can break. The subject is the repo's own workflow files
 * and its own module tree, so the tree is the fixture, in the style of
 * `dispatch/workflow-names.test.ts` and the workflow half of
 * `lib/trusted-authors.test.ts`.
 *
 * Five steps run `node --experimental-strip-types` with no npm install, four of
 * them against a sparse checkout. A module one of those entrypoints reaches has
 * to be inside that job's cone, has to be imported with an explicit `.ts`
 * specifier, and may not pull a package in. Nothing in the type system knows
 * any of that: #50 added an import to a dispatch-reachable module, typechecked
 * clean, and every sweep died on ERR_MODULE_NOT_FOUND.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const repoRoot = new URL("../../", import.meta.url);
const workflowsDir = new URL(".github/workflows/", repoRoot);

/**
 * Every step that runs a strip-types entrypoint: the workflow file, the job
 * whose checkout it runs against, and the entrypoint, repo-relative. The
 * dispatcher and the sweep are two entries against one checkout, because they
 * are two steps of the same job.
 */
const STRIP_TYPES_ENTRYPOINTS = [
  { workflow: "dispatch.yml", job: "dispatch", entrypoint: "factory/dispatch/dispatch-run.ts" },
  { workflow: "dispatch.yml", job: "dispatch", entrypoint: "factory/dispatch/sweep-run.ts" },
  { workflow: "update-branch.yml", job: "update", entrypoint: "factory/update-branch/update-branch.ts" },
  { workflow: "agent-audit.yml", job: "decide", entrypoint: "factory/audit/decide.ts" },
  { workflow: "agent-implement.yml", job: "implement", entrypoint: "factory/lib/preflight.ts" },
] as const;

/**
 * The jobs above whose factory checkout declares no sparse-checkout, so the
 * entrypoint runs against the whole repo. Named rather than skipped: adding a
 * cone to one of these must turn the check on, never drop it silently.
 */
const JOBS_WITHOUT_CONE = ["agent-implement.yml#implement"];

/** `import "x"`, on its own with no bindings. */
const SIDE_EFFECT_IMPORT = /^\s*import\s+["']([^"']+)["']/gm;
/** The `from "x"` of any import or re-export, including the `} from "x"` that closes a multi-line one. */
const FROM_IMPORT = /^\s*(?:import|export|\})[^'"\n]*\bfrom\s*["']([^"']+)["']/gm;
/** `import("x")`, anywhere on a line. */
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']/g;

/** The job's own block, from its two-space key to the next one. */
const jobOf = (yaml: string, id: string): string => {
  const start = yaml.indexOf(`\n  ${id}:\n`);
  assert.ok(start >= 0, `${id} is a top-level job`);
  const rest = yaml.slice(start + 1);
  const end = rest.slice(1).search(/\n {0,2}\S/);
  return end < 0 ? rest : rest.slice(0, end + 1);
};

/**
 * Top-level job ids: two-space indented keys, from the `jobs:` line on. The
 * `jobs:` key is asserted, not searched for and shrugged off: a workflow this
 * cannot parse would contribute no runs, and the table test below would then
 * call it covered.
 */
const jobIdsOf = (yaml: string, workflow: string): string[] => {
  const at = yaml.search(/^jobs:$/m);
  assert.ok(at >= 0, `${workflow} has a top-level jobs: key`);
  return [...yaml.slice(at).matchAll(/^ {2}([a-z][a-z0-9_-]*):$/gm)].map((m) => m[1]!);
};

/** Every strip-types run in the tree, keyed the way the table above writes one. */
const stripTypesRuns = (): string[] => {
  const runs: string[] = [];
  for (const workflow of fs.readdirSync(workflowsDir).sort()) {
    if (!/\.ya?ml$/.test(workflow)) continue;
    const yaml = fs.readFileSync(new URL(workflow, workflowsDir), "utf8");
    for (const job of jobIdsOf(yaml, workflow)) {
      const matches = jobOf(yaml, job).matchAll(/node --experimental-strip-types factory\/(\S+)/g);
      for (const match of matches) runs.push(`${workflow}#${job} ${match[1]!}`);
    }
  }
  return runs.sort();
};

/**
 * A job's steps, split on the six-space list boundary, so a step's `with:`
 * stays with the step it belongs to. The boundary is `- `, not `- name:`: a
 * step written straight as `- uses:` would otherwise fold into the step above
 * it and hand its neighbour's `sparse-checkout:` to the reader below.
 */
const stepsOf = (job: string): string[] => job.split(/\n(?= {6}- )/);

/** One cone entry as git reads it: no trailing comment, no trailing slash. */
const coneEntry = (raw: string): string => raw.replace(/\s+#.*$/, "").trim().replace(/\/+$/, "");

/**
 * The sparse-checkout a step declares, in either form the repo writes: a block
 * (`sparse-checkout: |` then one path a line) or a scalar
 * (`sparse-checkout: factory/audit`). `null` means the step declares none.
 */
const coneOf = (step: string): string[] | null => {
  const lines = step.split("\n");
  const at = lines.findIndex((line) => /^\s*sparse-checkout:/.test(line));
  if (at < 0) return null;
  const [, indent, inline] = lines[at]!.match(/^(\s*)sparse-checkout:\s*(.*)$/)!;
  if (!inline!.startsWith("|")) return [coneEntry(inline!)];
  const block: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === "") continue;
    if (!line.startsWith(`${indent!} `)) break;
    if (line.trim().startsWith("#")) continue;
    block.push(coneEntry(line));
  }
  return block;
};

/** The step that checks the factory out into `factory/`, which is the checkout the entrypoint runs against. */
const factoryCheckoutOf = (workflow: string, job: string): string => {
  const yaml = fs.readFileSync(new URL(workflow, workflowsDir), "utf8");
  const steps = stepsOf(jobOf(yaml, job)).filter(
    // `path: factory` whole, not as a prefix: `path: factory-out` is a different directory.
    (step) => step.includes("uses: actions/checkout") && /^\s*path: factory\s*$/m.test(step),
  );
  assert.equal(steps.length, 1, `${workflow} job ${job} checks the factory out in exactly one step`);
  return steps[0]!;
};

/**
 * Every module specifier of every file the entrypoint reaches, transitively.
 * An inline `type` specifier is not skipped: type stripping blanks the keyword
 * and leaves the import, so the module is still loaded at runtime.
 */
const walkFrom = (entrypoint: string): { reached: string[]; imports: { file: string; specifier: string }[] } => {
  const reached = new Set<string>();
  const imports: { file: string; specifier: string }[] = [];
  const queue = [entrypoint];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (reached.has(file)) continue;
    reached.add(file);
    const onDisk = new URL(file, repoRoot);
    if (!fs.existsSync(onDisk)) continue;
    const source = fs.readFileSync(onDisk, "utf8");
    for (const pattern of [SIDE_EFFECT_IMPORT, FROM_IMPORT, DYNAMIC_IMPORT]) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1]!;
        imports.push({ file, specifier });
        if (specifier.startsWith(".")) queue.push(path.posix.join(path.posix.dirname(file), specifier));
      }
    }
  }
  return { reached: [...reached].sort(), imports };
};

/** Cone membership as the workflows mean it: the entry is the file, or a directory holding it. */
const inCone = (cone: string[], file: string): boolean =>
  cone.some((entry) => file === entry || file.startsWith(`${entry}/`));

test("every file a strip-types entrypoint reaches is inside its job's cone", () => {
  for (const { workflow, job, entrypoint } of STRIP_TYPES_ENTRYPOINTS) {
    const cone = coneOf(factoryCheckoutOf(workflow, job));
    if (cone === null) continue; // Covered by the no-cone test below.
    for (const file of walkFrom(entrypoint).reached) {
      assert.ok(
        inCone(cone, file),
        `${workflow} job ${job}: ${entrypoint} reaches ${file}, which no sparse-checkout entry covers`,
      );
    }
  }
});

test("the jobs with no sparse-checkout are the ones that run against the whole repo", () => {
  const without = STRIP_TYPES_ENTRYPOINTS.filter(
    ({ workflow, job }) => coneOf(factoryCheckoutOf(workflow, job)) === null,
  ).map(({ workflow, job }) => `${workflow}#${job}`);
  assert.deepEqual(
    [...new Set(without)],
    JOBS_WITHOUT_CONE,
    "a job that gained or lost a cone needs this list changed",
  );
});

test("every relative import in a reached file names a .ts file that exists", () => {
  for (const { workflow, job, entrypoint } of STRIP_TYPES_ENTRYPOINTS) {
    const { reached, imports } = walkFrom(entrypoint);
    // Every entrypoint imports something, so a walk that finds nothing is a
    // broken regex passing every assertion below vacuously.
    assert.ok(reached.length > 1, `${workflow} job ${job}: the walk from ${entrypoint} found no imports at all`);
    for (const { file, specifier } of imports) {
      if (!specifier.startsWith(".")) continue;
      assert.ok(
        specifier.endsWith(".ts"),
        `${workflow} job ${job}: ${file} imports ${specifier} with no .ts extension, which strip-types cannot resolve`,
      );
    }
    for (const file of reached) {
      assert.ok(fs.existsSync(new URL(file, repoRoot)), `${workflow} job ${job}: ${entrypoint} reaches ${file}, which does not exist`);
    }
  }
});

test("no file a strip-types entrypoint reaches imports a package", () => {
  for (const { workflow, job, entrypoint } of STRIP_TYPES_ENTRYPOINTS) {
    for (const { file, specifier } of walkFrom(entrypoint).imports) {
      assert.ok(
        specifier.startsWith(".") || specifier.startsWith("node:"),
        `${workflow} job ${job}: ${file} imports the package ${specifier}, and the job runs with no npm install`,
      );
    }
  }
});

test("the table names every strip-types run in the tree and nothing else", () => {
  // Both directions: a table entry whose step moved stops matching, and a new
  // strip-types step nobody added to the table shows up here instead of going
  // uncovered. Same reason the no-cone list is named rather than skipped.
  assert.deepEqual(
    stripTypesRuns(),
    STRIP_TYPES_ENTRYPOINTS.map(({ workflow, job, entrypoint }) => `${workflow}#${job} ${entrypoint}`).sort(),
  );
});

test("a cone is read from either form a workflow writes it in", () => {
  // #84 turns the audit's scalar into a block. Both forms mean the same list.
  const scalar = ["        with:", "          sparse-checkout: factory/audit", "        env:"].join("\n");
  const block = [
    "        with:",
    "          sparse-checkout: |",
    "            factory/audit",
    "            factory/lib/gh.ts",
    "        env:",
  ].join("\n");
  assert.deepEqual(coneOf(scalar), ["factory/audit"]);
  assert.deepEqual(coneOf(block), ["factory/audit", "factory/lib/gh.ts"]);
  assert.equal(coneOf(["        with:", "          path: factory"].join("\n")), null);
  // A trailing slash and a trailing comment are both things git ignores, so
  // neither may turn a covered file into a reported miss.
  const noisy = [
    "        with:",
    "          sparse-checkout: |",
    "            # the dispatcher's own tree",
    "            factory/dispatch/",
    "            factory/lib/gh.ts # and the one module it reaches",
    "        env:",
  ].join("\n");
  assert.deepEqual(coneOf(noisy), ["factory/dispatch", "factory/lib/gh.ts"]);
});
