import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ClangdExtractionAdapter } from "../../../src/intelligence/db/extraction/clangd-extraction-adapter.js"
import { executeIngestTool, setIngestDeps } from "../../../src/intelligence/tools/ingest-tool.js"

describe("ClangdExtractionAdapter wlan_proc prioritization", () => {
  it("prioritizes wlan/src files before build artifacts when fileLimit is small", async () => {
    const base = await mkdtemp(join(tmpdir(), "wlan-proc-"))
    const root = join(base, "wlan_proc")
    await mkdir(root, { recursive: true })
    const buildDir = join(root, "build", "cust")
    const wlanDir = join(root, "wlan", "protocol", "src", "foo")
    await mkdir(buildDir, { recursive: true })
    await mkdir(wlanDir, { recursive: true })

    const buildFile = join(buildDir, "customer.h")
    const wlanFile = join(wlanDir, "handler.c")
    await writeFile(buildFile, "#define X 1\n")
    await writeFile(wlanFile, "int wlan_handler(void){return 0;}\n")

    const lsp = {
      documentSymbol: vi.fn(async (filePath: string) => {
        if (!filePath.endsWith("handler.c")) return []
        return [
          {
            name: "wlan_handler",
            kind: 12,
            range: { start: { line: 0, character: 0 } },
          },
        ]
      }),
      incomingCalls: vi.fn(async () => []),
      outgoingCalls: vi.fn(async () => []),
    }

    const adapter = new ClangdExtractionAdapter(lsp)
    const batch = await adapter.extractSymbols({ workspaceRoot: root, fileLimit: 1 })

    expect(batch.symbols.length).toBeGreaterThan(0)
    expect(batch.symbols[0]?.name).toBe("wlan_handler")
  })
})

describe("executeIngestTool extraction input contract", () => {
  afterEach(() => {
    setIngestDeps(null)
  })

  it("passes fileLimit through to extractor phases", async () => {
    const extractSymbols = vi.fn(async () => ({ symbols: [] }))
    const extractTypes = vi.fn(async () => ({ types: [], fields: [] }))
    const extractEdges = vi.fn(async () => ({ edges: [] }))
    const materializeSnapshot = vi.fn(async () => ({
      snapshotId: 9,
      inserted: { symbols: 0, types: 0, fields: 0, edges: 0, runtimeCallers: 0, logs: 0, timerTriggers: 0 },
      warnings: [],
    }))

    setIngestDeps({
      db: {
        initSchema: vi.fn(async () => {}),
        runMigrations: vi.fn(async () => {}),
        beginSnapshot: vi.fn(async () => ({ snapshotId: 9, status: "building", createdAt: "2026-01-01T00:00:00Z" })),
        commitSnapshot: vi.fn(async () => {}),
        failSnapshot: vi.fn(async () => {}),
        getLatestReadySnapshot: vi.fn(async () => null),
        withTransaction: vi.fn(async (fn: any) => fn({ query: vi.fn(async () => []) })),
      },
      extractor: {
        extractSymbols,
        extractTypes,
        extractEdges,
        materializeSnapshot,
      },
      projection: {
        syncFromAuthoritative: vi.fn(async () => ({ synced: true, nodesUpserted: 0, edgesUpserted: 0 })),
      },
    })

    const out = await executeIngestTool({ workspaceRoot: "/tmp/wlan_proc", fileLimit: 77 })
    expect(out).toContain("Snapshot committed: id=9 status=ready")

    const expectedInput = { workspaceRoot: "/tmp/wlan_proc", fileLimit: 77 }
    expect(extractSymbols).toHaveBeenCalledWith(expectedInput)
    expect(extractTypes).toHaveBeenCalledWith(expectedInput)
    expect(extractEdges).toHaveBeenCalledWith(expectedInput)
  })
})
