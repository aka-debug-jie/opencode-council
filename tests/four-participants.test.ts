import assert from "node:assert/strict"
import {mkdtempSync, rmSync} from "node:fs"
import {join} from "node:path"
import {tmpdir} from "node:os"
import test, {type TestContext} from "node:test"
import {CouncilStateStore,allValidated} from "../src/council-state.ts"
import {createTaskDispatchGuard} from "../src/task-dispatch-guard.ts"
import {createServer} from "../index.ts"
import {DEBATE_REGISTRY} from "../src/participants.ts"

const names=["one","two","three","four"]
const registry={participants:names.map(agent=>({agent,description:agent,model:"test/"+agent})),sets:{council:names},defaultSet:"council"}
type Guard=ReturnType<typeof createTaskDispatchGuard>
function fixture(t:TestContext) {
  const dir=mkdtempSync(join(tmpdir(),"council-four-")),store=new CouncilStateStore(dir)
  const guard=createTaskDispatchGuard({store,registry,runId:"four-run"})
  t.after(()=>{store.dispose();rmSync(dir,{recursive:true,force:true})})
  return {guard,store}
}
async function start(guard:Guard,rounds:number) {
  await guard.hooks["command.execute.before"]!({command:"council",sessionID:"parent",arguments:"--rounds "+rounds+" topic"},{parts:[]})
}
function args(p:number,r:number) {
  return {subagent_type:names[p-1],prompt:`[DEBATE_DISPATCH purpose=normal participant=${p} round=${r} subagent_type=${names[p-1]}]\nSame topic.`,...(r>1?{task_id:"child-"+p}:{})}
}
async function admit(guard:Guard,p:number,r:number) {
  const input=args(p,r)
  await guard.hooks["tool.execute.before"]!({tool:"task",sessionID:"parent",callID:`task-${p}-${r}`},{args:input})
  return input
}
async function finish(guard:Guard,p:number,r:number,callID=`task-${p}-${r}`) {
  const raw=JSON.stringify({turn:`p${p}r${r}`,...(r>1?{consensus_reached:false,recommend_stopping:false}:{})})
  await guard.hooks["tool.execute.after"]!({tool:"task",sessionID:"parent",callID,args:{}},
    {title:"done",metadata:{},output:`<task id="child-${p}" state="completed"><task_result>${raw}</task_result></task>`})
  await guard.hooks["tool.execute.before"]!({tool:"format_debate_response",sessionID:"parent",callID:`format-${p}-${r}`},{args:{participant:p,round:r}})
  const result=await guard.formatter.execute({participant:p,round:r},{sessionID:"parent"} as never)
  assert.equal(typeof result,"string")
}

for (const rounds of [1,2,3]) test(`four participants complete ${rounds} rounds in exactly ${rounds*4} dispatches`,async t=>{
  const {guard,store}=fixture(t);await start(guard,rounds)
  for (let r=1;r<=rounds;r++) {
    const inputs=await Promise.all([1,2,3,4].map(p=>admit(guard,p,r)))
    assert.equal(guard.getState("parent")!.dispatches.filter(d=>d.status==="active").length,4)
    if (r>1) for (let p=1;p<=4;p++) {
      const peers=JSON.parse(inputs[p-1].prompt.split("Verified previous-round peer turns (authoritative, appended by runtime):\n")[1]).other_participants
      assert.deepEqual(peers.map((peer:any)=>peer.participant),[1,2,3,4].filter(other=>other!==p))
      for (const peer of peers) assert.equal(peer.turn_response.turn,`p${peer.participant}r${r-1}`)
    }
    for (const p of [1,2,3]) await finish(guard,p,r)
    assert.equal(allValidated(guard.getState("parent")!),false)
    await finish(guard,4,r)
  }
  const state=guard.getState("parent")!
  assert.equal(state.status,"ready");assert.equal(state.dispatches.length,rounds*4)
  assert.equal(Object.keys(state.validated).length,rounds*4)
  assert.equal(allValidated(state),true)
  guard.clear()
  const reloaded=store.read("four-run")
  assert.equal(allValidated(reloaded),true)
  assert.equal(reloaded.registry.participants.length,4)
})

test("a correction in a four-person three-round run consumes headroom and blocks the thirteenth task",async t=>{
  const {guard}=fixture(t);await start(guard,3)
  await admit(guard,1,1)
  await guard.hooks["tool.execute.after"]!({tool:"task",sessionID:"parent",callID:"task-1-1",args:{}},
    {title:"invalid",metadata:{},output:'<task id="child-1" state="completed"><task_result>{"turn":""}</task_result></task>'})
  await guard.hooks["tool.execute.before"]!({tool:"format_debate_response",sessionID:"parent",callID:"invalid-format"},{args:{participant:1,round:1}})
  await assert.rejects(guard.formatter.execute({participant:1,round:1},{sessionID:"parent"} as never),/non-empty/)
  const correction={...args(1,1),task_id:"child-1",prompt:args(1,1).prompt.replace("purpose=normal","purpose=formatter-correction")}
  await guard.hooks["tool.execute.before"]!({tool:"task",sessionID:"parent",callID:"correction"},{args:correction})
  await finish(guard,1,1,"correction")
  for (const p of [2,3,4]) {await admit(guard,p,1);await finish(guard,p,1)}
  for (const p of [1,2,3,4]) {await admit(guard,p,2);await finish(guard,p,2)}
  for (const p of [1,2,3]) {await admit(guard,p,3);await finish(guard,p,3)}
  assert.equal(guard.getState("parent")!.dispatches.length,12)
  await assert.rejects(admit(guard,4,3),/dispatch budget exhausted/)
  assert.equal(guard.getState("parent")!.status,"aborted")
  assert.equal(guard.getState("parent")!.dispatches.length,12)
  assert.equal(allValidated(guard.getState("parent")!),false)
})

test("a missing fourth canonical turn blocks the next round rather than silently reverting to three",async t=>{
  const {guard}=fixture(t);await start(guard,2)
  for (const p of [1,2,3]) {await admit(guard,p,1);await finish(guard,p,1)}
  await assert.rejects(admit(guard,1,2),/previous round is not fully canonical/)
  assert.equal(guard.getState("parent")!.status,"aborted")
  assert.equal(guard.getState("parent")!.dispatches.length,3)
})

test("fourth participant routing and formatter identity remain pinned",async t=>{
  const {guard}=fixture(t);await start(guard,1)
  const input={...args(4,1),subagent_type:"three"}
  await assert.rejects(guard.hooks["tool.execute.before"]!({tool:"task",sessionID:"parent",callID:"spoof-four"},{args:input}),/mapping mismatch/)
  assert.equal(guard.getState("parent")!.dispatches.length,0)
})

test("runtime registers HY4 with exactly the same read-only boundary as the other three",async t=>{
  const {store}=fixture(t)
  const hooks=await createServer(()=>DEBATE_REGISTRY,store)({client:{app:{log:async()=>({data:true})}},directory:"/tmp/project",worktree:"/tmp/project"} as never)
  const config:any={}
  await hooks.config!(config)
  const agents=DEBATE_REGISTRY.sets[DEBATE_REGISTRY.defaultSet]
  assert.equal(agents.length,4)
  assert.equal(config.agent["council-hy4"].model,"opencode-go/hy4-preview")
  for (const agent of agents) {
    assert.equal(config.agent[agent].steps,5);assert.equal(config.agent[agent].hidden,true)
    for (const capability of ["bash","edit","webfetch","websearch","external_directory","question","task","skill"]) assert.equal(config.agent[agent].permission[capability],"deny")
    assert.equal(config.agent.debate.permission.task[agent],"allow")
  }
})
