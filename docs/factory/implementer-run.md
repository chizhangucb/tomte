# Implementer run

One ticket, one branch, one PR. The script fetches the ticket and its parent spec into one file, because the agent has no GitHub token. The agent reads the target repo's own `CLAUDE.md` or `AGENTS.md`, `CONTEXT.md` and `docs/adr/`, which are binding, then builds through the order in `docs/agents/build-and-review.md`: `mattpocock-skills:tdd` at the seams the ticket names, then `mattpocock-skills:code-review` on both axes with every finding fixed, then the harness's own `code-review medium --fix` when the harness bundles one, then typecheck and the full suite. All of that happens before any PR exists. Implementation commits come first, `review:` commits after.

The prompt forbids placeholders in plain words; the merge gate (#13) and the reviewer (#11) are what verify it. The agent never pushes, labels, or opens PRs.
