#!/usr/bin/env bash
# Run the heartbeat forever on an always-on machine (#326).
#   scripts/heartbeat-loop.sh
# No arguments, and no interval of its own: one pass is a fast-forward pull of `main`, the
# sender, then a sleep of whatever `factory/heartbeat/interval.ts` says, read back through
# `node` after every pull. So a merged fix, a target added to `targets.ts` and a moved
# interval all reach the heartbeat on the next pass with nothing edited on the host, which
# is the whole reason the host runs a loop instead of a scheduler (#324).
# The host's only job is keeping this alive: launchd `KeepAlive`, systemd `Restart=always`,
# README's own-machine recipe. Run it from a clone kept on `main` and used for nothing else;
# it pulls, so a session that left a branch checked out would change what sweeps the targets.
# `GH_TOKEN` and the ping URL are the environment's to set and are passed through untouched.
# A failed pull or a failed pass is a line on stderr and never the end of the loop: one bad
# pass must not stop every target sweeping, and a pull that could not reach GitHub leaves a
# clone that is still `main` as merged, one pass behind.
#
# Every line below lives in a function called on the last line, and that is load-bearing:
# the pull rewrites this file, bash reads a script lazily by byte offset, and a shell that
# resumed a rewritten file part-way through would run whatever the new bytes at that offset
# spell. A function is parsed whole before it runs, and the call is the last thing there is
# to read, so a merged edit takes effect on the next start and never mid-loop.
set -uo pipefail

# The interval, in the seconds `sleep` takes, read out of the module rather than restated:
# the number lives in one place and `send.test.ts` refuses any file that writes it again.
# Read through the same bare `node` the sender runs on, so a host that can run a pass can
# always answer this too.
read_interval_seconds() {
  node --experimental-strip-types --input-type=module \
    -e 'import { HEARTBEAT_INTERVAL_MINUTES } from "./factory/heartbeat/interval.ts"; process.stdout.write(String(HEARTBEAT_INTERVAL_MINUTES * 60));'
}

heartbeat_loop() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

  # Stamped like the sender's own lines, since a host's log is the only history of a loop and
  # neither launchd nor systemd timestamps what it keeps alive.
  log() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') heartbeat-loop: $*"; }

  # The last interval that was read. A read that fails leaves the loop sleeping what the repo
  # last said, because a pass every interval on a stale number beats a hot loop or a stopped
  # heartbeat. Nothing has been read before the first pull, which is the one case there is no
  # answer to: a `node` the keep-alive's PATH cannot see, or a directory that is not a clone
  # of this repo, neither of which the loop will fix by running. It says which and stops, so
  # a maintainer reads it off the failed unit rather than out of a log that scrolls.
  local interval_seconds=""
  local seconds

  while true; do
    git pull --ff-only origin main || log "pull failed; this pass runs the clone as it stands" >&2

    # The answer is checked and not just the exit status. A `node` that exits 0 having
    # printed a warning, a blank line or nothing at all would otherwise be slept, and
    # `sleep` refusing it every time is a loop with no wait in it at all: passes back to
    # back on every target, which is the one failure here that spends money.
    seconds=$(read_interval_seconds)
    if [[ "$seconds" =~ ^[0-9]+$ ]]; then
      interval_seconds="$seconds"
    elif [ -z "$interval_seconds" ]; then
      log "could not read the heartbeat interval from factory/heartbeat/interval.ts; nothing to sleep, so stopping" >&2
      exit 1
    else
      log "could not read the heartbeat interval; sleeping the last one read" >&2
    fi

    if node --experimental-strip-types factory/heartbeat/send.ts; then
      log "pass finished"
    else
      log "pass FAILED; the next one runs anyway" >&2
    fi

    sleep "$interval_seconds"
  done
}

heartbeat_loop
