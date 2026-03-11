/**
 * error-handler.ts — Global error handler
 */

import { getLogger } from "../logging/logger.js"
import { ClangdMcpError } from "./error-types.js"

export function handleError(error: unknown, context?: Record<string, unknown>): never {
  const logger = getLogger()

  if (error instanceof ClangdMcpError) {
    logger.error(`${error.name}: ${error.message}`, {
      code: error.code,
      ...error.context,
      ...context,
    })
  } else if (error instanceof Error) {
    logger.error(error.message, error)
  } else {
    logger.error(`Unknown error: ${String(error)}`, context)
  }

  process.exit(1)
}

export function wrapError(error: unknown, message: string): Error {
  if (error instanceof Error) {
    const wrapped = new Error(`${message}: ${error.message}`)
    wrapped.stack = error.stack
    return wrapped
  }
  return new Error(`${message}: ${String(error)}`)
}
