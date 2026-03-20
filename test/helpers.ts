/**
 * Shared test helpers and utilities
 */

import { spawn, type ChildProcess } from "child_process"
import { createServer } from "net"

/**
 * Find a free TCP port by binding to port 0
 */
export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      if (!addr || typeof addr === "string") {
        server.close()
        return reject(new Error("Could not determine free port"))
      }
      const port = addr.port
      server.close(() => resolve(port))
    })
    server.on("error", reject)
  })
}

/**
 * Wait for a TCP port to become available
 */
export async function waitForPort(port: number, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = new (require("net").Socket)()
        socket.setTimeout(500)
        socket.once("connect", () => {
          socket.destroy()
          resolve()
        })
        socket.once("timeout", () => {
          socket.destroy()
          reject(new Error("timeout"))
        })
        socket.once("error", reject)
        socket.connect(port, "127.0.0.1")
      })
      return true
    } catch {
      await new Promise(r => setTimeout(r, 300))
    }
  }
  return false
}

/**
 * Spawn a detached process and return when it's ready
 */
export async function spawnDetached(
  command: string,
  args: string[],
  readyPattern: RegExp,
  timeoutMs = 10000
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let output = ""
    const timeout = setTimeout(() => {
      proc.kill()
      reject(new Error(`Process did not become ready within ${timeoutMs}ms`))
    }, timeoutMs)

    proc.stderr?.on("data", (data) => {
      output += data.toString()
      if (readyPattern.test(output)) {
        clearTimeout(timeout)
        resolve(proc)
      }
    })

    proc.on("error", (err) => {
      clearTimeout(timeout)
      reject(err)
    })

    proc.on("exit", (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        reject(new Error(`Process exited with code ${code}`))
      }
    })
  })
}

/**
 * Clean up test artifacts
 */
export function cleanupTestArtifacts(root: string): void {
  const fs = require("fs")
  const path = require("path")
  
  const artifacts = [
    path.join(root, ".clangd-mcp-state.json"),
    path.join(root, ".clangd-mcp-spawn.lock"),
    path.join(root, "clangd-mcp.log"),
    path.join(root, "clangd-mcp-bridge.log"),
  ]
  
  for (const file of artifacts) {
    try {
      fs.unlinkSync(file)
    } catch {
      // ignore if file doesn't exist
    }
  }
}
