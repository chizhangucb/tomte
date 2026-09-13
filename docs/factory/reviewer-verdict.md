# Reviewer and verdict

The reviewer is read-only. It judges the PR head against the ticket's acceptance criteria (the checklist under `## Acceptance criteria` in the issue the PR closes), with the diff to main and the target's test output. Any commit, dirty file or moved HEAD fails the run; the workflow never pushes. It writes three things:

- a `<!-- factory:verdict -->` section in the PR body, one ticked or unticked line per criterion with its evidence, replaced on re-review;
- a review comment with the summary;
- the commit status `factory/verdict` on the PR head: `success` when every criterion is met, `failure` otherwise, including when the ticket has no criteria or the reviewer run itself failed.
