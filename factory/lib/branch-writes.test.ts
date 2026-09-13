/**
 * The factory asks `isFactoryAuthoredPr` before it closes a pull request
 * (ADR 0007, #195). Putting the implementer on a branch turns on the same
 * question, but that is the one **PR fix** decision now (`pr-disposition.ts`,
 * #309), asked once there and tested there, so the sites that used to ask it
 * each read the answer instead; this scan need only guard the close.
 *
 * The tree is the fixture, as in `lib/strip-types-cone.test.ts`: a table of
 * the sites that decide the close and the modules that make it. The last two
 * tests hand the scan synthetic sources instead, to check the scan itself.
 *
 * It asserts the asking, never a shared answer: escalation answers a PR the
 * factory did not author with `needs-human`, so the answer is compared only
 * with the site's own others.
 *
 * The limit, and it is not to be trusted past it: it pins the sites that
 * exist. It checks that each tabled site asks, and that the module making the
 * site's write calls the site, not which of its functions do or what they do
 * with the answer. It finds a call's site by layout, not by parsing: the
 * top-level statement whose first line, flush left, is the nearest at or
 * above the call. A statement that does not open its own line flush left is read as
 * part of the one above it, and a flush-left line inside a template literal
 * as a statement of its own. A new write path that calls neither the
 * predicate nor a site is invisible here. What its author reads is the
 * contract in `factory/lib/factory-pr.ts`'s doc comment, which is why that
 * stays the anchor.
 *
 * Not a site: update-branch's own update call. The 2026-09-10 amendment
 * applies it to any PR with auto-merge armed, since GitHub makes that merge
 * and no agent touches the branch.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { prEscalation } from "../retry/escalation.ts";
import {
  FACTORY_BODY_MARKER,
  type FactoryPrFacts,
  isFactoryAuthoredPr,
  isFactoryPr,
  VERDICT_SECTION_START,
} from "./factory-pr.ts";
import { codeOf, factoryModules, importedFrom } from "./repo-files.ts";

/**
 * The modules excluded from the "who asks the predicate" scan below, because
 * they are where the answer is *defined* rather than a site that writes on it.
 * `factory-pr.ts` holds the predicate (it calls itself through `isFactoryPr`,
 * not a site). `pr-disposition.ts` is the one **PR fix** decision (#309): it
 * asks the predicate once and returns the label, and its own tests cover both
 * branches, so update-branch's conflict plan and the retry handler read the
 * choice from it instead of each asking. The label the callers then write is
 * the module's typed return, not a mapping they keep.
 */
const PREDICATE_MODULE = "factory/lib/factory-pr.ts";
const DECISION_MODULES = [PREDICATE_MODULE, "factory/lib/pr-disposition.ts"];

/**
 * Every site that decides whether a PR is *closed*, the module that makes that
 * write, and the site's decision called with everything it reads besides who
 * authored the PR held fixed. Whether a PR gets the implementer is no longer a
 * per-site decision: it is `pr-disposition.ts`'s, above, tested there.
 */
const WRITE_SITES: readonly {
  module: string;
  site: string;
  writer: string;
  writes: string;
  decide: (pr: FactoryPrFacts) => unknown;
}[] = [
  {
    module: "factory/retry/escalation.ts",
    site: "prEscalation",
    // The plan the handler applies, not the handler (#310): `planFor` is where
    // the close is decided on and written down, and `retry.ts` only carries out
    // the `close-pr` effect that arm planned.
    writer: "factory/retry/plan.ts",
    writes: "closes the PR",
    decide: (pr) => prEscalation({ ...pr, labels: ["agent:review"] }),
  },
];

/**
 * PRs whose authorship is written down here rather than computed, so the
 * grouping below is not the predicate grading itself. Both of its arms, and
 * the PR that separates it from `isFactoryPr`: one the reviewer judged and the
 * factory did not open.
 */
const PRS: readonly { pr: FactoryPrFacts; authored: boolean }[] = [
  { authored: true, pr: { headRef: "agent/issue-12-add-slugify", body: "" } },
  { authored: true, pr: { headRef: "fix/typo", body: `${FACTORY_BODY_MARKER}. Run: x` } },
  { authored: true, pr: { headRef: "agent/issue-9-thing", body: `Does the thing.\n\n${VERDICT_SECTION_START}\npass` } },
  { authored: false, pr: { headRef: "maintainer/flaky-login", body: "Fixes the flaky login test." } },
  { authored: false, pr: { headRef: "maintainer/flaky-login", body: `Fixes it.\n\n${VERDICT_SECTION_START}\npass` } },
  { authored: false, pr: { headRef: "bot/dependabot-bump", body: "" } },
];

const siteKey = (module: string, site: string): string => `${module}#${site}`;

/** The first line of a top-level statement: flush left, and not a bracket or backtick closing the one above it. */
const STATEMENT_START = /^[^\s)\]}>`].*/gm;

/** The name a statement's first line declares: a function, generator, class, const, let or var, exported, default or async. */
const DECLARATION = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\b\s*\*?|class\b|const\b|let\b|var\b)\s*(?!extends\b)(\w+)/;

/**
 * The site a top-level statement is: the name it declares, `default` for an
 * unnamed default export, or `(top level)`, so a statement it cannot name
 * fails the table rather than passing as another site.
 */
const siteOf = (statementStart: string): string =>
  statementStart.match(DECLARATION)?.[1] ?? (/^export\s+default\b/.test(statementStart) ? "default" : "(top level)");

/** Every module under `factory/` that could call the predicate, mapped to its code. */
const treeCodes = (): Record<string, string> =>
  Object.fromEntries(
    factoryModules({ tests: false })
      .filter((module) => !DECISION_MODULES.includes(module))
      .map((module) => [module, codeOf(module)]),
  );

/**
 * `module#site` for every site in `codes` that calls the predicate, once
 * however often it asks. A call's site is the top-level statement it sits in,
 * named by `siteOf`, so a tabled site that stops asking is not credited with a
 * call a declaration below it makes, whatever that declaration's form.
 */
const callSites = (codes: Readonly<Record<string, string>> = treeCodes()): string[] =>
  [
    ...new Set(
      Object.entries(codes).flatMap(([module, code]) => {
        const statements = [...code.matchAll(STATEMENT_START)];
        return [...code.matchAll(/\bisFactoryAuthoredPr\(/g)].map((call) =>
          siteKey(module, siteOf(statements.filter((s) => s.index! <= call.index!).at(-1)?.[0] ?? "")),
        );
      }),
    ),
  ].sort();

test("the PRs below are authored as written, and one of them is where the two predicates part", () => {
  // Guards the grouping the next test leans on. A corpus that lost either side,
  // or lost the judged PR the factory did not open, would let a site that asks
  // nothing, or asks `isFactoryPr`, pass.
  for (const { pr, authored } of PRS) assert.equal(isFactoryAuthoredPr(pr), authored, `${pr.headRef}: ${pr.body}`);
  assert.ok(PRS.some(({ authored }) => authored) && PRS.some(({ authored }) => !authored));
  assert.ok(PRS.some(({ pr, authored }) => !authored && isFactoryPr(pr)), "no judged PR the factory did not author");
});

test("each write site's answer turns on who authored the PR", () => {
  for (const { site, writes, decide } of WRITE_SITES) {
    const [mine, ...moreMine] = PRS.filter(({ authored }) => authored).map(({ pr }) => decide(pr));
    const [theirs, ...moreTheirs] = PRS.filter(({ authored }) => !authored).map(({ pr }) => decide(pr));
    // Within a side the answer is one answer: anything else means the site
    // decides on something besides authorship, `isFactoryPr` included.
    for (const other of moreMine) assert.deepEqual(other, mine, `${site} answers two PRs the factory authored differently`);
    for (const other of moreTheirs) assert.deepEqual(other, theirs, `${site} answers two PRs the factory did not author differently`);
    // Across sides it differs: a site that answers the same either way asked nothing.
    assert.notDeepEqual(theirs, mine, `${site} ${writes} whoever authored the PR`);
  }
});

test("each write site asks isFactoryAuthoredPr itself, imported from the one definition", () => {
  // The behaviour above is satisfied by a copy of the predicate's two arms too.
  // A copy is how the audit and the reconciler drifted before factory-pr.ts
  // existed, so the site has to call the definition, not match it today.
  const called = callSites();
  for (const { module, site } of WRITE_SITES) {
    assert.ok(called.includes(siteKey(module, site)), `${site} in ${module} does not call isFactoryAuthoredPr`);
    assert.equal(importedFrom(module, "isFactoryAuthoredPr"), PREDICATE_MODULE, `${module} does not import isFactoryAuthoredPr from ${PREDICATE_MODULE}`);
  }
});

test("the module that makes each site's write calls the site", () => {
  // A site that asks protects nothing if the write goes round it, and that is
  // where #183's regression lived: retry.ts labelled the open PR
  // `agent:implement` itself, with no decision in between.
  for (const { module, site, writer } of WRITE_SITES) {
    assert.ok(new RegExp(`\\b${site}\\(`).test(codeOf(writer)), `${writer} makes the write ${site} decides without calling it`);
    assert.equal(importedFrom(writer, site), module, `${writer} does not import ${site} from ${module}`);
  }
});

test("the table names every call to isFactoryAuthoredPr in the tree, and nothing else", () => {
  // Both directions, as strip-types-cone's table does. A tabled site that stops
  // calling it drops out of the left, and a new caller nobody tabled shows up
  // there instead of going unchecked. A new write path that never calls it
  // appears on neither side: that is the limit the header names.
  assert.deepEqual(callSites(), WRITE_SITES.map(({ module, site }) => siteKey(module, site)).sort());
});

/** Where the synthetic sources below claim to live. No such module exists. */
const FIXTURE_MODULE = "factory/fixture.ts";

test("a call is credited to the top-level statement it sits in, whatever form that takes", () => {
  // The scan above is only as good as this. A tabled site that stops asking,
  // with an untabled declaration below it that starts, must read as the new
  // one asking, never as the tabled site still doing it.
  const FORMS: readonly { form: string; code: string; site: string }[] = [
    { form: "async function", code: "export async function helper(pr) {\n  return isFactoryAuthoredPr(pr);\n}", site: "helper" },
    { form: "class", code: "class Helper {\n  asks(pr) {\n    return isFactoryAuthoredPr(pr);\n  }\n}", site: "Helper" },
    { form: "var", code: "var helper = (pr) =>\n  isFactoryAuthoredPr(pr);", site: "helper" },
    { form: "generator", code: "function* helper(prs) {\n  for (const pr of prs) yield isFactoryAuthoredPr(pr);\n}", site: "helper" },
    { form: "export default", code: "export default (pr) =>\n  isFactoryAuthoredPr(pr);", site: "default" },
    { form: "export default function", code: "export default function helper(pr) {\n  return isFactoryAuthoredPr(pr);\n}", site: "helper" },
    { form: "export default class", code: "export default class extends Base {\n  asks(pr) {\n    return isFactoryAuthoredPr(pr);\n  }\n}", site: "default" },
    { form: "a statement that declares nothing", code: "if (isFactoryAuthoredPr(pr)) close(pr);", site: "(top level)" },
  ];
  const siteAbove = "export const site = (pr) => pr.headRef;\n\n";
  assert.deepEqual(
    FORMS.map(({ form, code }) => [form, callSites({ [FIXTURE_MODULE]: siteAbove + code })]),
    FORMS.map(({ form, site }) => [form, [siteKey(FIXTURE_MODULE, site)]]),
  );
});

test("a site that asks twice is one site", () => {
  // The table has a row per site, so a site asking in both arms of a ternary
  // is a site that asks, not a call the table forgot.
  const code = "export const site = (pr, retried) =>\n  retried ? isFactoryAuthoredPr(pr) : !isFactoryAuthoredPr(pr);\n";
  assert.deepEqual(callSites({ [FIXTURE_MODULE]: code }), [siteKey(FIXTURE_MODULE, "site")]);
});
