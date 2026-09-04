#!/usr/bin/env bash
set -euo pipefail

skill_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT
mkdir -p "$temp_dir/bin" "$temp_dir/project"

cat > "$temp_dir/bin/opencode" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

report='## Council Report

### Participant findings
A

### Agreements
B

### Disagreements
C

### Risks
D

### Falsification tests
E

### Unresolved questions
F'

emit_report() {
  local message_id=${1:-msg-2}
  printf '{"type":"text","sessionID":"ses_mock","part":{"id":"part-%s","messageID":"%s","type":"text","text":%s}}\n' "$message_id" "$message_id" "$(printf '%s' "$report" | jq -Rs .)"
}

case "$1 ${2:-}" in
  'run '*)
    printf '%s\n' "$@" >> "$MOCK_LOG"
    continuing=false
    for argument in "$@"; do
      [[ "$argument" == '--session' ]] && continuing=true
    done
    if "$continuing"; then
      test "${COUNCIL_RESUME:-}" = 1
      touch "$MOCK_STOPPED"
      case "$MOCK_MODE" in fallback|stale-report|truncated|wrong-message) ;; *) emit_report ;; esac
      exit 0
    fi
    test -z "${COUNCIL_RESUME:-}"
    test -n "$COUNCIL_RUN_ID"
    test "$COUNCIL_DEADLINE_MS" -gt "$(date +%s%3N)"
    case "$MOCK_MODE" in
      continue|fallback|truncated|wrong-message|state-reject|state-active|state-mismatch|complete-reject) exit 0 ;;
      stale-report) emit_report msg-old; exit 0 ;;
      drives)
        touch "$MOCK_STARTED"
        sleep 1
        touch "$MOCK_STOPPED"
        emit_report
        ;;
      timeout)
        sleep 30 &
        child=$!
        printf '%s\n' "$child" > "$MOCK_CHILD"
        wait "$child"
        ;;
      fail) printf '%s\n' '{"type":"error","error":{"name":"AccessError","data":{"message":"Model requires explicit opt in"}}}'; exit 7 ;;
      *) exit 64 ;;
    esac
    ;;
  'session list')
    printf '%s\n' 'Listing sessions' >&2
    title=$(awk 'previous == "--title" { print; exit } { previous = $0 }' "$MOCK_LOG")
    printf '[{"id":"ses_mock","title":"%s"}]\n' "$title"
    ;;
  'export --sanitize')
    printf '%s\n' 'Exporting sanitized session' >&2
    if [[ -f "$MOCK_STOPPED" ]]; then
      printf '%s\n' '{"messages":[{"info":{"id":"msg-2","role":"assistant","finish":"stop"},"parts":[{"type":"text","text":"[redacted]"}]}]}'
      exit 0
    fi
    count=$(cat "$MOCK_COUNT")
    count=$((count + 1))
    printf '%s' "$count" > "$MOCK_COUNT"
    case "$count" in
      1) printf '{"messages":[' ;;
      2|3) printf '%s\n' '{"messages":[{"info":{"id":"msg-1","role":"assistant","finish":"tool-calls"},"parts":[{"type":"tool","tool":"task","state":{"status":"running"}}]}]}' ;;
      *) printf '%s\n' '{"messages":[{"info":{"id":"msg-1","role":"assistant","finish":"tool-calls"},"parts":[{"type":"tool","tool":"task","state":{"status":"completed"}}]}]}' ;;
    esac
    ;;
  'export ses_mock')
    printf '%s\n' 'raw-export' >> "$MOCK_LOG"
    printf '%s\n' 'Exporting session: ses_mock' >&2
    case "$MOCK_MODE" in
      stale-report) printf '%s\n' '{"messages":[{"info":{"id":"msg-2","role":"assistant","finish":"stop"},"parts":[{"type":"text","text":"Done"}]}]}'; exit 0 ;;
      truncated) printf '{"messages":['; exit 0 ;;
    esac
    message_id=msg-2
    [[ "$MOCK_MODE" != wrong-message ]] || message_id=msg-old
    printf '{"messages":[{"info":{"id":"%s","role":"assistant","finish":"stop"},"parts":[{"type":"text","text":%s}]}]}\n' "$message_id" "$(printf '%s' "$report" | jq -Rs .)"
    ;;
  *) exit 64 ;;
esac
EOF
chmod +x "$temp_dir/bin/opencode"

cat > "$temp_dir/bin/timeout" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >> "$MOCK_TIMEOUT_LOG"
exec /usr/bin/timeout "$@"
EOF
chmod +x "$temp_dir/bin/timeout"

cat > "$temp_dir/bin/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
shift
action=$1
run_id=$2
session_id=${3:-}
printf '%s\n' "$action" >> "$MOCK_STATE_LOG"
case "$action" in
  continue)
    [[ "$MOCK_MODE" != state-reject ]] || exit 2
    test -n "${4:-}"
    ;;
  inspect)
    status=ready
    [[ "$MOCK_MODE" != state-active ]] || status=active
    [[ "$MOCK_MODE" != state-mismatch ]] || run_id=wrong-run
    printf '{"runId":"%s","sessionID":"%s","rounds":%s,"status":"%s","dispatches":[]}\n' "$run_id" "$session_id" "$MOCK_ROUNDS" "$status"
    ;;
  complete) [[ "$MOCK_MODE" != complete-reject ]] || exit 2 ;;
  abort) printf '## Council Abort\n\n%s\n' "${4:-failure}" ;;
  *) exit 64 ;;
esac
EOF
chmod +x "$temp_dir/bin/node"

run_mock() {
  local mode=$1 rounds=$2
  shift 2
  MOCK_MODE="$mode" \
  MOCK_ROUNDS="$rounds" \
  MOCK_LOG="$temp_dir/log" \
  MOCK_COUNT="$temp_dir/count" \
  MOCK_STOPPED="$temp_dir/stopped" \
  MOCK_STARTED="$temp_dir/started" \
  MOCK_CHILD="$temp_dir/child" \
  MOCK_TIMEOUT_LOG="$temp_dir/timeout-log" \
  MOCK_STATE_LOG="$temp_dir/state-log" \
  COUNCIL_NODE="$temp_dir/bin/node" \
  COUNCIL_CHECKOUT="$(cd "$skill_dir/../.." && pwd)" \
  COUNCIL_STATE_DIR="$temp_dir/state" \
  CODEX_COUNCIL_TIMEOUT_SECONDS=${CODEX_COUNCIL_TIMEOUT_SECONDS-} \
  CODEX_COUNCIL_POLL_SECONDS=0 \
  PATH="$temp_dir/bin:$PATH" \
    "$skill_dir/scripts/run_council.sh" --project-dir "$temp_dir/project" --rounds "$rounds" "$@"
}

for rounds in 1 2 3; do
  : > "$temp_dir/log"
  : > "$temp_dir/timeout-log"
  : > "$temp_dir/state-log"
  printf '0' > "$temp_dir/count"
  rm -f "$temp_dir/stopped" "$temp_dir/started" "$temp_dir/child"
  output=$(printf 'Decision: test' | run_mock continue "$rounds")
  grep -Fq '## Council Report' <<<"$output"
  ! grep -Fq 'Exporting session' <<<"$output"
  grep -Fx -- '--model' "$temp_dir/log" >/dev/null
  grep -Fx -- '--format' "$temp_dir/log" >/dev/null
  grep -Fx -- 'json' "$temp_dir/log" >/dev/null
  grep -Fx -- 'opencode-go/gpt-5.6-luna' "$temp_dir/log" >/dev/null
  grep -Fx -- '--command' "$temp_dir/log" >/dev/null
  grep -Fx -- 'council' "$temp_dir/log" >/dev/null
  grep -Fx -- "$temp_dir/project" "$temp_dir/log" >/dev/null
  grep -Fx -- "--rounds $rounds Decision: test" "$temp_dir/log" >/dev/null
  grep -Fx -- "$((rounds * 300))s" "$temp_dir/timeout-log" >/dev/null
  test "$(grep -Fxc -- '--session' "$temp_dir/log")" -eq 1
  test "$(grep -Fxc -- 'continue' "$temp_dir/state-log")" -eq 1
  test "$(grep -Fxc -- 'complete' "$temp_dir/state-log")" -eq 1
  test "$(grep -Fxc -- 'raw-export' "$temp_dir/log" || true)" -eq 0
done

: > "$temp_dir/log"
printf '0' > "$temp_dir/count"
rm -f "$temp_dir/stopped" "$temp_dir/started" "$temp_dir/child"
output=$(printf 'Decision: fallback' | run_mock fallback 1)
grep -Fq '## Council Report' <<<"$output"
! grep -Fq 'Exporting session' <<<"$output"
test "$(grep -Fxc -- 'raw-export' "$temp_dir/log")" -eq 1

: > "$temp_dir/log"
printf '0' > "$temp_dir/count"
rm -f "$temp_dir/stopped" "$temp_dir/started" "$temp_dir/child"
printf 'Decision: test' | run_mock drives 1 > "$temp_dir/drives.out" 2> "$temp_dir/drives.err" &
runner_pid=$!
for unused in 1 2 3 4 5; do
  [[ -f "$temp_dir/started" ]] && break
  sleep 0.1
done
[[ -f "$temp_dir/started" ]]
test "$(grep -Fxc -- '--session' "$temp_dir/log" || true)" -eq 0
wait "$runner_pid"
grep -Fq '## Council Report' "$temp_dir/drives.out"
test "$(grep -Fxc -- '--session' "$temp_dir/log" || true)" -eq 0

: > "$temp_dir/log"
printf '0' > "$temp_dir/count"
rm -f "$temp_dir/stopped" "$temp_dir/started" "$temp_dir/child"
if printf 'Decision: timeout' | CODEX_COUNCIL_TIMEOUT_SECONDS=1 run_mock timeout 1 > "$temp_dir/timeout.out" 2> "$temp_dir/timeout.err"; then
  exit 1
fi
grep -Fq 'timed out after 1 seconds during the initial OpenCode run' "$temp_dir/timeout.err"
child_pid=$(cat "$temp_dir/child")
for unused in 1 2 3 4 5; do
  kill -0 "$child_pid" 2>/dev/null || break
  sleep 0.1
done
if kill -0 "$child_pid" 2>/dev/null; then
  printf 'mock child process %s survived the runner timeout\n' "$child_pid" >&2
  exit 1
fi

: > "$temp_dir/log"
printf '0' > "$temp_dir/count"
rm -f "$temp_dir/stopped" "$temp_dir/started" "$temp_dir/child"
if printf 'Decision: failure' | run_mock fail 1 > "$temp_dir/fail.out" 2> "$temp_dir/fail.err"; then
  exit 1
fi
grep -Fq 'Initial OpenCode run exited with status 7' "$temp_dir/fail.err"
grep -Fq 'Model requires explicit opt in' "$temp_dir/fail.err"

for mode in state-reject state-active state-mismatch complete-reject stale-report truncated wrong-message; do
  : > "$temp_dir/log"
  : > "$temp_dir/state-log"
  printf '0' > "$temp_dir/count"
  rm -f "$temp_dir/stopped" "$temp_dir/started" "$temp_dir/child"
  if printf 'Decision: rejection' | run_mock "$mode" 1 > "$temp_dir/rejected.out" 2> "$temp_dir/rejected.err"; then
    printf 'runner accepted rejected mode: %s\n' "$mode" >&2
    exit 1
  fi
  test ! -s "$temp_dir/rejected.out"
  grep -Fq '## Council Abort' "$temp_dir/rejected.err"
  test "$(grep -Fxc -- 'abort' "$temp_dir/state-log")" -eq 1
  if [[ "$mode" == state-reject ]]; then
    test "$(grep -Fxc -- '--session' "$temp_dir/log" || true)" -eq 0
  fi
  case "$mode" in
    stale-report|truncated|wrong-message) test "$(grep -Fxc -- 'raw-export' "$temp_dir/log")" -eq 1 ;;
  esac
done

if printf 'test' | run_mock continue 4 >/dev/null 2>&1; then
  exit 1
fi
if printf '%*s' 16001 '' | run_mock continue 1 >/dev/null 2>&1; then
  exit 1
fi

printf '%s\n' 'run_council mock tests: ok'
