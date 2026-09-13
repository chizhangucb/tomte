/**
 * The targets the heartbeat wakes: one line each, and adding a target is one
 * line. One sender covers any number of them, so no target carries a sender of
 * its own.
 *
 * tomte-fixture is back on it (#212): it is private, so a sweep bills a whole
 * Actions minute, and what makes an idle one free is that the sender now reads a
 * target's open work first and skips a target with nothing waiting.
 *
 * chizhang-2 is private and stays private, so it bills an Actions minute per
 * sweep the way tomte-fixture does, and the same idle skip is what keeps a
 * quiet one free.
 *
 * This module imports nothing, so `send.ts` reaches it on bare
 * `node --experimental-strip-types`.
 */
export const TARGET_REPOS: readonly string[] = [
  "chizhangucb/tomte-fixture",
  "chizhangucb/chronicle",
  "chizhangucb/chizhang-2",
];
