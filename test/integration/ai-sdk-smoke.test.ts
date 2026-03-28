import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { AddressInfo } from "node:net"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { generateText, tool } from "ai"
import { z } from "zod"

type MockRequest = {
  path: string
  body: any
}

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

describe("AI SDK smoke: simple call + tool calling", () => {
  let server: ReturnType<typeof createServer>
  let baseURL = ""
  const requests: MockRequest[] = []

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      if (!req.url || req.method !== "POST") {
        res.statusCode = 404
        res.end("not found")
        return
      }

      const body = await readJson(req)
      requests.push({ path: req.url, body })

      // OpenAI-compatible chat endpoint used by @ai-sdk/openai-compatible
      if (req.url.endsWith("/chat/completions")) {
        const hasToolDefinition = Array.isArray(body.tools) && body.tools.length > 0
        const hasToolResult = Array.isArray(body.messages) && body.messages.some((m: any) => m?.role === "tool")

        // Simple non-tool call
        if (!hasToolDefinition) {
          sendJson(res, {
            id: "chatcmpl-simple-1",
            object: "chat.completion",
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "hello" },
                finish_reason: "stop",
              },
            ],
          })
          return
        }

        // Tool-calling step 1: ask client to execute get_weather
        if (!hasToolResult) {
          sendJson(res, {
            id: "chatcmpl-tool-1",
            object: "chat.completion",
            created: 2,
            model: body.model,
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
                        name: "get_weather",
                        arguments: JSON.stringify({ city: "Paris" }),
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

        // Tool-calling step 2: return final answer after tool result is supplied
        sendJson(res, {
          id: "chatcmpl-tool-2",
          object: "chat.completion",
          created: 3,
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Weather is sunny in Paris." },
              finish_reason: "stop",
            },
          ],
        })
        return
      }

      res.statusCode = 404
      res.end("unsupported endpoint")
    })

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    const addr = server.address() as AddressInfo
    baseURL = `http://127.0.0.1:${addr.port}/v1`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  })

  it("verifies a basic generateText LLM call", async () => {
    const provider = createOpenAICompatible({ name: "mock", apiKey: "test-key", baseURL })
    const model = provider("mock-model")

    const result = await generateText({
      model,
      prompt: "Say hello in one word.",
      temperature: 0,
    })

    expect(result.text).toBe("hello")
    expect(requests.some((r) => r.path.endsWith("/chat/completions"))).toBe(true)
  })

  it("verifies AI SDK tool-calling loop end-to-end", async () => {
    const provider = createOpenAICompatible({ name: "mock", apiKey: "test-key", baseURL })
    const model = provider("mock-model")
    let toolCalled = false

    const result = await generateText({
      model,
      prompt: "What is the weather in Paris? Use available tools.",
      maxSteps: 3,
      temperature: 0,
      tools: {
        get_weather: tool({
          description: "Get current weather by city",
          parameters: z.object({ city: z.string() }),
          execute: async ({ city }) => {
            toolCalled = true
            return { city, forecast: "sunny" }
          },
        }),
      },
    })

    expect(toolCalled).toBe(true)
    expect(result.text).toContain("sunny")

    const chatCalls = requests.filter((r) => r.path.endsWith("/chat/completions"))
    expect(chatCalls.length).toBeGreaterThanOrEqual(3)
  })
})
