import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { LlmDbEntry } from "./contracts.js"

const DB_SCHEMA_VERSION = "1"

function safeName(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]+/g, "_")
}

function dbDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".clangd-mcp-llm-db")
}

function dbFile(workspaceRoot: string, connectionKey: string): string {
  return path.join(dbDir(workspaceRoot), `${safeName(connectionKey)}.json`)
}

export function computeFileHash(filePath: string): string | null {
  try {
    const buf = readFileSync(filePath)
    return createHash("sha256").update(buf).digest("hex")
  } catch {
    return null
  }
}

export function readLlmDbEntry(workspaceRoot: string, connectionKey: string): LlmDbEntry | null {
  const fp = dbFile(workspaceRoot, connectionKey)
  if (!existsSync(fp)) return null
  try {
    const parsed = JSON.parse(readFileSync(fp, "utf8")) as LlmDbEntry
    if (!parsed || parsed.schemaVersion !== DB_SCHEMA_VERSION) return null
    return parsed
  } catch {
    return null
  }
}

export function writeLlmDbEntry(workspaceRoot: string, entry: Omit<LlmDbEntry, "schemaVersion">): void {
  const dir = dbDir(workspaceRoot)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const fp = dbFile(workspaceRoot, entry.connectionKey)
  const out: LlmDbEntry = { ...entry, schemaVersion: DB_SCHEMA_VERSION }
  writeFileSync(fp, JSON.stringify(out, null, 2) + "\n")
}

export function verifyHashManifest(hashManifest: Record<string, string>): {
  ok: boolean
  mismatchedFiles: string[]
} {
  const mismatchedFiles: string[] = []
  for (const [file, oldHash] of Object.entries(hashManifest)) {
    const current = computeFileHash(file)
    if (!current || current !== oldHash) mismatchedFiles.push(file)
  }
  return { ok: mismatchedFiles.length === 0, mismatchedFiles }
}
