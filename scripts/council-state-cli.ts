import { CouncilStateStore, abortMarkdown, abortRun, allValidated, assertLive } from "../src/council-state.ts"

const [action, runId, sessionID, messageID, reportDigest] = process.argv.slice(2)
const store = new CouncilStateStore()
try {
  if (!runId || !["inspect", "continue", "complete", "abort"].includes(action)) throw new Error("Expected inspect|continue|complete|abort RUN_ID [SESSION_ID] [MESSAGE_ID|REASON]")
  const result = store.update(runId, state => {
    if (sessionID && state.sessionID !== sessionID) throw new Error("Council session does not match safety state")
    if (action === "inspect") return state
    if (action === "abort") { abortRun(state, messageID ?? "Council runner failed"); return abortMarkdown(state) }
    if (action === "complete") {
      if (!messageID || !reportDigest || !/^[a-f0-9]{64}$/.test(reportDigest)) throw new Error("Report completion requires message ID and SHA-256")
      if (state.reportMessageID && state.reportMessageID !== messageID) throw new Error("Report message does not match persisted completion")
      if (state.reportDigest && state.reportDigest !== reportDigest) throw new Error("Report content does not match persisted completion")
      if (state.status === "completed" && allValidated(state)) return state
    }
    assertLive(state)
    if (action === "complete") {
      if (state.status !== "ready" || !allValidated(state)) throw new Error("Council cannot complete before every configured turn is validated")
      state.status = "completed"
      state.reportMessageID = messageID
      state.reportDigest = reportDigest
      return state
    }
    if (!messageID) throw new Error("Continuation requires an assistant message ID")
    if (state.dispatches.some(d => d.status === "active")) throw new Error("Council has unresolved active dispatches; refusing continuation")
    if (state.continuedMessageIDs.includes(messageID)) throw new Error("Council assistant message was already continued")
    if (state.continuations >= 8) { abortRun(state, "Council exceeded eight coordinator continuations"); throw new Error("Council exceeded eight coordinator continuations") }
    state.continuations++
    state.continuedMessageIDs.push(messageID)
    return state
  })
  console.log(typeof result === "string" ? result : JSON.stringify(result))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally { store.dispose() }
