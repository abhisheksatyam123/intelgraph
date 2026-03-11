/**
 * workspace-config.ts — Workspace configuration (.clangd-mcp.json) handling
 */

import { readFileSync } from "fs"
import path from "path"
import { ConfigurationError } from "../errors/error-types.js"

export interface WorkspaceConfig {
  root?: string
  clangd?: string
  args?: string[]
  enabled?: boolean
}

export function readWorkspaceConfig(dir: string): WorkspaceConfig {
  const configPath = path.join(dir, ".clangd-mcp.json")
  
  try {
    const text = readFileSync(configPath, "utf8")
    const config = JSON.parse(text) as WorkspaceConfig
    
    // Validate config structure
    if (config.root !== undefined && typeof config.root !== "string") {
      throw new ConfigurationError("Invalid config: 'root' must be a string", { configPath })
    }
    if (config.clangd !== undefined && typeof config.clangd !== "string") {
      throw new ConfigurationError("Invalid config: 'clangd' must be a string", { configPath })
    }
    if (config.args !== undefined && !Array.isArray(config.args)) {
      throw new ConfigurationError("Invalid config: 'args' must be an array", { configPath })
    }
    if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
      throw new ConfigurationError("Invalid config: 'enabled' must be a boolean", { configPath })
    }
    
    return config
  } catch (err) {
    if ((err as any).code === "ENOENT") {
      // File missing — all fields default
      return {}
    }
    
    if (err instanceof ConfigurationError) {
      throw err
    }
    
    throw new ConfigurationError(
      `Failed to read workspace config: ${(err as Error).message}`,
      { configPath },
    )
  }
}

export function isConfigEnabled(config: WorkspaceConfig): boolean {
  return config.enabled !== false
}
