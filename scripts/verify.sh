#!/usr/bin/env sh
set -eu

fail() { printf '%s\n' "verify: $*" >&2; exit 1; }

test -f src/limits.ts || fail "missing council limits"
test -f .node-version || fail "missing project Node version"
grep -Fq '24.15.0' .node-version || fail "wrong project Node version"
grep -Fq '"name": "@aka-debug-jie/opencode-council"' package.json || fail "wrong package name"
grep -Fq '"access": "restricted"' package.json || fail "package must be private"
grep -Fq 'docs/' .gitignore || fail "transcripts must be ignored"
grep -Fq 'council-mimo' config.yaml || fail "missing MiMo participant"
grep -Fq 'council-qwen' config.yaml || fail "missing Qwen participant"
grep -Fq 'council-deepseek' config.yaml || fail "missing DeepSeek participant"

node scripts/gen-participants.ts --check || fail "generated participant agents are stale"
node --test tests/council.test.ts || fail "council tests failed"
npm run pack:check || fail "package contents are incorrect"
npm run typecheck || fail "typecheck failed"
printf '%s\n' 'verify: ok'
