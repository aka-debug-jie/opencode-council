import assert from "node:assert/strict"
import {mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"
import {syncCouncilConfig} from "../scripts/sync-council-config.ts"

test("model registry synchronization is explicit, preserves unrelated config, and backs up changes", t => {
  const dir=mkdtempSync(join(tmpdir(),"council-sync-"))
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const source=join(dir,"packaged.yaml"),target=join(dir,"user.yaml")
  const config='version: 2\nparticipants:\n  a: {model: vendor/a}\n  b: {model: vendor/b}\n  c: {model: vendor/c}\nsets:\n  council:\n    participants: [a, b, c]\n'
  writeFileSync(source,config)
  writeFileSync(target,config.replace("vendor/a","vendor/old"))
  writeFileSync(join(dir,"opencode.json"),"untouched")
  assert.equal(syncCouncilConfig(source,target),false)
  assert.match(readFileSync(target,"utf8"),/vendor\/old/)
  assert.equal(syncCouncilConfig(source,target,true),true)
  assert.equal(syncCouncilConfig(source,target),true)
  assert.equal(readFileSync(join(dir,"opencode.json"),"utf8"),"untouched")
  assert.equal(readdirSync(dir).filter(f=>f.startsWith("user.yaml.backup-")).length,1)
})
