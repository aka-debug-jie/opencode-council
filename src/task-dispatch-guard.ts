import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { tool, type Hooks, type Plugin } from "@opencode-ai/plugin"
import { COUNCIL_LIMITS } from "./limits.ts"
import { parseDebateArguments } from "./debate.ts"
import { DEBATE_REGISTRY, type DebateRegistry } from "./participants.ts"
import { runResponseFormatter } from "./response-formatter.ts"
import { CouncilStateStore, abortMarkdown, abortRun, allValidated, assertLive, digest, type Dispatch, type RunState } from "./council-state.ts"
import { validateCouncilReport } from "./report.ts"

export const TASK_DISPATCH_MARKER = "DEBATE_DISPATCH"
export type TaskDispatchPurpose = Dispatch["purpose"]
export type TaskDispatchMarker = { purpose: TaskDispatchPurpose; participant: number; round: number; subagentType: string }
const MARKER = /^\[DEBATE_DISPATCH purpose=(normal|retry|formatter-correction) participant=([1-3]) round=([1-9][0-9]*) subagent_type=([^\s\]]+)\]$/
const TASK = /^<task id="([^"]+)" state="(running|completed|error)">[\s\S]*<task_(result|error)>\s*([\s\S]*?)\s*<\/task_\3>[\s\S]*<\/task>$/
export function parseTaskDispatchMarker(prompt: unknown): TaskDispatchMarker | undefined {
  if (typeof prompt !== "string" || !prompt.startsWith("[DEBATE_DISPATCH")) return undefined
  const m = MARKER.exec(prompt.split(/\r?\n/, 1)[0])
  if (!m) throw new Error("dispatch marker is malformed")
  return { purpose: m[1] as TaskDispatchPurpose, participant: +m[2], round: +m[3], subagentType: m[4] }
}
function taskResult(output: string, metadata?: Record<string, unknown>) {
  const m = TASK.exec(output.trim())
  const metadataID = metadata?.sessionId ?? metadata?.sessionID
  if (m && metadataID && m[1] !== metadataID) throw new Error("task child session ID mismatch")
  return { taskID: typeof metadataID === "string" ? metadataID : m?.[1],
    status: m?.[2] === "running" ? "active" : m?.[2] === "completed" && m[3] === "result" && m[4].trim() ? "completed" : "failed",
    raw: m?.[4].trim() ?? "" } as { taskID?: string; status: Dispatch["status"]; raw: string }
}
type Message = { info: { id: string; role: string; finish?: string }; parts: Array<any> }
export type GuardOptions = {
  registry?: DebateRegistry; store?: CouncilStateStore; runId?: string; deadlineMs?: number
  loadMessages?: (sessionID: string) => Promise<Message[]>
  cancelSession?: (sessionID: string) => Promise<unknown>
  parentSession?: (sessionID: string) => Promise<string | undefined>
}
export function createTaskDispatchGuard(options: GuardOptions = {}) {
  const registry = options.registry ?? DEBATE_REGISTRY
  const store = options.store ?? new CouncilStateStore()
  const configuredRunId = options.runId ?? process.env.COUNCIL_RUN_ID
  const runs = new Map<string, string>()
  const invalidSessions = new Set<string>()
  const rawResults = new Map<string, string>()
  const canonicalResults = new Map<string, string>()
  const formatCalls = new Map<string, string>()
  const key = (sessionID: string, p: number, r: number) => sessionID + ":" + p + ":" + r
  function find(sessionID: string): string | undefined {
    const cached = runs.get(sessionID)
    if (cached) return cached
    const id = store.find(sessionID)
    if (id) runs.set(sessionID, id)
    return id
  }
  function reject(state: RunState, reason: string, p?: number, round?: number): never {
    abortRun(state, reason, p, round)
    throw new Error("Council aborted: " + reason)
  }
  async function mutation<T>(id: string, fn: (state: RunState) => T): Promise<T> {
    try { return store.update(id, fn) }
    finally {
      const state = store.read(id)
      if (state.status === "aborted" && options.cancelSession) {
        for (const taskID of new Set(state.dispatches.filter(d => d.status === "active").map(d => d.taskID).filter(Boolean))) {
          try { await options.cancelSession(taskID!) } catch { /* The persisted abort remains authoritative. */ }
        }
      }
    }
  }
  async function hydrate(state: RunState) {
    if (!options.loadMessages) return
    const messages = await options.loadMessages(state.sessionID)
    const parts = messages.flatMap(m => m.parts).filter(p => p.type === "tool" && p.state?.status === "completed")
    for (const d of state.dispatches) {
      if (d.status !== "completed" || rawResults.has(d.callID)) continue
      const part = parts.find(p => p.callID === d.callID && p.tool === "task")
      if (part) {
        const result = taskResult(part.state.output, part.state.metadata)
        if (result.status === "completed" && digest(result.raw) === d.outputDigest) rawResults.set(d.callID, result.raw)
      }
    }
    for (const [turn, v] of Object.entries(state.validated)) {
      const part = parts.find(p => p.callID === v.formatterCallID && p.tool === "format_debate_response")
      if (part && digest(part.state.output) === v.digest) canonicalResults.set(state.sessionID + ":" + turn, part.state.output)
    }
  }
  async function completeTask(sessionID: string, callID: string, output: string, metadata?: Record<string, unknown>, forcedError = false) {
    const id = find(sessionID)
    if (!id) return
    await mutation(id, state => {
      const record = state.dispatches.find(d => d.callID === callID)
      if (!record || state.status === "aborted" || state.status === "completed") return
      assertLive(state)
      let result: ReturnType<typeof taskResult>
      try { result = taskResult(output, metadata) } catch { reject(state, "task child session ID mismatch", record.participant, record.round) }
      if (record.taskID && result.taskID && record.taskID !== result.taskID) reject(state, "task_id changed for an admitted dispatch", record.participant, record.round)
      if (result.taskID) { record.taskID = result.taskID; store.bindChild(result.taskID, id) }
      const status = forcedError ? "failed" : result.status
      if (record.status !== "active") {
        if (status !== "active" && status !== record.status) reject(state, "conflicting terminal task events", record.participant, record.round)
        return
      }
      record.status = status
      if (status === "completed") { record.outputDigest = digest(result.raw); rawResults.set(callID, result.raw) }
      else if (status === "failed" && (record.purpose === "retry" || !record.taskID)) reject(state, "participant task failed without an eligible retry", record.participant, record.round)
    })
  }
  const hooks: Hooks = {
    "experimental.text.complete": async (input, output) => {
      const id = find(input.sessionID)
      if (!id) return
      await mutation(id, state => {
        // Child output is evidence, not a coordinator report. It may legitimately
        // discuss/report the heading itself inside its requested JSON string.
        if (input.sessionID !== state.sessionID) return
        if (state.status === "aborted") { output.text = abortMarkdown(state); return }
        if (state.status === "completed") {
          if (state.reportMessageID === input.messageID && state.reportDigest === digest(output.text.trim())) return
          throw new Error("Council report has already completed")
        }
        if (!output.text.includes("## Council Report")) return
        try {
          assertLive(state, input.sessionID)
          if (state.status !== "ready" || !allValidated(state)) throw new Error("report attempted before every configured turn was canonical")
          const report = validateCouncilReport(output.text)
          state.reportMessageID = input.messageID
          state.reportDigest = digest(report)
          state.status = "completed"
          output.text = report
        } catch (error) {
          abortRun(state, error instanceof Error ? error.message : "invalid Council Report")
          output.text = abortMarkdown(state)
        }
      })
    },
    "command.execute.before": async (input) => {
      if (!["council", "debate"].includes(input.command)) return
      const parsed = parseDebateArguments(input.arguments, registry)
      if (!parsed.ok || !parsed.topic) { invalidSessions.add(input.sessionID); return }
      const runId = configuredRunId ?? randomUUID()
      const selected = registry.sets[registry.defaultSet]
      const snapshot = { participants: selected.map(agent => registry.participants.find(p => p.agent === agent)!), sets: { [registry.defaultSet]: [...selected] }, defaultSet: registry.defaultSet }
      const deadlineMs = options.deadlineMs ?? (process.env.COUNCIL_DEADLINE_MS ? Number(process.env.COUNCIL_DEADLINE_MS) : Date.now() + parsed.rounds * 300_000)
      if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now()) throw new Error("Council deadline expired or invalid")
      store.create({ version: 1, runId, sessionID: input.sessionID, deadlineMs, rounds: parsed.rounds, registry: snapshot,
        status: "active", dispatches: [], validated: {}, continuations: 0, continuedMessageIDs: [] })
      runs.set(input.sessionID, runId); invalidSessions.delete(input.sessionID)
    },
    "chat.params": async (input) => {
      let id = find(input.sessionID)
      if (!id && configuredRunId && existsSync(store.path(configuredRunId))) id = configuredRunId
      if (!id && options.parentSession && registry.participants.some(p => p.agent === input.agent)) {
        const parent = await options.parentSession(input.sessionID)
        if (parent) id = find(parent)
      }
      if (!id) {
        if (input.agent === "debate" || registry.participants.some(p => p.agent === input.agent)) throw new Error("Council model call has no valid safety state")
        return
      }
      await mutation(id, state => {
        if (input.agent === "debate") assertLive(state, input.sessionID)
        else if (state.registry.participants.some(p => p.agent === input.agent)) {
          assertLive(state)
          const active = state.dispatches.findLast(d => d.agent === input.agent && d.status === "active")
          if (!active) reject(state, "participant model call has no active admitted task")
          if (active.taskID && active.taskID !== input.sessionID) reject(state, "participant child session does not match admitted task", active.participant, active.round)
          active.taskID = input.sessionID
          store.bindChild(input.sessionID, id!)
        }
      })
    },
    "tool.execute.before": async (input, output) => {
      if (!["task", "format_debate_response", "question", "persist_debate_transcript"].includes(input.tool)) return
      const args = output.args as Record<string, any>
      const id = find(input.sessionID)
      if (!id) {
        if (invalidSessions.has(input.sessionID) || args.prompt?.startsWith?.("[DEBATE_DISPATCH") || registry.participants.some(p => p.agent === args.subagent_type)) throw new Error("Council dispatch has no valid parsed request")
        return
      }
      if (input.tool === "format_debate_response") {
        await mutation(id, state => {
          assertLive(state, input.sessionID)
          if (![1,2,3].includes(args.participant) || !Number.isInteger(args.round) || args.round < 1 || args.round > state.rounds) reject(state, "invalid formatter participant/round")
          const k = key(input.sessionID, args.participant, args.round)
          if (formatCalls.has(k)) reject(state, "duplicate active formatter call", args.participant, args.round)
          formatCalls.set(k, input.callID)
        }); return
      }
      if (input.tool !== "task") { await mutation(id, state => reject(state, "coordinator tool " + input.tool + " is forbidden")); return }
      const current = store.read(id)
      if (current.dispatches.length && canonicalResults.size === 0) await hydrate(current)
      await mutation(id, state => {
        assertLive(state, input.sessionID)
        let marker: TaskDispatchMarker | undefined
        try { marker = parseTaskDispatchMarker(args.prompt) } catch { reject(state, "dispatch marker is malformed") }
        if (!marker) reject(state, "structured dispatch marker is required")
        const {participant: p, round, purpose} = marker
        if (state.status === "ready" || round > state.rounds) reject(state, "configured round limit exhausted", p, round)
        const agent = state.registry.sets[state.registry.defaultSet][p - 1]
        if (marker.subagentType !== agent || (args.subagent_type !== undefined && args.subagent_type !== agent)) reject(state, "resolved participant mapping mismatch", p, round)
        // OpenCode task's selector may be omitted. Resolve only from the already
        // validated slot, never from an arbitrary model-supplied default.
        args.subagent_type = agent
        if (state.dispatches.some(d => d.callID === input.callID)) throw new Error("duplicate dispatch call ID")
        const history = state.dispatches.filter(d => d.participant === p && d.round === round)
        const latest = history.at(-1)
        const child = state.dispatches.find(d => d.participant === p && d.taskID)?.taskID
        if (purpose === "normal" && round === 1) {
          if (args.task_id !== undefined) reject(state, "round 1 normal dispatch must omit task_id", p, round)
        } else if (!child || args.task_id !== child) reject(state, "task_id continuity mismatch", p, round)
        if (history.some(d => d.status === "active")) reject(state, "duplicate active participant dispatch", p, round)
        if (purpose === "normal") {
          if (history.length) reject(state, "duplicate normal dispatch; use the eligible retry or correction", p, round)
          if (round > 1) {
            for (let previous = 1; previous < round; previous++) for (let other = 1; other <= 3; other++) {
              if (!state.validated[other + ":" + previous]) reject(state, "previous round is not fully canonical", p, round)
            }
            const peers = [1,2,3].filter(other => other !== p).map(other => {
              const canonical = canonicalResults.get(key(state.sessionID, other, round - 1))
              if (!canonical || digest(canonical) !== state.validated[other + ":" + (round-1)]?.digest) reject(state, "canonical peer evidence unavailable", p, round)
              return { participant: other, turn_response: JSON.parse(canonical) }
            })
            args.prompt += "\n\nVerified previous-round peer turns (authoritative, appended by runtime):\n" + JSON.stringify({other_participants: peers})
          }
        } else if (purpose === "retry") {
          if (latest?.status !== "failed" || history.some(d => d.purpose === "retry")) reject(state, "only one retry after a recorded task failure is allowed", p, round)
        } else {
          if (latest?.status !== "completed" || !latest.formatFailed) reject(state, "formatter correction requires a recorded validation failure", p, round)
          if (history.filter(d => d.purpose === "formatter-correction").length >= COUNCIL_LIMITS.maxFormatCorrections) reject(state, "format correction budget exhausted", p, round)
        }
        if (state.dispatches.length >= COUNCIL_LIMITS.maxTaskDispatches) reject(state, "participant dispatch budget exhausted", p, round)
        state.dispatches.push({ callID: input.callID, participant: p, round, purpose, agent, status: "active", ...(child ? {taskID: child} : {}) })
      })
    },
    "tool.execute.after": async (input, output) => {
      if (input.tool === "task") await completeTask(input.sessionID, input.callID, output.output, output.metadata)
    },
    event: async ({event}) => {
      if (event.type !== "message.part.updated") return
      const part = event.properties.part
      if (part.type !== "tool" || part.tool !== "task") return
      if (part.state.status === "completed") await completeTask(part.sessionID, part.callID, part.state.output, part.state.metadata)
      else if (part.state.status === "error") await completeTask(part.sessionID, part.callID, part.state.error, part.state.metadata, true)
      else if (part.state.status === "running") {
        const id = find(part.sessionID)
        const child = part.state.metadata?.sessionId ?? part.state.metadata?.sessionID
        if (id && typeof child === "string") await mutation(id, state => {
          if (state.status === "aborted" || state.status === "completed") return
          assertLive(state)
          const record = state.dispatches.find(d => d.callID === part.callID)
          if (record?.status === "active") {
            if (record.taskID && record.taskID !== child) reject(state, "task child session ID mismatch", record.participant, record.round)
            record.taskID = child
            store.bindChild(child, id)
          }
        })
      }
    },
    dispose: async () => { store.dispose() },
  }
  const formatter = tool({
    description: "Validate the actual completed participant result. Supply participant (1–3) and round only; do not rewrite or copy its JSON. Runtime returns the canonical turn.",
    args: { participant: tool.schema.number().int().min(1).max(3), round: tool.schema.number().int().min(1).max(3) },
    async execute({participant, round}, context) {
      const id = find(context.sessionID)
      if (!id) throw new Error("Formatter has no Council safety state")
      const k = key(context.sessionID, participant, round)
      const callID = formatCalls.get(k)
      if (!callID) throw new Error("Formatter admission is missing")
      const current = store.read(id)
      const latest = current.dispatches.filter(d => d.participant === participant && d.round === round).at(-1)
      if (latest && !rawResults.has(latest.callID)) await hydrate(current)
      try {
        return await mutation(id, state => {
          assertLive(state, context.sessionID)
          const record = state.dispatches.filter(d => d.participant === participant && d.round === round).at(-1)
          if (!record || record.status !== "completed") reject(state, "formatter requires a completed actual task", participant, round)
          if (record.formatFailed) throw new Error("This result already failed validation; return the diagnostic to the original participant")
          const raw = rawResults.get(record.callID)
          if (!raw || digest(raw) !== record.outputDigest) reject(state, "actual participant evidence unavailable", participant, round)
          let canonical: string
          try {
            // Legacy standalone formatter may extract/normalise old transcripts. Live
            // Council participants must supply actual valid JSON, never repaired by us.
            JSON.parse(raw)
            canonical = runResponseFormatter(raw, round === 1 ? "round1" : "round2")
          }
          catch (error) {
            record.formatFailed = true
            if (state.dispatches.filter(d => d.participant === participant && d.round === round && d.purpose === "formatter-correction").length >= 2) abortRun(state, "participant exhausted format corrections", participant, round)
            throw error
          }
          state.validated[participant + ":" + round] = { callID: record.callID, formatterCallID: callID, digest: digest(canonical) }
          canonicalResults.set(k, canonical)
          if (allValidated(state)) state.status = "ready"
          return canonical
        })
      } finally { formatCalls.delete(k) }
    },
  })
  return { hooks, formatter, store, getState(sessionID: string) { const id = find(sessionID); return id ? store.read(id) : undefined }, clear() { store.dispose(); runs.clear(); rawResults.clear(); canonicalResults.clear(); formatCalls.clear() } }
}
export const TaskDispatchGuardPlugin: Plugin = async () => createTaskDispatchGuard().hooks
