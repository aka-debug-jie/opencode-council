#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' 'Usage: run_council.sh --project-dir DIR --rounds 1|2|3 < Council_Brief' >&2
  exit 2
}

project_dir=''
rounds=''
while (($#)); do
  case "$1" in
    --project-dir) (($# >= 2)) || usage; project_dir=$2; shift 2 ;;
    --rounds) (($# >= 2)) || usage; rounds=$2; shift 2 ;;
    *) usage ;;
  esac
done
case "$rounds" in 1|2|3) ;; *) usage ;; esac
test -n "$project_dir" && test -d "$project_dir" || usage

brief=$(cat)
test -n "$brief" || { printf '%s\n' 'Council brief must not be empty.' >&2; exit 2; }
if ((${#brief} > 16000)); then
  printf '%s\n' 'Council brief exceeds 16000 characters.' >&2
  exit 2
fi

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
inspector="$script_dir/inspect_session.py"
council_checkout=${COUNCIL_CHECKOUT:-$HOME/Desktop/codexapp/opencode-council}
council_node=${COUNCIL_NODE:-$council_checkout/.tools/node-v24.15.0-linux-x64/bin/node}
state_cli="$council_checkout/scripts/council-state-cli.ts"
test -x "$council_node" && test -f "$state_cli" || {
  printf '%s\n' 'Council runner requires its checkout and Node 24 state CLI.' >&2
  exit 2
}
title="codex-council-$(date +%s)-$$"
output_file=$(mktemp)
control_log_file=$(mktemp)
trap 'rm -f "$output_file" "$control_log_file"' EXIT

timeout_seconds=${CODEX_COUNCIL_TIMEOUT_SECONDS:-$((rounds * 300))}
poll_seconds=${CODEX_COUNCIL_POLL_SECONDS:-1}
[[ "$timeout_seconds" =~ ^[1-9][0-9]*$ && "$poll_seconds" =~ ^[0-9]+([.][0-9]+)?$ ]] || {
  printf '%s\n' 'Council timeout must be positive integer seconds; poll interval must be nonnegative.' >&2
  exit 2
}
deadline=$((SECONDS + timeout_seconds))
export COUNCIL_RUN_ID
COUNCIL_RUN_ID=$(python3 -c 'import uuid; print(uuid.uuid4())')
export COUNCIL_DEADLINE_MS=$(( $(date +%s%3N) + timeout_seconds * 1000 ))
export COUNCIL_STATE_DIR=${COUNCIL_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/opencode-council}
unset COUNCIL_RESUME
session_id=''
export_failures=0

remaining_seconds() {
  local remaining=$((deadline - SECONDS))
  ((remaining > 0)) || return 1
  printf '%s\n' "$remaining"
}

state_action() {
  "$council_node" "$state_cli" "$@"
}

abort_run() {
  local reason=$1
  python3 "$inspector" event-errors <"$output_file" >&2
  tail -n 80 "$control_log_file" >&2
  if ! state_action abort "$COUNCIL_RUN_ID" "$session_id" "$reason" >&2; then
    printf '## Council Abort\n\n%s\n' "$reason" >&2
  fi
  exit 1
}

run_logged() {
  local remaining
  remaining=$(remaining_seconds) || return 124
  timeout --signal=TERM --kill-after=5s "${remaining}s" "$@" >>"$output_file" 2>>"$control_log_file"
}

capture_opencode() {
  local output_var=$1
  shift
  local remaining captured
  remaining=$(remaining_seconds) || return 124
  captured=$(timeout --signal=TERM --kill-after=5s "${remaining}s" env -u COUNCIL_RUN_ID -u COUNCIL_RESUME -u COUNCIL_DEADLINE_MS "$@" 2>>"$control_log_file") || return $?
  printf -v "$output_var" '%s' "$captured"
}

if run_logged opencode run --format json --agent debate --command council --dir "$project_dir" --title "$title" -- "--rounds $rounds $brief"; then
  :
else
  initial_status=$?
  if ((initial_status == 124 || initial_status == 137)); then
    abort_run "Council runner timed out after $timeout_seconds seconds during the initial OpenCode run."
  else
    abort_run "Initial OpenCode run exited with status $initial_status."
  fi
fi

if ! capture_opencode session_list opencode session list --format json -n 50; then
  abort_run 'Council runner could not list OpenCode sessions within its deadline.'
fi
if ! session_id=$(printf '%s' "$session_list" | python3 "$inspector" find-session "$title"); then
  abort_run 'Council runner could not identify its OpenCode session.'
fi

while ((SECONDS < deadline)); do
  if ! capture_opencode export_json opencode export --sanitize "$session_id"; then
    export_failures=$((export_failures + 1))
    ((export_failures <= 1)) || abort_run 'Council runner could not export its session after one retry.'
    sleep "$poll_seconds"
    continue
  fi
  export_failures=0
  if ! session_state=$(printf '%s' "$export_json" | python3 "$inspector" state); then
    abort_run 'Council runner received a malformed OpenCode session export.'
  fi
  IFS=$'\t' read -r decision message_id <<<"$session_state"
  case "$decision" in
    transient|wait)
      sleep "$poll_seconds"
      ;;
    continue)
      [[ -n "$message_id" ]] || abort_run 'Council continuation has no assistant message ID.'
      if ! state_action continue "$COUNCIL_RUN_ID" "$session_id" "$message_id" >/dev/null; then
        abort_run 'Council persistent state rejected coordinator continuation.'
      fi
      if run_logged env COUNCIL_RESUME=1 opencode run --format json --session "$session_id" --agent debate --dir "$project_dir" 'Continue the current council from completed tool results. Follow the coordinator instructions and finish the Council Report.'; then
        :
      else
        continuation_status=$?
        if ((continuation_status == 124 || continuation_status == 137)); then
          abort_run "Council runner timed out after $timeout_seconds seconds during a coordinator continuation."
        fi
        abort_run "Council coordinator continuation exited with status $continuation_status."
      fi
      ;;
    stop)
      if ! run_state=$(state_action inspect "$COUNCIL_RUN_ID" "$session_id"); then
        abort_run 'Council runner could not inspect persistent run state.'
      fi
      if ! printf '%s' "$run_state" | python3 "$inspector" run-ready "$COUNCIL_RUN_ID" "$session_id" "$rounds"; then
        abort_run 'Council run is not ready for a completed report.'
      fi
      if ! final_report=$(python3 "$inspector" event-report "$session_id" "$message_id" <"$output_file" 2>>"$control_log_file"); then
        if ! capture_opencode final_json opencode export "$session_id"; then
          abort_run 'Council runner could not read the final OpenCode session within its deadline.'
        fi
        if ! final_report=$(printf '%s' "$final_json" | python3 "$inspector" report "$message_id" 2>>"$control_log_file"); then
          abort_run 'Council latest assistant did not produce a complete valid report.'
        fi
      fi
      report_digest=$(printf '%s' "$final_report" | python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())')
      if ! state_action complete "$COUNCIL_RUN_ID" "$session_id" "$message_id" "$report_digest" >/dev/null; then
        abort_run 'Council persistent state rejected report completion.'
      fi
      printf '%s\n' "$final_report"
      exit 0
      ;;
    *)
      abort_run "Council runner received an invalid session state: $decision."
      ;;
  esac
done

abort_run "Council runner timed out after $timeout_seconds seconds."
