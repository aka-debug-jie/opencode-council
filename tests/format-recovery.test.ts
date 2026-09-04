import assert from "node:assert/strict"
import {mkdtempSync,rmSync} from "node:fs"
import {join} from "node:path"
import {tmpdir} from "node:os"
import test from "node:test"
import {CouncilStateStore,digest} from "../src/council-state.ts"
import {createTaskDispatchGuard} from "../src/task-dispatch-guard.ts"

const agents=["a","b","c"]
const registry={participants:agents.map(agent=>({agent,description:agent,model:"test/"+agent})),sets:{council:agents},defaultSet:"council"}
function setup(t:any) {
  const dir=mkdtempSync(join(tmpdir(),"council-recovery-")),store=new CouncilStateStore(dir)
  const guard=createTaskDispatchGuard({registry,runId:"recovery",store})
  t.after(()=>{guard.clear();rmSync(dir,{recursive:true,force:true})})
  return guard
}
function taskArgs(p:number,purpose="normal",task_id?:string) {
  return {subagent_type:agents[p-1],prompt:`[DEBATE_DISPATCH purpose=${purpose} participant=${p} round=1 subagent_type=${agents[p-1]}]\nTopic`,...(task_id?{task_id}:{})}
}
async function admit(guard:any,p:number,callID:string,purpose="normal",taskID?:string) {
  const args=taskArgs(p,purpose,taskID)
  await guard.hooks["tool.execute.before"]({tool:"task",sessionID:"parent",callID},{args})
  return args
}
async function finish(guard:any,p:number,callID:string,raw:string,child=`child-${p}`) {
  const output={title:"done",metadata:{sessionId:child},output:`<task id="${child}" state="completed"><task_result>${raw}</task_result></task>`}
  await guard.hooks["tool.execute.after"]({tool:"task",sessionID:"parent",callID,args:{}},output)
  return output.output
}
async function format(guard:any,p:number,callID:string) {
  await guard.hooks["tool.execute.before"]({tool:"format_debate_response",sessionID:"parent",callID},{args:{participant:p,round:1}})
  return guard.formatter.execute({participant:p,round:1},{sessionID:"parent"})
}

test("completed malformed task is labelled for formatter without changing raw evidence",async t=>{
  const guard=setup(t);await guard.hooks["command.execute.before"]!({command:"council",sessionID:"parent",arguments:"--rounds 1 topic"},{parts:[]})
  await admit(guard,1,"normal-1")
  const raw='{"turn":"missing close"'
  const rendered=await finish(guard,1,"normal-1",raw)
  assert.match(rendered,/Task completed for participant=1 round=1/)
  assert.match(rendered,/This is NOT a task failure/)
  assert.equal(guard.getState("parent")!.dispatches[0].outputDigest,digest(raw))
  await assert.rejects(format(guard,1,"format-1"),error=>{
    assert.match(String(error),/purpose=formatter-correction participant=1 round=1 subagent_type=a/)
    assert.match(String(error),/omit task_id; runtime injects the authoritative child session/)
    assert.match(String(error),/Do not use purpose=retry/)
    return true
  })
  assert.equal(guard.getState("parent")!.status,"active")
})

test("formatter infrastructure failure aborts instead of spending a model correction",async t=>{
  const guard=setup(t);await guard.hooks["command.execute.before"]!({command:"council",sessionID:"parent",arguments:"--rounds 1 topic"},{parts:[]})
  await admit(guard,1,"normal-1");await finish(guard,1,"normal-1",'{"turn":"valid"}')
  const oldPath=process.env.PATH
  try {
    process.env.PATH="/nonexistent-council-test-path"
    await assert.rejects(format(guard,1,"format-1"),/formatter infrastructure failure.*python3/)
  } finally {
    if (oldPath===undefined) delete process.env.PATH;else process.env.PATH=oldPath
  }
  const state=guard.getState("parent")!
  assert.equal(state.status,"aborted")
  assert.equal(state.dispatches.length,1)
  assert.equal(state.dispatches[0].formatFailed,undefined)
  await assert.rejects(admit(guard,1,"bad-correction","formatter-correction","child-1"),/aborted/)
})

test("revalidating the same failed result is terminal rather than an unlimited coordinator loop",async t=>{
  const guard=setup(t);await guard.hooks["command.execute.before"]!({command:"council",sessionID:"parent",arguments:"--rounds 1 topic"},{parts:[]})
  await admit(guard,1,"normal-1");await finish(guard,1,"normal-1",'not JSON')
  await assert.rejects(format(guard,1,"format-1"),/Correction 1\/2/)
  await assert.rejects(format(guard,1,"repeat-format"),/already failed validation/)
  assert.equal(guard.getState("parent")!.status,"aborted")
  assert.equal(guard.getState("parent")!.dispatches.length,1)
})

test("offline replay preserves rejection of retry for completed prose and accepts same-participant correction",async t=>{
  const guard=setup(t);await guard.hooks["command.execute.before"]!({command:"council",sessionID:"parent",arguments:"--rounds 1 topic"},{parts:[]})
  for (const p of [1,2,3]) {await admit(guard,p,`normal-${p}`);await finish(guard,p,`normal-${p}`,p===2?'planning prose, not JSON':`{"turn":"p${p}"}`)}
  await format(guard,1,"format-1")
  await assert.rejects(format(guard,2,"format-2"),/purpose=formatter-correction participant=2/)
  await format(guard,3,"format-3")
  await assert.rejects(admit(guard,3,"bad-retry","retry","child-3"),/only one retry after a recorded task failure/)
  assert.equal(guard.getState("parent")!.status,"aborted")

  const recovered=setup(t);await recovered.hooks["command.execute.before"]!({command:"council",sessionID:"parent",arguments:"--rounds 1 topic"},{parts:[]})
  for (const p of [1,2,3]) {await admit(recovered,p,`normal-${p}`);await finish(recovered,p,`normal-${p}`,p===2?'planning prose, not JSON':`{"turn":"p${p}"}`)}
  await format(recovered,1,"format-1")
  await assert.rejects(format(recovered,2,"format-2"),/Correction 1\/2/)
  await format(recovered,3,"format-3")
  await admit(recovered,2,"correction-2","formatter-correction","child-2")
  await finish(recovered,2,"correction-2",'{"turn":"corrected"}')
  await format(recovered,2,"format-correction-2")
  assert.equal(recovered.getState("parent")!.status,"ready")
  assert.equal(recovered.getState("parent")!.dispatches.length,4)
})
