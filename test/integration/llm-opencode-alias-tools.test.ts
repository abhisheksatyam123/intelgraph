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

describe("LLM advisor OpenCode alias tools", () => {
  let server: ReturnType<typeof createServer>
  let baseURL = ""
  let step = 0

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      if (!req.url || req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
        res.statusCode = 404
        res.end("not found")
        return
      }

      await readJson(req)
      step += 1

      if (step === 1) {
        sendJson(res, {
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 1,
          model: "mock-model",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "grep",
                      arguments: JSON.stringify({ pattern: "wlan_bpf_filter_offload_handler", include: "*.c" }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        })
        return
      }

      if (step === 2) {
        sendJson(res, {
          id: "chatcmpl-2",
          object: "chat.completion",
          created: 2,
          model: "mock-model",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call_2",
                    type: "function",
                    function: {
                      name: "read",
                      arguments: JSON.stringify({ filePath: "sample.c", offset: 1, limit: 20 }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        })
        return
      }

      sendJson(res, {
        id: "chatcmpl-3",
        object: "chat.completion",
        created: 3,
        model: "mock-model",
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
                    dispatchPattern: "fn-ptr-field",
                    gates: ["vdev bitmap match"],
                    invocationReason: {
                      runtimeTrigger: "Incoming RX packet from hardware",
                      dispatchChain: ["offloadif_data_ind", "_offldmgr_enhanced_data_handler", "wlan_bpf_filter_offload_handler"],
                      dispatchSite: {
                        file: "/tmp/sample.c",
                        line: 10,
                        snippet: "offload_data[i].data_handler(...)"
                      },
                      registrationGate: {
                        registrarFn: "wlan_bpf_enable_data_path",
                        registrationApi: "offldmgr_register_data_offload",
                        conditions: ["proto_type match"]
                      }
                    },
                    requiredFiles: ["/tmp/sample.c"],
                    confidence: 0.9,
                    rationale: "validated by grep+read",
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

  it("allows LLM to call OpenCode-style grep/read aliases", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "clangd-alias-tools-"))
    writeFileSync(path.join(root, "sample.c"), "void wlan_bpf_filter_offload_handler(void) {}\n")
    process.env.TEST_ALIAS_LLM_API_KEY = "test-key"

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
        apiKeyEnv: "TEST_ALIAS_LLM_API_KEY",
        maxCallsPerQuery: 6,
      },
      {
        targetSymbol: "wlan_bpf_filter_offload_handler",
        targetFile: path.join(root, "sample.c"),
        targetLine: 1,
        knownEvidence: [{ file: path.join(root, "sample.c"), line: 1, text: "void wlan_bpf_filter_offload_handler(void) {}" }],
        suspectedPatterns: ["data-offload-callback"],
      },
      { client: fakeClient, workspaceRoot: root },
    )

    expect(out).not.toBeNull()
    expect(out?.proposedPaths.length).toBeGreaterThan(0)
    expect(out?.proposedPaths[0]?.registrarFn).toBe("wlan_bpf_enable_data_path")
  })
})
