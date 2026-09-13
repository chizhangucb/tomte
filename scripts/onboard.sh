#!/usr/bin/env bash
# Onboard a target repo: labels, auto-merge, and a `factory` ruleset on the default branch. Idempotent.
#   scripts/onboard.sh owner/repo [--no-own-checks] [--allow-drop] [own-check ...]
# An own check is a required context in the target's `factory` ruleset not starting with `factory/`.
# Nothing is read off the target's commits: the script guesses no check, ever.
#   named: required as listed. None named: a re-run keeps what the ruleset already requires.
#   None named, no ruleset yet, and no workflow that runs on a pull request: a starter CI file
#     is written from templates/rollup-check.yml, publishing the roll-up check `check`, and
#     `check` is required. One command, no flag. --no-own-checks still writes no file.
#   None named, no ruleset yet, and the target has such a workflow: refused, with the roll-up to
#     paste and that repo's own job names already in its `needs`.
#   A write that would drop an own check: refused, unless --allow-drop.
# The CI of a target that has some is never edited, ever.
# Every refusal is before the first write.
set -euo pipefail
repo="${1:?usage: onboard.sh owner/repo [--no-own-checks] [--allow-drop] [own-check ...]}"
shift

# Every refusal prints like this and exits before any write: no label, no repo edit, no ruleset.
# Defined before the arguments are read, so a bad argument refuses in the same voice as the rest.
refuse() {
  {
    echo "############################################################"
    echo "## REFUSED: $repo was not onboarded, and nothing was written."
    while IFS= read -r line; do echo "## $line"; done <<<"$1"
    echo "############################################################"
  } >&2
  exit 1
}

# The repo comes first, before any flag: a flag in that slot would otherwise be read as the
# target's name and reach `gh` as one, failing on a repo nobody meant to name.
case "$repo" in
  -*) refuse "the repo comes first, and \"$repo\" reads as a flag:
  scripts/onboard.sh owner/repo [--no-own-checks] [--allow-drop] [own-check ...]" ;;
esac

no_own_checks=false
allow_drop=false
write_starter=false

# `a, b, c` from a list, since ${array[*]} joins on one character and the separator here is two.
join_with() {
  local separator="$1" joined="" item; shift
  for item in "$@"; do joined+="${joined:+$separator}$item"; done
  printf '%s' "$joined"
}
named=()
# A count of its own: bash 3.2, which is what macOS ships, reads an empty array as unset under
# `set -u`, so every array below is counted as it is filled and expanded with the `+` guard.
named_count=0
for argument in "$@"; do
  case "$argument" in
    --no-own-checks) no_own_checks=true ;;
    --allow-drop) allow_drop=true ;;
    # An empty argument names no check. Anything else beginning with `-` is a typo for a flag,
    # and requiring it as a context is the one reading that cannot be what was meant.
    "") ;;
    -*) refuse "unknown flag: $argument
The flags are --no-own-checks and --allow-drop." ;;
    *) named+=("$argument"); named_count=$((named_count + 1)) ;;
  esac
done

# Printed before the ruleset write and again after it, so it cannot scroll past.
warn_no_own_check() {
  {
    echo "############################################################"
    if [ "$has_caller" = "true" ]; then
      echo "## WARNING: no own check for $repo."
      echo "## The factory ruleset gates on the factory's checks alone:"
      echo "##   factory/verdict, factory/red-green, factory/test-integrity."
      echo "## The target's own CI is not required, so a PR that breaks the"
      echo "## target's build still merges."
    else
      echo "## WARNING: no own check for $repo, and it carries no caller."
      echo "## The ruleset requires nothing at all: no factory checks, since"
      echo "## no caller posts them, and no own check either. A PR merges"
      echo "## with nothing having run on it."
    fi
    echo "## Fix: name the checks the target's CI posts, which requires"
    echo "## exactly what you list, e.g."
    echo "##   scripts/onboard.sh $repo check"
    echo "############################################################"
  } >&2
}

note_unused_defaults() {
  {
    echo "############################################################"
    echo "## NOTE: $repo may still carry GitHub's default labels that"
    echo "## nothing here uses. This script deletes nothing, ever."
    echo "## Check each is unused on $repo first: deleting a label strips"
    echo "## it from every issue carrying it, silently and with no way back."
    echo "## To drop the ones it has, by hand:"
    for unused in "documentation" "good first issue" "help wanted" "invalid" "question"; do
      echo "##   gh label delete \"$unused\" --repo $repo --yes"
    done
    echo "## Not in that list, and not to be deleted: bug, enhancement,"
    echo "## wontfix and duplicate. Those are triage vocabulary."
    echo "############################################################"
  } >&2
}

judged_path_template="$(dirname "${BASH_SOURCE[0]}")/../templates/agents-md-judged-path.md"
note_judged_path() {
  {
    echo "############################################################"
    echo "## NOTE: an agent opening a PR on $repo itself needs"
    echo "## the line below in the target's AGENTS.md (or CLAUDE.md),"
    echo "## as it stands, or that PR stays blocked. It is the whole of"
    echo "## templates/agents-md-judged-path.md:"
    cat "$judged_path_template" ||
      echo "## (could not read it here: take it from the factory repo)"
    echo "## Landing it is $repo's own PR: this script writes no"
    echo "## file there."
    echo "############################################################"
  } >&2
}

rollup_template="$(dirname "${BASH_SOURCE[0]}")/../templates/rollup-check.yml"
# The roll-up's name, and where the starter file that publishes it goes.
rollup_check="check"
starter_path=".github/workflows/check.yml"

# One workflow file off the target, raw. A 404 is an answer (it is not there) and returns 1;
# anything else is not an answer and returns 2, having said why. Reading a failure as "not
# there" is how a target with CI would be read as empty and then written to. The caller cannot
# `exit` here: this runs in a command substitution, where an exit ends the subshell alone.
workflow_body() {
  local body error text status=0
  error=$(mktemp)
  body=$(gh api -H "Accept: application/vnd.github.raw" "repos/$repo/contents/.github/workflows/$1" 2>"$error") || status=$?
  text=$(cat "$error"); rm -f "$error"
  if [ "$status" -ne 0 ]; then
    case "$text" in
      *"HTTP 404"*) return 1 ;;
      *) echo "onboard.sh: could not read $repo's .github/workflows/$1: $text" >&2; return 2 ;;
    esac
  fi
  printf '%s\n' "$body"
}

# Reads first, every one of them, so a refusal below happens before anything is written.
default_branch=$(gh api "repos/$repo" --jq .default_branch)

# The spec-title rule the dispatcher enforces (#296) lives in the target's issue-tracker.md,
# which Matt's skills set up. Read it here, in the reads-first section: a target without it is
# not set up yet and is refused before any write; a target that has it but not the rule has the
# rule appended below. The bullet is idempotent: a re-run that finds it writes nothing.
issue_tracker_path="docs/agents/issue-tracker.md"
issue_tracker_bullet='- **A spec title starts `Spec:`**: prefix it after `/to-spec` publishes. The dispatcher skips any `Spec:` issue, sliced or not (#296).'
write_issue_tracker=false
it_error_file=$(mktemp)
it_status=0
issue_tracker_json=$(gh api "repos/$repo/contents/$issue_tracker_path" 2>"$it_error_file") || it_status=$?
it_error=$(cat "$it_error_file"); rm -f "$it_error_file"
if [ "$it_status" -ne 0 ]; then
  case "$it_error" in
    *"HTTP 404"*) refuse "$repo has no docs/agents/issue-tracker.md, so it isn't set up with Matt's skills yet.
Set it up in that repo's clone, then re-onboard:

  /mattpocock-skills:setup-matt-pocock-skills
  scripts/onboard.sh $repo" ;;
    *) refuse "$repo's docs/agents/issue-tracker.md could not be read:
  $it_error
It is where the dispatcher's spec-title rule lives, and a target that has it
but reads as missing would be refused as un-set-up." ;;
  esac
fi
issue_tracker_sha=$(jq -r '.sha // ""' <<<"$issue_tracker_json")
issue_tracker_content=$(jq -r '(.content // "") | gsub("\n";"") | @base64d' <<<"$issue_tracker_json")
# Idempotent: the rule's distinctive opening is the marker, so a re-run adds nothing and a
# file that carries it, however the rest reads, is left alone.
case "$issue_tracker_content" in
  *"A spec title starts"*) ;;
  *) write_issue_tracker=true; issue_tracker_new_content="$issue_tracker_content"$'\n'"$issue_tracker_bullet"$'\n' ;;
esac
caller_status=0
caller=$(workflow_body factory.yml) || caller_status=$?
case "$caller_status" in
  0) has_caller=true ;;
  1) has_caller=false; caller="" ;;
  *) exit 1 ;;
esac

# The target's own CI is a workflow that runs on a pull request and is not the caller: the caller
# runs on one too, and posts the factory's checks, never the target's own. Three forms of the
# trigger, and the whole file is read rather than the `on:` block alone: a job keyed
# `pull_request` would read as a trigger and the target as having CI, which refuses, where
# assuming `on:` comes before `jobs:` risks the other error, writing into a CI that exists.
# `on: [pull_request]` and `"on":` both read, since YAML 1.1 makes a bare `on` a boolean and a
# target is free to quote it, and so does the flow form, `pull_request: {branches: [main]}`:
# whatever follows the key is not read, so a trigger written inline is still a trigger. A false
# negative here is the expensive one, since it is what writes a starter file into a live CI.
# `pull_request_target` is not it: the character after `pull_request` has to end the key.
runs_on_pull_request() {
  awk '/^("?on"?:).*pull_request([]},:[:space:]]|$)/ { found = 1 }
       /^[[:space:]]*-?[[:space:]]*pull_request:?([[:space:]].*)?$/ { found = 1 }
       END { print found ? "true" : "false" }' <<<"$1"
}
# The job keys of a workflow: the keys at the first indentation seen under `jobs:`, whatever that
# indentation is, and no deeper. Pinning it to two spaces read a four-space file as having no job
# at all, and `needs: []` is a roll-up that rolls up nothing and is green forever.
job_keys() {
  awk '/^jobs:/ { in_jobs = 1; next }
       in_jobs && /^[A-Za-z]/ { exit }
       in_jobs && /^[[:space:]]+[A-Za-z0-9_.-]+:([[:space:]]*(#.*)?$|[[:space:]]*\{)/ {
         indent = match($0, /[^[:space:]]/)
         if (job_indent == 0) job_indent = indent
         if (indent != job_indent) next
         sub(/:.*$/, ""); gsub(/ /, ""); print }' <<<"$1"
}

workflows_error_file=$(mktemp)
workflows_status=0
workflows=$(gh api "repos/$repo/contents/.github/workflows" --jq '.[].name' 2>"$workflows_error_file") ||
  workflows_status=$?
workflows_error=$(cat "$workflows_error_file")
rm -f "$workflows_error_file"
if [ "$workflows_status" -ne 0 ]; then
  case "$workflows_error" in
    # No workflow directory at all: the empty target, which is the case the starter file is for.
    *"HTTP 404"*) workflows="" ;;
    *) refuse "$repo's workflows could not be listed:
  $workflows_error
That listing is what says whether the target has CI of its own, and a target
that has some is never written to." ;;
  esac
fi
own_ci_jobs=()
own_ci_files=()
own_ci_file_count=0
has_own_ci=false
starter_path_taken=false
while IFS= read -r workflow; do
  case "$workflow" in "") continue ;; esac
  if [ ".github/workflows/$workflow" = "$starter_path" ]; then starter_path_taken=true; fi
  case "$workflow" in factory.yml) continue ;; esac
  body_status=0
  body=$(workflow_body "$workflow") || body_status=$?
  case "$body_status" in 0) ;; 1) continue ;; *) exit 1 ;; esac
  if [ "$(runs_on_pull_request "$body")" != "true" ]; then continue ; fi
  has_own_ci=true
  own_ci_files+=("$workflow"); own_ci_file_count=$((own_ci_file_count + 1))
  while IFS= read -r job; do
    # Nothing that cannot go in the pasted roll-up's `needs`: its own two job keys (a job cannot
    # depend on itself, and a second `check:` in one file is a duplicate key), and a name already
    # listed, which two workflows sharing a job name would otherwise produce.
    case "$job" in "" | "$rollup_check" | "$rollup_check-stub") continue ;; esac
    for seen in ${own_ci_jobs[@]+"${own_ci_jobs[@]}"}; do
      if [ "$seen" = "$job" ]; then continue 2; fi
    done
    own_ci_jobs+=("$job")
  done <<<"$(job_keys "$body")"
done <<<"$workflows"

# What the starter file runs, from the caller's merge-gate job, so the values live in one place.
# That job and not the file at large: the same input names appear on implement, review and audit
# too, and the merge-gate's are the ones that say what this target installs and how it tests.
# A caller leaving one unset runs .github/workflows/merge-gate.yml's default for it, and the
# fallbacks below are those defaults; onboard.test.ts fails the day the two disagree.
caller_input() {
  local value
  value=$(awk -v key="$1:" '
    /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { in_merge_gate = ($1 == "merge-gate:") }
    in_merge_gate && $1 == key {
      sub(/^[^:]*:[[:space:]]*/, ""); sub(/[[:space:]]+$/, ""); print; exit }' <<<"$caller")
  # A quoted scalar ends at its closing quote, so `'24'` is 24 and a `#` inside it is content.
  # An unquoted one ends at a ` #` comment, which is where YAML ends it too. Neither is left in:
  # `node-version: "'24'"` is a Node nobody has, and a comment carried through breaks the file.
  case "$value" in
    \"*) value=${value#\"}; value=${value%%\"*} ;;
    \'*) value=${value#\'}; value=${value%%\'*} ;;
    *)   value=${value%%[[:space:]]#*} ;;
  esac
  printf '%s' "${value:-$2}"
}

# The roll-up, as templates/rollup-check.yml holds it, with the jobs it rolls up and the work it
# runs itself filled in. Both paths use it: the starter file writes it, the refusal prints it.
rollup() {
  # The steps go through the environment: `awk -v` takes no newline in a value.
  STEPS="$2" awk -v needs="$1" '
    /^__STEPS__$/ { if (ENVIRON["STEPS"] != "") print ENVIRON["STEPS"]; next }
    { gsub(/__NEEDS__/, needs); print }' "$rollup_template"
}
starter_file() {
  # The comment goes in the written file: the caller's test_command is run once per changed test
  # file, so a target pointing it at a routing command (templates/routing-test-command.sh) gets a
  # step here that is handed no file and passes having run nothing.
  printf '%s\n' "$(rollup "[]" "$(printf '      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: "%s"\n      - run: %s\n      # From the caller. Replace it if it is a routing command: it runs the test\n      # file it is handed, and here it is handed none.\n      - run: %s' \
    "$(caller_input node_version 22)" "$(caller_input install_command "npm ci")" "$(caller_input test_command "node --test")")")"
}

# One assignment, no `| head`: a pipeline here either swallows a failed listing or SIGPIPEs gh on
# a repo with several rulesets, and either way onboarding cannot tell a first run from a re-run.
# `includes_parents=false` because the listing defaults to including the org's rulesets: one named
# `factory` there would read as this target's own, so a first run would skip the refusal and the
# PUT below would go to an id this repo does not own, after the labels were already written.
rulesets_error_file=$(mktemp)
rulesets_status=0
rulesets=$(gh api "repos/$repo/rulesets?includes_parents=false" --jq '.[] | select(.name == "factory") | .id' 2>"$rulesets_error_file") ||
  rulesets_status=$?
rulesets_error=$(cat "$rulesets_error_file")
rm -f "$rulesets_error_file"
if [ "$rulesets_status" -ne 0 ]; then
  refuse "$repo's rulesets could not be listed:
  $rulesets_error
That listing is what tells a first run from a re-run, so onboarding cannot
tell whether there is a factory ruleset to keep own checks from."
fi
existing_ruleset_id=${rulesets%%$'\n'*}
existing_own=()
existing_own_count=0
if [ -n "$existing_ruleset_id" ]; then
  # Assigned, not looped over inline, so a failure is caught: a ruleset that exists and cannot be
  # read is a refusal, never an empty answer, or the read failure reads as "this target requires
  # nothing" and the write below takes its own checks off.
  ruleset_error_file=$(mktemp)
  ruleset_status=0
  contexts=$(gh api "repos/$repo/rulesets/$existing_ruleset_id" \
    --jq '.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context' \
    2>"$ruleset_error_file") || ruleset_status=$?
  ruleset_error=$(cat "$ruleset_error_file")
  rm -f "$ruleset_error_file"
  if [ "$ruleset_status" -ne 0 ]; then
    refuse "The factory ruleset (id $existing_ruleset_id) is there but could not be read:
  $ruleset_error
Its own checks are what a re-run keeps and what a drop is measured against,
so onboarding cannot tell what this write would take away."
  fi
  while IFS= read -r context; do
    # The factory's three are the caller's to require, never the target's own.
    case "$context" in "" | factory/*) continue ;; esac
    existing_own+=("$context"); existing_own_count=$((existing_own_count + 1))
  done <<<"$contexts"
fi

# Where the own checks come from: the command line, the flag, or the ruleset already there.
if [ "$named_count" -gt 0 ] && [ "$no_own_checks" = "true" ]; then
  refuse "--no-own-checks says $repo has no own check, and these were named anyway:
  ${named[*]}
Pass one or the other."
elif [ "$named_count" -gt 0 ]; then
  own=("${named[@]}")
  echo "own checks named on the command line: ${own[*]}"
elif [ "$no_own_checks" = "true" ]; then
  own=()
  echo "no own check, as --no-own-checks says"
elif [ -n "$existing_ruleset_id" ]; then
  own=(${existing_own[@]+"${existing_own[@]}"})
  if [ "$existing_own_count" -gt 0 ]; then
    echo "own checks kept from the factory ruleset (id $existing_ruleset_id): ${own[*]}"
  else
    echo "no own check to keep: the factory ruleset (id $existing_ruleset_id) requires none"
  fi
elif [ "$has_own_ci" = "false" ]; then
  # No CI to name a check from, so onboarding writes one rather than refusing: the roll-up's
  # name exists before the first test does, and the factory's first test lands inside it.
  if [ "$starter_path_taken" = "true" ]; then
    refuse "$repo has no workflow that runs on a pull request, so onboarding would write
$starter_path, and that file is already there. Nothing here overwrites it.
Name the checks its CI posts instead:
  scripts/onboard.sh $repo <check> ..."
  fi
  own=("$rollup_check")
  write_starter=true
  echo "no workflow here runs on a pull request: $starter_path will publish $rollup_check"
else
  # `needs` names jobs in the one file the roll-up lives in, so the filled-in list is a
  # starting point whenever more than one workflow contributed to it, and says so. A job that
  # is skipped rather than run reports `skipped`, which the result test below reads as not
  # success: take a path-filtered or conditional job out of `needs` rather than gating on it.
  several_files=""
  if [ "$own_ci_file_count" -gt 1 ]; then
    several_files="\`needs\` reaches jobs in its own file only, and these came from several:
  $(join_with ", " ${own_ci_files[@]+"${own_ci_files[@]}"})
Keep the ones in the file you paste this into.
"
  fi
  refuse "$repo has no factory ruleset yet and no own check was named, and its CI is
its own: onboarding never edits the CI of a target that has some.
Add a roll-up to it, and this run then has a name to require. As it stands:

$(rollup "$(printf '[%s]' "$(join_with ", " ${own_ci_jobs[@]+"${own_ci_jobs[@]}"})")" "")
${several_files}Leave out any job that is skipped rather than run on some pull requests: a
skipped job reports \`skipped\`, and the result test above wants \`success\`.

Then:
  scripts/onboard.sh $repo $rollup_check
Or name the checks its CI already posts:
  scripts/onboard.sh $repo <check> ...
Or --no-own-checks, if it genuinely has none yet."
fi

# A write that takes an own check off the ruleset is the foot-gun, whatever put the list together.
dropped=()
dropped_count=0
for was_required in ${existing_own[@]+"${existing_own[@]}"}; do
  still_required=false
  for keeping in ${own[@]+"${own[@]}"}; do
    if [ "$keeping" = "$was_required" ]; then still_required=true; break; fi
  done
  if [ "$still_required" = "false" ]; then dropped+=("$was_required"); dropped_count=$((dropped_count + 1)); fi
done
if [ "$dropped_count" -gt 0 ] && [ "$allow_drop" = "false" ]; then
  refuse "This run would stop requiring own checks $repo's factory ruleset requires:
$(printf '  %s\n' "${dropped[@]}")
A PR that breaks one would then merge clean.
Name them alongside the rest, or pass --allow-drop if they really are to go."
fi

# `--force` rewrites a same-named label the target already has: check `hold` is not already theirs.
# The five triage roles' descriptions are docs/agents/triage-labels.md's Meaning column.
label() { gh label create "$1" --repo "$repo" --color "$2" --description "$3" --force >/dev/null && echo "label $1"; }
gh repo edit "$repo" --enable-auto-merge --delete-branch-on-merge >/dev/null
echo "repo: auto-merge allowed, branches deleted on merge"
label "ready-for-agent"   "0e8a16" "Fully specified, ready for an AFK agent"
label "hold"              "d4c5f9" "Factory: never dispatched while this is set"
label "ready-for-human"   "c2e0c6" "Requires human implementation"
label "needs-triage"      "ededed" "Maintainer needs to evaluate this issue"
label "needs-info"        "bfd4f2" "Waiting on reporter for more information"
label "wontfix"           "ffffff" "Will not be actioned"
label "bug"               "d73a4a" "Something is broken"
label "enhancement"       "a2eeef" "New feature or improvement"
label "agent:implement"   "1d76db" "Factory: run the implementer on this ticket"
label "agent:in-progress" "fbca04" "Factory: a run is active"
label "agent:review"      "5319e7" "Factory: run the reviewer on this PR"
label "agent:blocked"     "b60205" "Factory: last run failed, see the comment"
label "needs-human"       "d93f0b" "Factory: escalated, a human must read this"
label "factory:retry-1"   "c5def5" "Factory: retries used on this ticket"
label "wayfinder:map"       "006b75" "Wayfinder: the map a chart's decision tickets hang off"
label "wayfinder:research"  "006b75" "Wayfinder: AFK, read sources for a fact a decision waits on"
label "wayfinder:prototype" "006b75" "Wayfinder: with a human, a rough artifact to react to"
label "wayfinder:grilling"  "006b75" "Wayfinder: with a human, conversation to settle a decision"
label "wayfinder:task"      "006b75" "Wayfinder: manual work a decision is blocked on, AFK where it can be"

build_checks() {
  jq -cn '[$ARGS.positional[] | select(. != "")]
    | reduce .[] as $c ([]; if index($c) then . else . + [$c] end)
    | map({context: .})' --args "$@"
}
if [ "$has_caller" = "true" ]; then
  checks=$(build_checks factory/verdict factory/red-green factory/test-integrity ${own[@]+"${own[@]}"})
else
  checks=$(build_checks ${own[@]+"${own[@]}"})
fi
own_checks=$(jq -r '[.[].context | select(. != "" and (startswith("factory/") | not))] | length' <<<"$checks")
# The admin role (actor_id 5) bypasses the ruleset, so a human can still push the caller workflow.
payload=$(jq -cn --arg branch "$default_branch" --argjson checks "$checks" '{
  name: "factory",
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: ["refs/heads/\($branch)"], exclude: [] } },
  bypass_actors: [ { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" } ],
  rules: [
    { type: "deletion" },
    { type: "non_fast_forward" },
    { type: "pull_request", parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
        require_extra_approval_for_unattributed_changes: false,
        allowed_merge_methods: ["squash"] } },
    { type: "required_status_checks", parameters: {
        strict_required_status_checks_policy: true,
        do_not_enforce_on_create: false,
        required_status_checks: $checks } }
  ]
}')
if [ "$own_checks" -eq 0 ]; then warn_no_own_check; fi
# The spec-title rule, if the target's issue-tracker.md did not already carry it (#296). The
# read and the refusal are done above; this only writes, and only when the rule is missing.
if [ "$write_issue_tracker" = "true" ]; then
  jq -n --arg content "$issue_tracker_new_content" --arg branch "$default_branch" --arg sha "$issue_tracker_sha" \
    '{ message: "docs: the dispatcher skips a Spec:-titled issue (#296)",
       branch: $branch, sha: $sha, content: ($content | @base64) }' |
    gh api --method PUT "repos/$repo/contents/$issue_tracker_path" --input - >/dev/null
  echo "issue-tracker.md: added the spec-title rule"
fi
# Before the ruleset, so the check the rule is about to require is already published. Only ever
# on a target with no workflow that runs on a pull request: nothing here edits CI that exists.
if [ "$write_starter" = "true" ]; then
  jq -n --arg content "$(starter_file)" --arg branch "$default_branch" \
    '{ message: "ci: a roll-up check, so the merge rule never names a test",
       branch: $branch, content: ($content + "\n" | @base64) }' |
    gh api --method PUT "repos/$repo/contents/$starter_path" --input - >/dev/null
  echo "starter CI file written: $starter_path, publishing $rollup_check"
fi
if [ -n "$existing_ruleset_id" ]; then
  gh api --method PUT "repos/$repo/rulesets/$existing_ruleset_id" --input - <<<"$payload" >/dev/null
  echo "ruleset factory updated (id $existing_ruleset_id)"
else
  id=$(gh api --method POST "repos/$repo/rulesets" --input - <<<"$payload" --jq .id)
  echo "ruleset factory created (id $id)"
fi
echo "required on $default_branch: $(jq -r '[.[].context] | join(", ")' <<<"$checks")"
# Last, so the warning has the last word on screen.
if [ "$has_caller" = "true" ]; then note_judged_path; fi
note_unused_defaults
if [ "$own_checks" -eq 0 ]; then warn_no_own_check; fi
