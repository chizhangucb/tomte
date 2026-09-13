/**
 * The production half of the PR-context seam (#312): the reads the fetch is
 * handed in a workflow, driven against a stub `gh` and a stub `git` on PATH, in
 * the style of `target-repo.test.ts`.
 *
 * The in-memory half is proved in `shared/review-context.test.ts`, where the
 * fetch assembles five answers into a context. This is the other side of the
 * same interface: that each read asks GitHub for what the context needs (the
 * ticket's labels among them, #119) and hands back the shape the fetch expects,
 * so the two halves cannot agree with each other and disagree with GitHub.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import { prContextRepo } from "./pr-context-repo";

let stubDir: string;
let logFile: string;
let realPath: string | undefined;

/** The target the record under test is built for; GraphQL's two variables come from it. */
const REPO = "chizhangucb/chronicle";

/** Every command the stubs were handed, one per line, so a test reads what was asked. */
const asked = (): string[] =>
  fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean);

const ISSUE_VIEW = {
  number: 4,
  title: "Add a helper",
  body: "## Acceptance criteria\n\n- [ ] It helps",
  labels: [{ name: "model:claude-sonnet-5" }],
  comments: [{ author: { login: "chi" }, authorAssociation: "OWNER", body: "Owner on the ticket." }],
};

/** One unresolved thread with one comment on it, as the GraphQL read answers. */
const THREADS_ANSWER = {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: [
            {
              id: "T1",
              isResolved: false,
              comments: {
                nodes: [
                  {
                    id: "C1",
                    path: "a.ts",
                    line: 3,
                    originalLine: null,
                    body: "Owner in the thread.",
                    author: { login: "chi" },
                    authorAssociation: "OWNER",
                  },
                ],
              },
            },
          ],
        },
      },
    },
  },
};

const stub = (name: string, body: string[]): void => {
  const file = path.join(stubDir, name);
  fs.writeFileSync(file, ["#!/bin/sh", `printf '${name} %s\\n' "$*" >> "$STUB_LOG"`, ...body, ""].join("\n"));
  fs.chmodSync(file, 0o755);
};

before(() => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-context-stub-"));
  logFile = path.join(stubDir, "asked.log");
  realPath = process.env.PATH;
  process.env.PATH = `${stubDir}:${realPath ?? ""}`;
  process.env.STUB_LOG = logFile;

  stub("gh", [
    'case "$*" in',
    `  *"pr view"*) printf '%s' '{"title":"Add a helper","body":"Closes #4","comments":[{"author":{"login":"chi"},"authorAssociation":"OWNER","body":"Owner on the PR."}]}' ;;`,
    `  *"issue view"*) printf '%s' '${JSON.stringify(ISSUE_VIEW)}' ;;`,
    `  *reviews*) printf '%s' '[{"user":{"login":"chi"},"author_association":"OWNER","body":"Owner review summary.","state":"COMMENTED"}]' ;;`,
    `  *graphql*) test -n "$NO_THREADS" && printf '%s' '{"data":{"repository":{"pullRequest":null}}}' || printf '%s' '${JSON.stringify(THREADS_ANSWER)}' ;;`,
    `  *issues/4*) printf '%s' '{"author_association":"OWNER","user":{"login":"chi"}}' ;;`,
    '  *) printf "" ;;',
    "esac",
  ]);
  stub("git", [
    'case "$*" in',
    '  *"main...HEAD"*) test -n "$NO_MERGE_BASE" && exit 1 || printf "three-dot diff" ;;',
    '  *"main..HEAD"*) printf "two-dot diff" ;;',
    "esac",
  ]);
});

after(() => {
  process.env.PATH = realPath;
  delete process.env.STUB_LOG;
  delete process.env.NO_THREADS;
  delete process.env.NO_MERGE_BASE;
  fs.rmSync(stubDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.writeFileSync(logFile, "");
  delete process.env.NO_THREADS;
  delete process.env.NO_MERGE_BASE;
});

test("the PR read asks for the title, body and comments the context is built from", () => {
  const pr = prContextRepo(REPO).pr("12");
  assert.equal(pr.title, "Add a helper");
  assert.equal(pr.body, "Closes #4");
  assert.deepEqual(pr.comments.map((comment) => comment.authorAssociation), ["OWNER"]);
  assert.deepEqual(asked(), [`gh pr view 12 --repo ${REPO} --json title,body,comments`]);
});

/** Both halves of the ticket, from the two reads that each carry one (#179). */
test("the ticket read brings back its labels and, from REST, whoever opened it", () => {
  const read = prContextRepo(REPO).linkedIssue("4");
  assert.equal(read.view.body, ISSUE_VIEW.body);
  assert.deepEqual(read.view.labels, [{ name: "model:claude-sonnet-5" }]);
  assert.deepEqual(read.author, { association: "OWNER", login: "chi" });
  assert.deepEqual(asked(), [
    `gh issue view 4 --repo ${REPO} --json number,title,body,comments,labels`,
    `gh api repos/${REPO}/issues/4`,
  ]);
});

test("the reviews read is the REST list of submitted reviews on the PR", () => {
  const reviews = prContextRepo(REPO).reviews("12");
  assert.deepEqual(reviews.map((review) => review.author_association), ["OWNER"]);
  assert.deepEqual(asked(), [`gh api repos/${REPO}/pulls/12/reviews`]);
});

/** The threads, and the target they are asked for: the record's own, not an env read of its own. */
test("the review threads come out of the one GraphQL answer, for the target the record was built for", () => {
  const threads = prContextRepo(REPO).reviewThreads("12");
  assert.deepEqual(threads.map((thread) => thread.id), ["T1"]);
  assert.deepEqual(threads[0]?.comments.nodes.map((comment) => comment.id), ["C1"]);
  const [owner, repo] = REPO.split("/");
  const graphql = asked()[0] ?? "";
  assert.match(graphql, new RegExp(`owner=${owner}`));
  assert.match(graphql, new RegExp(`repo=${repo}`));
  assert.match(graphql, /number=12/);
});

test("a PR with no review threads reads as none rather than as a failure", () => {
  process.env.NO_THREADS = "1";
  assert.deepEqual(prContextRepo(REPO).reviewThreads("12"), []);
});

test("the diff read is the branch against the base, three dots first", () => {
  assert.equal(prContextRepo(REPO).diff(), "three-dot diff");
  assert.deepEqual(asked(), ["git diff main...HEAD"]);
});

/**
 * A shallow checkout can leave the merge base out of the clone, and then the
 * three-dot form exits non-zero. Two dots is the answer that still describes
 * the branch, so the run judges a diff rather than dying.
 */
test("a three-dot diff that cannot resolve a merge base falls back to two dots", () => {
  process.env.NO_MERGE_BASE = "1";
  assert.equal(prContextRepo(REPO).diff(), "two-dot diff");
  assert.deepEqual(asked(), ["git diff main...HEAD", "git diff main..HEAD"]);
});
