/**
 * error-types.ts — Custom error classes for structured error handling
 */

export class ClangdMcpError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "ClangdMcpError"
    Error.captureStackTrace(this, this.constructor)
  }
}

export class ConfigurationError extends ClangdMcpError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "CONFIG_ERROR", context)
    this.name = "ConfigurationError"
  }
}

export class DaemonError extends ClangdMcpError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "DAEMON_ERROR", context)
    this.name = "DaemonError"
  }
}

export class LspError extends ClangdMcpError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "LSP_ERROR", context)
    this.name = "LspError"
  }
}

export class TransportError extends ClangdMcpError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "TRANSPORT_ERROR", context)
    this.name = "TransportError"
  }
}

export class ToolError extends ClangdMcpError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "TOOL_ERROR", context)
    this.name = "ToolError"
  }
}

export class ValidationError extends ClangdMcpError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "VALIDATION_ERROR", context)
    this.name = "ValidationError"
  }
}
