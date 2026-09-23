/**
 * What the merge gate is judging, read off the event that woke it.
 *
 * The gate answers two events and judges the same thing on both: a pull
 * request, and the merge queue's candidate for that pull request. A
 * `merge_group` payload carries no `pull_request` object, so none of the three
 * values the gate needs is in the same place twice, and the whole of that
 * difference is this function. The gate itself, and the two checks behind it,
 * never learn which event they ran on.
 *
 * The queue branch is the only place a `merge_group` payload says which pull
 * request it came from: GitHub names it
 * `gh-readonly-queue/<base branch>/pr-<number>-<base sha>`. The number is what
 * fetches the linked ticket, so a branch that does not carry one is refused
 * rather than guessed at.
 */
import * as fs from "node:fs";

/** A webhook event as the gate receives it: GitHub's name for it, and its payload. */
export type GateEvent = { name: string; payload: unknown };

/**
 * The three things the gate reads off the event. `prNumber` is a string
 * because that is what `gh pr view` takes and what `merge-gate.json` has
 * always carried.
 */
export type GateSubject = { prNumber: string; headSha: string; baseRef: string };

/**
 * The event this run was started by, from the payload Actions wrote for it.
 * Taking it from there rather than from caller inputs is what keeps the gate's
 * subject defined once: a caller cannot hand in a pull request number on an
 * event that has none.
 */
export const gateEvent = (env: NodeJS.ProcessEnv): GateEvent => {
  const name = env.GITHUB_EVENT_NAME;
  const file = env.GITHUB_EVENT_PATH;
  if (!name) throw new Error("GITHUB_EVENT_NAME is not set, so the merge gate cannot tell which event woke it");
  if (!file) throw new Error("GITHUB_EVENT_PATH is not set, so the merge gate cannot read the event that woke it");
  return { name, payload: JSON.parse(fs.readFileSync(file, "utf8")) };
};

/**
 * Where each event carries the head the gate judges. Exported because the
 * workflow has to read it too: the head sha is wanted before anything is
 * checked out, to mark both checks pending, which is earlier than this module
 * can run. Naming the paths here keeps that one YAML expression tied to this
 * function rather than being a second reading of the payload.
 */
export const HEAD_SHA_PATHS = {
  pull_request: "pull_request.head.sha",
  merge_group: "merge_group.head_sha",
} as const;

/** `refs/heads/main` as the rest of the factory writes it: `main`. */
const branchName = (ref: string): string => ref.replace(/^refs\/heads\//, "");

/** GitHub's queue branch, whose tail names the pull request the candidate is for. */
const QUEUE_BRANCH = /\/pr-(\d+)-[^/]*$/;

const read = (payload: unknown, path: string): string => {
  let value: unknown = payload;
  for (const key of path.split(".")) {
    if (value === null || typeof value !== "object") value = undefined;
    else value = (value as Record<string, unknown>)[key];
  }
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number") return String(value);
  throw new Error(`the event carries no ${path}, so the merge gate cannot tell what it is judging`);
};

export const gateSubject = ({ name, payload }: GateEvent): GateSubject => {
  if (name === "pull_request") {
    return {
      prNumber: read(payload, "pull_request.number"),
      headSha: read(payload, HEAD_SHA_PATHS.pull_request),
      baseRef: read(payload, "pull_request.base.ref"),
    };
  }
  if (name === "merge_group") {
    const headRef = read(payload, "merge_group.head_ref");
    const number = QUEUE_BRANCH.exec(headRef)?.[1];
    if (!number) {
      throw new Error(
        `the merge group's branch ${branchName(headRef)} does not name a pull request, so its ticket cannot be read`,
      );
    }
    return {
      prNumber: number,
      headSha: read(payload, HEAD_SHA_PATHS.merge_group),
      baseRef: branchName(read(payload, "merge_group.base_ref")),
    };
  }
  throw new Error(`the merge gate does not run on a ${name} event`);
};
