/**
 * Target repo (#281): the GitHub-backed reads and writes the factory's scripts
 * make against a target, written once here and handed to a script as its needs
 * record. docs/factory/layout.md, "How a script is wired", carries the pattern.
 *
 * The key choice lives here, not in any script. Two settled names (#288 dropped
 * the old ones): the writing key is `FACTORY_PAT`, so its events fire, and the
 * reading key, for the reads a fine-grained PAT cannot make (Actions runs and
 * jobs, commit statuses), is `READ_TOKEN`. The old names each replaced
 * (`GH_TOKEN` for writes, `STATUS_TOKEN` and `GH_TOKEN` for reads) are no longer
 * read: a script wired with only the old names is refused with a clear error
 * naming the key it is missing, rather than handed an empty token. No function
 * here takes a key; each factory resolves what it uses once, by `resolveKeys`.
 *
 * Every function throws `GhError` on failure, the shape `lib/gh.ts` throws, a
 * read that answered with something other than JSON included. Which of those a
 * script may shrug off is the script's own policy, decided in the script.
 *
 * The mapping from GitHub's JSON to the factory's shapes stays pure and stays
 * in `dispatch/reconcile.ts`, `dispatch/gh-read.ts` and `dispatch/select.ts`;
 * this module calls it, it does not absorb it.
 *
 * Builtins only, imported with explicit `.ts` extensions, so the dispatch job
 * runs it on bare `node --experimental-strip-types` with no `npm ci`.
 */
import {
  DISPATCH_ISSUE_PROJECTION,
  PROJECTIONS,
  type Projection,
  STATUSES_PROJECTION,
  parseItems,
} from "../dispatch/gh-read.ts";
import {
  type PrComment,
  type PrState,
  type Run,
  type Subject,
  type TicketState,
  type VerdictState,
  commentFromGitHub,
  leftAlone,
  marksFromTimeline,
  prFromGitHub,
  runFromGitHub,
  stateSinceFromTimeline,
  ticketFromGitHub,
} from "../dispatch/reconcile.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { type DispatchNeeds } from "../dispatch/dispatch.ts";
import { fromGitHub } from "../dispatch/select.ts";
import { type JobSummary, type Needs, type OpenPr } from "../dispatch/sweep.ts";
import { IMPLEMENT_LABEL, IN_PROGRESS_LABEL, REVIEW_LABEL } from "./labels.ts";
import { type Author } from "./trusted-authors.ts";
import { GhError, gh } from "./gh.ts";

/**
 * A required key, or a clear failure. Returns an env with the key in `gh`'s own
 * `GH_TOKEN` slot (that is how `gh` reads its token, not a factory input name).
 * An unset key throws naming the missing var, rather than handing `gh` an empty
 * token that fails later as an opaque 401 (#288).
 */
const withKey = (name: "FACTORY_PAT" | "READ_TOKEN"): NodeJS.ProcessEnv => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}: the old fallback names were dropped in #288, so set ${name}.`);
  return { ...process.env, GH_TOKEN: value };
};

/**
 * The two keys, resolved when a factory is built so no function names one (#281,
 * #282, #288). The writing key is `FACTORY_PAT`, the reading key `READ_TOKEN`;
 * the old names are gone (#288). Each is a getter, so a factory pays for only
 * the keys it destructures: the dispatcher takes `writeEnv` alone and never
 * needs `READ_TOKEN` set, while the sweep, update-branch and retry take both.
 * Read per build, not at import, so a script that sets its env late still gets
 * the right key. Shared by every factory below.
 */
const resolveKeys = (): { readonly writeEnv: NodeJS.ProcessEnv; readonly readEnv: NodeJS.ProcessEnv } => ({
  get writeEnv() {
    return withKey("FACTORY_PAT");
  },
  get readEnv() {
    return withKey("READ_TOKEN");
  },
});

/** How many commits on `base` a head lacks, from the compare API. */
const behindByOf = (repo: string, base: string, sha: string, env?: NodeJS.ProcessEnv): number =>
  Number(gh(["api", `repos/${repo}/compare/${base}...${sha}`, "--jq", ".behind_by"], env).trim());

/**
 * A read whose command answered with something other than JSON is a failure of
 * that command, thrown in the shape `gh` throws (`GhError`): the command and
 * the cause, no stack, no token.
 */
const ghJson = (args: string[], env?: NodeJS.ProcessEnv): any => {
  const out = gh(args, env);
  try {
    return JSON.parse(out);
  } catch {
    throw new GhError(args, new Error(`printed something other than JSON: ${out.slice(0, 200)}`));
  }
};

/** All pages of `endpoint`, each projected by gh to the fields its readers map, one item per line. */
const paginate = (endpoint: string, projection: Projection, env?: NodeJS.ProcessEnv): any[] => {
  const args = ["api", "--paginate", endpoint, "--jq", PROJECTIONS[projection]];
  try {
    return parseItems(gh(args, env));
  } catch (error) {
    if (error instanceof GhError) throw error;
    throw new GhError(args, error);
  }
};

/** A subject's kind is gh's own noun for it, so it is the subcommand: `gh issue edit`, `gh pr edit`. */
const edit = (repo: string, subject: Subject, args: string[], env?: NodeJS.ProcessEnv): void => {
  gh([subject.kind, "edit", String(subject.number), "--repo", repo, ...args], env);
};

/** Comment on a subject. */
const postComment = (repo: string, subject: Subject, body: string, env?: NodeJS.ProcessEnv): void => {
  gh([subject.kind, "comment", String(subject.number), "--repo", repo, "--body", body], env);
};

/** A subject's own comments, projected to the marker head, and who wrote each. The issues and PRs endpoint is one. */
const commentsOf = (repo: string, subject: number, env?: NodeJS.ProcessEnv): PrComment[] =>
  paginate(`repos/${repo}/issues/${subject}/comments?per_page=100`, "comments", env).map(commentFromGitHub);

/**
 * The GitHub-backed target repo for one owner/repo, on one base branch. Its
 * functions are the sweep's `Needs`; another script's record is a subset of the
 * same set.
 */
export const targetRepo = (repo: string, base: string): Needs => {
  const { writeEnv, readEnv } = resolveKeys();

  const timeline = (number: number): any[] => paginate(`repos/${repo}/issues/${number}/timeline?per_page=100`, "timeline", writeEnv);

  /** A subject's label state: when its current state label went on, and the sweep marks on it. */
  const withLabelState = <T extends TicketState | PrState>(subject: T, stateLabels: readonly string[]): T => {
    const state = stateLabels.find((l) => subject.labels.includes(l));
    if (!state || leftAlone(subject.labels)) return subject;
    const events = timeline(subject.number);
    return { ...subject, stateSince: stateSinceFromTimeline(events, state), marks: marksFromTimeline(events) };
  };

  const openTickets = (): TicketState[] =>
    paginate(`repos/${repo}/issues?state=open&per_page=100`, "issues", writeEnv)
      .filter((raw: any) => !raw.pull_request)
      .map(ticketFromGitHub)
      .map((t: TicketState) => withLabelState(t, [IN_PROGRESS_LABEL, IMPLEMENT_LABEL]));

  /** `gh pr list --json` is its own projection; 200 PRs with bodies fit the buffer with room. */
  const openPrs = (): OpenPr[] => {
    const rawPrs: any[] = ghJson([
      "pr", "list", "--repo", repo, "--state", "open", "--base", base, "--limit", "200",
      "--json", "number,title,headRefName,headRefOid,labels,autoMergeRequest,body,createdAt,isDraft,isCrossRepository",
    ], writeEnv);
    return rawPrs.map((raw) => ({
      pr: withLabelState(prFromGitHub(raw), [IN_PROGRESS_LABEL, REVIEW_LABEL, IMPLEMENT_LABEL]),
      createdAt: raw.createdAt,
    }));
  };

  const recentRuns = (since: string): Run[] => {
    const runsById = new Map<number, Run>();
    for (const query of [`created=%3E%3D${since}`, "status=queued", "status=in_progress", "status=waiting"]) {
      for (const raw of paginate(`repos/${repo}/actions/runs?${query}&per_page=100`, "runs", readEnv)) runsById.set(Number(raw.id), runFromGitHub(raw));
    }
    return [...runsById.values()];
  };

  const jobs = (runId: number): JobSummary[] => paginate(`repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, "jobs", readEnv);

  const verdict = (sha: string): VerdictState => {
    const statuses: { context: string; state: string }[] = ghJson(["api", `repos/${repo}/commits/${sha}/status`, "--jq", STATUSES_PROJECTION], readEnv);
    const state = statuses.find((s) => s.context === "factory/verdict")?.state;
    return state === "pending" || state === "success" || state === "failure" || state === "error" ? state : "none";
  };

  const commitDate = (sha: string): string => gh(["api", `repos/${repo}/commits/${sha}`, "--jq", ".commit.committer.date"], writeEnv).trim();

  const behindBy = (sha: string): number => behindByOf(repo, base, sha, writeEnv);

  /**
   * Whoever opened a ticket, via REST because `gh issue view --json` carries no
   * `author_association`, and that is the field the `ticket-author` channel is
   * judged on (#179).
   */
  const ticketAuthor = (ticket: number): Author => {
    const raw = ghJson(["api", `repos/${repo}/issues/${ticket}`, "--jq", "{association: .author_association, login: .user.login}"], writeEnv);
    return { association: raw.association, login: raw.login };
  };

  const factoryLogin = (): string => gh(["api", "user", "--jq", ".login"], writeEnv).trim();

  const currentLabels = (subject: number): string[] =>
    ghJson(["issue", "view", String(subject), "--repo", repo, "--json", "labels", "--jq", "[.labels[].name]"], writeEnv);

  return {
    openTickets,
    openPrs,
    recentRuns,
    jobs,
    verdict,
    commitDate,
    behindBy,
    ticketAuthor,
    prComments: (pr) => commentsOf(repo, pr, writeEnv),
    factoryLogin,
    currentLabels,
    addLabel: (subject, label) => edit(repo, subject, ["--add-label", label], writeEnv),
    removeLabel: (subject, label) => edit(repo, subject, ["--remove-label", label], writeEnv),
    comment: (subject, body) => postComment(repo, subject, body, writeEnv),
    dispatch: (eventType, pr) =>
      gh(["api", "--method", "POST", `repos/${repo}/dispatches`, "-f", `event_type=${eventType}`, "-F", `client_payload[pr]=${pr}`, "--silent"], writeEnv),
    // The same call the implement workflow's non-fatal step makes, and idempotent.
    armAutoMerge: (pr) => gh(["pr", "merge", String(pr), "--repo", repo, "--auto", "--squash"], writeEnv),
  };
};

/**
 * The GitHub-backed target repo for update-branch (#287): the reads and writes
 * in `UpdateBranchNeeds`. Kept a separate factory from the sweep's so this
 * module stays free of any `update-branch/` import, which would drag those files
 * into the dispatch job's cone; the return type is inferred and satisfies
 * `UpdateBranchNeeds` structurally where `update-branch-run.ts` assembles it.
 *
 * The status key lives here, not in the script: commit statuses are the one read
 * and the one write a fine-grained PAT cannot make, so `statuses` and
 * `postStatus` use the reading key (`READ_TOKEN`; #288 dropped its old
 * `STATUS_TOKEN` name). Everything else uses the writing key so the update
 * call's merge commit fires the `pull_request` event a fine-grained PAT needs
 * for CI to re-run.
 *
 * Every function throws `GhError`, and `requestUpdate` throws the two documented
 * 422s the same way; `update-branch.ts` reads them back off the error's fields.
 */
export const updateBranchTargetRepo = (repo: string, base: string) => {
  const { writeEnv, readEnv } = resolveKeys();

  return {
    openPrs: () =>
      ghJson([
        "pr", "list", "--repo", repo, "--state", "open", "--base", base, "--limit", "200",
        "--json", "number,headRefOid,headRefName,body,autoMergeRequest,mergeable,labels",
      ], writeEnv).map((raw: any) => ({
        number: raw.number,
        headRef: raw.headRefName,
        headRefOid: raw.headRefOid,
        body: raw.body ?? "",
        autoMerge: raw.autoMergeRequest !== null && raw.autoMergeRequest !== undefined,
        mergeable: raw.mergeable === "MERGEABLE" || raw.mergeable === "CONFLICTING" ? raw.mergeable : "UNKNOWN",
        labels: raw.labels.map((l: any) => l.name),
      })),

    behindBy: (sha: string) => behindByOf(repo, base, sha, writeEnv),

    statuses: (sha: string) => ghJson(["api", `repos/${repo}/commits/${sha}/status`, "--jq", ".statuses"], readEnv),

    commit: (sha: string) => {
      const raw = ghJson(["api", `repos/${repo}/commits/${sha}`, "--jq", "{sha, parents: [.parents[].sha], committerLogin: .committer.login}"], writeEnv);
      return { sha: raw.sha, parents: raw.parents, committerLogin: raw.committerLogin ?? null };
    },

    headOf: (pr: number) => gh(["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid", "--jq", ".headRefOid"], writeEnv).trim(),

    requestUpdate: (pr: number, expectedHead: string) => {
      gh(["api", "--method", "PUT", `repos/${repo}/pulls/${pr}/update-branch`, "-f", `expected_head_sha=${expectedHead}`, "--silent"], writeEnv);
    },

    postStatus: (sha: string, status: { state: string; context: string; description: string | null; target_url: string | null }) => {
      gh([
        "api", "--method", "POST", `repos/${repo}/statuses/${sha}`,
        "-f", `state=${status.state}`, "-f", `context=${status.context}`,
        "-f", `description=${status.description ?? ""}`, "-f", `target_url=${status.target_url ?? ""}`,
        "--silent",
      ], readEnv);
    },

    comment: (pr: number, body: string) => gh(["pr", "comment", String(pr), "--repo", repo, "--body", body], writeEnv),

    addLabel: (pr: number, label: string) => gh(["pr", "edit", String(pr), "--repo", repo, "--add-label", label], writeEnv),
  };
};

/**
 * The GitHub-backed target repo for the dispatcher (#286): a subset of the same
 * reads and writes, with the open-issues read carrying the dispatch fields
 * `select.ts` maps. `hasOpenPr` is left for the dispatcher to resolve against
 * `openPrs`, so this read stays one call. Every read is one a fine-grained PAT
 * can make, so they all use the write key, no `READ_TOKEN` among them.
 */
export const dispatchNeeds = (repo: string): DispatchNeeds => {
  const { writeEnv } = resolveKeys();

  return {
    openIssues: () => fromGitHub(paginate(`repos/${repo}/issues?state=open&per_page=100`, "dispatch", writeEnv), new Set()),
    openPrs: () => ghJson(["pr", "list", "--repo", repo, "--state", "open", "--limit", "200", "--json", "number,body"], writeEnv),
    readIssue: (number) => fromGitHub([ghJson(["api", `repos/${repo}/issues/${number}`, "--jq", DISPATCH_ISSUE_PROJECTION], writeEnv)], new Set())[0],
    comments: (number) => commentsOf(repo, number, writeEnv),
    addLabel: (subject, label) => edit(repo, subject, ["--add-label", label], writeEnv),
    comment: (subject, body) => postComment(repo, subject, body, writeEnv),
  };
};

/**
 * The GitHub-backed reads and writes the retry handler's failed-attempt path
 * needs (#284), the shape of `retry/retry.ts`'s `RetryNeeds`. Assembled by
 * `retry/retry-run.ts` and handed to the handler; a test hands it an in-memory
 * target repo instead.
 *
 * The retry handler's two keys are the two settled ones (#282, #288): reads
 * (labels, a PR, the open PR list, the branch, the artifact) use the reading key
 * `READ_TOKEN` (GITHUB_TOKEN, with checks: read); writes (labels, comments,
 * close, disarm) use `FACTORY_PAT` so their label events fire. The choice lives
 * here, not in the handler. Every function throws `GhError`; which of those the
 * handler shrugs off is its own policy.
 *
 * The checks wait's reads (the head's statuses and check runs, a PR's
 * mergeability) are not here: they build the checks-path failure, which
 * `retry/assemble.ts` turns into the `ChecksNeeds` record `waitForChecks` runs
 * on (#285). They have their own record and their own production adapter,
 * `retry/run-needs.ts` (#315), beside the log and artifact reads.
 */
export const retryTargetRepo = (repo: string, branch: string) => {
  // The same two keys the sweep and update-branch resolve (#282, #288): reads (a
  // PR, the open PR list, labels, the branch, the artifact) use the reading key
  // READ_TOKEN, writes (labels, comments, close, disarm) the writing one
  // FACTORY_PAT. The retry step passes both under their settled names.
  const { writeEnv, readEnv } = resolveKeys();

  // Structurally `retry.ts`'s `Subject`, named once here rather than re-inlined
  // per call. Not imported: `decide.ts`, where `Subject` lives, is not on the
  // bare-node cone the sweep's entry reaches through this module.
  type Named = { readonly kind: "issue" | "pr"; readonly number: string };
  const edit = (on: Named, args: string[]): void => {
    gh([on.kind, "edit", on.number, "--repo", repo, ...args], writeEnv);
  };

  return {
    viewPr: (number: string) => ghJson(["pr", "view", number, "--repo", repo, "--json", "state,body,headRefName"], readEnv),
    openPrs: () =>
      ghJson(["pr", "list", "--repo", repo, "--state", "open", "--limit", "200", "--json", "number,body,headRefName,isCrossRepository"], readEnv),
    labelsOf: (on: Named) => ghJson([on.kind, "view", on.number, "--repo", repo, "--json", "labels", "--jq", "[.labels[].name]"], readEnv),
    // Throws GhError on any read failure, a missing branch (404) among them; the
    // handler's `safeBranchExists` shrugs each off and reads the branch as gone,
    // as the pre-seam `tryGh` did.
    branchExists: (): boolean => {
      gh(["api", `repos/${repo}/branches/${branch}`, "--jq", ".name"], readEnv);
      return true;
    },
    artifactUrl: (): string | undefined => {
      const name = process.env.ARTIFACT_NAME;
      const runId = process.env.GITHUB_RUN_ID;
      if (!name || !runId) return undefined;
      const id = gh(["api", `repos/${repo}/actions/runs/${runId}/artifacts`, "--jq", `.artifacts[] | select(.name == "${name}") | .id`], readEnv).trim();
      return id ? `https://github.com/${repo}/actions/runs/${runId}/artifacts/${id}` : undefined;
    },
    addLabel: (on: Named, label: string) => edit(on, ["--add-label", label]),
    removeLabel: (on: Named, label: string) => edit(on, ["--remove-label", label]),
    // A body-file, not --body: an escalation comment carries the failing output and can outrun the arg limit.
    comment: (on: Named, body: string) => {
      const file = nodePath.join(os.tmpdir(), `retry-comment-${on.kind}-${on.number}-${process.pid}-${Date.now()}.md`);
      fs.writeFileSync(file, body);
      try {
        gh([on.kind, "comment", on.number, "--repo", repo, "--body-file", file], writeEnv);
      } finally {
        fs.rmSync(file, { force: true });
      }
    },
    ensureRetryLabel: (label: string) =>
      gh(["label", "create", label, "--repo", repo, "--color", "c5def5", "--description", "Factory: retries used on this ticket", "--force"], writeEnv),
    closePr: (number: string, comment: string) => gh(["pr", "close", number, "--repo", repo, "--comment", comment], writeEnv),
    disarmAutoMerge: (number: string) => gh(["pr", "merge", number, "--repo", repo, "--disable-auto"], writeEnv),
  };
};
