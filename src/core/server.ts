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
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createServer, type IncomingMessage, type ServerResponse } from "http"
import { randomUUID } from "crypto"
import { TOOLS } from "../tools/index.js"
import { setUnifiedBackend } from "../tools/index.js"
import { log, logError } from "../logging/logger.js"
import { z } from "zod"
import type { BackendDeps } from "./types.js"

// ── Build a fresh McpServer with all tools registered ─────────────────────────

export async function createMcpServer(
  deps: BackendDeps,
): Promise<McpServer> {
  setUnifiedBackend(deps.backend)

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
        log("DEBUG", `Tool call: ${tool.name}`, args)
        try {
          const client = await deps.getClient()
          const text = await tool.execute(args, client, deps.tracker)
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

export async function startStdio(deps: BackendDeps): Promise<void> {
  log("INFO", "Creating stdio MCP server", { pid: process.pid })
  const server = await createMcpServer(deps)
  const transport = new StdioServerTransport()

  transport.onclose = () => {
    log("WARN", "Stdio MCP transport closed (client disconnected)", { pid: process.pid })
  }
  ;(transport as any).onerror = (err: Error) => {
    logError("Stdio MCP transport error", err)
  }

  await server.connect(transport)
  log("INFO", "Stdio MCP server connected and listening", { pid: process.pid })
  process.stderr.write("[clangd-mcp] Listening on stdio\n")
}

// ── HTTP/StreamableHTTP transport (multi-session) ─────────────────────────────
//
// Each POST /mcp creates a new MCP session backed by the same LspClient.
// Clients connect with:
//   { "url": "http://localhost:<port>/mcp" }

export async function startHttp(
  deps: BackendDeps,
  port: number,
): Promise<void> {
  log("INFO", "Creating HTTP MCP server", { port, pid: process.pid })
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
        log("INFO", "Creating new HTTP MCP session", { sessionId, port })
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => sessionId,
          onsessioninitialized: (id) => {
            log("INFO", "HTTP session initialized", { sessionId: id, port })
            process.stderr.write(`[clangd-mcp] Session initialized: ${id}\n`)
          },
        })
        sessions.set(sessionId, transport)

        const server = await createMcpServer(deps)
        await server.connect(transport)

        transport.onclose = () => {
          sessions.delete(sessionId)
          log("INFO", "HTTP session closed", { sessionId, port, remainingSessions: sessions.size })
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
        log("WARN", "GET request for unknown session", { sessionId, port })
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
        log("INFO", "DELETE session request", { sessionId, port })
        await transport.handleRequest(req, res)
        sessions.delete(sessionId)
      } else {
        log("WARN", "DELETE request for unknown session", { sessionId, port })
        res.writeHead(404).end("Session not found")
      }
      return
    }

    res.writeHead(405).end("Method not allowed")
  })

  await new Promise<void>((resolve) => httpServer.listen(port, resolve))
  log("INFO", "HTTP MCP server listening", { url: `http://localhost:${port}/mcp`, port, pid: process.pid })
  process.stderr.write(`[clangd-mcp] HTTP MCP server listening on http://localhost:${port}/mcp\n`)
}

// ── Stdio → HTTP proxy (for --http-daemon-mode) ───────────────────────────────
//
// Creates a stdio MCP server that forwards every tool call to the persistent
// HTTP MCP daemon. The user's OpenCode session talks to this proxy over stdio;
// the proxy forwards to the long-lived daemon that holds the warm clangd index.
//
// This means:
//   - clangd background index stays warm across all OpenCode restarts
//   - Multiple OpenCode sessions share the same warm clangd instance
//   - Each workspace gets its own daemon on an OS-assigned free port (no config needed)

export async function startStdioProxy(httpUrl: string): Promise<void> {
  log("INFO", "Creating stdio proxy MCP client", { httpUrl, pid: process.pid })
  // Connect to the HTTP daemon as an MCP client
  const client = new Client({ name: "clangd-mcp-proxy", version: "0.1.0" })
  const transport = new StreamableHTTPClientTransport(new URL(httpUrl))

  await client.connect(transport)
  log("INFO", "Proxy connected to HTTP daemon", { httpUrl })

  // Discover the tools the daemon exposes
  const { tools: remoteTools } = await client.listTools()
  log("INFO", "Proxy discovered tools from daemon", { toolCount: remoteTools.length, httpUrl })

  // Build a local stdio MCP server that forwards each tool call to the daemon.
  // We register each tool with _meta containing the JSON schema so OpenCode
  // can see the schema, but we don't use inputSchema (which requires Zod)
  // to avoid validation that would strip parameters.
  const server = new McpServer({ name: "clangd-mcp", version: "0.1.0" })

  for (const tool of remoteTools) {
    // Convert JSON Schema to Zod shape for MCP SDK compatibility.
    // The inputSchema from listTools() is a JSON Schema object with a "properties" field.
    // We need to convert it to a Zod shape (Record<string, ZodTypeAny>) for server.tool().
    let shape: Record<string, z.ZodTypeAny> = {}
    
    if (tool.inputSchema && typeof tool.inputSchema === 'object' && 'properties' in tool.inputSchema) {
      const properties = (tool.inputSchema as any).properties
      if (properties && typeof properties === 'object') {
        // Convert each JSON Schema property to a Zod schema
        for (const [key, propSchema] of Object.entries(properties)) {
          const prop = propSchema as any
          // Create a basic Zod schema based on the JSON Schema type
          if (prop.type === 'string') {
            shape[key] = z.string().describe(prop.description || '')
          } else if (prop.type === 'number' || prop.type === 'integer') {
            shape[key] = z.number().describe(prop.description || '')
          } else if (prop.type === 'boolean') {
            shape[key] = z.boolean().describe(prop.description || '')
          } else {
            // Fallback: accept any type
            shape[key] = z.any().describe(prop.description || '')
          }
        }
      }
    }

    server.tool(
      tool.name,
      tool.description ?? "",
      shape,
      async (args: any) => {
        log("DEBUG", "Proxy forwarding tool call", { tool: tool.name, httpUrl })
        try {
          const result = await client.callTool({ name: tool.name, arguments: args })
          log("DEBUG", "Proxy tool call succeeded", { tool: tool.name })
          return result as any
        } catch (err: any) {
          logError(`Proxy tool error: ${tool.name}`, err)
          return {
            content: [{ type: "text" as const, text: `Proxy error: ${err?.message ?? String(err)}` }],
            isError: true,
          }
        }
      },
    )
  }

  const stdioTransport = new StdioServerTransport()
  stdioTransport.onclose = () => {
    log("WARN", "Stdio proxy transport closed (client disconnected)", { httpUrl, pid: process.pid })
  }

  await server.connect(stdioTransport)
  log("INFO", "Stdio proxy MCP server listening", { httpUrl, pid: process.pid })
  process.stderr.write("[clangd-mcp] Stdio proxy ready\n")
}
