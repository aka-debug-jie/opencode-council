import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { createDebatePlugin } from "./src/debate.ts"
import {
  DEBATE_PARTICIPANTS,
  loadEffectiveRegistry,
  type DebateParticipant,
  type DebateRegistry,
} from "./src/participants.ts"
import { ResponseFormatterPlugin } from "./src/response-formatter.ts"
import { createTaskDispatchGuard } from "./src/task-dispatch-guard.ts"
import { PERSIST_DEBATE_TRANSCRIPT_TOOL } from "./src/transcript-persistence.ts"
import { COUNCIL_LIMITS } from "./src/limits.ts"

export { buildCoordinatorPrompt, COORDINATOR_PROMPT } from "./src/coordinator-prompt.ts"
import { buildCoordinatorPrompt } from "./src/coordinator-prompt.ts"
import { CouncilStateStore, assertLive } from "./src/council-state.ts"
import { existsSync } from "node:fs"

export const PARTICIPANT_PROMPT = `You are a neutral council participant providing an independent second opinion to a stronger main coding model. Be concise; evidence matters more than consensus. Identify questionable assumptions, missed risks, and evidence that could falsify your recommendation. In later rounds, challenge concrete peer claims and preserve unresolved disagreement. Use only read, grep, glob, and lsp when needed. Do not edit, use shell commands, browse the web, spawn subagents, invoke skills, or ask the user questions. Return only the requested JSON object; do not wrap it in a code fence.`

export const PARTICIPANT_PERMISSION = {
  "*": "deny" as const,
  read: {
    "*": "allow" as const,
    "*.env": "deny" as const,
    "*.env.*": "deny" as const,
    "*.env.example": "allow" as const,
  },
  grep: "allow" as const,
  glob: "allow" as const,
  lsp: "allow" as const,
  webfetch: "deny" as const,
  websearch: "deny" as const,
  external_directory: "deny" as const,
  bash: "deny" as const,
  edit: "deny" as const,
  question: "deny" as const,
  task: "deny" as const,
  skill: "deny" as const,
}

export type PermissionAction = "allow" | "ask" | "deny"
export type TaskPermission = PermissionAction | Record<string, PermissionAction>
export type PermissionConfiguration = PermissionAction | Record<string, unknown>

export function participantTaskDenials(
  existing: TaskPermission | undefined,
  participants: readonly DebateParticipant[] = DEBATE_PARTICIPANTS,
): Record<string, PermissionAction> {
  const participantNames = new Set(participants.map(({ agent }) => agent))
  const retained: [string, PermissionAction][] = typeof existing === "object"
    ? Object.entries(existing).filter(([pattern]) => !participantNames.has(pattern))
    : existing === undefined
      ? []
      : [["*", existing]]
  return Object.fromEntries([
    ...retained,
    ...participants.map(({ agent }) => [agent, "deny"] as const),
  ])
}

export function denyParticipantTasks(
  permission: PermissionConfiguration | undefined,
  participants: readonly DebateParticipant[] = DEBATE_PARTICIPANTS,
): Record<string, unknown> {
  const normalised: Record<string, unknown> = typeof permission === "object" && permission !== null
    ? permission
    : permission === undefined
      ? {}
      : { "*": permission }
  return {
    ...normalised,
    task: participantTaskDenials(normalised.task as TaskPermission | undefined, participants),
  }
}

export function participantTaskPermission(
  participants: readonly DebateParticipant[] = DEBATE_PARTICIPANTS,
): Record<string, "allow" | "deny"> {
  return Object.fromEntries([
    ["*", "deny"],
    ...participants.map(({ agent }) => [agent, "allow"] as const),
  ])
}

export function coordinatorPermission(
  participants: readonly DebateParticipant[] = DEBATE_PARTICIPANTS,
) {
  return {
    "*": "deny" as const,
    external_directory: "deny" as const,
    [PERSIST_DEBATE_TRANSCRIPT_TOOL]: "deny" as const,
    question: "deny" as const,
    format_debate_response: "allow" as const,
    task: participantTaskPermission(participants),
  }
}

export function createServer(loadRegistry: () => DebateRegistry = loadEffectiveRegistry, stateStore?: CouncilStateStore): Plugin {
  return async (input, options) => {
    const store = stateStore ?? new CouncilStateStore()
    let registry: DebateRegistry
    try {
      registry = loadRegistry()
      const runId = process.env.COUNCIL_RUN_ID
      if (runId && (process.env.COUNCIL_RESUME === "1" || existsSync(store.path(runId)))) {
        const snapshot = store.read(runId)
        assertLive(snapshot)
        registry = snapshot.registry
      } else if (process.env.COUNCIL_RESUME === "1") throw new Error("Council continuation requires a run ID and safety state")
      const selected = registry.sets[registry.defaultSet]
      registry = { participants: selected.map(agent => registry.participants.find(p => p.agent === agent)!), sets: { [registry.defaultSet]: selected }, defaultSet: registry.defaultSet }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        await input.client.app.log({
          body: {
            service: "opencode-council",
            level: "error",
            message,
          },
        })
      } catch {
        // Preserve the actionable configuration error if server logging is unavailable.
      }
      throw error
    }

    const debateHooks = await createDebatePlugin(registry)(input, options)
    const responseFormatterHooks = await ResponseFormatterPlugin(input, options)
    const taskDispatchGuard = createTaskDispatchGuard({ registry, store,
      loadMessages: async sessionID => {
        const result = await input.client.session.messages({ path: {id: sessionID} })
        if (!result.data) throw new Error("Cannot recover Council evidence from session")
        return result.data
      },
      cancelSession: async sessionID => input.client.session.abort({ path: {id: sessionID} }),
      parentSession: async sessionID => (await input.client.session.get({path:{id: sessionID}})).data?.parentID,
    })

    return {
      ...debateHooks,
      ...responseFormatterHooks,
      ...taskDispatchGuard.hooks,
      tool: { format_debate_response: taskDispatchGuard.formatter },
      "command.execute.before": async (input, output) => {
        await debateHooks["command.execute.before"]?.(input, output)
        await taskDispatchGuard.hooks["command.execute.before"]?.(input, output)
      },
      config: async (config) => {
        config.permission = denyParticipantTasks(
          config.permission as PermissionConfiguration | undefined,
          registry.participants,
        ) as typeof config.permission
        if (!config.agent) config.agent = {}
        if (!config.command) config.command = {}

        for (const [agentName, agentConfig] of Object.entries(config.agent)) {
          if (agentName === "debate" || agentConfig === undefined) continue
          agentConfig.permission = denyParticipantTasks(
            agentConfig.permission as PermissionConfiguration | undefined,
            registry.participants,
          ) as typeof agentConfig.permission
        }

        config.command.debate = {
          template: "$ARGUMENTS",
          description: "Run bounded multi-model council",
          agent: "debate",
        }
        config.command.council = {
          template: "$ARGUMENTS",
          description: "Run bounded multi-model council",
          agent: "debate",
        }

        config.agent.debate = {
          description: "Coordinates visible debates using participant subagents with self-contained per-round context",
          mode: "primary",
          model: "opencode-go/gpt-5.6-luna",
          prompt: buildCoordinatorPrompt(registry.participants),
          hidden: true,
          permission: coordinatorPermission(registry.participants),
        } as any

        for (const participant of registry.participants) {
          config.agent[participant.agent] = {
            description: participant.description,
            mode: "subagent",
            model: participant.model,
            prompt: PARTICIPANT_PROMPT,
            hidden: true,
            steps: COUNCIL_LIMITS.participantSteps,
            permission: PARTICIPANT_PERMISSION,
            ...(participant.variant === undefined ? {} : { variant: participant.variant }),
          } as any
        }

        await responseFormatterHooks.config?.(config)
        config.agent.debate!.permission = coordinatorPermission(registry.participants) as any
      },
    }
  }
}

const installedProjects = new Set<string>()
const installServer = createServer()
// The global wrapper and a checkout's local bridge may both be discovered.
// One controller must own admission; never register the same hooks twice.
export const server: Plugin = async (input, options) => {
  const key = input.directory ?? input.worktree ?? "default"
  if (installedProjects.has(key)) return {}
  installedProjects.add(key)
  try {
    const hooks = await installServer(input, options)
    return { ...hooks, dispose: async () => {
      try { await hooks.dispose?.() } finally { installedProjects.delete(key) }
    } }
  } catch (error) { installedProjects.delete(key); throw error }
}

const plugin: PluginModule = {
  id: "opencode-council",
  server,
}

export default plugin
