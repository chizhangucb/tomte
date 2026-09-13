# Issue tracker: GitHub

Tickets and specs are GitHub issues on this repo, driven with `gh`, which infers the repo inside a clone.

## Tickets

- **Create**: `gh issue create --title "..." --body "..."`, a heredoc for a multi-line body. This is what a skill means by "publish to the issue tracker".
- **Size**: every ticket is one `/to-tickets` slice, the ticket bar in `CONTEXT.md`. A criterion that outgrows one context window splits into its own ticket or drops; it never ships oversized. The dispatcher enforces the shape, not the size: `factory/dispatch/select.ts` skips a ticket whose body has no acceptance-criteria checklist and comments once saying so.
- **A spec title starts `Spec:`**: prefix it after `/to-spec` publishes. The dispatcher (`factory/dispatch/select.ts`) skips any `Spec:` issue, sliced or not, so a spec is never built as one ticket before `/to-tickets` slices it.
- **Criteria go in the body**: the checklist the dispatcher's gate reads is the reviewer's and the audit's too, one parser in `factory/lib/verdict.ts`: top-level checklist items under an ATX heading naming acceptance criteria, in the ticket's own body. Nothing else is parsed. A brief posted as a comment still reaches the agents as context (`factory/lib/ticket-context.ts`) but ticks no criterion, and a bold `**Acceptance criteria:**` line is not a heading. The vendored `mattpocock-skills:triage` brief writes both; this bullet overrides it, and the plugin is never edited because `factory/plugins/` is copied verbatim (`factory/plugins/README.md`).
- **Removals**: a ticket whose work removes something says so in its body: the reviewer and the audit judge every deleted test against it.
- **Read**: `gh issue view <number> --comments`, labels included. This is what a skill means by "fetch the relevant ticket".
- **List**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`, with `--label` and `--state` filters.
- **Comment**: `gh issue comment <number> --body "..."`
- **Label**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`, the moment its PR merges and before starting anything it blocks: `blocked_by` clears only on close. A PR whose author is doing the ticket's work carries `Closes #N`, which closes it on merge and is the only way the reviewer finds the ticket. The one trap is a ticket the factory is meant to build: the dispatcher skips any ticket an open PR's body names that way, a passing `resolves #N` included.

## Pull requests

**PRs as a request surface: no.** `/triage` reads this flag; `yes` puts external PRs (`authorAssociation` `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR` or `NONE`) through the same labels with `gh pr`.

Issues and PRs share one number space: resolve a bare `#42` with `gh pr view 42`, then `gh issue view 42`.

## Wayfinding

Used by `/wayfinder`. The **map** is one issue; its **children** are tickets.

- **Map**: labelled `wayfinder:map`, its body holding Notes / Decisions-so-far / Fog. `gh issue create --label wayfinder:map`.
- **Child ticket**: a GitHub sub-issue of the map (`gh api` on the sub-issues endpoint), labelled `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`) and assigned to the driving dev once claimed. Without sub-issues: a task list in the map body, and `Part of #<map>` atop the child.
- **Blocking**: GitHub's native issue dependencies. `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where the id is the blocker's **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`), not its `#number` or `node_id`. `issue_dependencies_summary.blocked_by` counts open blockers only, so it is the live gate. Without dependencies: a `Blocked by: #<n>, #<n>` line atop the child. A ticket is unblocked when every blocker is closed.
- **Frontier**: the map's open children, less any with an open blocker or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, `gh issue close <n>`, then a context pointer (gist + link) appended to the map's Decisions-so-far.
