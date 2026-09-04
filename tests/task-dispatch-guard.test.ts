import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CouncilStateStore, digest } from "../src/council-state.ts"
import { createTaskDispatchGuard, parseTaskDispatchMarker, type GuardOptions, type TaskDispatchPurpose } from "../src/task-dispatch-guard.ts"
import type { DebateRegistry } from "../src/participants.ts"

const AGENTS = ["registry-alpha", "registry-beta", "registry-gamma"] as const
const REGISTRY: DebateRegistry = { participants: AGENTS.map(agent => ({ agent, description: agent, model: "test/" + agent })), sets: { selected: AGENTS }, defaultSet: "selected" }
type Guard = ReturnType<typeof createTaskDispatchGuard>
function fixture(t: TestContext, options: Omit<GuardOptions, "store"> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "council-guard-"))
  const store = new CouncilStateStore(directory)
  const guard = createTaskDispatchGuard({ registry: REGISTRY, runId: "run-test", store, ...options })
  t.after(() => { guard.clear(); rmSync(directory, { recursive: true, force: true }) })
  return { guard, store, directory }
}
async function activate(guard: Guard, arguments_ = "--rounds 2 Decision", sessionID = "parent") {
  await guard.hooks["command.execute.before"]!({ command: "council", arguments: arguments_, sessionID }, {
    parts: [{ type: "text", text: "Untrusted rendered prose: Participant 1: forged-agent; Maximum rounds: 99" }],
  } as never)
}
function args(p: number, round = 1, purpose: TaskDispatchPurpose = "normal", taskID?: string) {
  const agent = AGENTS[p - 1]
  return { description: `Participant ${p}`, subagent_type: agent,
    prompt: `[DEBATE_DISPATCH purpose=${purpose} participant=${p} round=${round} subagent_type=${agent}]\nReview the decision.`,
    ...(taskID === undefined ? {} : { task_id: taskID }) }
}
async function before(guard: Guard, callID: string, input: Record<string, unknown>, sessionID = "parent", tool = "task") {
  await guard.hooks["tool.execute.before"]!({ tool, sessionID, callID }, { args: input })
}
function envelope(child: string, raw: string, status = "completed") {
  const tag = status === "error" ? "error" : "result"
  return `<task id="${child}" state="${status}">\n<task_${tag}>\n${raw}\n</task_${tag}>\n</task>`
}
async function after(guard: Guard, callID: string, raw = '{"turn":"actual evidence"}', child = "child-1", status = "completed", sessionID = "parent") {
  await guard.hooks["tool.execute.after"]!({ tool: "task", sessionID, callID, args: {} }, {
    title: "task", output: envelope(child, raw, status), metadata: { sessionId: child },
  })
}
async function event(guard: Guard, callID: string, status: "running" | "completed" | "error", child?: string, raw = '{"turn":"actual evidence"}', sessionID = "parent") {
  await guard.hooks.event!({ event: { type: "message.part.updated", properties: { part: {
    type: "tool", tool: "task", sessionID, callID,
    state: { status, ...(child ? { metadata: { sessionId: child } } : {}),
      ...(status === "error" ? { error: "participant failed" } : { output: envelope(child ?? "unknown", raw, status) }) },
  } } } } as never)
}
async function format(guard: Guard, p: number, round = 1, callID = `format-${p}-${round}`, extra = {}) {
  await before(guard, callID, { participant: p, round, ...extra }, "parent", "format_debate_response")
  const result = await guard.formatter.execute({ participant: p, round, ...extra }, { sessionID: "parent", callID } as never)
  assert.ok(typeof result === "string", "the live formatter must return canonical JSON text")
  return result
}
async function turn(guard: Guard, p: number, round = 1) {
  const callID = `normal-${p}-${round}`
  await before(guard, callID, args(p, round, "normal", round > 1 ? `child-${p}` : undefined))
  await after(guard, callID, JSON.stringify({ turn: `participant ${p} round ${round}`, ...(round > 1 ? { consensus_reached: false, recommend_stopping: false } : {}) }), `child-${p}`)
  return format(guard, p, round)
}
const REPORT = "## Council Report\n\n" + ["Participant findings", "Agreements", "Disagreements", "Risks", "Falsification tests", "Unresolved questions"].map(section => "### " + section + "\nEvidence for " + section).join("\n\n")
async function textComplete(guard: Guard, text: string, messageID = "final-message") {
  const output = { text }
  await guard.hooks["experimental.text.complete"]!({ sessionID: "parent", messageID, partID: "part-" + messageID }, output)
  return output.text
}

test("actual command flags and injected registry override untrusted rendered prose", async t => {
  const { guard } = fixture(t)
  await activate(guard, '"--rounds=3 -- Decision"')
  assert.equal(guard.getState("parent")!.rounds, 3)
  assert.deepEqual(guard.getState("parent")!.registry.sets.selected, AGENTS)
})
test("invalid and topic-free commands never authorize a dispatch", async t => {
  for (const input of ["--rounds 4 Decision", "--rounds 1 --rounds 2 Decision", "--bad", "--rounds 1", ""]) {
    const { guard } = fixture(t)
    await activate(guard, input)
    assert.equal(guard.getState("parent"), undefined)
    await assert.rejects(before(guard, "unparsed", args(1)), /no valid parsed request/)
  }
})
test("unrelated tasks, lifecycle events, and tools do not create council state", async t => {
  const { guard } = fixture(t)
  await before(guard, "ordinary", { prompt: "ordinary", subagent_type: "general" }, "ordinary")
  await after(guard, "ordinary", "output", "child", "completed", "ordinary")
  await event(guard, "ordinary", "running", "child", "", "ordinary")
  await before(guard, "read", {}, "ordinary", "read")
  assert.equal(guard.getState("ordinary"), undefined)
})
test("three distinct initial participants are admitted concurrently", async t => {
  const { guard } = fixture(t)
  await activate(guard)
  await Promise.all([1, 2, 3].map(p => before(guard, `call-${p}`, args(p))))
  assert.deepEqual(guard.getState("parent")!.dispatches.map(d => [d.participant, d.agent, d.status]), AGENTS.map((agent, i) => [i + 1, agent, "active"]))
})
test("markers must be exact and on the first line", async t => {
  assert.deepEqual(parseTaskDispatchMarker(args(2, 3, "retry").prompt), { purpose: "retry", participant: 2, round: 3, subagentType: AGENTS[1] })
  assert.equal(parseTaskDispatchMarker(undefined), undefined)
  for (const prompt of ["ordinary", " " + args(1).prompt, "[DEBATE_DISPATCH participant=1]"]) {
    const { guard } = fixture(t)
    await activate(guard)
    await assert.rejects(before(guard, "bad", { ...args(1), prompt }), /marker.*required|marker is malformed/)
    assert.equal(guard.getState("parent")!.status, "aborted")
  }
})
test("explicit task args and marker must match the resolved registry assignment", async t => {
  for (const input of [{ ...args(1), subagent_type: null }, { ...args(1), subagent_type: "" }, { ...args(1), subagent_type: AGENTS[1] }, { ...args(1), prompt: args(2).prompt.replace("participant=2", "participant=1") }]) {
    const { guard } = fixture(t)
    await activate(guard)
    await assert.rejects(before(guard, "bad", input), /mapping mismatch/)
    assert.equal(guard.getState("parent")!.dispatches.length, 0)
  }
})
test("an omitted selector is filled only from a valid marker and the pinned registry", async t => {
  const {guard}=fixture(t)
  await activate(guard)
  const input={...args(2),subagent_type:undefined as string | undefined}
  await before(guard,"selector-default",input)
  assert.equal(input.subagent_type,AGENTS[1])
  assert.equal(guard.getState("parent")!.dispatches[0].agent,AGENTS[1])
})
test("duplicate registry assignments cannot create a valid run", async t => {
  const { guard } = fixture(t, { registry: { ...REGISTRY, sets: { selected: [AGENTS[0], AGENTS[0], AGENTS[2]] } } })
  await assert.rejects(activate(guard), /registry snapshot is corrupt/)
})
test("initial normal calls omit child IDs; continuation IDs cannot be invented or borrowed", async t => {
  const first = fixture(t).guard
  await activate(first)
  await assert.rejects(before(first, "bad", args(1, 1, "normal", "child-1")), /must omit task_id/)
  {
    const { guard } = fixture(t)
    await activate(guard)
    for (const p of [1, 2, 3]) await turn(guard, p)
    const omitted=args(1,2,"normal")
    await before(guard,"injected",omitted)
    assert.equal(omitted.task_id,"child-1")
  }
  for (const child of ["arbitrary", "child-2"]) {
    const { guard } = fixture(t)
    await activate(guard)
    for (const p of [1, 2, 3]) await turn(guard, p)
    await assert.rejects(before(guard, "bad", args(1, 2, "normal", child)), /task_id continuity mismatch/)
  }
})

test("runtime injects authoritative child ID when later calls omit opaque task_id", async t => {
  const { guard } = fixture(t)
  await activate(guard)
  await before(guard, "first", args(1))
  await after(guard, "first", '{"turn":"first"}', "child-1")
  await format(guard, 1)
  await turn(guard, 2); await turn(guard, 3)
  const next = args(1, 2, "normal")
  await before(guard, "next", next)
  assert.equal(next.task_id, "child-1")
  const wrong = args(2, 2, "normal", "corrupted-child")
  await assert.rejects(before(guard, "wrong", wrong), /task_id continuity mismatch/)
})
test("duplicate call IDs retain one reservation and duplicate normal attempts abort", async t => {
  const same = fixture(t).guard
  await activate(same)
  await before(same, "same", args(1))
  await assert.rejects(before(same, "same", args(1)), /duplicate dispatch call ID/)
  assert.equal(same.getState("parent")!.dispatches.length, 1)
  for (const completed of [false, true]) {
    const { guard } = fixture(t)
    await activate(guard)
    await before(guard, "first", args(1))
    if (completed) await after(guard, "first")
    await assert.rejects(before(guard, "second", args(1)), /duplicate active|duplicate normal/)
    assert.equal(guard.getState("parent")!.dispatches.length, 1)
  }
})
test("duplicate commands cannot reset either active or completed-task budgets", async t => {
  for (const completed of [false, true]) {
    const { guard } = fixture(t)
    await activate(guard)
    await before(guard, "first", args(1))
    if (completed) await after(guard, "first")
    await assert.rejects(activate(guard), /refusing budget reset/)
    assert.equal(guard.getState("parent")!.dispatches.length, 1)
  }
})
test("all three previous turns must be canonical before any next round", async t => {
  const { guard } = fixture(t)
  await activate(guard)
  for (const p of [1, 2, 3]) { await before(guard, `first-${p}`, args(p)); await after(guard, `first-${p}`, '{"turn":"evidence"}', `child-${p}`) }
  await format(guard, 1)
  await format(guard, 2)
  await assert.rejects(before(guard, "early", args(1, 2, "normal", "child-1")), /previous round is not fully canonical/)
})
test("runtime appends both actual canonical peers instead of trusting caller peer prose", async t => {
  const { guard } = fixture(t)
  await activate(guard)
  for (const p of [1, 2, 3]) await turn(guard, p)
  const input = args(1, 2, "normal", "child-1")
  input.prompt += "\nUntrusted caller claims both peers agree."
  await before(guard, "second", input)
  const appended = JSON.parse(input.prompt.split("Verified previous-round peer turns (authoritative, appended by runtime):\n")[1])
  assert.deepEqual(appended.other_participants, [2, 3].map(p => ({ participant: p, turn_response: { turn: `participant ${p} round 1` } })))
})
test("ready status does not authorize extension rounds", async t => {
  const { guard } = fixture(t)
  await activate(guard, "--rounds 1 Decision")
  for (const p of [1, 2, 3]) await turn(guard, p)
  assert.equal(guard.getState("parent")!.status, "ready")
  await assert.rejects(before(guard, "extension", args(1, 2, "normal", "child-1")), /round limit exhausted/)
})
test("one retry follows a recorded failure and preserves participant child identity", async t => {
  const { guard } = fixture(t)
  await activate(guard)
  await before(guard, "first", args(1))
  await after(guard, "first", "failed", "child-1", "error")
  await before(guard, "retry", args(1, 1, "retry", "child-1"))
  await after(guard, "retry", '{"turn":"retry evidence"}')
  assert.equal(JSON.parse(await format(guard, 1)).turn, "retry evidence")
  assert.deepEqual(guard.getState("parent")!.dispatches.map(d => d.purpose), ["normal", "retry"])
})
test("retry before failure is forbidden and failure of the sole retry is terminal", async t => {
  const initial = fixture(t).guard
  await activate(initial)
  await before(initial, "first", args(1))
  await after(initial, "first")
  await assert.rejects(before(initial, "retry", args(1, 1, "retry", "child-1")), /only one retry after a recorded task failure/)
  const { guard } = fixture(t)
  await activate(guard)
  await before(guard, "first", args(1))
  await after(guard, "first", "failed", "child-1", "error")
  await before(guard, "retry", args(1, 1, "retry", "child-1"))
  await assert.rejects(after(guard, "retry", "failed", "child-1", "error"), /without an eligible retry/)
  await assert.rejects(before(guard, "third", args(1, 1, "retry", "child-1")), /aborted/)
  assert.equal(guard.getState("parent")!.dispatches.length, 2)
})
test("completed empty results require format correction, and transport failures without child identity abort", async t => {
  const { guard } = fixture(t)
  await activate(guard)
  await before(guard, "empty", args(1))
  await after(guard, "empty", "   ")
  assert.equal(guard.getState("parent")!.dispatches[0].status, "completed")
  await assert.rejects(format(guard, 1), /purpose=formatter-correction participant=1/)
  await before(guard, "correction", args(1, 1, "formatter-correction", "child-1"))
  const unknown = fixture(t).guard
  await activate(unknown)
  await before(unknown, "first", args(1))
  await assert.rejects(event(unknown, "first", "error"), /without an eligible retry/)
})
test("running envelopes stay active and metadata-free terminal errors retain known child IDs", async t => {
  const { guard } = fixture(t)
  await activate(guard)
  await before(guard, "first", args(1))
  await after(guard, "first", "started", "child-1", "running")
  assert.equal(guard.getState("parent")!.dispatches[0].status, "active")
  await event(guard, "first", "error")
  await before(guard, "retry", args(1, 1, "retry", "child-1"))
})
test("duplicate same-ID lifecycle events cannot double charge or replace actual output", async t => {
  const { guard } = fixture(t)
  await activate(guard)
  await before(guard, "first", args(1))
  await event(guard, "first", "running", "child-1")
  await event(guard, "first", "running", "child-1")
  await after(guard, "first", '{"turn":"original"}')
  await event(guard, "first", "completed", "child-1", '{"turn":"replacement"}')
  assert.equal(guard.getState("parent")!.dispatches.length, 1)
  assert.equal(JSON.parse(await format(guard, 1)).turn, "original")
})
test("conflicting terminal events abort instead of overriding completed evidence", async t => {
  const { guard } = fixture(t)
  await activate(guard)
  await before(guard, "first", args(1))
  await after(guard, "first")
  await assert.rejects(event(guard, "first", "error", "child-1"), /conflicting terminal task events/)
  assert.equal(guard.getState("parent")!.status, "aborted")
})
test("a delayed original failure cannot demote a successful retry", async t => {
  const { guard } = fixture(t)
  await activate(guard)
  await before(guard, "first", args(1))
  await after(guard, "first", "failed", "child-1", "error")
  await before(guard, "retry", args(1, 1, "retry", "child-1"))
  await after(guard, "retry")
  await event(guard, "first", "error", "child-1")
  assert.deepEqual(guard.getState("parent")!.dispatches.map(d => d.status), ["failed", "completed"])
  await format(guard, 1)
})
test("child identities are write-once in both running metadata and completed envelopes", async t => {
  for (const running of [true, false]) {
    const { guard } = fixture(t)
    await activate(guard)
    await before(guard, "first", args(1))
    await event(guard, "first", "running", "child-1")
    await assert.rejects(running ? event(guard, "first", "running", "child-other") : after(guard, "first", '{"turn":"evidence"}', "child-other"), /task_id changed|child.*mismatch|conflicting.*child/)
    assert.equal(guard.getState("parent")!.dispatches[0].taskID, "child-1")
    assert.equal(guard.getState("parent")!.status, "aborted")
  }
})
test("task envelope ID must agree with child metadata", async t => {
  const { guard } = fixture(t)
  await activate(guard)
  await before(guard, "first", args(1))
  await assert.rejects(guard.hooks["tool.execute.after"]!({ tool: "task", sessionID: "parent", callID: "first", args: {} }, {
    title: "task", output: envelope("child-1", '{"turn":"evidence"}'), metadata: { sessionId: "child-other" },
  }), /child session ID mismatch/)
})
test("formatter binds actual raw output, dispatch ID, and formatter ID; state contains no discussion text", async t => {
  const { guard, store } = fixture(t)
  await activate(guard)
  await before(guard, "first", args(1))
  await after(guard, "first", '{"turn":"actual participant evidence"}')
  const canonical = await format(guard, 1, 1, "format-actual", { response: '{"turn":"coordinator fabrication"}', schema: "round1" })
  assert.equal(JSON.parse(canonical).turn, "actual participant evidence")
  const state = guard.getState("parent")!
  assert.deepEqual(state.validated["1:1"], { callID: "first", formatterCallID: "format-actual", digest: digest(canonical) })
  assert.doesNotMatch(readFileSync(store.path(state.runId), "utf8"), /actual participant evidence|coordinator fabrication/)
})
test("formatter requires an admission and a completed actual task", async t => {
  const { guard } = fixture(t)
  await activate(guard)
  await assert.rejects(guard.formatter.execute({ participant: 1, round: 1 }, { sessionID: "parent" } as never), /admission is missing/)
  await assert.rejects(format(guard, 1), /completed actual task/)
})
test("coordinator-supplied valid JSON cannot repair a malformed actual task result", async t => {
  const { guard } = fixture(t)
  await activate(guard)
  await before(guard, "first", args(1))
  await after(guard, "first", '{"turn":42}')
  await assert.rejects(format(guard, 1, 1, "f", { response: '{"turn":"fake valid"}' }), /turn|formatter/i)
  assert.equal(guard.getState("parent")!.dispatches[0].formatFailed, true)
  assert.deepEqual(guard.getState("parent")!.validated, {})
})
test("formatter correction requires actual validation failure and validates corrected participant output", async t => {
  const unfailed = fixture(t).guard
  await activate(unfailed)
  await before(unfailed, "first", args(1))
  await after(unfailed, "first")
  await assert.rejects(before(unfailed, "correction", args(1, 1, "formatter-correction", "child-1")), /recorded validation failure/)
  const { guard } = fixture(t)
  await activate(guard)
  await before(guard, "first", args(1))
  await after(guard, "first", '{"turn":42}')
  await assert.rejects(format(guard, 1), /turn|formatter/i)
  await before(guard, "correction", args(1, 1, "formatter-correction", "child-1"))
  await after(guard, "correction", '{"turn":"corrected actual evidence"}')
  assert.equal(JSON.parse(await format(guard, 1)).turn, "corrected actual evidence")
  assert.equal(guard.getState("parent")!.validated["1:1"].callID, "correction")
})
test("two formatter corrections consume budget and a third invalid result aborts", async t => {
  const { guard } = fixture(t)
  await activate(guard)
  for (let attempt = 0; attempt < 3; attempt++) {
    await before(guard, `attempt-${attempt}`, args(1, 1, attempt ? "formatter-correction" : "normal", attempt ? "child-1" : undefined))
    await after(guard, `attempt-${attempt}`, '{"turn":42}')
    await assert.rejects(format(guard, 1, 1, `format-${attempt}`), /turn|formatter/i)
  }
  assert.equal(guard.getState("parent")!.status, "aborted")
  assert.equal(guard.getState("parent")!.dispatches.length, 3)
  await assert.rejects(before(guard, "third-correction", args(1, 1, "formatter-correction", "child-1")), /aborted/)
})
test("twelfth versus thirteenth concurrent admissions never exceed twelve tasks", async t => {
  const { guard } = fixture(t)
  await activate(guard, "--rounds 3 Decision")
  for (let attempt = 0; attempt < 3; attempt++) {
    await before(guard, `p1-${attempt}`, args(1, 1, attempt ? "formatter-correction" : "normal", attempt ? "child-1" : undefined))
    await after(guard, `p1-${attempt}`, attempt === 2 ? '{"turn":"correct"}' : '{"turn":42}')
    if (attempt === 2) await format(guard, 1)
    else await assert.rejects(format(guard, 1), /turn|formatter/i)
  }
  await before(guard, "p2-first", args(2))
  await after(guard, "p2-first", "failed", "child-2", "error")
  await before(guard, "p2-retry", args(2, 1, "retry", "child-2"))
  await after(guard, "p2-retry", '{"turn":"correct"}', "child-2")
  await format(guard, 2)
  await turn(guard, 3)
  for (const p of [1, 2, 3]) await turn(guard, p, 2)
  await turn(guard, 1, 3)
  await before(guard, "p2-r3", args(2, 3, "normal", "child-2"))
  await after(guard, "p2-r3", '{"turn":42,"consensus_reached":false,"recommend_stopping":false}', "child-2")
  await assert.rejects(format(guard, 2, 3), /turn|formatter/i)
  assert.equal(guard.getState("parent")!.dispatches.length, 11)
  const results = await Promise.allSettled([before(guard, "twelfth", args(3, 3, "normal", "child-3")), before(guard, "thirteenth", args(2, 3, "formatter-correction", "child-2"))])
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1)
  assert.match(String((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason), /dispatch budget exhausted/)
  assert.equal(guard.getState("parent")!.dispatches.length, 12)
  assert.equal(guard.getState("parent")!.status, "aborted")
})
test("forbidden coordinator tools abort without admitting tasks", async t => {
  for (const tool of ["question", "persist_debate_transcript"]) {
    const { guard } = fixture(t)
    await activate(guard)
    await assert.rejects(before(guard, "forbidden", {}, "parent", tool), /forbidden/)
    assert.equal(guard.getState("parent")!.dispatches.length, 0)
  }
})
test("clear, dispose, and session deletion cannot erase persistent budgets", async t => {
  const { guard, directory } = fixture(t)
  await activate(guard)
  await before(guard, "first", args(1))
  await event(guard, "first", "running", "child-1")
  for (const id of ["parent", "child-1"]) await guard.hooks.event!({ event: { type: "session.deleted", properties: { info: { id } } } } as never)
  guard.clear()
  const resumed = createTaskDispatchGuard({ registry: REGISTRY, store: new CouncilStateStore(directory), runId: "run-test" })
  try { assert.equal(resumed.getState("parent")!.dispatches.length, 1); await assert.rejects(before(resumed, "duplicate", args(1)), /duplicate active/) }
  finally { resumed.clear() }
})
test("abort remains terminal after reattachment and late running or completion events", async t => {
  const { guard, directory } = fixture(t)
  await activate(guard)
  await before(guard, "first", args(1))
  await assert.rejects(before(guard, "bad", {}, "parent", "question"), /forbidden/)
  const snapshot = guard.getState("parent")!
  guard.clear()
  const resumed = createTaskDispatchGuard({ registry: REGISTRY, store: new CouncilStateStore(directory), runId: "run-test" })
  try {
    await after(resumed, "first")
    await event(resumed, "first", "running", "late-child")
    assert.deepEqual(resumed.getState("parent"), snapshot)
    await assert.rejects(before(resumed, "late", args(2)), /aborted/)
  } finally { resumed.clear() }
})
test("deadline-expired terminal events cannot promote actual task evidence", async t => {
  const { guard, store } = fixture(t)
  await activate(guard)
  await before(guard, "first", args(1))
  store.update("run-test", state => { state.deadlineMs = Date.now() - 1 })
  await assert.rejects(after(guard, "first"), /deadline/)
  assert.equal(guard.getState("parent")!.status, "aborted")
  assert.deepEqual(guard.getState("parent")!.validated, {})
})
test("abort requests cancellation of known active child sessions", async t => {
  const cancelled: string[] = []
  const { guard } = fixture(t, { cancelSession: async id => { cancelled.push(id) } })
  await activate(guard)
  await before(guard, "first", args(1))
  await event(guard, "first", "running", "child-1")
  await assert.rejects(before(guard, "bad", {}, "parent", "question"), /forbidden/)
  assert.deepEqual(cancelled, ["child-1"])
})

test("premature root reports become deterministic abort text instead of advisory success", async t => {
  const { guard } = fixture(t)
  await activate(guard)
  const output = await textComplete(guard, REPORT)
  assert.match(output, /^## Council Abort/)
  assert.match(output, /before every configured turn was canonical/)
  assert.equal(guard.getState("parent")!.status, "aborted")
})

test("participant JSON mentioning the report heading is not routed through the root report gate", async t => {
  const {guard}=fixture(t)
  await activate(guard)
  await before(guard,"child-title",args(1))
  await event(guard,"child-title","running","child-1")
  const text=JSON.stringify({turn:"The final output must start with ## Council Report, not a synthesis."})
  const output={text}
  await guard.hooks["experimental.text.complete"]!({sessionID:"child-1",messageID:"child-message",partID:"child-part"},output)
  assert.equal(output.text,text)
  assert.equal(guard.getState("parent")!.status,"active")
  await after(guard,"child-title",text,"child-1")
  assert.equal(JSON.parse(await format(guard,1)).turn,JSON.parse(text).turn)
})

test("ready reports reject extra recommendation headings and missing or empty sections", async t => {
  for (const report of [REPORT + "\n\n## Final recommendation\nAdopt it", REPORT.replace("Evidence for Risks", ""), REPORT.replace("### Agreements", "### Synthesis")]) {
    const { guard } = fixture(t)
    await activate(guard, "--rounds 1 Decision")
    for (const p of [1, 2, 3]) await turn(guard, p)
    assert.match(await textComplete(guard, report), /^## Council Abort/)
    assert.equal(guard.getState("parent")!.status, "aborted")
  }
})

test("valid root report completion binds message and digest and is immutable after reattachment", async t => {
  const { guard, directory } = fixture(t)
  await activate(guard, "--rounds 1 Decision")
  for (const p of [1, 2, 3]) await turn(guard, p)
  assert.equal(await textComplete(guard, " \n" + REPORT + "\n "), REPORT)
  const snapshot = guard.getState("parent")!
  assert.equal(snapshot.status, "completed")
  assert.equal(snapshot.reportMessageID, "final-message")
  assert.equal(snapshot.reportDigest, digest(REPORT))
  guard.clear()
  const resumed = createTaskDispatchGuard({ registry: REGISTRY, store: new CouncilStateStore(directory), runId: "run-test" })
  try {
    assert.equal(await textComplete(resumed, REPORT), REPORT)
    await assert.rejects(textComplete(resumed, REPORT, "different-message"), /already completed/)
    await assert.rejects(textComplete(resumed, REPORT.replace("Evidence for Risks", "Changed risk")), /already completed/)
    assert.deepEqual(resumed.getState("parent"), snapshot)
  } finally { resumed.clear() }
})

test("reattachment hydrates only digest-matching actual task and canonical peer evidence", async t => {
  for (const corrupt of [false, true]) {
    const { guard, directory } = fixture(t)
    await activate(guard)
    const parts: any[] = []
    for (const p of [1, 2, 3]) {
      const canonical = await turn(guard, p)
      parts.push({ type: "tool", tool: "task", callID: `normal-${p}-1`, state: { status: "completed", output: envelope(`child-${p}`, JSON.stringify({ turn: `participant ${p} round 1` })), metadata: { sessionId: `child-${p}` } } })
      parts.push({ type: "tool", tool: "format_debate_response", callID: `format-${p}-1`, state: { status: "completed", output: corrupt && p === 2 ? '{"turn":"substituted evidence"}' : canonical } })
    }
    guard.clear()
    const resumed = createTaskDispatchGuard({ registry: REGISTRY, store: new CouncilStateStore(directory), runId: "run-test", loadMessages: async () => [{ info: { id: "history", role: "assistant" }, parts }] })
    try {
      const input = args(1, 2, "normal", "child-1")
      if (corrupt) await assert.rejects(before(resumed, "resumed-round2", input), /canonical peer evidence unavailable/)
      else { await before(resumed, "resumed-round2", input); assert.match(input.prompt, /participant 2 round 1/); assert.match(input.prompt, /participant 3 round 1/) }
    } finally { resumed.clear() }
  }
})
