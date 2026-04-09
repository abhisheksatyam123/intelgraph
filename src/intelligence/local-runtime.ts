import { accessSync, existsSync, mkdirSync, readFileSync, writeFileSync, constants } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { log } from "../logging/logger.js"
import type { WorkspaceConfig } from "../config/bootstrap.js"
import { resolveConfigPath } from "../config/config.js"

function hashPortSeed(input: string): number {
  let h = 0
  for (let i = 0; i < input.length; i++) h = ((h << 5) - h + input.charCodeAt(i)) | 0
  return Math.abs(h)
}

function isWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolves a writable directory for storing workspace-specific runtime files.
 * If the workspace root is not writable, falls back to a global storage directory.
 */
function resolveEffectiveRoot(root: string): string {
  if (isWritable(root)) return root

  const hash = hashPortSeed(root).toString(36)
  // Prefer the new ~/.local/share/intelgraph/workspaces path. Fall back to the
  // legacy clangd-mcp directory if it already exists on disk so upgraded users
  // keep writing to their existing storage location.
  const newFallback = path.join(homedir(), ".local", "share", "intelgraph", "workspaces", hash)
  const legacyFallback = path.join(homedir(), ".local", "share", "clangd-mcp", "workspaces", hash)
  const fallback = existsSync(legacyFallback) && !existsSync(newFallback) ? legacyFallback : newFallback

  if (!existsSync(fallback)) {
    try {
      mkdirSync(fallback, { recursive: true })
      log("INFO", "intelligence local: using fallback storage for read-only workspace", { root, fallback })
    } catch (err) {
      log("WARN", "intelligence local: failed to create fallback storage", { fallback, error: String(err) })
      return "/tmp/intelgraph-" + hash
    }
  }

  return fallback
}

function defaultPorts(workspaceRoot: string): { bolt: number; http: number } {
  const seed = hashPortSeed(workspaceRoot) % 700
  return { bolt: 56000 + seed, http: 57000 + seed }
}

const DEFAULT_COMPOSE = [
  "services:",
  "  neo4j:",
  "    image: neo4j:5",
  "    container_name: ${INTEL_STACK_NAME:-intelgraph-local}-neo4j",
  "    restart: unless-stopped",
  "    environment:",
  "      NEO4J_AUTH: ${INTEL_NEO4J_USER:-neo4j}/${INTEL_NEO4J_PASSWORD:-neo4j1234}",
  "    ports:",
  "      - \"${INTEL_NEO4J_HTTP_PORT:-57474}:7474\"",
  "      - \"${INTEL_NEO4J_BOLT_PORT:-57687}:7687\"",
  "    volumes:",
  "      - ${INTELLIGENCE_NEO4J_DATA_DIR:-${WLAN_WORKSPACE_ROOT:-.}/.intelligence-data/neo4j/data}:/data",
  "",
].join("\n")

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function ensureWorkspaceConfig(root: string, ws: WorkspaceConfig, ports: { bolt: number; http: number }) {
  // Use resolveConfigPath so we don't overwrite an existing
  // .clangd-mcp.json or .intelgraph.json. resolveConfigPath returns
  // the new .intelgraph.json path when neither exists, so fresh
  // installs land on the new name.
  const cfgPath = resolveConfigPath(root)
  if (existsSync(cfgPath)) return

  const cfg: WorkspaceConfig = {
    enabled: ws.enabled ?? true,
    clangd: ws.clangd,
    args: ws.args,
    compileCommandsCleaning: ws.compileCommandsCleaning,
    intelligenceLocal: {
      enabled: true,
      composeFile: "docker-compose.intelligence.local.yml",
      env: {
        INTELLIGENCE_NEO4J_URL: `bolt://localhost:${ports.bolt}`,
        INTELLIGENCE_NEO4J_USER: "neo4j",
        INTELLIGENCE_NEO4J_PASSWORD: "neo4j1234",
      },
      storage: {
        neo4jDataDir: ".intelligence-data/neo4j/data",
        neo4jLogsDir: ".intelligence-data/neo4j/logs",
      },
    },
  }

  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8")
  log("INFO", "intelligence local: wrote workspace config", { cfgPath })
}

function ensureComposeAndEnv(effectiveRoot: string, projectRoot: string, ports: { bolt: number; http: number }) {
  const composePath = path.join(effectiveRoot, "docker-compose.intelligence.local.yml")
  writeFileSync(composePath, DEFAULT_COMPOSE, "utf8")

  const envPath = path.join(effectiveRoot, ".env.intelligence.local")
  const envContent = [
    `WLAN_WORKSPACE_ROOT=${projectRoot}`,
    `INTELLIGENCE_NEO4J_DATA_DIR=${path.join(effectiveRoot, ".intelligence-data", "neo4j", "data")}`,
    `INTEL_STACK_NAME=intelgraph-${hashPortSeed(projectRoot).toString(36)}`,
    `INTEL_NEO4J_USER=neo4j`,
    `INTEL_NEO4J_PASSWORD=neo4j1234`,
    `INTEL_NEO4J_HTTP_PORT=${ports.http}`,
    `INTEL_NEO4J_BOLT_PORT=${ports.bolt}`,
    `INTELLIGENCE_NEO4J_URL=bolt://localhost:${ports.bolt}`,
    `INTELLIGENCE_NEO4J_USER=neo4j`,
    `INTELLIGENCE_NEO4J_PASSWORD=neo4j1234`,
    "",
  ].join("\n")
  writeFileSync(envPath, envContent, "utf8")
}

function loadEnvFromFile(envPath: string) {
  if (!existsSync(envPath)) return
  const raw = readFileSync(envPath, "utf8")
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const idx = trimmed.indexOf("=")
    if (idx <= 0) continue
    const key = trimmed.slice(0, idx)
    const value = trimmed.slice(idx + 1)
    process.env[key] = value
  }
}

function startCompose(root: string) {
  const composePath = path.join(root, "docker-compose.intelligence.local.yml")
  const envPath = path.join(root, ".env.intelligence.local")
  const run = spawnSync("docker", ["compose", "--env-file", envPath, "-f", composePath, "up", "-d", "--force-recreate"], {
    cwd: root,
    stdio: "pipe",
    encoding: "utf8",
  })
  if (run.status !== 0) {
    log("WARN", "intelligence local: docker compose up failed", { code: run.status, stderr: run.stderr?.trim() })
    return
  }
  log("INFO", "intelligence local: docker compose ready")
}

export function ensureLocalIntelligenceRuntime(root: string, ws: WorkspaceConfig): void {
  const local = ws.intelligenceLocal
  if (local?.enabled === false) return

  const effectiveRoot = resolveEffectiveRoot(root)
  const ports = defaultPorts(root)

  ensureDir(path.join(effectiveRoot, ".intelligence-data", "neo4j", "data"))
  ensureDir(path.join(effectiveRoot, ".intelligence-data", "neo4j", "logs"))

  ensureWorkspaceConfig(effectiveRoot, ws, ports)
  ensureComposeAndEnv(effectiveRoot, root, ports)

  const envPath = path.join(effectiveRoot, ".env.intelligence.local")
  loadEnvFromFile(envPath)
  startCompose(effectiveRoot)
}
