import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { AddressInfo } from "node:net"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { requestReasonProposals } from "../../src/tools/reason-engine/llm-advisor.js"

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const raw = Buffer.concat(chunks).toString("utf8")
  return raw ? JSON.parse(raw) : {}
}

function sendJson(res: ServerResponse, payload: any) {
  res.statusCode = 200
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(payload))
}

describe("LLM advisor deterministic rescue for empty proposal sets", () => {
  let server: ReturnType<typeof createServer>
  let baseURL = ""

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      if (!req.url || req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
        res.statusCode = 404
        res.end("not found")
        return
      }

      await readJson(req)
      sendJson(res, {
        id: "chatcmpl-empty",
        object: "chat.completion",
        created: 1,
        model: "mock-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                proposedPaths: [],
                openQuestions: ["Could not infer registrar function name"],
              }),
            },
            finish_reason: "stop",
          },
        ],
      })
    })

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    const addr = server.address() as AddressInfo
    baseURL = `http://127.0.0.1:${addr.port}/v1`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  })

  it("synthesizes one minimal proposal from known evidence", async () => {
    process.env.TEST_EMPTY_RESCUE_KEY = "test-key"
    const root = mkdtempSync(path.join(tmpdir(), "clangd-empty-rescue-"))
    const file = path.join(root, "sample.c")
    writeFileSync(
      file,
      [
        "static void wlan_bpf_filter_offload_handler(void) {}",
        "void wlan_bpf_enable_data_path(void)",
        "{",
        "  offldmgr_register_data_offload(DATA_FILTER_OFFLOAD, OFFLOAD_BPF, wlan_bpf_filter_offload_handler);",
        "}",
        "",
      ].join("\n"),
    )

    const fakeClient: any = {
      root,
      incomingCalls: async () => [],
      outgoingCalls: async () => [],
      definition: async () => [],
      references: async () => [],
      workspaceSymbol: async () => [],
    }

    const out = await requestReasonProposals(
      {
        enabled: true,
        baseURL,
        model: "mock-model",
        apiKeyEnv: "TEST_EMPTY_RESCUE_KEY",
        maxCallsPerQuery: 4,
      },
      {
        targetSymbol: "wlan_bpf_filter_offload_handler",
        targetFile: file,
        targetLine: 1,
        knownEvidence: [{ file, line: 1, text: "offldmgr_register_data_offload(..., wlan_bpf_filter_offload_handler);" }],
        suspectedPatterns: ["data-offload-callback"],
      },
      { client: fakeClient, workspaceRoot: root },
    )

    expect(out).not.toBeNull()
    expect(out?.proposedPaths.length).toBe(1)
    expect(out?.proposedPaths[0]?.invocationReason?.dispatchChain?.at(-1)).toBe("wlan_bpf_filter_offload_handler")
    expect(out?.proposedPaths[0]?.invocationReason?.registrationGate?.registrarFn).toBe("wlan_bpf_enable_data_path")
    expect(out?.proposedPaths[0]?.requiredFiles.length).toBeGreaterThan(0)
  })
})
