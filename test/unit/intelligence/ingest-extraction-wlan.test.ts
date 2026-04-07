import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ClangdExtractionAdapter } from "../../../src/intelligence/db/extraction/clangd-extraction-adapter.js"
import { executeIngestTool, setIngestDeps } from "../../../src/intelligence/tools/ingest-tool.js"
import type { ILanguageClient } from "../../../src/lsp/types.js"
import type {
  GraphWriteBatch,
  GraphWriteSink,
} from "../../../src/intelligence/db/graph-rows.js"
import type { ExtractorRunner } from "../../../src/intelligence/extraction/runner.js"

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

  it("constructs the runner with the right snapshot, root, and sink", async () => {
    // Test sink + stub LSP — neither is invoked because the runnerFactory
    // override returns a stub runner that immediately resolves.
    const sink: GraphWriteSink = {
      write: vi.fn(async (_batch: GraphWriteBatch) => {}),
    }
    const stubLsp = {} as unknown as ILanguageClient

    // Capture the args the runnerFactory was called with so we can assert
    // ingest-tool passed the right snapshotId, workspaceRoot, and sink.
    const runnerFactory = vi.fn((opts: {
      snapshotId: number
      workspaceRoot: string
      sink: GraphWriteSink
    }): ExtractorRunner => {
      return {
        run: async () => ({
          snapshotId: opts.snapshotId,
          workspaceRoot: opts.workspaceRoot,
          totalDurationMs: 0,
          pluginsRun: 1,
          pluginsSkipped: 0,
          pluginsFailed: 0,
          perPlugin: [],
          bus: {
            totalAccepted: 0,
            totalEmits: 0,
            byKind: {
              symbol: 0,
              type: 0,
              "aggregate-field": 0,
              edge: 0,
              evidence: 0,
              observation: 0,
            },
            byExtractor: {},
            flushCount: 0,
            closed: true,
          },
          warnings: [],
        }),
      } as unknown as ExtractorRunner
    })

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
      lsp: stubLsp,
      sink,
      plugins: [],
      runnerFactory,
      projection: {
        syncFromAuthoritative: vi.fn(async () => ({ synced: true, nodesUpserted: 0, edgesUpserted: 0 })),
      },
    })

    const out = await executeIngestTool({ workspaceRoot: "/tmp/wlan_proc", fileLimit: 77 })
    expect(out).toContain("Snapshot committed: id=9 status=ready")

    expect(runnerFactory).toHaveBeenCalledTimes(1)
    const call = runnerFactory.mock.calls[0][0]
    expect(call.snapshotId).toBe(9)
    expect(call.workspaceRoot).toBe("/tmp/wlan_proc")
    // The sink passed to the runner is a FunctionSymbolCaptureSink
    // wrapper around our stub sink. We can't strict-equal it, but we
    // can verify it's a sink-shaped object.
    expect(typeof call.sink.write).toBe("function")
  })
})
