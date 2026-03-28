import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { AddressInfo } from "node:net"
import path from "node:path"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { requestReasonProposals } from "../../src/tools/reason-engine/llm-advisor.js"

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const raw = Buffer.concat(chunks).toString("utf8")
  return raw ? JSON.parse(raw) : {}
}

function sendJson(res: ServerResponse, code: number, payload: any) {
  res.statusCode = code
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(payload))
}

describe("LLM advisor model fallback", () => {
  let server: ReturnType<typeof createServer>
  let baseURL = ""

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      if (!req.url || req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
        res.statusCode = 404
        res.end("not found")
        return
      }

      const body = await readJson(req)
      const model = body?.model

      if (model === "azure::gpt-5.3-codex") {
        sendJson(res, 400, {
          error: { message: "Model not available for this client" },
        })
        return
      }

      sendJson(res, 200, {
        id: "chatcmpl-ok",
        object: "chat.completion",
        created: 1,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                proposedPaths: [
                  {
                    registrarFn: "wlan_bpf_enable_data_path",
                    registrationApi: "offldmgr_register_data_offload",
                    storageFieldPath: "offload_data[i].data_handler",
                    gates: ["vdev bitmap match"],
                    invocationReason: {
                      runtimeTrigger: "Incoming RX packet from hardware",
                      dispatchChain: ["offloadif_data_ind", "_offldmgr_enhanced_data_handler", "wlan_bpf_filter_offload_handler"],
                      dispatchSite: { file: "/tmp/sample.c", line: 10, snippet: "offload_data[i].data_handler(...)" },
                      registrationGate: {
                        registrarFn: "wlan_bpf_enable_data_path",
                        registrationApi: "offldmgr_register_data_offload",
                        conditions: ["proto_type match"],
                      },
                    },
                    requiredFiles: ["/tmp/sample.c"],
                    confidence: 0.9,
                    rationale: "fallback model succeeded",
                  },
                ],
                openQuestions: [],
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

  it("falls back to alternate model when primary is unavailable", async () => {
    process.env.TEST_FALLBACK_API_KEY = "test-key"
    const root = mkdtempSync(path.join(tmpdir(), "clangd-llm-fallback-"))
    const file = path.join(root, "sample.c")
    writeFileSync(file, "void wlan_bpf_filter_offload_handler(void){}\n")

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
        model: "qpilot/azure::gpt-5.3-codex",
        fallbackModels: ["qpilot/anthropic::claude-4-6-sonnet"],
        apiKeyEnv: "TEST_FALLBACK_API_KEY",
        maxCallsPerQuery: 4,
      },
      {
        targetSymbol: "wlan_bpf_filter_offload_handler",
        targetFile: file,
        targetLine: 1,
        knownEvidence: [{ file, line: 1, text: "void wlan_bpf_filter_offload_handler(void){}" }],
        suspectedPatterns: ["data-offload-callback"],
      },
      { client: fakeClient, workspaceRoot: root },
    )

    expect(out).not.toBeNull()
    expect(out?.proposedPaths.length).toBeGreaterThan(0)
    expect(out?.proposedPaths[0]?.registrarFn).toBe("wlan_bpf_enable_data_path")
  })
})
