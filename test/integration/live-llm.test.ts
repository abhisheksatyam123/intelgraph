/**
 * Live LLM integration test — runs against real WLAN workspace with real API key.
 * Usage: node --experimental-vm-modules node_modules/.bin/vitest run test/integration/live-llm.test.ts
 */
import { describe, it, expect } from "vitest"
import { existsSync, unlinkSync } from "fs"
import path from "path"
import { getWlanTargets, getWlanWorkspaceRoot } from "./wlan-targets.js"
import { runReasonEngine } from "../../src/tools/reason-engine/index.js"
import { collectIndirectCallers } from "../../src/tools/indirect-callers.js"

const root = getWlanWorkspaceRoot()
const targets = getWlanTargets()
const apiKey = process.env.QPILOT_API_KEY || process.env.OPENAI_API_KEY || ""
const hasKey = apiKey.length > 0
const hasWorkspace = existsSync(root)

const llmConfig = {
  enabled: true,
  baseURL: "https://qpilot-api.qualcomm.com/v1",
  model: "qpilot/anthropic::claude-4-5-sonnet",
  fallbackModels: ["qpilot/anthropic::claude-4-6-sonnet"],
  apiKeyEnv: "QPILOT_API_KEY",
  maxCallsPerQuery: 8,
  ruleFile: path.join(process.cwd(), "doc/skill/indirect-caller-reasoning-rules.md"),
}

// Fake LSP client that uses real file system but no live clangd
// (the LLM uses search_code + read_file which don't need LSP)
const fakeClient: any = {
  root,
  prepareCallHierarchy: async () => [],
  incomingCalls: async () => [],
  references: async () => [],
  workspaceSymbol: async () => [],
}

function safeName(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]+/g, "_")
}

function clearReasonCache(symbol: string, file: string, line: number): void {
  const connectionKey = `${root}::${symbol}::${file}:${line}`
  const cacheFile = path.join(root, ".clangd-mcp-llm-db", `${safeName(connectionKey)}.json`)
  if (existsSync(cacheFile)) unlinkSync(cacheFile)
}

describe.skipIf(!hasKey || !hasWorkspace)(
  "Live LLM: lsp_reason_chain finds indirect callers via LLM+cache",
  () => {
    // Test the flagship target end-to-end
    const flagship = targets[0] // bpf-filter-offload-handler

    it(
      `${flagship.id}: LLM produces invocationReason with all three layers`,
      async () => {
        // Force first invocation down the LLM path (not stale cache reuse).
        clearReasonCache("wlan_bpf_filter_offload_handler", flagship.file, flagship.line)

        // Collect LSP evidence (reference sites) — uses fake client so returns empty,
        // but the LLM will find them via search_code
        const graph = await collectIndirectCallers(fakeClient, {
          file: flagship.file,
          line: flagship.line,
          character: flagship.character,
          maxNodes: 20,
        })

        const knownEvidence = [
          { file: flagship.file, line: flagship.line, text: "" },
          ...graph.nodes.map(n => ({ file: n.file, line: n.line, text: n.sourceText })),
        ]

        const result = await runReasonEngine(
          fakeClient,
          {
            targetSymbol: "wlan_bpf_filter_offload_handler",
            targetFile: flagship.file,
            targetLine: flagship.line,
            knownEvidence,
            suspectedPatterns: [flagship.patternFamily],
            workspaceRoot: root,
          },
          llmConfig,
        )

        console.log("usedLlm:", result.usedLlm)
        console.log("cacheHit:", result.cacheHit)
        console.log("rejected:", result.rejected)
        console.log("paths:", result.reasonPaths.length)
        if (result.reasonPaths[0]?.invocationReason) {
          const ir = result.reasonPaths[0].invocationReason
          console.log("runtimeTrigger:", ir.runtimeTrigger)
          console.log("dispatchChain:", ir.dispatchChain)
          console.log("dispatchSite:", ir.dispatchSite.file, ":", ir.dispatchSite.line)
          console.log("registrarFn:", ir.registrationGate.registrarFn)
          console.log("conditions:", ir.registrationGate.conditions)
        }

        // Must have produced at least one path
        expect(result.reasonPaths.length, "LLM must produce at least one reason path").toBeGreaterThan(0)

        const rp = result.reasonPaths[0]
        const ir = rp.invocationReason

        // invocationReason must be present
        expect(ir, "invocationReason must be present").toBeDefined()
        if (!ir) return

        // Layer C: runtime trigger
        expect(ir.runtimeTrigger.length, "runtimeTrigger must be non-trivial").toBeGreaterThan(10)

        // Layer B: dispatch chain ends with target
        expect(ir.dispatchChain.length, "dispatchChain must have ≥2 entries").toBeGreaterThanOrEqual(2)
        expect(
          ir.dispatchChain[ir.dispatchChain.length - 1],
          "dispatchChain must end with target symbol",
        ).toBe("wlan_bpf_filter_offload_handler")

        // Layer B: dispatch site file exists
        expect(existsSync(ir.dispatchSite.file), `dispatchSite.file must exist: ${ir.dispatchSite.file}`).toBe(true)

        // Layer A: registrar is one of the known registrars
        expect(
          flagship.expectedIndirectCallers,
          `registrarFn "${ir.registrationGate.registrarFn}" must be a known registrar`,
        ).toContain(ir.registrationGate.registrarFn)

        // Layer A: conditions non-empty
        expect(ir.registrationGate.conditions.length, "conditions must be non-empty").toBeGreaterThan(0)
      },
      180_000,
    )

    it(
      `${flagship.id}: second call hits cache and returns same result`,
      async () => {
        const result = await runReasonEngine(
          fakeClient,
          {
            targetSymbol: "wlan_bpf_filter_offload_handler",
            targetFile: flagship.file,
            targetLine: flagship.line,
            knownEvidence: [],
            suspectedPatterns: [],
            workspaceRoot: root,
          },
          llmConfig,
        )

        expect(result.cacheHit, "second call must be a cache hit").toBe(true)
        expect(result.usedLlm, "cache hit must not use LLM").toBe(false)
        expect(result.reasonPaths.length, "cache must return paths").toBeGreaterThan(0)
      },
      30_000,
    )
  },
)
