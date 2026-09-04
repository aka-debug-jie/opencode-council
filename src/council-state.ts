import { createHash, randomUUID } from "node:crypto"
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { DebateRegistry } from "./participants.ts"

export type Dispatch = {
  callID: string; participant: number; round: number; purpose: "normal" | "retry" | "formatter-correction"
  agent: string; taskID?: string; status: "active" | "completed" | "failed"; outputDigest?: string
  formatFailed?: boolean
}
export type RunState = {
  version: 1; runId: string; sessionID: string; deadlineMs: number; rounds: number; registry: DebateRegistry
  status: "active" | "ready" | "aborted" | "completed"; dispatches: Dispatch[]
  validated: Record<string, { callID: string; formatterCallID: string; digest: string }>
  continuations: number; continuedMessageIDs: string[]
  reportMessageID?: string; reportDigest?: string
  abort?: { reason: string; participant?: number; round?: number }
}

export function stateDirectory(): string {
  return process.env.COUNCIL_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode-council")
}
export function digest(text: string): string { return createHash("sha256").update(text).digest("hex") }
export function assertRunId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid Council run ID")
}
function processStart(pid: number): string {
  // Linux process start ticks disambiguate PID reuse; no timestamps or stale-TTL guesses.
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]
}
function isDead(owner: { pid: number; start: string }): boolean {
  try { return processStart(owner.pid) !== owner.start }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
    throw new Error("Cannot establish Council lease owner liveness", { cause: error })
  }
}
function atomicJSON(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  const fd = openSync(tmp, "wx", 0o600)
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd) }
  finally { closeSync(fd) }
  try {
    renameSync(tmp, path)
    const directory = openSync(dirname(path), "r")
    try { fsyncSync(directory) } finally { closeSync(directory) }
  }
  finally { if (existsSync(tmp)) unlinkSync(tmp) }
}
function validate(value: unknown, id: string): asserts value is RunState {
  const s = value as RunState
  if (!s || s.version !== 1 || s.runId !== id || typeof s.sessionID !== "string"
    || !Number.isFinite(s.deadlineMs) || ![1, 2, 3].includes(s.rounds)
    || !["active", "ready", "aborted", "completed"].includes(s.status)
    || !Array.isArray(s.dispatches) || s.dispatches.length > 12
    || !s.registry || !Array.isArray(s.registry.participants) || s.registry.participants.length !== 3
    || !s.validated || typeof s.validated !== "object" || Array.isArray(s.validated)
    || !Number.isInteger(s.continuations) || s.continuations < 0 || s.continuations > 8
    || !Array.isArray(s.continuedMessageIDs) || s.continuedMessageIDs.length !== s.continuations
    || new Set(s.continuedMessageIDs).size !== s.continuations || s.continuedMessageIDs.some(id => typeof id !== "string" || !id)
    || new Set(s.dispatches.map(d => d.callID)).size !== s.dispatches.length
    || s.dispatches.some(d => typeof d.callID !== "string" || ![1,2,3].includes(d.participant)
      || !Number.isInteger(d.round) || d.round < 1 || d.round > s.rounds
      || !["normal", "retry", "formatter-correction"].includes(d.purpose)
      || !["active", "completed", "failed"].includes(d.status)
      || (d.taskID !== undefined && (typeof d.taskID !== "string" || !d.taskID))
      || (d.status === "completed" && !/^[a-f0-9]{64}$/.test(d.outputDigest ?? "")))
    || (s.status === "aborted" && !s.abort?.reason)) throw new Error("Council safety state is corrupt")
  const names = s.registry.sets[s.registry.defaultSet]
  if (!names || names.length !== 3 || new Set(names).size !== 3 || names.some(n => !s.registry.participants.some(p => p.agent === n))) {
    throw new Error("Council registry snapshot is corrupt")
  }
  if (s.registry.participants.some(p => typeof p.agent !== "string" || !p.agent || typeof p.model !== "string" || !p.model)
    || s.dispatches.some(d => d.agent !== names[d.participant - 1])
    || Object.entries(s.validated).some(([key,v]) => !/^[1-3]:[1-3]$/.test(key) || !v || !v.callID || !v.formatterCallID || !/^[a-f0-9]{64}$/.test(v.digest))) {
    throw new Error("Council safety state contains invalid task or validation records")
  }
}

/** One process owns each run for its lifetime. All methods are synchronous, so event
 * updates are serialized in-process. Atomic replacement makes readers see whole snapshots. */
export class CouncilStateStore {
  readonly directory: string
  private leases = new Map<string, string>()
  constructor(directory = stateDirectory()) { this.directory = directory }
  path(id: string): string { assertRunId(id); return join(this.directory, `${id}.json`) }
  read(id: string): RunState {
    let value: unknown
    try { value = JSON.parse(readFileSync(this.path(id), "utf8")) }
    catch (error) { throw new Error("Council safety state is missing or unreadable", { cause: error }) }
    validate(value, id)
    return value
  }
  find(sessionID: string): string | undefined {
    const path = join(this.directory, `session-${digest(sessionID)}.json`)
    if (!existsSync(path)) return undefined
    const data = JSON.parse(readFileSync(path, "utf8"))
    assertRunId(data.runId)
    return data.runId
  }
  bindChild(sessionID: string, runId: string): void {
    this.acquire(runId)
    const previous = this.find(sessionID)
    if (previous && previous !== runId) throw new Error("Child session already belongs to another Council run")
    atomicJSON(join(this.directory, `session-${digest(sessionID)}.json`), {runId})
  }
  acquire(id: string): void {
    if (this.leases.has(id)) return
    this.path(id)
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const lease = join(this.directory, `${id}.lease`)
    const token = randomUUID()
    const claim = () => {
      mkdirSync(lease, { mode: 0o700 })
      atomicJSON(join(lease, "owner.json"), { pid: process.pid, start: processStart(process.pid), token })
      this.leases.set(id, token)
    }
    try { claim(); return }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error }
    // Reclaim only under an exclusive recovery lock, and only from a proven dead PID.
    const recovery = `${lease}.recover`
    mkdirSync(recovery, { mode: 0o700 })
    try {
      let owner
      try { owner = JSON.parse(readFileSync(join(lease, "owner.json"), "utf8")) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        // A contender may have released its lease after our failed mkdir, or
        // may still be publishing its owner record. Only the former is claimable.
        if (!existsSync(lease)) { claim(); return }
        throw new Error("Council lease acquisition is in progress; refusing takeover")
      }
      if (!Number.isInteger(owner.pid) || typeof owner.start !== "string" || !isDead(owner)) {
        throw new Error("Council run is still owned by another live process")
      }
      unlinkSync(join(lease, "owner.json")); rmdirSync(lease)
      claim()
    } finally { rmdirSync(recovery) }
  }
  release(id: string): void {
    const token = this.leases.get(id)
    if (!token) return
    const lease = join(this.directory, `${id}.lease`)
    const owner = JSON.parse(readFileSync(join(lease, "owner.json"), "utf8"))
    if (owner.token !== token) throw new Error("Council lease ownership changed")
    unlinkSync(join(lease, "owner.json")); rmdirSync(lease); this.leases.delete(id)
  }
  dispose(): void { for (const id of this.leases.keys()) this.release(id) }
  create(state: RunState): void {
    this.acquire(state.runId)
    if (existsSync(this.path(state.runId))) throw new Error("Council run ID already exists; refusing budget reset")
    validate(state, state.runId)
    const old = this.find(state.sessionID)
    if (old && !["completed", "aborted"].includes(this.read(old).status)) throw new Error("Council session has an unfinished run")
    atomicJSON(this.path(state.runId), state)
    atomicJSON(join(this.directory, `session-${digest(state.sessionID)}.json`), { runId: state.runId })
  }
  update<T>(id: string, fn: (state: RunState) => T): T {
    this.acquire(id)
    const state = this.read(id)
    try { return fn(state) }
    finally { validate(state, id); atomicJSON(this.path(id), state) }
  }
}

export function abortRun(state: RunState, reason: string, participant?: number, round?: number): void {
  if (state.status === "aborted") return
  if (state.status === "completed") throw new Error("Council run has already completed")
  state.status = "aborted"
  state.abort = { reason, ...(participant === undefined ? {} : {participant}), ...(round === undefined ? {} : {round}) }
}
export function assertLive(state: RunState, sessionID = state.sessionID): void {
  if (state.sessionID !== sessionID) throw new Error("Council session does not match safety state")
  if (state.status === "aborted" || state.status === "completed") throw new Error(`Council run is ${state.status}`)
  if (Date.now() >= state.deadlineMs) { abortRun(state, "Council deadline exhausted"); throw new Error("Council deadline exhausted") }
}
export function allValidated(state: RunState): boolean {
  for (let round = 1; round <= state.rounds; round++) for (let p = 1; p <= 3; p++) {
    const v = state.validated[`${p}:${round}`]
    const d = v && state.dispatches.find(d => d.callID === v.callID)
    if (!d || d.participant !== p || d.round !== round || d.status !== "completed" || !v.digest || !v.formatterCallID) return false
  }
  return !state.dispatches.some(d => d.status === "active")
}
export function abortMarkdown(state: RunState): string {
  return `## Council Abort\n\nReason: ${state.abort?.reason ?? "Council did not finish"}\nParticipant: ${state.abort?.participant ?? "n/a"}\nRound: ${state.abort?.round ?? "n/a"}\nCompleted turns: ${Object.keys(state.validated).sort().join(", ") || "none"}\n`
}
