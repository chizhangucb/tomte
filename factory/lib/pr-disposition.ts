/**
 * The **PR fix** decided in one place: who repairs a pull request the factory
 * will not merge as-is. Either the factory itself, on a PR it opened, a
 * **hand-off** that labels `agent:implement` and lets an implementer rewrite
 * the branch; or the PR's author, a **tell-author** that labels `agent:blocked`
 * and waits, because merging the base in and pushing someone else's branch is
 * not the factory's to do (#180, #183, ADR 0007).
 *
 * One answer, read wherever a conflict or a failing check raises the question:
 * update-branch's conflict plan, the retry handler's conflict hand-off, and the
 * retry handler's failing-check tell-author. Before this module each derived the
 * same two-way choice and named it in parallel prose, held in agreement only by
 * matching tests. Here the choice is keyed on whether the factory authored the
 * PR (`isFactoryAuthoredPr`, not `isFactoryPr`, per #174: the broad predicate's
 * verdict arm is exactly the PR the factory did not author and must not touch),
 * and the return type makes `agent:implement` on any other PR a type error.
 *
 * The module returns the label and the one label-bound sentence, and nothing
 * else. Each caller keeps its own trigger, comment framing and accounting; only
 * the choice and the sentence that names it live here, so the callers cannot
 * drift apart on who may write to a branch or on what the reader is told the
 * label does.
 *
 * Imports only pure `factory/lib` modules (`factory-pr.ts`, `labels.ts`), each
 * builtins-only itself, so a job can run this on bare
 * `node --experimental-strip-types` with no install; every sparse-checkout cone
 * that reaches it lists it.
 */
import { type FactoryPrFacts, isFactoryAuthoredPr } from "./factory-pr.ts";
import { BLOCKED_LABEL, IMPLEMENT_LABEL } from "./labels.ts";

/** Which of the two the PR fix is; CONTEXT.md defines both terms. */
export type PrFixAction = "hand-off" | "tell-author";

/**
 * The PR fix: which of the two, the label that records it, and the sentence
 * that names what the label does. `add` is one of two labels and not any
 * string, so "no `agent:implement` on a branch the factory did not author" is a
 * fact tsc checks rather than one a caller has to keep.
 */
export type PrDisposition =
  | { readonly action: "hand-off"; readonly add: typeof IMPLEMENT_LABEL; readonly sentence: string }
  | { readonly action: "tell-author"; readonly add: typeof BLOCKED_LABEL; readonly sentence: string };

/**
 * The PR fix for this PR: a hand-off on a PR the factory authored, a
 * tell-author on any other. `base` is the branch a hand-off merges in, named in
 * its sentence; the tell-author sentence needs none, so the failing-check path,
 * which has no base to give, may ask without one.
 */
export const prDisposition = (pr: FactoryPrFacts, base?: string): PrDisposition =>
  isFactoryAuthoredPr(pr)
    ? {
        action: "hand-off",
        add: IMPLEMENT_LABEL,
        sentence: base
          ? `Its run merges \`${base}\` into the branch, resolves the conflicts, and pushes.`
          : "Its run picks the branch up and pushes.",
      }
    : {
        action: "tell-author",
        add: BLOCKED_LABEL,
        sentence: `Push the fix yourself, then take \`${BLOCKED_LABEL}\` off, which hands the PR back.`,
      };
