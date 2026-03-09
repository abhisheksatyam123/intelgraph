/**
 * server.ts — Creates and configures the MCP server.
 *
 * Registers all tools from tools.ts and wires them to the shared LspClient.
 * Supports two transports:
 *   - Stdio  (--stdio flag, default for single-session use)
 *   - HTTP/SSE (--port N, allows multiple OpenCode sessions to share one clangd)
 *     Uses the MCP StreamableHTTP transport over a plain Node.js HTTP server.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { createServer, type IncomingMessage, type ServerResponse } from "http"
import { randomUUID } from "crypto"
import { TOOLS } from "./tools.js"
import type { LspClient } from "./lsp-client.js"
import type { IndexTracker } from "./index-tracker.js"
import { log, logError } from "./logger.js"
import { z } from "zod"

// ── Build a fresh McpServer with all tools registered ─────────────────────────

export async function createMcpServer(
  getClient: () => Promise<LspClient>,
  tracker: IndexTracker,
): Promise<McpServer> {
  const server = new McpServer({
    name: "clangd-mcp",
    version: "0.1.0",
  })

  for (const tool of TOOLS) {
    // Extract the raw shape from a ZodObject, or use an empty object for ZodObject({})
    let shape: Record<string, z.ZodTypeAny>
    if (tool.inputSchema instanceof z.ZodObject) {
      shape = (tool.inputSchema as z.ZodObject<any>).shape
    } else {
      shape = {}
    }

    server.tool(
      tool.name,
      tool.description,
      shape,
      async (args: any) => {
        const start = Date.now()
        log("DEBUG", `Tool call: ${tool.name}`, { file: args.file ? require("path").basename(args.file) : undefined, line: args.line, character: args.character })
        try {
          const client = await getClient()
          const text = await tool.execute(args, client, tracker)
          log("DEBUG", `Tool done: ${tool.name} (${Date.now() - start}ms)`)
          return {
            content: [{ type: "text" as const, text }],
          }
        } catch (err: any) {
          logError(`Tool error: ${tool.name}`, err)
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: ${err?.message ?? String(err)}`,
              },
            ],
            isError: true,
          }
        }
      },
    )
  }

  return server
}

// ── Stdio transport (single session) ─────────────────────────────────────────

export async function startStdio(getClient: () => Promise<LspClient>, tracker: IndexTracker): Promise<void> {
  const server = await createMcpServer(getClient, tracker)
  const transport = new StdioServerTransport()

  transport.onclose = () => {
    log("WARN", "Stdio MCP transport closed (client disconnected)")
  }
  ;(transport as any).onerror = (err: Error) => {
    logError("Stdio MCP transport error", err)
  }

  await server.connect(transport)
  log("INFO", "Listening on stdio")
  process.stderr.write("[clangd-mcp] Listening on stdio\n")
}

// ── HTTP/StreamableHTTP transport (multi-session) ─────────────────────────────
//
// Each POST /mcp creates a new MCP session backed by the same LspClient.
// Clients connect with:
//   { "url": "http://localhost:<port>/mcp" }

export async function startHttp(
  getClient: () => Promise<LspClient>,
  tracker: IndexTracker,
  port: number,
): Promise<void> {
  // Map of sessionId → transport (for DELETE / cleanup)
  const sessions = new Map<string, StreamableHTTPServerTransport>()

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`)

    if (url.pathname !== "/mcp") {
      res.writeHead(404).end("Not found")
      return
    }

    if (req.method === "POST") {
      // New or existing session
      const sessionId = (req.headers["mcp-session-id"] as string) ?? randomUUID()

      let transport = sessions.get(sessionId)
      if (!transport) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => sessionId,
          onsessioninitialized: (id) => {
            log("INFO", `HTTP session initialized: ${id}`)
            process.stderr.write(`[clangd-mcp] Session initialized: ${id}\n`)
          },
        })
        sessions.set(sessionId, transport)

        const server = await createMcpServer(getClient, tracker)
        await server.connect(transport)

        transport.onclose = () => {
          sessions.delete(sessionId)
          log("INFO", `HTTP session closed: ${sessionId}`)
          process.stderr.write(`[clangd-mcp] Session closed: ${sessionId}\n`)
        }
      }

      await transport.handleRequest(req, res)
      return
    }

    if (req.method === "GET") {
      // SSE stream for an existing session
      const sessionId = req.headers["mcp-session-id"] as string
      const transport = sessionId ? sessions.get(sessionId) : undefined
      if (!transport) {
        res.writeHead(404).end("Session not found")
        return
      }
      await transport.handleRequest(req, res)
      return
    }

    if (req.method === "DELETE") {
      const sessionId = req.headers["mcp-session-id"] as string
      const transport = sessionId ? sessions.get(sessionId) : undefined
      if (transport) {
        await transport.handleRequest(req, res)
        sessions.delete(sessionId)
      } else {
        res.writeHead(404).end("Session not found")
      }
      return
    }

    res.writeHead(405).end("Method not allowed")
  })

  await new Promise<void>((resolve) => httpServer.listen(port, resolve))
  log("INFO", `HTTP MCP server listening on http://localhost:${port}/mcp`)
  process.stderr.write(`[clangd-mcp] HTTP MCP server listening on http://localhost:${port}/mcp\n`)
}
