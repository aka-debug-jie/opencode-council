import type { Plugin } from "@opencode-ai/plugin"
import type { Part, TextPart } from "@opencode-ai/sdk"
import { COUNCIL_LIMITS } from "./limits.ts"
import { DEBATE_PARTICIPANT_SETS, DEBATE_REGISTRY, type DebateParticipantSets, type DebateRegistry } from "./participants.ts"

type ParsedDebateArguments =
  | { ok: true; topic: string; rounds: number }
  | { ok: false; error: string }

function resolvedParticipants(sets: DebateParticipantSets, registry: DebateRegistry): string[] {
  return sets[registry.defaultSet].map((participant, index) => `Participant ${index + 1}: ${participant}`)
}

export function parseDebateArguments(args: string, _registry: DebateRegistry = DEBATE_REGISTRY): ParsedDebateArguments {
  args = trimSurroundingQuotes(args)
  let index = 0
  let rounds: number = COUNCIL_LIMITS.defaultRounds
  let roundsSeen = false

  while (index < args.length) {
    while (index < args.length && /\s/.test(args[index])) index++
    if (index >= args.length) break

    const tokenStart = index
    while (index < args.length && !/\s/.test(args[index])) index++
    const token = args.slice(tokenStart, index)
    if (token === "--") {
      while (index < args.length && /\s/.test(args[index])) index++
      return { ok: true, topic: args.slice(index).trim(), rounds }
    }
    if (token === "--rounds" || token.startsWith("--rounds=")) {
      let value: string
      if (token === "--rounds") {
        while (index < args.length && /\s/.test(args[index])) index++
        if (index >= args.length) return { ok: false, error: `--rounds requires an integer between 1 and ${COUNCIL_LIMITS.maxRounds}.` }
        const valueStart = index
        while (index < args.length && !/\s/.test(args[index])) index++
        value = args.slice(valueStart, index)
      } else {
        value = token.slice("--rounds=".length)
      }
      const numeric = Number(value)
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(numeric) || numeric < 1 || numeric > COUNCIL_LIMITS.maxRounds) {
        return { ok: false, error: `--rounds must be an integer between 1 and ${COUNCIL_LIMITS.maxRounds}.` }
      }
      if (roundsSeen) return { ok: false, error: "--rounds may only be specified once." }
      rounds = numeric
      roundsSeen = true
      continue
    }
    if (token.startsWith("--")) {
      return { ok: false, error: `Unsupported option: ${token}. Supported options: --rounds <1-${COUNCIL_LIMITS.maxRounds}>.` }
    }
    return { ok: true, topic: args.slice(tokenStart).trim(), rounds }
  }
  return { ok: true, topic: "", rounds }
}

export function trimSurroundingQuotes(args: string): string {
  const trimmed = args.trim()
  if (trimmed.length < 2) return trimmed
  const first = trimmed[0]
  const last = trimmed.at(-1)
  return (first === '"' && last === '"') || (first === "'" && last === "'") ? trimmed.slice(1, -1) : trimmed
}

function randomDelimiter(): string {
  return Math.random().toString(36).slice(2, 10)
}

export function validPrompt(
  topic: string,
  rounds: number,
  token: string = randomDelimiter(),
  registry: DebateRegistry = DEBATE_REGISTRY,
  sets: DebateParticipantSets = registry.sets,
): string {
  if (topic === "") return ["No council topic was provided.", "", "Ask the user for a topic and do not start participant subagents."].join("\n")
  return [
    "Run a bounded council with this parsed request.", "", "Topic:", `BEGIN TOPIC ${token}`, topic, `END TOPIC ${token}`, "",
    `Maximum rounds: ${rounds}`, "Resolved participants:", ...resolvedParticipants(sets, registry), "",
    "The command arguments have already been parsed and validated. Do not re-parse slash-command flags.",
    "Use the resolved participants exactly as listed for every round. After the configured final round is validated, return the advisory Council Report; never ask for or run extension rounds.",
  ].join("\n")
}

export function errorPrompt(error: string): string {
  return ["The /council command arguments are invalid.", "", "Error:", error, "", "Explain this error to the user and do not start participant subagents."].join("\n")
}

export function replaceParts(output: { parts: Part[] }, text: string) {
  const existing = output.parts.find((part): part is TextPart => part.type === "text")
  output.parts.length = 0
  output.parts.push(existing ? { ...existing, text, synthetic: true } : { type: "text", text, synthetic: true } as TextPart)
}

export function createDebatePlugin(registry: DebateRegistry): Plugin {
  return async () => ({
    "command.execute.before": async (input, output) => {
      if (input.command !== "debate" && input.command !== "council") return
      const parsed = parseDebateArguments(input.arguments, registry)
      replaceParts(output, parsed.ok ? validPrompt(parsed.topic, parsed.rounds, randomDelimiter(), registry) : errorPrompt(parsed.error))
    },
  })
}

export const DebatePlugin: Plugin = createDebatePlugin(DEBATE_REGISTRY)
