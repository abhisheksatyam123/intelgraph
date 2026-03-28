import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { AddressInfo } from "node:net"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { requestReasonProposals } from "../../src/tools/reason-engine/llm-advisor.js"
import { validateReasonProposals } from "../../src/tools/reason-engine/proposal-validator.js"

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

describe("LLM proposal normalization", () => {
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

      // Intentionally sparse/malformed proposal missing requiredFiles/invocationReason.
      sendJson(res, {
        id: "chatcmpl-norm",
        object: "chat.completion",
        created: 1,
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
                    confidence: 0.2,
                    rationale: "sparse model output",
                  },
                ],
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

  it("normalizes sparse proposals to pass validator minimums", async () => {
    process.env.TEST_NORM_API_KEY = "test-key"
    const root = mkdtempSync(path.join(tmpdir(), "clangd-norm-"))
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
        model: "mock-model",
        apiKeyEnv: "TEST_NORM_API_KEY",
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
    expect(out?.proposedPaths.length).toBe(1)
    const check = validateReasonProposals(out?.proposedPaths)
    expect(check.accepted.length).toBe(1)
    expect(check.rejected.length).toBe(0)
  })
})
