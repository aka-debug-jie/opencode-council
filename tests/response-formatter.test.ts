import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"
import {
  FORMAT_DEBATE_RESPONSE_TOOL,
  ResponseFormatterPlugin,
  responseFormatterScriptPath,
  runResponseFormatter,
} from "../src/response-formatter.ts"
import { createServer } from "../index.ts"
import { CouncilStateStore } from "../src/council-state.ts"
import { limitCanonicalTurn } from "../src/response-formatter.ts"
import type { DebateRegistry } from "../src/participants.ts"

const TEST_REGISTRY: DebateRegistry = {
  participants: [
    { agent: "one", description: "One", model: "provider/one" },
    { agent: "two", description: "Two", model: "provider/two" },
    { agent: "three", description: "Three", model: "provider/three" },
  ],
  sets: { default: ["one", "two", "three"] },
  defaultSet: "default",
}

function finalMatchingAction(
  permission: Record<string, string>,
  toolName: string,
): string | undefined {
  let action: string | undefined
  for (const [pattern, candidate] of Object.entries(permission)) {
    if (pattern === "*" || pattern === toolName) action = candidate
  }
  return action
}

async function applyRuntimeConfig(config: any): Promise<any> {
  const hooks = await createServer(() => TEST_REGISTRY)({
    client: { app: { log: async () => ({ data: true }) } },
    directory: "/tmp/project",
    worktree: "/tmp/project",
  } as never)
  const configHook = hooks.config
  assert.ok(configHook)
  await configHook(config)
  return config
}

test("formatter script resolves relative to the installed package module", () => {
  assert.equal(
    responseFormatterScriptPath("file:///opt/opencode-debate/src/response-formatter.ts"),
    "/opt/opencode-debate/scripts/format_response.py",
  )
})

test("formatter wrapper sends the response through stdin and returns canonical JSON", () => {
  assert.equal(
    runResponseFormatter('prefix {"turn":"line 1\\nline 2"} suffix', "round1"),
    '{"turn": "line 1\\nline 2"}',
  )
})

test("formatter wrapper repairs literal control characters inside strings", () => {
  const turn = "line 1\nline 2\r\t\b\f\u0000\u0001\u001f"

  assert.equal(
    runResponseFormatter(`{"turn":"${turn}"}`, "round1"),
    `{"turn": ${JSON.stringify(turn)}}`,
  )
})

test("formatter wrapper propagates strict formatter diagnostics", () => {
  assert.throws(
    () => runResponseFormatter('{"turn":""}', "round1"),
    /format_response: turn must be a non-empty string/,
  )
})

test("formatter wrapper reports when python3 is unavailable", (t) => {
  const emptyPath = mkdtempSync(join(tmpdir(), "debate-no-python-"))
  t.after(() => rmSync(emptyPath, { recursive: true, force: true }))

  assert.throws(
    () => runResponseFormatter('{"turn":"valid"}', "round1", {
      env: { ...process.env, PATH: emptyPath },
    }),
    /python3.*PATH/i,
  )
})

test("formatter wrapper bounds a hung subprocess without a model retry", (t) => {
  const bin=mkdtempSync(join(tmpdir(),"council-hung-formatter-"))
  t.after(()=>rmSync(bin,{recursive:true,force:true}))
  const fakePython=join(bin,"python3")
  writeFileSync(fakePython,"#!/bin/sh\nexec /bin/sleep 10\n")
  chmodSync(fakePython,0o755)
  assert.throws(()=>runResponseFormatter('{"turn":"valid"}',"round1",{env:{...process.env,PATH:bin},timeoutMs:30}),/ETIMEDOUT/)
})

test("formatter wrapper invokes python3 directly without a shell", (t) => {
  const root = mkdtempSync(join(tmpdir(), "debate-no-shell-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, "bin")
  const marker = join(root, "shell-injected")
  mkdirSync(bin)
  const fakePython = join(bin, "python3")
  writeFileSync(fakePython, "#!/bin/sh\nprintf '%s\\n' '{\"turn\": \"safe\"}'\n")
  chmodSync(fakePython, 0o755)
  const dangerousModuleUrl = pathToFileURL(
    join(root, "plugin;touch${IFS}$FORMATTER_MARKER;#", "src", "response-formatter.ts"),
  ).href

  const output = runResponseFormatter('{"turn":"safe"}', "round1", {
    moduleUrl: dangerousModuleUrl,
    env: {
      ...process.env,
      PATH: bin,
      FORMATTER_MARKER: marker,
    },
  })

  assert.equal(output, '{"turn": "safe"}')
  assert.equal(existsSync(marker), false)
})

test("response formatter plugin registers an executable custom tool", async () => {
  const hooks = await ResponseFormatterPlugin({} as never)
  const formatter = hooks.tool?.[FORMAT_DEBATE_RESPONSE_TOOL]
  assert.ok(formatter)

  assert.equal(
    await formatter.execute({ response: '{"turn":"plugin"}', schema: "round1" }, {} as never),
    '{"turn": "plugin"}',
  )
})

test("project-local plugin bridge satisfies the OpenCode v1.17.13 file-plugin loader", (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "council-bridge-state-"))
  t.after(() => rmSync(stateDir, {recursive:true, force:true}))
  const pluginUrl = new URL("../.opencode/plugin/debate.ts", import.meta.url).href
  const script = [
    `const bridge = await import(${JSON.stringify(pluginUrl)})`,
    "const seen = new Set()",
    "const plugins = []",
    "for (const entry of Object.values(bridge)) {",
    "  if (seen.has(entry)) continue",
    "  seen.add(entry)",
    "  const plugin = typeof entry === 'function'",
    "    ? entry",
    "    : entry && typeof entry === 'object' && typeof entry.server === 'function'",
    "      ? entry.server",
    "      : undefined",
    "  if (!plugin) throw new TypeError('Plugin export is not a function')",
    "  plugins.push(plugin)",
    "}",
    "const hooks = []",
    "for (const plugin of plugins) hooks.push(await plugin({}))",
    "if (!hooks.some((candidate) => candidate['command.execute.before'])) process.exit(1)",
    "if (!hooks.some((candidate) => candidate.tool?.format_debate_response)) process.exit(1)",
    "const output = { parts: [{ type: 'text', text: '' }] }",
    "for (const candidate of hooks) await candidate['command.execute.before']?.({ command: 'debate', sessionID: 'bridge-session', arguments: 'topic' }, output)",
    "const guard = hooks.find((candidate) => candidate['tool.execute.before'])",
    "if (!guard) process.exit(1)",
    "try {",
    "  await guard['tool.execute.before']({ tool: 'task', sessionID: 'bridge-session', callID: 'unmarked' }, { args: { prompt: 'ordinary task', subagent_type: 'general' } })",
    "  process.exit(2)",
    "} catch (error) {",
    "  if (!String(error).match(/dispatch marker.*required/i)) process.exit(3)",
    "}",
  ].join("\n")
  const result = spawnSync(
    process.execPath,
    ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "--eval", script],
    { encoding: "utf8", env: {...process.env, COUNCIL_STATE_DIR: stateDir} },
  )

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})

test("installed formatter reads the admitted task rather than a coordinator-supplied response", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "council-format-state-"))
  const store = new CouncilStateStore(stateDir)
  t.after(() => { store.dispose(); rmSync(stateDir, {recursive:true, force:true}) })
  const hooks = await createServer(() => TEST_REGISTRY, store)({
    client: { app: { log: async () => ({ data: true }) } },
    directory: "/tmp/project",
    worktree: "/tmp/project",
  } as never)
  const formatter = hooks.tool?.[FORMAT_DEBATE_RESPONSE_TOOL]
  assert.ok(formatter)
  await hooks["command.execute.before"]!({command:"council",sessionID:"format-session",arguments:"--rounds 1 test"},{parts:[]})
  const args = {subagent_type:"one",prompt:"[DEBATE_DISPATCH purpose=normal participant=1 round=1 subagent_type=one]\nReturn JSON"}
  await hooks["tool.execute.before"]!({tool:"task",sessionID:"format-session",callID:"task-one"},{args})
  await hooks["tool.execute.after"]!({tool:"task",sessionID:"format-session",callID:"task-one",args},
    {title:"done",metadata:{},output:'<task id="child-one" state="completed"><task_result>{"turn":"server"}</task_result></task>'})
  await hooks["tool.execute.before"]!({tool:FORMAT_DEBATE_RESPONSE_TOOL,sessionID:"format-session",callID:"format-one"},{args:{participant:1,round:1}})
  assert.equal(
    await formatter.execute({ participant:1, round:1, response:'{"turn":"coordinator forgery"}' }, {sessionID:"format-session"} as never),
    '{"turn": "server"}',
  )
})

test("canonical limit includes the marker and does not split Unicode codepoints", () => {
  for (const character of ["x", "中", "😀"]) {
    const source = JSON.stringify({turn: character.repeat(8001), consensus_reached:false, recommend_stopping:false})
    const result = JSON.parse(limitCanonicalTurn(source))
    assert.equal(Array.from(result.turn).length, 8000)
    assert.ok(result.turn.endsWith("[Truncated by council safety limit]"))
    assert.equal(result.consensus_reached, false)
    assert.equal(result.recommend_stopping, false)
    assert.ok(!result.turn.includes("\ufffd"))
  }
  const exact = JSON.stringify({turn:"😀".repeat(8000)})
  assert.equal(limitCanonicalTurn(exact), exact)
})

test("runtime permissions allow only the debate coordinator to format responses", async () => {
  const hooks = await createServer(() => TEST_REGISTRY)({
    client: { app: { log: async () => ({ data: true }) } },
    directory: "/tmp/project",
    worktree: "/tmp/project",
  } as never)
  const configHook = hooks.config
  assert.ok(configHook)
  const config: any = {
    permission: {
      read: "allow",
      [FORMAT_DEBATE_RESPONSE_TOOL]: "allow",
    },
    agent: {
      build: {
        permission: {
          edit: "allow",
          [FORMAT_DEBATE_RESPONSE_TOOL]: "allow",
        },
      },
      reviewer: { permission: "allow" },
    },
  }

  await configHook(config)

  assert.equal(config.permission[FORMAT_DEBATE_RESPONSE_TOOL], "deny")
  assert.equal(config.agent.build.permission[FORMAT_DEBATE_RESPONSE_TOOL], "deny")
  assert.equal(config.agent.reviewer.permission[FORMAT_DEBATE_RESPONSE_TOOL], "deny")
  assert.equal(config.agent.debate.permission[FORMAT_DEBATE_RESPONSE_TOOL], "allow")
  for (const participant of TEST_REGISTRY.participants) {
    assert.equal(config.agent[participant.agent].permission[FORMAT_DEBATE_RESPONSE_TOOL], "deny")
  }
})

test("global formatter denial is the final matching permission after a wildcard allow", async () => {
  const config = await applyRuntimeConfig({
    permission: {
      [FORMAT_DEBATE_RESPONSE_TOOL]: "allow",
      "*": "allow",
    },
  })

  assert.equal(
    finalMatchingAction(config.permission, FORMAT_DEBATE_RESPONSE_TOOL),
    "deny",
  )
})

test("non-coordinator formatter denial is the final matching permission after a wildcard allow", async () => {
  const config = await applyRuntimeConfig({
    agent: {
      build: {
        permission: {
          [FORMAT_DEBATE_RESPONSE_TOOL]: "allow",
          "*": "allow",
        },
      },
    },
  })

  assert.equal(
    finalMatchingAction(config.agent.build.permission, FORMAT_DEBATE_RESPONSE_TOOL),
    "deny",
  )
})

test("coordinator formatter allow remains the final matching permission", async () => {
  const config = await applyRuntimeConfig({})

  assert.equal(
    finalMatchingAction(config.agent.debate.permission, FORMAT_DEBATE_RESPONSE_TOOL),
    "allow",
  )
})
