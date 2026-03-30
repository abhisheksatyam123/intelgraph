/**
 * dispatch.ts — Tool interface, backend singletons, and file-priming helper.
 *
 * Owns all mutable module-level state and the ToolDef contract.
 */

import { z } from "zod"
import { readFileSync } from "fs"
import type { LspClient } from "../lsp/index.js"
import type { IndexTracker } from "../tracking/index.js"
import type { UnifiedBackend } from "../backend/unified-backend.js"
import type { OrchestratorRunnerDeps } from "../intelligence/index.js"
import type { ToolDef } from "../core/types.js"

// Re-export ToolDef so existing consumers don't break
export type { ToolDef }

// ── Module-level singletons ───────────────────────────────────────────────────

let UNIFIED_BACKEND: UnifiedBackend | null = null
export const INFLIGHT_INDIRECT_CALLERS = new Map<string, Promise<any>>()
export const INDIRECT_CALLER_TELEMETRY = {
  cacheHits: 0,
  inflightDedupReuses: 0,
  freshComputes: 0,
}

let INTELLIGENCE_DEPS: OrchestratorRunnerDeps | null = null

// ── Mutators ──────────────────────────────────────────────────────────────────

export function setUnifiedBackend(backend: UnifiedBackend): void {
  UNIFIED_BACKEND = backend
}

export function setIntelligenceDeps(deps: OrchestratorRunnerDeps): void {
  INTELLIGENCE_DEPS = deps
}

export function getIntelligenceDeps(): OrchestratorRunnerDeps | null {
  return INTELLIGENCE_DEPS
}

export function unifiedBackendOrThrow(): UnifiedBackend {
  if (!UNIFIED_BACKEND) {
    throw new Error("Unified backend not initialized")
  }
  return UNIFIED_BACKEND
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function inflightIndirectCallerKey(workspaceRoot: string, cacheKey: string): string {
  return `${workspaceRoot}::${cacheKey}`
}

export async function withFile(
  client: LspClient,
  filePath: string,
  fn: () => Promise<string>,
): Promise<string> {
  try {
    const text = readFileSync(filePath, "utf8")
    const isFirstOpen = await client.openFile(filePath, text)
    if (isFirstOpen) await new Promise((r) => setTimeout(r, 300))
  } catch {
    // proceed anyway — clangd may have it indexed
  }
  return fn()
}
