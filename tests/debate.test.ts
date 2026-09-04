import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CouncilStateStore } from "../src/council-state.ts"
import type { Part } from "@opencode-ai/sdk"
import {
  createDebatePlugin,
  errorPrompt,
  parseDebateArguments,
  replaceParts,
  trimSurroundingQuotes,
  validPrompt,
} from "../src/debate.ts"
import { DEBATE_PARTICIPANTS, DebateConfigError, type DebateRegistry } from "../src/participants.ts"
import {
  COORDINATOR_PROMPT,
  PARTICIPANT_PERMISSION,
  PARTICIPANT_PROMPT,
  buildCoordinatorPrompt,
  coordinatorPermission,
  createServer,
  participantTaskPermission,
} from "../index.ts"
import { PERSIST_DEBATE_TRANSCRIPT_TOOL } from "../src/transcript-persistence.ts"

function markdownBody(source: string): string {
  const match = /^---\n[\s\S]*?\n---\n\n([\s\S]*)$/.exec(source)
  assert.ok(match, "expected YAML frontmatter")
  return match[1].trimEnd()
}

const DYNAMIC_REGISTRY: DebateRegistry = {
  participants: [
    { agent: "one", description: "One", model: "provider/one" },
    { agent: "two", description: "Two", model: "provider/two" },
    { agent: "three", description: "Three", model: "provider/three" },
    { agent: "four", description: "Four", model: "provider/four" },
    { agent: "five", description: "Five", model: "provider/five" },
    { agent: "six", description: "Six", model: "provider/six" },
  ],
  sets: {
    default: ["one", "two", "three"],
    custom: ["four", "five", "six"],
  },
  defaultSet: "custom",
}


function isolatedStore(t: TestContext): CouncilStateStore {
  const directory = mkdtempSync(join(tmpdir(), "council-contract-"))
  const store = new CouncilStateStore(directory)
  t.after(() => { store.dispose(); rmSync(directory, { recursive: true, force: true }) })
  return store
}

test("default rounds when --rounds absent", () => {
  const r = parseDebateArguments("compare two options")
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.rounds, 2)
    assert.equal(r.topic, "compare two options")
  }
})

test("--rounds sets the round count", () => {
  const r = parseDebateArguments("--rounds 3 compare two options")
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.rounds, 3)
    assert.equal(r.topic, "compare two options")
  }
})

test("--rounds=N equals syntax", () => {
  const r = parseDebateArguments("--rounds=3 compare two options")
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.rounds, 3)
    assert.equal(r.topic, "compare two options")
  }
})

test("empty topic is valid with default rounds", () => {
  const r = parseDebateArguments("")
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.topic, "")
    assert.equal(r.rounds, 2)
  }
})

test("--rounds 0 is rejected", () => {
  const r = parseDebateArguments("--rounds 0 topic")
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /integer between 1 and 3/)
})

test("--rounds above the cap is rejected", () => {
  const r = parseDebateArguments("--rounds 4 topic")
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /between 1 and 3/)
})

test("rounds accepts the lower boundary and rejects fractional, empty and nonnumeric values", () => {
  assert.deepEqual(parseDebateArguments("--rounds 1 topic"), { ok: true, topic: "topic", rounds: 1 })
  for (const value of ["1.5", "", "NaN", "abc"]) {
    const result = parseDebateArguments(`--rounds=${value} topic`)
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /integer between 1 and 3/)
  }
})

test("--rounds with a huge digit string is rejected (safe integer guard)", () => {
  const r = parseDebateArguments("--rounds 9999999999999999999999 topic")
  assert.equal(r.ok, false)
})

test("--rounds without a value is rejected", () => {
  const r = parseDebateArguments("--rounds")
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /integer between 1 and 3/)
})

test("duplicate --rounds is rejected", () => {
  const r = parseDebateArguments("--rounds 2 --rounds 3 topic")
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /only be specified once/)
})

test("negative --rounds is rejected", () => {
  const r = parseDebateArguments("--rounds -3 topic")
  assert.equal(r.ok, false)
})

test("unknown option is rejected", () => {
  const r = parseDebateArguments("--foo topic")
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /Unsupported option/)
})


for (const flag of ["--set", "--set:", "--set:cheap", "--set:default", "--set:custom", "--set:toString", "--ask", "--discretion"]) {
  test(flag + " is rejected even with configured set mappings", () => {
    const result = parseDebateArguments(flag + " topic", DYNAMIC_REGISTRY)
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /Unsupported option/)
  })
}

test("parsed output contains only topic and bounded rounds", () => {
  assert.deepEqual(parseDebateArguments("topic", DYNAMIC_REGISTRY), { ok: true, topic: "topic", rounds: 2 })
})

test("set-like text after topic or separator remains literal topic text", () => {
  for (const [input, topic] of [["review --set:cheap", "review --set:cheap"], ["-- --set:cheap", "--set:cheap"]]) {
    assert.deepEqual(parseDebateArguments(input), { ok: true, topic, rounds: 2 })
  }
})

test("validPrompt resolves only the configured default set without continuation metadata", () => {
  const prompt = validPrompt("topic", 2, "abc123", DYNAMIC_REGISTRY)
  assert.match(prompt, /Participant 1: four/)
  assert.match(prompt, /Participant 2: five/)
  assert.match(prompt, /Participant 3: six/)
  assert.doesNotMatch(prompt, /Participant set:|Continuation mode:/)
})

for (const command of ["debate", "council"]) {
  test(command + " resolves configured participants and rejects legacy CLI options", async () => {
    const hooks = await createDebatePlugin(DYNAMIC_REGISTRY)({} as never)
    const before = hooks["command.execute.before"]!
    const output: { parts: Part[] } = { parts: [] }
    await before({ command, arguments: "topic" } as never, output)
    assert.match(output.parts[0]?.type === "text" ? output.parts[0].text : "", /Participant 1: four/)
    await before({ command, arguments: "--set:custom topic" } as never, output)
    assert.match(output.parts[0]?.type === "text" ? output.parts[0].text : "", /Unsupported option/)
  })
}

test("unrelated commands leave output untouched", async () => {
  const hooks = await createDebatePlugin(DYNAMIC_REGISTRY)({} as never)
  const output: { parts: Part[] } = { parts: [] }
  await hooks["command.execute.before"]!({ command: "other", arguments: "topic" } as never, output)
  assert.deepEqual(output.parts, [])
})

test("static and plugin participant prompts are identical", () => {
  const body = readFileSync(new URL("../scripts/debate-participant-body.md", import.meta.url), "utf8")
  assert.equal(PARTICIPANT_PROMPT, body.trimEnd())
})

test("static and project-local coordinator prompts are identical", () => {
  const source = readFileSync(new URL("../.opencode/agents/debate.md", import.meta.url), "utf8")
  assert.equal(COORDINATOR_PROMPT, markdownBody(source))
})


test("coordinator uses concrete configured markers and independent concurrent first-round tasks", () => {
  const participants = DYNAMIC_REGISTRY.participants.slice(3)
  const prompt = buildCoordinatorPrompt(participants)
  for (const [index, participant] of participants.entries()) {
    assert.ok(prompt.includes("[DEBATE_DISPATCH purpose=normal participant=" + (index + 1) + " round=1 subagent_type=" + participant.agent + "]"))
  }
  assert.doesNotMatch(prompt, /subagent_type=<|subagent_type=one\]/)
  assert.match(prompt, /all 3 task calls in one response as a concurrent batch/)
  assert.match(prompt, /same original delimited topic and no peer answers/)
})

test("coordinator preserves session continuity and canonical-only round transitions", () => {
  assert.match(COORDINATOR_PROMPT, /Round 1 normal tasks omit task_id/)
  assert.match(COORDINATOR_PROMPT, /Later normal tasks, retries, and formatter-correction tasks reuse that same participant task_id/)
  assert.match(COORDINATOR_PROMPT, /Do not advance to the next round until all 4 current turns are canonical/)
  assert.match(COORDINATOR_PROMPT, /other 3 exact canonical previous-round turns/)
  assert.match(COORDINATOR_PROMPT, /Wait for all 4 task results in a round/)
})

test("coordinator binds formatting to actual results, never self-repairs, and caps corrections", () => {
  assert.ok(COORDINATOR_PROMPT.includes("using ONLY {participant:1|2|3|4,round:N}"))
  assert.match(COORDINATOR_PROMPT, /runtime reads the actual task result/)
  assert.match(COORDINATOR_PROMPT, /Do not pass a response string/)
  assert.match(COORDINATOR_PROMPT, /Never repair JSON yourself/)
  assert.match(COORDINATOR_PROMPT, /exact diagnostic to the original participant with purpose=formatter-correction/)
  assert.match(COORDINATOR_PROMPT, /At most two corrections per participant\/round/)
  assert.match(COORDINATOR_PROMPT, /global cap of 12/)
})

test("coordinator uses strict schemas and does not extend or shorten from advisory status", () => {
  assert.ok(COORDINATOR_PROMPT.includes('JSON {"turn":"..."}'))
  assert.ok(COORDINATOR_PROMPT.includes('"consensus_reached":true|false,"recommend_stopping":true|false'))
  assert.match(COORDINATOR_PROMPT, /Never request position, reasoning, evidence, concerns/)
  assert.match(COORDINATOR_PROMPT, /status fields are advisory only and cannot extend or shorten/)
  assert.match(COORDINATOR_PROMPT, /No extension rounds, Question calls, or transcript persistence/)
})

test("coordinator exhausted retry aborts without synthesizing incomplete evidence", () => {
  assert.match(COORDINATOR_PROMPT, /purpose=retry only once per participant\/round/)
  assert.match(COORDINATOR_PROMPT, /task failure after its one retry terminates the Council/)
  assert.match(COORDINATOR_PROMPT, /Do not call another tool or model, produce a report, or synthesize incomplete evidence/)
  assert.match(COORDINATOR_PROMPT, /deterministic Council Abort/)
  assert.doesNotMatch(COORDINATOR_PROMPT, /no hard extension cap|repeat until formatting is successful|syntax-preserving repair|ask-mode/)
})

test("coordinator reports six ordered advisory sections and leaves decisions to Codex", () => {
  assert.match(COORDINATOR_PROMPT, /## Council Report/)
  assert.match(COORDINATOR_PROMPT, /Participant findings, Agreements, Disagreements, Risks, Falsification tests, Unresolved questions/)
  assert.match(COORDINATOR_PROMPT, /Preserve minority views/)
  assert.match(COORDINATOR_PROMPT, /Do not state a final recommendation, choose an option, or present consensus as authority; Codex decides/)
})

test("task permissions are derived from the participant registry", () => {
  assert.deepEqual(participantTaskPermission(), {
    "*": "deny",
    ...Object.fromEntries(DEBATE_PARTICIPANTS.map(({ agent }) => [agent, "allow"])),
  })
})

test("runtime registration uses only selected effective participants and omits absent variants", async (t) => {
  let loads = 0
  const server = createServer(() => {
    loads++
    return DYNAMIC_REGISTRY
  }, isolatedStore(t))
  const hooks = await server({
    client: { app: { log: async () => ({ data: true }) } },
    directory: "/tmp/project",
    worktree: "/tmp/project",
  } as never)
  const configHook = hooks.config
  assert.ok(configHook)
  const config: any = {
    permission: {
      bash: "allow",
      task: {
        one: "allow",
        "*": "allow",
        general: "ask",
      },
    },
    agent: {
      build: {
        permission: {
          edit: "allow",
          task: {
            one: "allow",
            "*": "allow",
          },
        },
      },
      reviewer: { permission: "allow" },
    },
  }

  await configHook(config)

  assert.equal(loads, 1)
  assert.deepEqual(Object.keys(config.agent).sort(), [
    "build",
    "debate",
    "five",
    "four",
    "reviewer",
    "six",
  ])
  assert.equal(config.agent.four.model, "provider/four")
  assert.equal(Object.hasOwn(config.agent.four, "variant"), false)
  assert.deepEqual(config.permission, {
    bash: "allow",
    format_debate_response: "deny",
    [PERSIST_DEBATE_TRANSCRIPT_TOOL]: "deny",
    task: {
      "*": "allow",
      general: "ask",
      one: "allow",
      four: "deny",
      five: "deny",
      six: "deny",
    },
  })
  assert.deepEqual(config.agent.build.permission, {
    edit: "allow",
    format_debate_response: "deny",
    [PERSIST_DEBATE_TRANSCRIPT_TOOL]: "deny",
    task: {
      "*": "allow",
      one: "allow",
      four: "deny",
      five: "deny",
      six: "deny",
    },
  })
  assert.deepEqual(config.agent.reviewer.permission, {
    "*": "allow",
    format_debate_response: "deny",
    [PERSIST_DEBATE_TRANSCRIPT_TOOL]: "deny",
    task: {
      four: "deny",
      five: "deny",
      six: "deny",
    },
  })
  for (const name of ["four", "five", "six"]) {
    assert.equal(config.agent[name].hidden, true)
    assert.equal(config.agent[name].steps, 5)
    assert.deepEqual(config.agent[name].permission, {
      ...PARTICIPANT_PERMISSION,
      format_debate_response: "deny",
      [PERSIST_DEBATE_TRANSCRIPT_TOOL]: "deny",
    })
  }
  assert.equal(config.agent.debate.prompt, buildCoordinatorPrompt(DYNAMIC_REGISTRY.participants.slice(3)))
  assert.deepEqual(config.agent.debate.permission, coordinatorPermission(DYNAMIC_REGISTRY.participants.slice(3)))
  assert.deepEqual(config.command.council, config.command.debate)
  assert.deepEqual(config.agent.debate.permission.task, {
    "*": "deny",
    four: "allow",
    five: "allow",
    six: "allow",
  })
})

test("configuration failures are logged once and abort plugin initialisation", async (t) => {
  const error = new DebateConfigError("/tmp/bad.yaml", "participants.bad.model", "expected a non-empty string")
  const logs: unknown[] = []
  const server = createServer(() => {
    throw error
  }, isolatedStore(t))

  await assert.rejects(
    server({
      client: {
        app: {
          log: async (entry: unknown) => {
            logs.push(entry)
            return { data: true }
          },
        },
      },
      directory: "/tmp/project",
      worktree: "/tmp/project",
    } as never),
    (thrown: unknown) => thrown === error,
  )
  assert.deepEqual(logs, [{
    body: {
      service: "opencode-council",
      level: "error",
      message: error.message,
    },
  }])
})

test("a logging failure does not mask the configuration failure", async (t) => {
  const error = new DebateConfigError("/tmp/bad.yaml", "$", "bad YAML")
  const server = createServer(() => {
    throw error
  }, isolatedStore(t))

  await assert.rejects(
    server({
      client: { app: { log: async () => { throw new Error("logging unavailable") } } },
      directory: "/tmp/project",
      worktree: "/tmp/project",
    } as never),
    (thrown: unknown) => thrown === error,
  )
})

test("participant permissions deny shell, web, writes and external access", () => {
  assert.equal(PARTICIPANT_PERMISSION["*"], "deny")
  for (const tool of ["bash", "webfetch", "websearch", "edit", "question", "task", "skill"] as const) assert.equal(PARTICIPANT_PERMISSION[tool], "deny")
  assert.equal(PARTICIPANT_PERMISSION.external_directory, "deny")
  assert.deepEqual(PARTICIPANT_PERMISSION.read, {
    "*": "allow",
    "*.env": "deny",
    "*.env.*": "deny",
    "*.env.example": "allow",
  })
})

test("coordinator denies persistence and questions", () => {
  const permission = coordinatorPermission()
  assert.equal(permission[PERSIST_DEBATE_TRANSCRIPT_TOOL], "deny")
  assert.equal(permission.question, "deny")
  assert.equal(Object.hasOwn(permission, "bash"), false)
  assert.equal(Object.hasOwn(permission, "edit"), false)
  assert.equal(permission["*"], "deny")
  assert.equal(permission.external_directory, "deny")
})

test("server registers only the runtime-bound formatter and no persistence tool", async (t) => {
  const hooks = await createServer(() => DYNAMIC_REGISTRY, isolatedStore(t))({
    client: { app: { log: async () => ({ data: true }) } },
    directory: "/tmp/project",
    worktree: "/tmp/project",
  } as never)

  assert.deepEqual(Object.keys(hooks.tool ?? {}), ["format_debate_response"])
})

test("server composes task dispatch lifecycle and model hooks", async (t) => {
  const hooks = await createServer(() => DYNAMIC_REGISTRY, isolatedStore(t))({
    client: { app: { log: async () => ({ data: true }) } },
    directory: "/tmp/project",
    worktree: "/tmp/project",
  } as never)

  assert.ok(hooks["tool.execute.before"])
  assert.ok(hooks["tool.execute.after"])
  assert.ok(hooks.event)
  assert.ok(hooks.dispose)
  assert.ok(hooks["chat.params"])
})

test("server composes debate command handling before dispatch validation", async (t) => {
  const hooks = await createServer(() => DYNAMIC_REGISTRY, isolatedStore(t))({
    client: { app: { log: async () => ({ data: true }) } },
    directory: "/tmp/project",
    worktree: "/tmp/project",
  } as never)
  assert.ok(hooks["command.execute.before"])
  assert.ok(hooks["tool.execute.before"])

  const output: { parts: Part[] } = { parts: [] }
  await hooks["command.execute.before"](
    { command: "debate", sessionID: "coordinator-session", arguments: "topic" },
    output,
  )
  assert.match(output.parts[0]?.type === "text" ? output.parts[0].text : "", /Run a debate with this parsed request\.|BEGIN TOPIC/)
  await assert.rejects(
    hooks["tool.execute.before"](
      { tool: "task", sessionID: "coordinator-session", callID: "ordinary-call" },
      { args: { description: "ordinary", prompt: "ordinary", subagent_type: "general" } },
    ),
    /dispatch marker.*required/i,
  )
})

test("static coordinator task permissions contain every registry agent", () => {
  const source = readFileSync(new URL("../.opencode/agents/debate.md", import.meta.url), "utf8")
  for (const { agent } of DEBATE_PARTICIPANTS) {
    assert.match(source, new RegExp(`^    "${agent}": "allow"$`, "m"))
  }
})

test("-- separator treats the rest as the topic", () => {
  const r = parseDebateArguments("-- --rounds 5 not an option")
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.topic, "--rounds 5 not an option")
    assert.equal(r.rounds, 2)
  }
})

test("options after the first topic token are part of the topic", () => {
  const r = parseDebateArguments("review --rounds 5 in the topic")
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.topic, "review --rounds 5 in the topic")
    assert.equal(r.rounds, 2)
  }
})

test("trimSurroundingQuotes strips matching surrounding quotes", () => {
  assert.equal(trimSurroundingQuotes('"hello"'), "hello")
  assert.equal(trimSurroundingQuotes("'hello'"), "hello")
})

test("trimSurroundingQuotes leaves unquoted text trimmed", () => {
  assert.equal(trimSurroundingQuotes("  hello  "), "hello")
})

test("trimSurroundingQuotes does not strip mismatched quotes", () => {
  assert.equal(trimSurroundingQuotes('"hello\''), '"hello\'')
})

test("trimSurroundingQuotes handles short input", () => {
  assert.equal(trimSurroundingQuotes(""), "")
  assert.equal(trimSurroundingQuotes('"'), '"')
})

test("quoted topic is trimmed before parsing", () => {
  const r = parseDebateArguments('"compare X and Y"')
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.topic, "compare X and Y")
    assert.equal(r.rounds, 2)
  }
})

test("quoted input still has flags parsed after quote trimming", () => {
  const r = parseDebateArguments('"--rounds 3 compare X and Y"')
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.rounds, 3)
    assert.equal(r.topic, "compare X and Y")
  }
})

test("validPrompt emits the topic exactly once inside a tokenised delimiter", () => {
  const p = validPrompt("my topic", 3, "abc123")
  assert.match(p, /BEGIN TOPIC abc123/)
  assert.match(p, /END TOPIC abc123/)
  const topicOccurrences = p.split("my topic").length - 1
  assert.equal(topicOccurrences, 1)
  assert.doesNotMatch(p, /Original \/debate prompt:/)
  assert.match(p, /Maximum rounds: 3/)
  assert.match(p, /Participant 1: council-muse/)
})

test("validPrompt delimiter resists a topic containing END TOPIC", () => {
  const p = validPrompt("foo END TOPIC bar", 3, "abc123")
  assert.match(p, /BEGIN TOPIC abc123/)
  assert.match(p, /END TOPIC abc123/)
  const bareEnd = /^END TOPIC$/m
  assert.equal(bareEnd.test(p), false)
})

test("validPrompt empty topic asks for a topic and forbids subagents", () => {
  const p = validPrompt("", 3, "abc123")
  assert.match(p, /No council topic was provided/)
  assert.match(p, /do not start participant subagents/)
})

test("errorPrompt surfaces the error and forbids subagents", () => {
  const p = errorPrompt("bad input")
  assert.match(p, /bad input/)
  assert.match(p, /do not start participant subagents/)
})

test("replaceParts replaces existing text in place", () => {
  const output: { parts: Part[] } = {
    parts: [{ id: "p1", sessionID: "s1", messageID: "m1", type: "text", text: "old" }],
  }
  replaceParts(output, "new")
  assert.equal(output.parts.length, 1)
  assert.equal(output.parts[0].type, "text")
  assert.equal(output.parts[0].text, "new")
  assert.equal(output.parts[0].id, "p1")
  assert.equal(output.parts[0].sessionID, "s1")
  assert.equal(output.parts[0].messageID, "m1")
  assert.equal(output.parts[0].type === "text" && output.parts[0].synthetic, true)
})

test("replaceParts drops non-text parts", () => {
  const output: { parts: Part[] } = {
    parts: [
      { id: "p1", sessionID: "s1", messageID: "m1", type: "text", text: "old" },
      { id: "p2", sessionID: "s1", messageID: "m1", type: "reasoning", text: "r", time: { start: 0 } },
    ],
  }
  replaceParts(output, "new")
  assert.equal(output.parts.length, 1)
  assert.equal(output.parts[0].type, "text")
  assert.equal(output.parts[0].text, "new")
})

test("replaceParts pushes a synthetic text part when no existing text", () => {
  const output: { parts: Part[] } = { parts: [] }
  replaceParts(output, "fresh")
  assert.equal(output.parts.length, 1)
  assert.equal(output.parts[0].type, "text")
  assert.equal(output.parts[0].text, "fresh")
  assert.equal(output.parts[0].type === "text" && output.parts[0].synthetic, true)
})
