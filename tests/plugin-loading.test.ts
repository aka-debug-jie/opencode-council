import assert from "node:assert/strict"
import test from "node:test"
import {server} from "../index.ts"

test("global and project-local wrappers install one controller per project process", async () => {
  const input = {directory:"/tmp/council-loader-test",worktree:"/tmp/council-loader-test",client:{app:{log:async()=>({data:true})}}} as never
  const first = await server(input)
  const second = await server(input)
  try {
    assert.equal([first,second].filter(h => h["command.execute.before"]).length,1)
    assert.equal([first,second].filter(h => h.tool?.format_debate_response).length,1)
  } finally { await first.dispose?.(); await second.dispose?.() }
  const fresh=await server(input)
  assert.ok(fresh["command.execute.before"])
  await fresh.dispose?.()
})
