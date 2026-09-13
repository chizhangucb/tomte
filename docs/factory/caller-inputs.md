# Caller inputs

Every input has a default, so the template works as copied. Set them in the calling job's `with:`. Models are resolved by `factory/lib/model.ts`.

| Input | Jobs | Default | What it does |
| --- | --- | --- | --- |
| `factory_ref` | all | `main` | Ref of the factory scripts. Must equal the ref in that job's `uses:`. |
| `factory_repo` | all | `chizhangucb/tomte` | Repo holding the factory scripts. |
| `node_version` | implement, implement-pr, review, merge-gate, audit | `"22"` | The Node the agent, `test_command`, the merge gate's test runs and the factory's own engine get. Match the target's CI, on every one of those jobs (chronicle needs `"24"`). |
| `implementer_model` | implement, implement-pr | `claude-opus-5` | Model for the implementer. A `model:<name>` label on a ticket overrides it for that run only. |
| `reviewer_model` | review | `claude-opus-5` | Model for the reviewer. Never overridden by a label. |
| `audit_model` | audit | `claude-opus-5` | Model for the audit. Never overridden by a label. |
| `test_command` | review, audit | `npm ci && npm run typecheck --if-present && npm test` | The target's whole suite, run before the agent starts; the output is evidence for the verdict. It stays an input because how a target is built and tested is a fact about that target rather than a choice a maintainer could get wrong, the same class as `node_version`, and a target that is not an npm project would otherwise give the reviewer and the audit no test evidence to read. |
| `test_command` | merge-gate | `node --test` | A different input sharing the name: it receives one changed test file as an argument, once per file, rather than running the whole suite. It stays for the same reason as the row above, how a target runs one test file being a fact about the target, and without it the merge gate cannot run the new tests of a target whose test command is not `node --test`. |
| `install_command` | merge-gate | `npm ci` | Empty to skip. It **replaces** the default rather than running after it, so a target adding to it repeats its own install first (`npm ci && ...`) or both checkouts have no dependencies at all. Run once per checkout, so whatever a second kind of test needs installed (a browser, say) belongs here rather than in the test command, which runs once per changed test file. |
| `checks_timeout_minutes` | review | `15` | How long the retry handler waits after the verdict for the head's merge gate and CI to settle. A check still pending then is requeued, not failed. |
| `trusted_author_associations` | dispatch, implement, implement-pr, review, audit | `OWNER` | Whose words the factory acts on. Set all five together. |
| `stuck_minutes`, `verdict_minutes`, `update_minutes` | dispatch | `30`, `30`, `30` | The reconciler's deadlines. |

## Two conditional extras

- A target with two kinds of test needs a **routing test command** (`templates/routing-test-command.sh`) named in the merge-gate job's `test_command`; see [merge-gate.md](merge-gate.md).
- Any producer opening its own PR (an interactive session, a cloud agent) needs the judged-path line (`templates/agents-md-judged-path.md`) in its `AGENTS.md`, and its branch has to be in the target, not a fork, or the PR is refused.
