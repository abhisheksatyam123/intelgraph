#!/usr/bin/env node
/**
 * bridge.ts — Standalone TCP↔stdio bridge for clangd.
 *
 * This script is spawned as a DETACHED daemon by daemon.ts. It:
 *   1. Spawns clangd as a child process (stdio pipes)
 *   2. Creates a TCP server on the given port
 *   3. On each incoming TCP connection, pipes the socket ↔ clangd stdio
 *   4. Writes the clangd PID back to the state file so the MCP server can
 *      track it for liveness checks
 *   5. Exits when clangd exits (MCP server detects stale state on next start)
 *
 * CLI args:
 *   --port <number>        TCP port to listen on (required)
 *   --root <path>          Workspace root (for state file update + clangd cwd)
 *   --clangd <path>        Path to clangd binary
 *   --clangd-args <args>   Comma-separated extra args for clangd
 *   --log <path>           Log file path
 *
 * This file is bundled separately as dist/bridge.js.
 */

import { createServer, type Socket } from "net"
import { spawn } from "child_process"
import { appendFileSync, writeFileSync, readFileSync } from "fs"
import path from "path"

// ── Argument parsing ──────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  port: number
  root: string
  clangdBin: string
  clangdArgs: string[]
  logFile: string
} {
  const args = argv.slice(2)
  let port = 0
  let root = process.cwd()
  let clangdBin = "clangd"
  let clangdArgs: string[] = []
  let logFile = "/tmp/clangd-mcp-bridge.log"

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === "--port") port = parseInt(args[++i] ?? "0", 10)
    else if (a.startsWith("--port=")) port = parseInt(a.slice(7), 10)
    else if (a === "--root") root = args[++i] ?? root
    else if (a.startsWith("--root=")) root = a.slice(7)
    else if (a === "--clangd") clangdBin = args[++i] ?? clangdBin
    else if (a.startsWith("--clangd=")) clangdBin = a.slice(9)
    else if (a === "--clangd-args") clangdArgs = (args[++i] ?? "").split(",").filter(Boolean)
    else if (a.startsWith("--clangd-args=")) clangdArgs = a.slice(14).split(",").filter(Boolean)
    else if (a === "--log") logFile = args[++i] ?? logFile
    else if (a.startsWith("--log=")) logFile = a.slice(6)
  }

  if (!port) throw new Error("--port is required")
  return { port, root, clangdBin, clangdArgs, logFile }
}

// ── Logger ────────────────────────────────────────────────────────────────────

let _logFile = "/tmp/clangd-mcp-bridge.log"

function initLog(file: string): void {
  _logFile = file
  writeLine(`${"=".repeat(60)}`)
  writeLine(`clangd-mcp bridge starting — PID ${process.pid}`)
}

function writeLine(msg: string): void {
  const line = `${new Date().toISOString()} [BRIDGE] ${msg}\n`
  try { appendFileSync(_logFile, line) } catch { /* ignore */ }
  process.stderr.write(line)
}

// ── State file update ─────────────────────────────────────────────────────────

const STATE_FILE = ".clangd-mcp-state.json"

function updateStateClangdPid(root: string, clangdPid: number): void {
  const stateFile = path.join(root, STATE_FILE)
  try {
    const text = readFileSync(stateFile, "utf8")
    const state = JSON.parse(text)
    state.clangdPid = clangdPid
    writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8")
    writeLine(`Updated state file with clangd PID ${clangdPid}`)
  } catch (err) {
    writeLine(`Warning: could not update state file: ${err}`)
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { port, root, clangdBin, clangdArgs, logFile } = parseArgs(process.argv)
  initLog(logFile)

  const defaultArgs = [
    "--background-index",
    "--clang-tidy=false",
    "--completion-style=detailed",
    "--header-insertion=never",
    "--log=error",
  ]
  const finalArgs = clangdArgs.length > 0 ? clangdArgs : defaultArgs

  writeLine(`Spawning clangd: ${clangdBin} ${finalArgs.join(" ")}`)
  writeLine(`Working directory: ${root}`)

  // ── Spawn clangd ────────────────────────────────────────────────────────────
  const clangd = spawn(clangdBin, finalArgs, {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  })

  if (!clangd.pid) {
    writeLine("ERROR: Failed to spawn clangd (no PID)")
    process.exit(1)
  }

  writeLine(`clangd spawned with PID ${clangd.pid}`)

  // Update state file with clangd PID so MCP server can track it
  updateStateClangdPid(root, clangd.pid)

  // Forward clangd stderr to our log
  clangd.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trimEnd()
    try { appendFileSync(_logFile, `${new Date().toISOString()} [CLANGD] ${text}\n`) } catch { /* ignore */ }
  })

  clangd.on("error", (err) => {
    writeLine(`clangd process error: ${err.message}`)
  })

  clangd.on("exit", (code, signal) => {
    writeLine(`clangd exited (code=${code}, signal=${signal}) — bridge shutting down`)
    tcpServer.close()
    process.exit(0)
  })

  // ── TCP server ──────────────────────────────────────────────────────────────
  //
  // Each incoming connection gets its own bidirectional pipe to clangd's stdio.
  // Since clangd is a single-session server (one JSON-RPC connection), we only
  // allow one active connection at a time. A new connection replaces the old one.

  let activeSocket: Socket | null = null

  const tcpServer = createServer((socket: Socket) => {
    const remote = `${socket.remoteAddress}:${socket.remotePort}`
    writeLine(`New TCP connection from ${remote}`)

    // If there's an existing connection, destroy it (MCP server reconnected)
    if (activeSocket && !activeSocket.destroyed) {
      writeLine("Replacing previous TCP connection")
      activeSocket.destroy()
    }
    activeSocket = socket

    socket.on("error", (err) => {
      writeLine(`TCP socket error: ${err.message}`)
    })

    socket.on("close", () => {
      writeLine(`TCP connection closed (${remote})`)
      if (activeSocket === socket) activeSocket = null
    })

    // Pipe: TCP socket → clangd stdin
    socket.on("data", (chunk: Buffer) => {
      if (!clangd.stdin?.writable) {
        writeLine("Warning: clangd stdin not writable, dropping data")
        return
      }
      clangd.stdin.write(chunk, (err) => {
        if (err) writeLine(`stdin write error: ${err.message}`)
      })
    })

    // Pipe: clangd stdout → TCP socket
    const onStdout = (chunk: Buffer) => {
      if (!socket.destroyed) {
        socket.write(chunk, (err) => {
          if (err) writeLine(`socket write error: ${err.message}`)
        })
      }
    }
    clangd.stdout?.on("data", onStdout)

    socket.on("close", () => {
      clangd.stdout?.removeListener("data", onStdout)
    })
  })

  tcpServer.on("error", (err) => {
    writeLine(`TCP server error: ${err.message}`)
    process.exit(1)
  })

  await new Promise<void>((resolve) => {
    tcpServer.listen(port, "127.0.0.1", () => {
      writeLine(`TCP bridge listening on 127.0.0.1:${port}`)
      resolve()
    })
  })

  // Keep the process alive
  process.on("SIGINT", () => {
    writeLine("SIGINT received — shutting down bridge")
    tcpServer.close()
    clangd.kill()
    process.exit(0)
  })

  process.on("SIGTERM", () => {
    writeLine("SIGTERM received — shutting down bridge")
    tcpServer.close()
    clangd.kill()
    process.exit(0)
  })
}

main().catch((err) => {
  process.stderr.write(`[bridge] Fatal: ${err}\n`)
  process.exit(1)
})
