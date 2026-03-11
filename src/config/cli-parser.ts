/**
 * cli-parser.ts — Command-line argument parsing
 */

export interface CliArgs {
  root: string
  stdio: boolean
  port: number | undefined
  httpDaemonMode: boolean
  httpDaemon: boolean
  httpPort: number | undefined
  clangdPath: string | undefined
  clangdArgs: string[] | undefined
  help: boolean
}

export function parseCliArgs(argv: string[]): CliArgs {
  const args = argv.slice(2) // strip "node" and script path

  let root = ""
  let stdio = false
  let port: number | undefined
  let httpDaemonMode = false
  let httpDaemon = false
  let httpPort: number | undefined
  let clangdPath: string | undefined
  let clangdArgs: string[] | undefined
  let help = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    if (arg === "--stdio") {
      stdio = true
    } else if (arg === "--http-daemon-mode") {
      httpDaemonMode = true
    } else if (arg === "--http-daemon") {
      httpDaemon = true
    } else if (arg === "--http-port") {
      httpPort = parseInt(args[++i] ?? "0", 10)
    } else if (arg.startsWith("--http-port=")) {
      httpPort = parseInt(arg.slice("--http-port=".length), 10)
    } else if (arg === "--root" || arg === "-r") {
      root = args[++i] ?? ""
    } else if (arg.startsWith("--root=")) {
      root = arg.slice("--root=".length)
    } else if (arg === "--port" || arg === "-p") {
      port = parseInt(args[++i] ?? "7777", 10)
    } else if (arg.startsWith("--port=")) {
      port = parseInt(arg.slice("--port=".length), 10)
    } else if (arg === "--clangd") {
      clangdPath = args[++i]
    } else if (arg.startsWith("--clangd=")) {
      clangdPath = arg.slice("--clangd=".length)
    } else if (arg === "--clangd-args") {
      clangdArgs = (args[++i] ?? "").split(",").filter(Boolean)
    } else if (arg.startsWith("--clangd-args=")) {
      clangdArgs = arg.slice("--clangd-args=".length).split(",").filter(Boolean)
    } else if (arg === "--help" || arg === "-h") {
      help = true
    }
  }

  return {
    root,
    stdio,
    port,
    httpDaemonMode,
    httpDaemon,
    httpPort,
    clangdPath,
    clangdArgs,
    help,
  }
}

export function printHelp(): void {
  process.stderr.write(`
clangd-mcp — MCP bridge server for clangd

Configuration is read from .clangd-mcp.json at the working directory.
All CLI flags are optional and override the config file.

Usage:
  clangd-mcp [--stdio | --port <number>] [options]

Options:
  --root <path>         Workspace root (default: value in .clangd-mcp.json, then process.cwd()).
  --stdio               Use stdio transport (default if --port not given).
  --port <number>       Use HTTP/StreamableHTTP transport on this port.
  --clangd <path>       Path to clangd binary (default: "clangd" from PATH).
  --clangd-args <args>  Extra args for clangd, comma-separated.
  --help, -h            Show this help message.

Persistent daemon:
  On first start, clangd is spawned as a detached background daemon.
  State is saved to <root>/.clangd-mcp-state.json.
  On subsequent starts, the MCP server reconnects to the existing daemon
  without re-indexing — giving instant startup on large codebases.

.clangd-mcp.json (place at project root, all fields optional):
  {
    "root":    "/path/to/project",
    "clangd":  "/usr/local/bin/clangd-20",
    "args":    ["--background-index", "--query-driver=/usr/bin/arm-none-eabi-gcc", "--log=error"],
    "enabled": true
  }

Examples:
  # Zero-config: reads .clangd-mcp.json, falls back to cwd + system clangd
  clangd-mcp

  # Explicit root override
  clangd-mcp --root /workspace/myproject --stdio

  # Multi-session HTTP transport
  clangd-mcp --port 7777
`)
}
