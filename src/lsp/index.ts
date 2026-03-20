/**
 * LspClient — spawns clangd, sets up JSON-RPC over stdio, sends initialize,
 * and exposes typed wrappers for every LSP operation we need.
 */

import { spawn, type ChildProcess } from "child_process"
import { createConnection } from "net"
import { pathToFileURL, fileURLToPath } from "url"
import path from "path"
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  SocketMessageReader,
  SocketMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node.js"
import { IndexTracker } from "../tracking/index.js"
import { log, logError } from "../logger.js"

// ── Language extension → LSP languageId map ──────────────────────────────────
const LANGUAGE_EXTENSIONS: Record<string, string> = {
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".hh": "cpp",
  ".cu": "cuda",
  ".cuh": "cuda",
  ".m": "objective-c",
  ".mm": "objective-cpp",
}

export interface LspClientOptions {
  /** Absolute path to the workspace / compile_commands.json directory */
  root: string
  /** Path to clangd binary (default: "clangd" from PATH) */
  clangdPath?: string
  /** Extra args forwarded to clangd */
  clangdArgs?: string[]
  /** Called when clangd exits unexpectedly */
  onExit?: (code: number | null) => void
  /** Shared index tracker instance */
  indexTracker?: IndexTracker
}

export class LspClient {
  private _proc: ChildProcess
  private _conn: MessageConnection
  private _openFiles = new Map<string, number>()   // path → version
  private _diagnostics = new Map<string, any[]>()  // path → diagnostics
  private _shuttingDown = false                     // prevents onExit from firing during clean shutdown
  readonly indexTracker: IndexTracker
  readonly root: string

  private constructor(
    proc: ChildProcess,
    conn: MessageConnection,
    root: string,
    indexTracker: IndexTracker,
  ) {
    this._proc = proc
    this._conn = conn
    this.root = root
    this.indexTracker = indexTracker
  }

  // ── Factory ────────────────────────────────────────────────────────────────

  static async create(opts: LspClientOptions): Promise<LspClient> {
    const clangdBin = opts.clangdPath ?? "clangd"
    const clangdArgs = opts.clangdArgs ?? [
      "--background-index",
      "--clang-tidy=false",
      "--completion-style=detailed",
      "--header-insertion=never",
      "--log=error",
    ]

    log("INFO", `Spawning clangd: ${clangdBin} ${clangdArgs.join(" ")}`)
    log("INFO", `Working directory: ${opts.root}`)

    const proc = spawn(clangdBin, clangdArgs, {
      cwd: opts.root,
      stdio: ["pipe", "pipe", "pipe"],
    })

    log("INFO", `clangd spawned with PID ${proc.pid}`)

    if (!proc.stdout || !proc.stdin) {
      throw new Error("Failed to open clangd stdio streams")
    }

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trimEnd()
      // Write clangd's own stderr to our log file
      try {
        const { appendFileSync } = require("fs") as typeof import("fs")
        const { getLogFile } = require("../logger.js") as typeof import("./logger.js")
        appendFileSync(getLogFile(), `${new Date().toISOString()} [CLANGD] ${text}\n`)
      } catch { /* ignore */ }
      process.stderr.write(`[clangd] ${text}\n`)
    })

    proc.on("error", (err) => {
      logError(`clangd process error (PID ${proc.pid})`, err)
    })

    proc.stdout.on("error", (err) => {
      logError("clangd stdout stream error", err)
    })

    proc.stdin.on("error", (err) => {
      // EPIPE is expected when clangd exits — log but don't crash
      log("WARN", `clangd stdin stream error: ${err.message} (code=${(err as any).code})`)
    })

    const conn = createMessageConnection(
      new StreamMessageReader(proc.stdout as any),
      new StreamMessageWriter(proc.stdin as any),
    )

    // ── Connection lifecycle handlers (CRITICAL — prevents silent crashes) ────
    conn.onClose(() => {
      log("WARN", "JSON-RPC connection to clangd closed")
    })

    conn.onError((err) => {
      // err is [Error, number|undefined, number|undefined]
      const [error, code, count] = err as [Error, number | undefined, number | undefined]
      logError(`JSON-RPC connection error (code=${code}, count=${count})`, error)
    })

    const tracker = opts.indexTracker ?? new IndexTracker()

    // ── Wire up server-side requests / notifications ──────────────────────────
    conn.onRequest("window/workDoneProgress/create", (params: any) => {
      tracker.onProgressCreate(params.token)
      return null
    })
    conn.onNotification("$/progress", (params: any) => {
      tracker.onProgress(params.token, params.value)
    })
    // Per-file parse state (clangd extension)
    conn.onNotification("clangd/fileStatus", (params: any) => {
      if (params?.uri && params?.state) {
        tracker.onFileStatus(params.uri, params.state)
      }
    })
    conn.onRequest("workspace/configuration", () => [{}])
    conn.onRequest("client/registerCapability", () => {})
    conn.onRequest("client/unregisterCapability", () => {})
    conn.onRequest("workspace/workspaceFolders", () => [
      { name: "workspace", uri: pathToFileURL(opts.root).href },
    ])

    conn.listen()
    log("INFO", "JSON-RPC connection listening")

    // ── Initialize ────────────────────────────────────────────────────────────
    log("INFO", "Sending LSP initialize request…")
    await conn.sendRequest("initialize", {
      rootUri: pathToFileURL(opts.root).href,
      processId: proc.pid ?? null,
      workspaceFolders: [
        { name: "workspace", uri: pathToFileURL(opts.root).href },
      ],
      initializationOptions: {},
      capabilities: {
        window: { workDoneProgress: true },
        workspace: {
          configuration: true,
          didChangeWatchedFiles: { dynamicRegistration: true },
          symbol: { resolveSupport: { properties: ["location.range"] } },
          workspaceEdit: {
            documentChanges: true,
            resourceOperations: ["create", "rename", "delete"],
          },
        },
        textDocument: {
          synchronization: { didOpen: true, didChange: true, didClose: true },
          publishDiagnostics: { versionSupport: true, relatedInformation: true },
          hover: { contentFormat: ["plaintext", "markdown"] },
          definition: { linkSupport: true },
          declaration: { linkSupport: true },
          typeDefinition: { linkSupport: true },
          references: {},
          implementation: { linkSupport: true },
          documentHighlight: {},
          callHierarchy: { dynamicRegistration: true },
          typeHierarchy: { dynamicRegistration: true },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          foldingRange: { dynamicRegistration: true, lineFoldingOnly: true },
          selectionRange: { dynamicRegistration: true },
          signatureHelp: {
            dynamicRegistration: true,
            signatureInformation: {
              documentationFormat: ["plaintext", "markdown"],
              parameterInformation: { labelOffsetSupport: true },
              activeParameterSupport: true,
            },
            contextSupport: true,
          },
          rename: {
            dynamicRegistration: true,
            prepareSupport: true,
          },
          formatting: { dynamicRegistration: true },
          rangeFormatting: { dynamicRegistration: true },
          semanticTokens: {
            dynamicRegistration: true,
            requests: { full: true, range: true },
            tokenTypes: [],
            tokenModifiers: [],
            formats: ["relative"],
          },
          codeAction: {
            dynamicRegistration: true,
            codeActionLiteralSupport: {
              codeActionKind: { valueSet: ["quickfix", "refactor", "source"] },
            },
            resolveSupport: { properties: ["edit"] },
          },
          inlayHint: {
            dynamicRegistration: true,
            resolveSupport: { properties: [] },
          },
        },
      },
    })

    await conn.sendNotification("initialized", {})
    log("INFO", "LSP initialized successfully")

    const client = new LspClient(proc, conn, opts.root, tracker)

    conn.onNotification("textDocument/publishDiagnostics", (params: any) => {
      try {
        const filePath = fileURLToPath(params.uri)
        const diags = params.diagnostics ?? []
        client._diagnostics.set(filePath, diags)
        if (diags.length > 0) {
          log("DEBUG", `Diagnostics for ${path.basename(filePath)}: ${diags.length} item(s)`)
        }
      } catch {
        // ignore malformed URIs
      }
    })

    proc.on("exit", (code, signal) => {
      log("WARN", `clangd process exited`, { pid: proc.pid, code, signal })
      if (!client._shuttingDown && opts.onExit) opts.onExit(code)
    })

    return client
  }

  // ── Socket factory (reconnect to existing daemon) ─────────────────────────

  /**
   * Connect to an already-running clangd TCP bridge on the given port and
   * return a fully initialized LspClient.
   *
   * This is the fast path used when the daemon is already alive from a
   * previous MCP server session.
   *
   * @param skipInit  When true, skip the LSP initialize/initialized handshake
   *                  (use this when reconnecting to an already-initialized clangd).
   *                  When false (first connection), send the full handshake.
   */
  static async createFromSocket(
    port: number,
    root: string,
    indexTracker?: IndexTracker,
    skipInit = false,
  ): Promise<LspClient> {
    log("INFO", `Connecting to clangd bridge on 127.0.0.1:${port} (skipInit=${skipInit})`)

    const socket = createConnection({ port, host: "127.0.0.1" })

    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve)
      socket.once("error", reject)
    })

    log("INFO", `TCP connection established to port ${port}`)

    const conn = createMessageConnection(
      new SocketMessageReader(socket),
      new SocketMessageWriter(socket),
    )

    conn.onClose(() => {
      log("WARN", "JSON-RPC connection to clangd bridge closed")
    })
    conn.onError((err) => {
      const [error, code, count] = err as [Error, number | undefined, number | undefined]
      logError(`JSON-RPC connection error (code=${code}, count=${count})`, error)
    })

    const tracker = indexTracker ?? new IndexTracker()

    // Wire up server-side requests / notifications (same as stdio path)
    conn.onRequest("window/workDoneProgress/create", (params: any) => {
      tracker.onProgressCreate(params.token)
      return null
    })
    conn.onNotification("$/progress", (params: any) => {
      tracker.onProgress(params.token, params.value)
    })
    conn.onNotification("clangd/fileStatus", (params: any) => {
      if (params?.uri && params?.state) {
        tracker.onFileStatus(params.uri, params.state)
      }
    })
    conn.onRequest("workspace/configuration", () => [{}])
    conn.onRequest("client/registerCapability", () => {})
    conn.onRequest("client/unregisterCapability", () => {})
    conn.onRequest("workspace/workspaceFolders", () => [
      { name: "workspace", uri: pathToFileURL(root).href },
    ])

    conn.listen()
    log("INFO", "JSON-RPC connection listening (socket)")

    if (!skipInit) {
      log("INFO", "Sending LSP initialize request (socket)…")
      await conn.sendRequest("initialize", {
        rootUri: pathToFileURL(root).href,
        processId: null,
        workspaceFolders: [{ name: "workspace", uri: pathToFileURL(root).href }],
        initializationOptions: {},
        capabilities: {
          window: { workDoneProgress: true },
          workspace: {
            configuration: true,
            didChangeWatchedFiles: { dynamicRegistration: true },
            symbol: { resolveSupport: { properties: ["location.range"] } },
            workspaceEdit: {
              documentChanges: true,
              resourceOperations: ["create", "rename", "delete"],
            },
          },
          textDocument: {
            synchronization: { didOpen: true, didChange: true, didClose: true },
            publishDiagnostics: { versionSupport: true, relatedInformation: true },
            hover: { contentFormat: ["plaintext", "markdown"] },
            definition: { linkSupport: true },
            declaration: { linkSupport: true },
            typeDefinition: { linkSupport: true },
            references: {},
            implementation: { linkSupport: true },
            documentHighlight: {},
            callHierarchy: { dynamicRegistration: true },
            typeHierarchy: { dynamicRegistration: true },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            foldingRange: { dynamicRegistration: true, lineFoldingOnly: true },
            selectionRange: { dynamicRegistration: true },
            signatureHelp: {
              dynamicRegistration: true,
              signatureInformation: {
                documentationFormat: ["plaintext", "markdown"],
                parameterInformation: { labelOffsetSupport: true },
                activeParameterSupport: true,
              },
              contextSupport: true,
            },
            rename: { dynamicRegistration: true, prepareSupport: true },
            formatting: { dynamicRegistration: true },
            rangeFormatting: { dynamicRegistration: true },
            semanticTokens: {
              dynamicRegistration: true,
              requests: { full: true, range: true },
              tokenTypes: [],
              tokenModifiers: [],
              formats: ["relative"],
            },
            codeAction: {
              dynamicRegistration: true,
              codeActionLiteralSupport: {
                codeActionKind: { valueSet: ["quickfix", "refactor", "source"] },
              },
              resolveSupport: { properties: ["edit"] },
            },
            inlayHint: {
              dynamicRegistration: true,
              resolveSupport: { properties: [] },
            },
          },
        },
      })

      await conn.sendNotification("initialized", {})
      log("INFO", "LSP initialized successfully (socket)")
    } else {
      log("INFO", "Skipping LSP initialize (reconnecting to already-initialized clangd)")
    }

    // createFromSocket has no ChildProcess — pass a dummy proc object
    const dummyProc = { pid: undefined, kill: () => {}, stdin: null, stdout: null, stderr: null } as unknown as ChildProcess
    const client = new LspClient(dummyProc, conn, root, tracker)

    conn.onNotification("textDocument/publishDiagnostics", (params: any) => {
      try {
        const filePath = fileURLToPath(params.uri)
        const diags = params.diagnostics ?? []
        client._diagnostics.set(filePath, diags)
        if (diags.length > 0) {
          log("DEBUG", `Diagnostics for ${path.basename(filePath)}: ${diags.length} item(s)`)
        }
      } catch {
        // ignore malformed URIs
      }
    })

    return client
  }

  // ── File management ────────────────────────────────────────────────────────

  async openFile(filePath: string, text: string): Promise<boolean> {
    const uri = pathToFileURL(filePath).href
    const ext = path.extname(filePath)
    const languageId = LANGUAGE_EXTENSIONS[ext] ?? "cpp"

    const version = this._openFiles.get(filePath)
    if (version !== undefined) {
      const next = version + 1
      this._openFiles.set(filePath, next)
      await this._conn.sendNotification("textDocument/didChange", {
        textDocument: { uri, version: next },
        contentChanges: [{ text }],
      })
      return false
    } else {
      log("DEBUG", `Opening file: ${path.basename(filePath)} (${languageId})`)
      this._openFiles.set(filePath, 0)
      await this._conn.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 0, text },
      })
      await new Promise((r) => setImmediate(r))
      return true
    }
  }

  getDiagnostics(filePath?: string): Map<string, any[]> | any[] {
    if (filePath) return this._diagnostics.get(filePath) ?? []
    return this._diagnostics
  }

  // ── LSP requests ───────────────────────────────────────────────────────────

  private _uri(filePath: string) { return pathToFileURL(filePath).href }
  private _pos(line: number, character: number) { return { line, character } }

  async hover(filePath: string, line: number, character: number): Promise<any> {
    return this._conn
      .sendRequest("textDocument/hover", {
        textDocument: { uri: this._uri(filePath) },
        position: this._pos(line, character),
      })
      .catch(() => null)
  }

  async definition(filePath: string, line: number, character: number): Promise<any[]> {
    return this._conn
      .sendRequest("textDocument/definition", {
        textDocument: { uri: this._uri(filePath) },
        position: this._pos(line, character),
      })
      .then((r: any) => (Array.isArray(r) ? r : r ? [r] : []))
      .catch(() => [])
  }

  async declaration(filePath: string, line: number, character: number): Promise<any[]> {
    return this._conn
      .sendRequest("textDocument/declaration", {
        textDocument: { uri: this._uri(filePath) },
        position: this._pos(line, character),
      })
      .then((r: any) => (Array.isArray(r) ? r : r ? [r] : []))
      .catch(() => [])
  }

  async typeDefinition(filePath: string, line: number, character: number): Promise<any[]> {
    return this._conn
      .sendRequest("textDocument/typeDefinition", {
        textDocument: { uri: this._uri(filePath) },
        position: this._pos(line, character),
      })
      .then((r: any) => (Array.isArray(r) ? r : r ? [r] : []))
      .catch(() => [])
  }

  async references(filePath: string, line: number, character: number): Promise<any[]> {
    return this._conn
      .sendRequest("textDocument/references", {
        textDocument: { uri: this._uri(filePath) },
        position: this._pos(line, character),
        context: { includeDeclaration: true },
      })
      .then((r: any) => (Array.isArray(r) ? r : []))
      .catch(() => [])
  }

  async implementation(filePath: string, line: number, character: number): Promise<any[]> {
    return this._conn
      .sendRequest("textDocument/implementation", {
        textDocument: { uri: this._uri(filePath) },
        position: this._pos(line, character),
      })
      .then((r: any) => (Array.isArray(r) ? r : r ? [r] : []))
      .catch(() => [])
  }

  async documentHighlight(filePath: string, line: number, character: number): Promise<any[]> {
    return this._conn
      .sendRequest("textDocument/documentHighlight", {
        textDocument: { uri: this._uri(filePath) },
        position: this._pos(line, character),
      })
      .then((r: any) => (Array.isArray(r) ? r : []))
      .catch(() => [])
  }

  async documentSymbol(filePath: string): Promise<any[]> {
    return this._conn
      .sendRequest("textDocument/documentSymbol", {
        textDocument: { uri: this._uri(filePath) },
      })
      .then((r: any) => (Array.isArray(r) ? r : []))
      .catch(() => [])
  }

  async workspaceSymbol(query: string): Promise<any[]> {
    return this._conn
      .sendRequest("workspace/symbol", { query })
      .then((r: any) => (Array.isArray(r) ? r : []))
      .catch(() => [])
  }

  async foldingRange(filePath: string): Promise<any[]> {
    return this._conn
      .sendRequest("textDocument/foldingRange", {
        textDocument: { uri: this._uri(filePath) },
      })
      .then((r: any) => (Array.isArray(r) ? r : []))
      .catch(() => [])
  }

  async signatureHelp(filePath: string, line: number, character: number): Promise<any> {
    return this._conn
      .sendRequest("textDocument/signatureHelp", {
        textDocument: { uri: this._uri(filePath) },
        position: this._pos(line, character),
        context: { triggerKind: 1, isRetrigger: false },
      })
      .catch(() => null)
  }

  async prepareRename(filePath: string, line: number, character: number): Promise<any> {
    return this._conn
      .sendRequest("textDocument/prepareRename", {
        textDocument: { uri: this._uri(filePath) },
        position: this._pos(line, character),
      })
      .catch(() => null)
  }

  async rename(filePath: string, line: number, character: number, newName: string): Promise<any> {
    return this._conn
      .sendRequest("textDocument/rename", {
        textDocument: { uri: this._uri(filePath) },
        position: this._pos(line, character),
        newName,
      })
      .catch(() => null)
  }

  async formatting(filePath: string): Promise<any[]> {
    return this._conn
      .sendRequest("textDocument/formatting", {
        textDocument: { uri: this._uri(filePath) },
        options: { tabSize: 4, insertSpaces: true },
      })
      .then((r: any) => (Array.isArray(r) ? r : []))
      .catch(() => [])
  }

  async rangeFormatting(
    filePath: string,
    startLine: number, startChar: number,
    endLine: number, endChar: number,
  ): Promise<any[]> {
    return this._conn
      .sendRequest("textDocument/rangeFormatting", {
        textDocument: { uri: this._uri(filePath) },
        range: {
          start: { line: startLine, character: startChar },
          end:   { line: endLine,   character: endChar   },
        },
        options: { tabSize: 4, insertSpaces: true },
      })
      .then((r: any) => (Array.isArray(r) ? r : []))
      .catch(() => [])
  }

  async inlayHints(filePath: string, startLine: number, endLine: number): Promise<any[]> {
    return this._conn
      .sendRequest("textDocument/inlayHint", {
        textDocument: { uri: this._uri(filePath) },
        range: {
          start: { line: startLine, character: 0 },
          end:   { line: endLine,   character: 0 },
        },
      })
      .then((r: any) => (Array.isArray(r) ? r : []))
      .catch(() => [])
  }

  async prepareCallHierarchy(filePath: string, line: number, character: number): Promise<any[]> {
    const startedAt = Date.now()
    log("INFO", "call-hierarchy prepare start", { filePath, line, character })
    return this._conn
      .sendRequest("textDocument/prepareCallHierarchy", {
        textDocument: { uri: this._uri(filePath) },
        position: this._pos(line, character),
      })
      .then((r: any) => {
        const items = Array.isArray(r) ? r : []
        const first = items[0]?.name ?? null
        log("INFO", "call-hierarchy prepare result", {
          filePath,
          line,
          character,
          count: items.length,
          first,
          durationMs: Date.now() - startedAt,
        })
        return items
      })
      .catch((err: any) => {
        logError("call-hierarchy prepare failed", err)
        return []
      })
  }

  async incomingCalls(filePath: string, line: number, character: number): Promise<any[]> {
    const startedAt = Date.now()
    log("INFO", "call-hierarchy incoming start", { filePath, line, character })
    const items = await this.prepareCallHierarchy(filePath, line, character)
    if (!items.length) {
      log("WARN", "call-hierarchy incoming skipped: no prepare item", {
        filePath,
        line,
        character,
        durationMs: Date.now() - startedAt,
      })
      return []
    }
    const seed = items[0]?.name ?? null
    return this._conn
      .sendRequest("callHierarchy/incomingCalls", { item: items[0] })
      .then((r: any) => {
        const calls = Array.isArray(r) ? r : []
        log("INFO", "call-hierarchy incoming result", {
          filePath,
          line,
          character,
          seed,
          count: calls.length,
          durationMs: Date.now() - startedAt,
        })
        return calls
      })
      .catch((err: any) => {
        logError("call-hierarchy incoming failed", err)
        return []
      })
  }

  async outgoingCalls(filePath: string, line: number, character: number): Promise<any[]> {
    const startedAt = Date.now()
    log("INFO", "call-hierarchy outgoing start", { filePath, line, character })
    const items = await this.prepareCallHierarchy(filePath, line, character)
    if (!items.length) {
      log("WARN", "call-hierarchy outgoing skipped: no prepare item", {
        filePath,
        line,
        character,
        durationMs: Date.now() - startedAt,
      })
      return []
    }
    const seed = items[0]?.name ?? null
    return this._conn
      .sendRequest("callHierarchy/outgoingCalls", { item: items[0] })
      .then((r: any) => {
        const calls = Array.isArray(r) ? r : []
        log("INFO", "call-hierarchy outgoing result", {
          filePath,
          line,
          character,
          seed,
          count: calls.length,
          durationMs: Date.now() - startedAt,
        })
        return calls
      })
      .catch((err: any) => {
        logError("call-hierarchy outgoing failed", err)
        return []
      })
  }

  async prepareTypeHierarchy(filePath: string, line: number, character: number): Promise<any[]> {
    return this._conn
      .sendRequest("textDocument/prepareTypeHierarchy", {
        textDocument: { uri: this._uri(filePath) },
        position: this._pos(line, character),
      })
      .then((r: any) => (Array.isArray(r) ? r : []))
      .catch(() => [])
  }

  async supertypes(filePath: string, line: number, character: number): Promise<any[]> {
    const items = await this.prepareTypeHierarchy(filePath, line, character)
    if (!items.length) return []
    return this._conn
      .sendRequest("typeHierarchy/supertypes", { item: items[0] })
      .then((r: any) => (Array.isArray(r) ? r : []))
      .catch(() => [])
  }

  async subtypes(filePath: string, line: number, character: number): Promise<any[]> {
    const items = await this.prepareTypeHierarchy(filePath, line, character)
    if (!items.length) return []
    return this._conn
      .sendRequest("typeHierarchy/subtypes", { item: items[0] })
      .then((r: any) => (Array.isArray(r) ? r : []))
      .catch(() => [])
  }

  async codeAction(filePath: string, line: number, character: number): Promise<any[]> {
    const fileDiags = this._diagnostics.get(filePath) ?? []
    const range = {
      start: { line, character },
      end:   { line, character },
    }
    return this._conn
      .sendRequest("textDocument/codeAction", {
        textDocument: { uri: this._uri(filePath) },
        range,
        context: { diagnostics: fileDiags },
      })
      .then((r: any) => (Array.isArray(r) ? r : []))
      .catch(() => [])
  }

  async semanticTokensFull(filePath: string): Promise<any> {
    return this._conn
      .sendRequest("textDocument/semanticTokens/full", {
        textDocument: { uri: this._uri(filePath) },
      })
      .catch(() => null)
  }

  async clangdInfo(): Promise<any> {
    return this._conn.sendRequest("$/clangd/info", {}).catch(() => null)
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    this._shuttingDown = true
    log("INFO", "Shutting down LSP connection…")
    try {
      await this._conn.sendRequest("shutdown", {})
      await this._conn.sendNotification("exit", {})
      log("INFO", "LSP shutdown request sent")
    } catch (err) {
      logError("Error during LSP shutdown (ignored)", err)
    }
    this._conn.end()
    this._conn.dispose()
    // Only kill the process if we own it (stdio mode). In socket mode the
    // bridge/clangd are daemons that should keep running.
    if (this._proc.pid) {
      this._proc.kill()
      log("INFO", `clangd process killed (PID ${this._proc.pid})`)
    }
  }
}
