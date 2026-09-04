import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { CouncilStateStore, abortRun, allValidated, assertLive, digest, type RunState } from "../src/council-state.ts"
import { createTaskDispatchGuard, type TaskDispatchPurpose } from "../src/task-dispatch-guard.ts"

const AGENTS = ["test-alpha", "test-beta", "test-gamma"]
const REGISTRY = { participants: AGENTS.map(agent => ({ agent, model: "test/" + agent, description: agent })), sets: { selected: AGENTS }, defaultSet: "selected" }
const STATE_URL = new URL("../src/council-state.ts", import.meta.url).href
const GUARD_URL = new URL("../src/task-dispatch-guard.ts", import.meta.url).href
const CLI = fileURLToPath(new URL("../scripts/council-state-cli.ts", import.meta.url))
function state(overrides: Partial<RunState> = {}): RunState {
  return { version: 1, runId: "run-test", sessionID: "parent", deadlineMs: Date.now() + 120_000, rounds: 1,
    registry: REGISTRY, status: "active", dispatches: [], validated: {}, continuations: 0, continuedMessageIDs: [], ...overrides }
}
function fixture(t: TestContext, initial?: RunState) {
  const directory = mkdtempSync(join(tmpdir(), "council-state-"))
  const store = new CouncilStateStore(directory)
  if (initial) store.create(initial)
  t.after(() => { store.dispose(); rmSync(directory, { recursive: true, force: true }) })
  return { directory, store }
}
function child(script: string, directory: string, withoutRunID = false) {
  const env: NodeJS.ProcessEnv = { ...process.env, COUNCIL_STATE_DIR: directory }
  if (withoutRunID) delete env.COUNCIL_RUN_ID
  return spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8", timeout: 10_000, env,
  })
}
function cli(directory: string, ...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 10_000, env: { ...process.env, COUNCIL_STATE_DIR: directory } })
}
function bootstrap(directory: string, messages: unknown[] = []) {
  return `import { CouncilStateStore } from ${JSON.stringify(STATE_URL)};\nimport { createTaskDispatchGuard } from ${JSON.stringify(GUARD_URL)};\nconst store = new CouncilStateStore(${JSON.stringify(directory)});\nconst guard = createTaskDispatchGuard({store, registry:${JSON.stringify(REGISTRY)}, runId:'run-test',loadMessages:async()=>${JSON.stringify(messages)}});\n`
}
function task(p = 1, purpose = "normal", taskID?: string, round = 1) {
  const agent = AGENTS[p - 1]
  return { subagent_type: agent, prompt: `[DEBATE_DISPATCH purpose=${purpose} participant=${p} round=${round} subagent_type=${agent}]\nReview`, ...(taskID ? { task_id: taskID } : {}) }
}
function ready(): RunState {
  const result = state({ status: "ready" })
  for (let p = 1; p <= 3; p++) {
    result.dispatches.push({ callID: "task-" + p, participant: p, round: 1, purpose: "normal", agent: AGENTS[p - 1], taskID: "child-" + p, status: "completed", outputDigest: digest("raw-" + p) })
    result.validated[p + ":1"] = { callID: "task-" + p, formatterCallID: "formatter-" + p, digest: digest("canonical-" + p) }
  }
  return result
}

test("crashing after real admission preserves the reserved task and permits dead-owner lease recovery", t => {
  const { directory, store } = fixture(t)
  const result = child(bootstrap(directory) + `
    await guard.hooks['command.execute.before']({command:'council',sessionID:'parent',arguments:'--rounds 1 Decision'}, {parts:[]});
    await guard.hooks['tool.execute.before']({tool:'task',sessionID:'parent',callID:'reserved-before-crash'}, {args:${JSON.stringify(task())}});
    process.kill(process.pid, 'SIGKILL');`, directory)
  assert.equal(result.signal, "SIGKILL", result.stderr)
  assert.equal(store.read("run-test").dispatches.length, 1)
  assert.equal(store.read("run-test").dispatches[0].status, "active")
  assert.ok(existsSync(join(directory, "run-test.lease", "owner.json")))
  store.update("run-test", current => { current.continuations = 1; current.continuedMessageIDs = ["reserved-continuation"] })
  assert.equal(JSON.parse(readFileSync(join(directory, "run-test.lease", "owner.json"), "utf8")).pid, process.pid)
  assert.equal(store.read("run-test").dispatches[0].callID, "reserved-before-crash")
})

test("another live process cannot acquire or mutate the same run lease", t => {
  const { directory, store } = fixture(t, state())
  const before = readFileSync(store.path("run-test"), "utf8")
  const result = child(`import {CouncilStateStore} from ${JSON.stringify(STATE_URL)}; const s = new CouncilStateStore(); try { s.update('run-test', s => {s.continuations=1;s.continuedMessageIDs=['stolen']}) } finally {s.dispose()}`, directory)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /owned by another live process/)
  assert.equal(readFileSync(store.path("run-test"), "utf8"), before)
})

test("restarting a guard cannot reset an existing run or replace an unfinished session with a new ID", t => {
  const initial = state()
  initial.dispatches.push({ callID: "charged", participant: 1, round: 1, purpose: "normal", agent: AGENTS[0], status: "active" })
  const { directory, store } = fixture(t, initial)
  store.dispose()
  const result = child(bootstrap(directory) + `try {await guard.hooks['command.execute.before']({command:'council',sessionID:'parent',arguments:'Decision'}, {parts:[]})} finally {guard.clear()}`, directory)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /refusing budget reset/)
  const replacement = child(`import {CouncilStateStore} from ${JSON.stringify(STATE_URL)};const s=new CouncilStateStore();try{s.create(${JSON.stringify(state({ runId: "replacement" }))})}finally{s.dispose()}`, directory)
  assert.equal(replacement.status, 1)
  assert.match(replacement.stderr, /unfinished run/)
  assert.equal(store.read("run-test").dispatches.length, 1)
  assert.equal(store.find("parent"), "run-test")
})

test("missing and corrupt snapshots fail closed without overwriting their contents", t => {
  const { directory, store } = fixture(t)
  assert.throws(() => store.read("missing"), /missing or unreadable/)
  const missing = cli(directory, "continue", "missing", "parent", "message")
  assert.equal(missing.status, 1)
  assert.equal(existsSync(store.path("missing")), false)
  for (const raw of ["{truncated", JSON.stringify({ ...state(), continuations: 9 }), JSON.stringify({ ...state(), dispatches: [{ callID: "bad", participant: 1, round: 1, purpose: "normal", agent: "wrong", status: "active" }] })]) {
    writeFileSync(store.path("run-test"), raw)
    const result = cli(directory, "inspect", "run-test", "parent")
    assert.equal(result.status, 1)
    assert.match(result.stderr, /missing or unreadable|corrupt|invalid task/)
    assert.equal(readFileSync(store.path("run-test"), "utf8"), raw)
  }
})

test("an unpublished lease owner cannot be mistaken for a dead owner", t => {
  const {directory,store}=fixture(t,state())
  store.dispose()
  const before=readFileSync(store.path("run-test"),"utf8")
  mkdirSync(join(directory,"run-test.lease"))
  assert.throws(()=>store.update("run-test",s=>{s.status="aborted"}),/lease acquisition is in progress/)
  assert.equal(readFileSync(store.path("run-test"),"utf8"),before)
  assert.ok(existsSync(join(directory,"run-test.lease")))
})

test("continuation reservations survive CLI process exits and duplicate messages are not charged again", t => {
  const { directory, store } = fixture(t, state())
  store.dispose()
  assert.equal(cli(directory, "continue", "run-test", "parent", "msg-1").status, 0)
  const duplicate = cli(directory, "continue", "run-test", "parent", "msg-1")
  assert.equal(duplicate.status, 1)
  assert.match(duplicate.stderr, /already continued/)
  assert.equal(store.read("run-test").continuations, 1)
  assert.deepEqual(store.read("run-test").continuedMessageIDs, ["msg-1"])
  for (let i = 2; i <= 8; i++) assert.equal(cli(directory, "continue", "run-test", "parent", "msg-" + i).status, 0)
  const ninth = cli(directory, "continue", "run-test", "parent", "msg-9")
  assert.equal(ninth.status, 1)
  assert.match(ninth.stderr, /eight coordinator continuations/)
  assert.equal(store.read("run-test").continuations, 8)
  assert.equal(store.read("run-test").status, "aborted")
})

test("continuations reject active dispatches, wrong sessions, and expired deadlines", t => {
  const active = state()
  active.dispatches.push({ callID: "task", participant: 1, round: 1, purpose: "normal", agent: AGENTS[0], status: "active" })
  for (const [initial, session, diagnostic] of [
    [active, "parent", /unresolved active dispatches/], [state(), "other-session", /session does not match/],
    [state({ deadlineMs: Date.now() - 1 }), "parent", /deadline exhausted/],
  ] as const) {
    const { directory, store } = fixture(t, initial)
    store.dispose()
    const result = cli(directory, "continue", "run-test", session, "message")
    assert.equal(result.status, 1)
    assert.match(result.stderr, diagnostic)
    assert.equal(store.read("run-test").continuations, 0)
  }
})

test("terminal abort persists its original reason across CLI reattachment and late guards", t => {
  const initial = state()
  abortRun(initial, "original failure", 2, 1)
  const { directory, store } = fixture(t, initial)
  store.dispose()
  const repeated = cli(directory, "abort", "run-test", "parent", "replacement reason")
  assert.equal(repeated.status, 0)
  assert.match(repeated.stdout, /original failure/)
  assert.doesNotMatch(repeated.stdout, /replacement reason/)
  const admission = child(bootstrap(directory) + `try{await guard.hooks['tool.execute.before']({tool:'task',sessionID:'parent',callID:'late'},{args:${JSON.stringify(task())}})}finally{guard.clear()}`, directory)
  assert.equal(admission.status, 1)
  assert.match(admission.stderr, /aborted/)
  assert.deepEqual(store.read("run-test"), initial)
})

test("only complete participant-round coverage with completed bound dispatches is ready", () => {
  const complete = ready()
  assert.equal(allValidated(complete), true)
  for (const missing of ["1:1", "2:1", "3:1"]) {
    const incomplete = structuredClone(complete)
    delete incomplete.validated[missing]
    assert.equal(allValidated(incomplete), false)
  }
  const active = structuredClone(complete)
  active.dispatches[0].status = "active"
  assert.equal(allValidated(active), false)
  const wrong = structuredClone(complete)
  wrong.validated["1:1"].callID = "task-2"
  assert.equal(allValidated(wrong), false)
  const moreRounds = structuredClone(complete)
  moreRounds.rounds = 2
  assert.equal(allValidated(moreRounds), false)
})

test("completed report metadata is immutable across CLI processes and idempotent only for identical evidence", t => {
  const { directory, store } = fixture(t, ready())
  store.dispose()
  const reportHash = digest("trimmed final report")
  assert.equal(cli(directory, "complete", "run-test", "parent", "msg-final", reportHash).status, 0)
  const completed = store.read("run-test")
  assert.equal(completed.status, "completed")
  assert.equal(completed.reportMessageID, "msg-final")
  assert.equal(completed.reportDigest, reportHash)
  assert.equal(cli(directory, "complete", "run-test", "parent", "msg-final", reportHash).status, 0)
  for (const [message, hash, expected] of [["msg-other", reportHash, /message does not match/], ["msg-final", digest("replacement"), /content does not match/]] as const) {
    const result = cli(directory, "complete", "run-test", "parent", message, hash)
    assert.equal(result.status, 1)
    assert.match(result.stderr, expected)
    assert.deepEqual(store.read("run-test"), completed)
  }
})

test("incomplete state cannot be promoted by a syntactically valid completion request", t => {
  const { directory, store } = fixture(t, state())
  store.dispose()
  const result = cli(directory, "complete", "run-test", "parent", "msg-final", digest("report"))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /every configured turn/)
  assert.equal(store.read("run-test").status, "active")
})

test("thrown mutations persist deadline aborts but never silently replenish budgets", t => {
  const { store } = fixture(t, state({ deadlineMs: Date.now() - 1, continuations: 2, continuedMessageIDs: ["m1", "m2"] }))
  assert.throws(() => store.update("run-test", current => assertLive(current)), /deadline/)
  assert.equal(store.read("run-test").status, "aborted")
  assert.equal(store.read("run-test").continuations, 2)
})

test("cross-process contention around the twelfth reservation admits at most one task", async t => {
  // Build the eleven charged attempts through the actual runtime, including its
  // formatter and round barriers. Neither a forged ledger nor a test-only counter
  // establishes eligibility for the two competing real subprocess admissions.
  const { directory, store } = fixture(t)
  const guard = createTaskDispatchGuard({ store, registry: REGISTRY, runId: "run-test" })
  await guard.hooks["command.execute.before"]!({ command: "council", sessionID: "parent", arguments: "--rounds 3 Decision" }, { parts: [] })
  const parts: unknown[] = []
  let calls = 0
  const attempt = async (p: number, round: number, purpose: TaskDispatchPurpose = "normal", invalid = false, failed = false) => {
    const callID = "prepared-" + ++calls
    await guard.hooks["tool.execute.before"]!({ tool: "task", sessionID: "parent", callID }, { args: task(p, purpose, round > 1 || purpose !== "normal" ? "child-" + p : undefined, round) })
    const raw = JSON.stringify({ turn: invalid ? 42 : "actual participant " + p, ...(round > 1 ? { consensus_reached: false, recommend_stopping: false } : {}) })
    const tag = failed ? "error" : "result"
    await guard.hooks["tool.execute.after"]!({ tool: "task", sessionID: "parent", callID, args: {} }, {
      title: "task", output: `<task id="child-${p}" state="${failed ? "error" : "completed"}"><task_${tag}>${raw}</task_${tag}></task>`, metadata: { sessionId: "child-" + p },
    })
    if (failed) return
    const formatterCallID = "formatter-" + callID
    await guard.hooks["tool.execute.before"]!({ tool: "format_debate_response", sessionID: "parent", callID: formatterCallID }, { args: { participant: p, round } })
    const formatting = guard.formatter.execute({ participant: p, round }, { sessionID: "parent", callID: formatterCallID } as never)
    if (invalid) await assert.rejects(formatting, /turn.*non-empty string/)
    else {
      const canonical = await formatting
      assert.ok(typeof canonical === "string")
      parts.push({ type: "tool", tool: "format_debate_response", callID: formatterCallID, state: { status: "completed", output: canonical } })
    }
  }
  await attempt(1, 1, "normal", true)
  await attempt(1, 1, "formatter-correction", true)
  await attempt(1, 1, "formatter-correction")
  await attempt(2, 1, "normal", false, true)
  await attempt(2, 1, "retry")
  await attempt(3, 1)
  for (const p of [1, 2, 3]) await attempt(p, 2)
  await attempt(1, 3)
  await attempt(2, 3, "normal", true)
  assert.equal(store.read("run-test").dispatches.length, 11)
  guard.clear()
  const messages = [{ info: { id: "prior", role: "assistant" }, parts }]
  const raceArgs = (p: number) => task(p, p === 3 ? "normal" : "formatter-correction", "child-" + p, 3)
  const run = (p: number) => new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const script = bootstrap(directory, messages) + `try{await guard.hooks['tool.execute.before']({tool:'task',sessionID:'parent',callID:'race-${p}'},{args:${JSON.stringify(raceArgs(p))}})}finally{guard.clear()}`
    const process_ = spawn(process.execPath, ["--input-type=module", "--eval", script], { env: { ...process.env, COUNCIL_STATE_DIR: directory }, stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    process_.stderr.on("data", data => { stderr += data })
    process_.on("error", reject)
    process_.on("exit", code => resolve({ code, stderr }))
  })
  const results = await Promise.all([run(3), run(2)])
  assert.equal(results.filter(result => result.code === 0).length, 1, JSON.stringify(results))
  assert.match(results.find(result => result.code !== 0)!.stderr, /owned by another live process|dispatch budget exhausted|EEXIST|lease acquisition is in progress/)
  assert.equal(store.read("run-test").dispatches.length, 12)
  const winner = store.read("run-test").dispatches.at(-1)!.participant
  const other = winner === 3 ? 2 : 3
  const repeated = child(bootstrap(directory, messages) + `try{await guard.hooks['tool.execute.before']({tool:'task',sessionID:'parent',callID:'thirteenth'},{args:${JSON.stringify(raceArgs(other))}})}finally{guard.clear()}`, directory)
  assert.equal(repeated.status, 1)
  assert.match(repeated.stderr, /dispatch budget exhausted|aborted/)
  assert.equal(store.read("run-test").dispatches.length, 12)
})

test("native no-env council children find their persistent run after running metadata and reattachment", t => {
  const { directory, store } = fixture(t)
  const result = child(`
    import {CouncilStateStore} from ${JSON.stringify(STATE_URL)};
    import {createTaskDispatchGuard} from ${JSON.stringify(GUARD_URL)};
    const store=new CouncilStateStore();
    const options={store,registry:${JSON.stringify(REGISTRY)}};
    const guard=createTaskDispatchGuard(options);
    await guard.hooks['command.execute.before']({command:'council',sessionID:'parent',arguments:'--rounds 1 Decision'},{parts:[]});
    await guard.hooks['tool.execute.before']({tool:'task',sessionID:'parent',callID:'native-task'},{args:${JSON.stringify(task())}});
    await guard.hooks.event({event:{type:'message.part.updated',properties:{part:{type:'tool',tool:'task',sessionID:'parent',callID:'native-task',state:{status:'running',metadata:{sessionId:'native-child'}}}}}});
    guard.clear();
    const resumed=createTaskDispatchGuard(options);
    try{await resumed.hooks['chat.params']({sessionID:'native-child',agent:${JSON.stringify(AGENTS[0])}},{});console.log(store.find('parent'))}finally{resumed.clear()}
  `, directory, true)
  assert.equal(result.status, 0, result.stderr)
  const runId = result.stdout.trim()
  assert.match(runId, /^[a-f0-9-]{36}$/)
  assert.equal(store.find("native-child"), runId)
  assert.equal(store.read(runId).dispatches[0].taskID, "native-child")
})

test("native first child model call can bind through the SDK parent-session callback", t => {
  const { directory, store } = fixture(t)
  const result = child(`
    import {CouncilStateStore} from ${JSON.stringify(STATE_URL)};
    import {createTaskDispatchGuard} from ${JSON.stringify(GUARD_URL)};
    const store=new CouncilStateStore();
    const seen=[];
    const guard=createTaskDispatchGuard({store,registry:${JSON.stringify(REGISTRY)},parentSession:async child=>{seen.push(child);return child==='native-child'?'parent':undefined}});
    try{
      await guard.hooks['command.execute.before']({command:'council',sessionID:'parent',arguments:'Decision'},{parts:[]});
      await guard.hooks['tool.execute.before']({tool:'task',sessionID:'parent',callID:'native-task'},{args:${JSON.stringify(task())}});
      await guard.hooks['chat.params']({sessionID:'native-child',agent:${JSON.stringify(AGENTS[0])}},{});
      console.log(JSON.stringify({runId:store.find('parent'),seen}));
    }finally{guard.clear()}
  `, directory, true)
  assert.equal(result.status, 0, result.stderr)
  const result_ = JSON.parse(result.stdout)
  assert.deepEqual(result_.seen, ["native-child"])
  assert.equal(store.find("native-child"), result_.runId)
  assert.equal(store.read(result_.runId).dispatches[0].taskID, "native-child")
})
