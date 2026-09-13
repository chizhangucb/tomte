# Engine notes

- Sandcastle 0.12.0 pinned exactly, Claude Code CLI pinned in `package.json`, both installed from the lockfile on every run. `package-lock.json`'s `integrity` for `node_modules/@ai-hero/sandcastle` is the live check on what a run installs, so `npm ci` is the check and CI needs no hash step of its own.
- The 0.12.0 tarball is also attached to the `engine-0.12.0` release as cold storage, should the npm copy go away. Nothing fetches it: no workflow, no script, no install path. A bump cuts the next `engine-<version>` release the same way (ADR 0002).
- Every run logs to a file with the stream event hook and appends Claude's raw `result` events to `<name>.result-events.jsonl` in the log artifact as they arrive. Success is decided from the last of them (`is_error`), never from the library's return value or the CLI exit code, because a rate-limited `claude -p` exits 0. Every event is still read for rate-limit detection.
- Runs pass `--dangerously-skip-permissions` on a bare ephemeral runner (ADR 0002). Pushes and PR creation use `FACTORY_PAT` so the target's CI fires on the agent's work.
- Skill invocations (`Skill` tool uses) are echoed to the job log as `skill <name> <args>`; the library's parser only surfaces Bash, WebSearch, WebFetch and Agent calls.

## Develop

```
npm ci
npm run typecheck
npm test
```
