import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { parse } from "yaml"

test("repository Skill has explicit-only metadata and a scoped installer", t => {
  const source = readFileSync(new URL("../skills/codex-council/SKILL.md", import.meta.url), "utf8")
  const frontmatter = parse(source.split("---")[1])
  assert.equal(frontmatter.name, "codex-council")
  assert.equal(typeof frontmatter.description, "string")
  const metadata = parse(readFileSync(new URL("../skills/codex-council/agents/openai.yaml", import.meta.url), "utf8"))
  assert.equal(metadata.policy.allow_implicit_invocation, false)
  const root = mkdtempSync(join(tmpdir(), "council-install-"))
  t.after(() => rmSync(root, {recursive:true,force:true}))
  const target = join(root, "skill")
  writeFileSync(join(root, "config.toml"), "unrelated=true\n")
  const run = (...args) => spawnSync("python3", [new URL("../scripts/install-council-skill.py", import.meta.url).pathname, "--destination", target, ...args], {encoding:"utf8"})
  assert.equal(run().status, 0)
  writeFileSync(join(target, "user-note"), "preserve")
  assert.equal(run("--check").status, 0)
  writeFileSync(join(target, "SKILL.md"), "drift")
  assert.equal(run("--check").status, 1)
  assert.equal(run().status, 0)
  assert.equal(run("--check").status, 0)
  assert.equal(readFileSync(join(target, "user-note"), "utf8"), "preserve")
  assert.equal(readFileSync(join(root, "config.toml"), "utf8"), "unrelated=true\n")
})
