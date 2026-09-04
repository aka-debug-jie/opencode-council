import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { loadPackagedRegistry, resolveUserConfigPath } from "../src/participants.ts"

export function syncCouncilConfig(source: string, destination: string, apply = false): boolean {
  const expected = loadPackagedRegistry(source)
  if (existsSync(destination)) {
    if (JSON.stringify(expected) === JSON.stringify(loadPackagedRegistry(destination))) return true
    if (!apply) return false
  } else if (!apply) return false
  mkdirSync(dirname(destination), {recursive:true, mode:0o700})
  // Explicit application replaces only this model-registry file, never provider/auth config.
  if (existsSync(destination)) writeFileSync(destination + ".backup-" + randomUUID(), readFileSync(destination), {flag:"wx",mode:0o600,flush:true})
  const temporary = destination + "." + randomUUID() + ".tmp"
  writeFileSync(temporary, readFileSync(source), {flag:"wx",mode:0o600,flush:true})
  renameSync(temporary, destination)
  return JSON.stringify(expected) === JSON.stringify(loadPackagedRegistry(destination))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, ...rest] = process.argv.slice(2)
    if (!["--check", "--apply"].includes(mode) || (rest.length && (rest.length !== 2 || rest[0] !== "--destination"))) throw new Error("Usage: sync-council-config.ts --check|--apply [--destination FILE]")
    const destination = resolve(rest[1] ?? resolveUserConfigPath())
    const success = syncCouncilConfig(fileURLToPath(new URL("../config.yaml", import.meta.url)), destination, mode === "--apply")
    if (!success) throw new Error("Effective Council model config differs; inspect it and explicitly use --apply to synchronize")
    console.log("Council model registry matches: " + destination)
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode=1 }
}
