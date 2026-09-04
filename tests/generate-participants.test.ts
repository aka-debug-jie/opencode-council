import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEBATE_PARTICIPANT_SETS, DEBATE_PARTICIPANTS } from "../src/participants.ts"
import { buildCoordinatorPrompt, coordinatorPermission, PARTICIPANT_PERMISSION } from "../index.ts"
import { parse } from "yaml"
import {
  checkParticipantAgents,
  renderCoordinatorAgent,
  renderParticipantAgent,
} from "../scripts/gen-participants.ts"

test("participant registry defines the supported sets", () => {
  assert.deepEqual(Object.keys(DEBATE_PARTICIPANT_SETS), ["council"])
  assert.deepEqual(DEBATE_PARTICIPANT_SETS.council, ["council-muse", "council-qwen", "council-glm", "council-hy4"])
})

test("participant registry contains metadata for every referenced agent", () => {
  const agents = new Set(DEBATE_PARTICIPANTS.map((participant) => participant.agent))
  for (const set of Object.values(DEBATE_PARTICIPANT_SETS)) {
    for (const agent of set) assert.equal(agents.has(agent), true, `${agent} missing from registry`)
  }
})

test("all four shipped participants have the intended model mapping", () => {
  assert.deepEqual(DEBATE_PARTICIPANTS.map(({ agent, model }) => [agent, model]), [
    ["council-muse", "opencode-go/muse-spark-1.3-contributor"],
    ["council-qwen", "opencode-go/qwen3.8-flash"],
    ["council-glm", "opencode-go/glm-5.3-flash"],
    ["council-hy4", "opencode-go/hy4-preview"],
  ])
})

test("renderParticipantAgent combines participant metadata with the shared body", () => {
  const participant = { ...DEBATE_PARTICIPANTS[0], variant: "high" }

  const rendered = renderParticipantAgent(participant, "Shared participant instructions.\n")

  assert.match(rendered, /description: Neutral Muse council participant/)
  assert.match(rendered, /model: opencode-go\/muse-spark-1\.3-contributor/)
  assert.match(rendered, /variant: high/)
  assert.match(rendered, /^steps: 5$/m)
  assert.match(rendered, /^hidden: true$/m)
  assert.match(rendered, /permission:\n  "\*": "deny"/)
  assert.match(rendered, /  read:\n    "\*": "allow"/)
  assert.match(rendered, /    "\*\.env": "deny"/)
  assert.match(rendered, /    "\*\.env\.\*": "deny"/)
  assert.match(rendered, /    "\*\.env\.example": "allow"/)
  for (const tool of ["grep", "glob", "lsp"]) {
    assert.match(rendered, new RegExp(`  ${tool}: allow`))
  }
  for (const tool of ["bash", "webfetch", "websearch", "external_directory", "edit", "question", "task", "skill"]) {
    assert.match(rendered, new RegExp(`  ${tool}: deny`))
  }
  assert.doesNotMatch(rendered, /"find \*"|"echo \*"|"cat \*"|git (show|diff|log)/)
  assert.match(rendered, /Shared participant instructions\./)
  assert.equal(rendered.endsWith("\n"), true)
  assert.deepEqual(parse(rendered.split("---")[1]).permission, PARTICIPANT_PERMISSION)
})

test("renderParticipantAgent omits variant when it is not configured", () => {
  const rendered = renderParticipantAgent({
    agent: "debate-new",
    description: "Neutral debate participant using provider/model",
    model: "provider/model",
  }, "Shared participant instructions.\n")

  assert.match(rendered, /model: provider\/model/)
  assert.doesNotMatch(rendered, /^variant:/m)
})

test("renderCoordinatorAgent emits unified prompt and permissions, discarding stale body", () => {
  const source = [
    "---",
    "description: Coordinator",
    "permission:",
    '  "*": "deny"',
    "  task:",
    '    "*": "deny"',
    '    "stale": "allow"',
    "  question: allow",
    "---",
    "",
    "Coordinator body.",
    "",
  ].join("\n")

  const participants = [
    { agent: "debate-one", description: "One", model: "provider/one" },
    { agent: "debate-two", description: "Two", model: "provider/two" },
  ]
  const rendered = renderCoordinatorAgent(source, participants)
  const [, frontmatter, body] = rendered.split("---")
  assert.deepEqual(parse(frontmatter).permission, coordinatorPermission(participants))
  assert.equal(parse(frontmatter).model, "opencode-go/gpt-5.6-luna")
  assert.equal(body.trim(), buildCoordinatorPrompt(participants))
  assert.doesNotMatch(rendered, /Coordinator body\.|"stale"/)
  assert.equal(renderCoordinatorAgent(rendered, participants), rendered)
})

test("renderCoordinatorAgent rejects malformed original frontmatter and task blocks", () => {
  for (const [source, diagnostic] of [
    ["body", /begin with YAML frontmatter/],
    ["---\npermission:", /not closed/],
    ["---\npermission: {}\n---\n", /found 0/],
    ["---\npermission:\n  task:\n  task:\n---\n", /found 2/],
  ] as const) assert.throws(() => renderCoordinatorAgent(source, DEBATE_PARTICIPANTS), diagnostic)
})

test("checkParticipantAgents reports generated-file drift without writing", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "debate-agents-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const agentDir = join(dir, ".opencode", "agents")
  const body = "Shared participant instructions.\n"
  const participant = DEBATE_PARTICIPANTS[0]
  const stalePath = join(agentDir, `${participant.agent}.md`)
  const coordinatorPath = join(agentDir, "debate.md")

  mkdirSync(agentDir, { recursive: true })
  writeFileSync(stalePath, "stale\n", { flush: true })
  writeFileSync(coordinatorPath, renderCoordinatorAgent([
    "---",
    "permission:",
    "  task:",
    '    "*": "deny"',
    "---",
    "",
    "Coordinator body.",
    "",
  ].join("\n"), [participant]))
  const result = checkParticipantAgents({ root: dir, body, participants: [participant] })

  assert.deepEqual(result.changed, [`.opencode/agents/${participant.agent}.md`])
  assert.equal(readFileSync(stalePath, "utf8"), "stale\n")
})

test("checkParticipantAgents reports coordinator permission drift", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "debate-agents-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const agentDir = join(dir, ".opencode", "agents")
  const body = "Shared participant instructions.\n"
  const participant = DEBATE_PARTICIPANTS[0]

  mkdirSync(agentDir, { recursive: true })
  writeFileSync(join(agentDir, `${participant.agent}.md`), renderParticipantAgent(participant, body))
  writeFileSync(join(agentDir, "debate.md"), [
    "---",
    "permission:",
    "  task:",
    '    "*": "deny"',
    '    "stale": "allow"',
    "---",
    "",
    "Coordinator body.",
    "",
  ].join("\n"))

  const result = checkParticipantAgents({ root: dir, body, participants: [participant] })

  assert.deepEqual(result.changed, [".opencode/agents/debate.md"])
})
