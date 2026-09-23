# Merge gate

`merge-gate.yml` runs no agent. It reads the PR diff, notes the linked ticket's number (`Closes #N` in the PR body) for its summary, and posts two commit statuses on the PR head. Neither check reads the ticket's body: whether a deletion was owed is the reviewer's and the audit's judgment, and a wrong refusal on a required check has no judge after it.

- `factory/red-green`: the PR's new or changed test files (`*.test.*`, `*.spec.*`, `_test.go`, `test_*.py`, anything under `__tests__/`) are copied onto a checkout of the base branch and run alone. At least one of them must fail there, and all of them must pass on the head. A helper or fixture under `test/` is a source change, not a test.

  Each file is run in its own invocation of the target's **test command**, on the base and on the head alike, so a failure names the file that failed and nothing else. Install runs once per checkout, not once per file. Requiring only one file to go red on the base is today's meaning kept: a batch's non-zero exit meant at least one file failed there, and requiring every file would newly refuse a PR that adds a real new test in one file and tidies the wording of another. The per-file exit statuses reach the status summary, `merge-gate.json` as `redGreen.runs`, and the retry marker; each side's log holds one section per file, the head's failures last, because a retry quotes that log's tail.

  A changed test file the merge gate could not run at all is passed over rather than failed, named in the status with the reason, and left to the reviewer and the audit the way a deleted test is. **Unrunnable** means the file's process died before any test reported a result; a file that ran and failed still fails the check. Such a file is left out of the base-red count, since it proved nothing either way, and a change whose touched test files are all unrunnable passes with a reason saying plainly that nothing was proved. `merge-gate.json` carries each file's answer as `redGreen.runs[].runnability` and the whole list as `redGreen.unrunnable`.

  Only the default test command gets that detection. The merge gate chooses that invocation, so it appends `--test-reporter=tap` and reads the report: a file whose process died is reported as one entry named after the file carrying the dead process's exit status, where a genuine failure carries the assertion and no exit status. A caller's own test command is never parsed, because a wrong guess about output the merge gate does not understand would either hide a real failure or invent a fake excuse; under one of those every file counts as having run, a dying file simply fails, and the per-file split alone means it names only itself.

  So a target gets two layers, and only the first is owed to it. **The per-file split protects every target for free**, with nothing to configure: no passing file is ever blamed for the file beside it that failed. **Passing over what could not be run rides on the default test command alone**, per the paragraph above, so a target that names any command of its own gives it up. **A routing test command is the opt-in second layer**, bought with that, and what restores a real before-and-after proof for a second kind of test: `templates/routing-test-command.sh` is a worked example a target copies into its own tree, edits at its one marked mapping, and names in the merge-gate job's `test_command`. It has to be on the default branch, like the caller, since the merge gate runs the test command on a checkout of the base branch too. Only the target knows which of its files are which kind, so the factory ships the shape and not the knowledge. A target that never adopts it is correct, just less proved, and the status says so.

  Two costs come with the per-file rule. The test command's startup is paid once per file per side, so a PR touching many test files on a target whose command boots a real test framework can run long enough to reach the merge gate job's 30 minute timeout, and a job killed there posts no status at all, leaving both checks pending rather than red. And a test command that cannot run one file alone now reports its own failure as the file's: `go test` will not compile a single `_test.go` without the rest of its package, and pytest exits 5 on a file that collects no tests. On the default command a file like that reads as unrunnable and is passed over; under a caller's own command it fails, and the answer is a test command that maps each file to the invocation its kind needs.

  It passes vacuously twice over: when the diff changes no source file, and when the diff deletes a source or test file (a test renamed out of the test tree counts; a deleted doc or config file does not), while adding or changing no test, with a reason that says nothing was proved. Not source: a doc, a dotfile anywhere, and a data or manifest file (`.yml`, `.json`, `.toml`, `.lock`, and the rest of `CONFIG_EXTENSIONS`) at the repo root or under a dot directory. The same extension nested deeper is data the code reads, and stays source. Outside those two passes, a source change with no test change fails.
- `factory/test-integrity`: fails on a new `skip`, `only` or `todo` marker in a test file. A deleted test file, or a test renamed out of the test tree, never fails it; the check lists each one in its summary and in `merge-gate.json` as `deletedTests`, for the reviewer and the audit to judge against the ticket.

## Which event the gate answers

The gate runs on a pull request and on `merge_group`, GitHub's merge-queue event, and judges both the same way (#344). A queue rebases a queued pull request onto the latest default branch and asks for the required checks on that candidate just before it lands; a required workflow that does not subscribe to `merge_group` never reports on one, so the name stays pending and the queue waits on it forever.

It is one definition, not two. `merge-gate.yml` is a `workflow_call` workflow with no triggers of its own, so it runs on whatever event reached the caller, and `factory/merge-gate/gate-subject.ts` reads the three things the gate needs off whichever payload arrived: the pull request number, the head sha, and the base branch. A `merge_group` payload carries no `pull_request` object at all, and the queue branch is the only place it says which pull request the candidate came from (`gh-readonly-queue/<base>/pr-<number>-<sha>`). Nothing behind that function knows which event ran, so `factory/red-green` and `factory/test-integrity` mean on a candidate exactly what they mean on the pull request.

A queue no repo has enabled sends no `merge_group`, so the trigger changes nothing until a target's ruleset turns one on.

### The one line a target adds

Every workflow a target's merge rule requires by name needs this, next to its existing `pull_request:`, and nothing else:

```yaml
on:
  pull_request:
  merge_group:
```

That is the whole of the caller-side change. Do it in **every** required workflow, not just some: the queue waits on all of them, and one that stays silent stalls the queue as surely as a red one blocks it. For a typical target that is the caller `.github/workflows/factory.yml` (which carries `factory/red-green` and `factory/test-integrity` to the candidate), the check roll-up that publishes `check`, and whatever else the ruleset names -- `gitleaks` and `e2e` on chronicle, for instance. `templates/factory.yml` and `templates/rollup-check.yml` already carry it, so a target copying either today needs no edit; `scripts/onboard.sh` writes the roll-up from that template, so an onboarded starter file carries it too.

Two things it does not cover, both deliberately out of the trigger's scope: the caller's `merge-gate` job condition has to admit the event as well (`templates/factory.yml` has it, so re-copy that job's `if:` with the `on:` block), and enabling the queue itself is a per-repo ruleset change, sequenced after every required workflow answers the event.
