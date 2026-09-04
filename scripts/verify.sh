#!/usr/bin/env sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$root"
if test -x "$root/.tools/node-v24.15.0-linux-x64/bin/node"; then
  PATH="$root/.tools/node-v24.15.0-linux-x64/bin:$PATH"
  export PATH
fi

fail() { printf '%s\n' "verify: $*" >&2; exit 1; }

test -f src/limits.ts || fail "missing council limits"
test -f .node-version || fail "missing project Node version"
grep -Fq '24.15.0' .node-version || fail "wrong project Node version"
grep -Fq '"name": "@aka-debug-jie/opencode-council"' package.json || fail "wrong package name"
grep -Fq '"access": "restricted"' package.json || fail "package must be private"
grep -Fq 'docs/' .gitignore || fail "transcripts must be ignored"
grep -Fq 'council-muse' config.yaml || fail "missing Muse participant"
grep -Fq 'council-qwen' config.yaml || fail "missing Qwen participant"
grep -Fq 'council-glm' config.yaml || fail "missing GLM participant"

node scripts/gen-participants.ts --check || fail "generated participant agents are stale"
npm test || fail "Node regression tests failed"
python3 -m unittest discover -s tests -p 'test_*.py' || fail "Python regression tests failed"
python3 skills/codex-council/scripts/test_inspect_session.py || fail "Skill inspector tests failed"
bash skills/codex-council/scripts/test_run_council.sh || fail "Skill runner tests failed"
npm run pack:check || fail "package contents are incorrect"
npm run typecheck || fail "typecheck failed"
printf '%s\n' 'verify: ok'
