import assert from "node:assert/strict"
import {mkdtempSync, rmSync, readFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"
import {createServer, PARTICIPANT_PERMISSION} from "../index.ts"
import {CouncilStateStore} from "../src/council-state.ts"
import {DEBATE_REGISTRY, DEFAULT_COORDINATOR_MODEL, parseParticipantConfig} from "../src/participants.ts"

const source = readFileSync(new URL('../config.yaml', import.meta.url), 'utf8')
const legacy = source.replace(/coordinator:\n  model: [^\n]+\n/, '')

test('coordinator config accepts custom model, preserves legacy files and rejects invalid fields', () => {
  assert.equal(parseParticipantConfig(legacy, '/tmp/config.yaml').coordinator, undefined)
  assert.deepEqual(parseParticipantConfig(source.replace(DEFAULT_COORDINATOR_MODEL, 'test/custom'), '/tmp/config.yaml').coordinator, {model:'test/custom'})
  for (const value of ['null', '{}', '{model: ""}', '{model: 3}', '{model: test/custom, permission: allow}']) {
    assert.throws(() => parseParticipantConfig(legacy + '\ncoordinator: ' + value, '/tmp/config.yaml'), /coordinator/)
  }
})

test('custom models reach runtime without changing permissions, and resume uses the saved models', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'council-models-'))
  const store = new CouncilStateStore(directory)
  const originalRun = process.env.COUNCIL_RUN_ID, originalResume = process.env.COUNCIL_RESUME
  t.after(() => {
    store.dispose()
    for (const [key,value] of [['COUNCIL_RUN_ID',originalRun],['COUNCIL_RESUME',originalResume]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value
    }
    rmSync(directory,{recursive:true,force:true})
  })
  process.env.COUNCIL_RUN_ID = 'custom-models'
  delete process.env.COUNCIL_RESUME
  const registry = {...DEBATE_REGISTRY,coordinator:{model:'test/coordinator'},participants:DEBATE_REGISTRY.participants.map((p,i)=>({...p,model:'test/participant-'+i}))}
  const input = {client:{app:{log:async()=>({data:true})}},directory,worktree:directory} as never
  const hooks = await createServer(()=>registry,store)(input)
  const config:any = {}
  await hooks.config!(config)
  assert.equal(config.agent.debate.model,'test/coordinator')
  assert.equal(config.agent.debate.permission.question,'deny')
  for (const p of registry.participants) {
    assert.equal(config.agent[p.agent].model,p.model)
    assert.equal(config.agent[p.agent].steps,5)
    assert.deepEqual(config.agent[p.agent].permission,{...PARTICIPANT_PERMISSION,format_debate_response:'deny',persist_debate_transcript:'deny'})
  }
  await hooks['command.execute.before']!({command:'council',sessionID:'model-parent',arguments:'--rounds 1 topic'},{parts:[]})
  assert.deepEqual(store.read('custom-models').registry.coordinator,registry.coordinator)
  store.dispose()
  process.env.COUNCIL_RESUME = '1'
  const resumed = await createServer(()=>({...registry,coordinator:{model:'test/changed'},participants:DEBATE_REGISTRY.participants}),store)(input)
  const restored:any = {}
  await resumed.config!(restored)
  assert.equal(restored.agent.debate.model,'test/coordinator')
  for (const p of registry.participants) assert.equal(restored.agent[p.agent].model,p.model)
})

test('old registry without coordinator keeps Luna as the runtime default', async t => {
  const directory = mkdtempSync(join(tmpdir(),'council-legacy-model-'))
  const store = new CouncilStateStore(directory)
  t.after(()=>{store.dispose();rmSync(directory,{recursive:true,force:true})})
  const {coordinator, ...legacyRegistry} = DEBATE_REGISTRY
  const hooks = await createServer(()=>legacyRegistry,store)({client:{app:{log:async()=>({data:true})}},directory,worktree:directory} as never)
  const config:any = {}
  await hooks.config!(config)
  assert.equal(config.agent.debate.model,DEFAULT_COORDINATOR_MODEL)
})
