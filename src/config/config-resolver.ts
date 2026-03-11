/**
 * config-resolver.ts — Configuration merging and resolution
 */

import { WorkspaceConfig } from "./workspace-config.js"
import { CliArgs } from "./cli-parser.js"

export interface ResolvedConfig {
  root: string
  clangdPath: string
  clangdArgs: string[]
  transport: "stdio" | "http" | "http-daemon" | "http-daemon-mode"
  port?: number
  httpPort?: number
}

export function resolveConfig(
  cli: CliArgs,
  workspace: WorkspaceConfig,
  cwd: string,
): ResolvedConfig {
  // Merge precedence: CLI flag > .clangd-mcp.json > default (cwd / system clangd)
  const root = cli.root || workspace.root || cwd
  const clangdPath = cli.clangdPath || workspace.clangd || "clangd"
  const clangdArgs = cli.clangdArgs || workspace.args || []

  // Determine transport mode
  let transport: ResolvedConfig["transport"]
  if (cli.httpDaemon) {
    transport = "http-daemon"
  } else if (cli.httpDaemonMode) {
    transport = "http-daemon-mode"
  } else if (cli.port !== undefined) {
    transport = "http"
  } else {
    transport = "stdio"
  }

  return {
    root,
    clangdPath,
    clangdArgs,
    transport,
    port: cli.port,
    httpPort: cli.httpPort,
  }
}

export function getDefaultClangdArgs(): string[] {
  return [
    "--background-index",
    "--clang-tidy=false",
    "--completion-style=detailed",
    "--header-insertion=never",
    "--log=error",
  ]
}
