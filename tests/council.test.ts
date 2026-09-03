import assert from "node:assert/strict"
import test from "node:test"
import { COUNCIL_LIMITS } from "../src/limits.ts"
import { parseDebateArguments } from "../src/debate.ts"
import { limitCanonicalTurn } from "../src/response-formatter.ts"
import { PARTICIPANT_PERMISSION } from "../index.ts"

test("council rounds are bounded before dispatch", () => {
  assert.deepEqual(parseDebateArguments("architecture choice"), { ok: true, topic: "architecture choice", rounds: 2 })
  for (const rounds of ["1", "2", "3"]) assert.equal(parseDebateArguments(`--rounds ${rounds} topic`).ok, true)
  const invalid = parseDebateArguments("--rounds 4 topic")
  assert.equal(invalid.ok, false)
  if (!invalid.ok) assert.match(invalid.error, /1 and 3/)
  assert.equal(parseDebateArguments("--set:council topic").ok, false)
})

test("participant limits and permissions are fixed", () => {
  assert.equal(COUNCIL_LIMITS.maxTaskDispatches, 12)
  assert.equal(COUNCIL_LIMITS.maxFormatCorrections, 2)
  assert.equal(COUNCIL_LIMITS.participantSteps, 5)
  assert.equal(PARTICIPANT_PERMISSION.read["*"], "allow")
  for (const tool of ["bash", "webfetch", "websearch", "edit", "task", "question", "skill", "external_directory"] as const) {
    assert.equal(PARTICIPANT_PERMISSION[tool], "deny")
  }
})

test("turn truncation happens only after canonical JSON parsing", () => {
  const canonical = JSON.stringify({ turn: "x".repeat(COUNCIL_LIMITS.maxTurnChars + 1) })
  const limited = JSON.parse(limitCanonicalTurn(canonical)) as { turn: string }
  assert.equal(limited.turn.startsWith("x".repeat(COUNCIL_LIMITS.maxTurnChars)), true)
  assert.match(limited.turn, /Truncated by council safety limit/)
})
