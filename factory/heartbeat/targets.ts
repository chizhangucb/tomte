/**
 * The targets the heartbeat wakes: one line each, and adding a target is one
 * line. One sender covers any number of them, so no target carries a sender of
 * its own.
 *
 * tomte-fixture is back on it (#212): it is private, so a sweep bills a whole
 * Actions minute, and what makes an idle one free is that the sender now reads a
 * target's open work first and skips a target with nothing waiting.
 *
 * This module imports nothing, so `send.ts` reaches it on bare
 * `node --experimental-strip-types`.
 */
export const TARGET_REPOS: readonly string[] = [
  "chizhangucb/tomte-fixture",
  "chizhangucb/chronicle",
  "chizhangucb/tomte",
];