/**
 * services/index.ts — barrel re-exports for the four parsing services
 * exposed to plugin extractors via ctx.{lsp, treesitter, ripgrep, workspace}.
 */

export type {
  LspService,
  LspServiceLogger,
  LspCallResult,
  LspErrorClass,
} from "./lsp-service.js"
export { LspServiceImpl, classifyLspError } from "./lsp-service.js"

export type {
  TreeSitterService,
  FunctionCall,
} from "./treesitter-service.js"
export { TreeSitterServiceImpl } from "./treesitter-service.js"

export type {
  RipgrepService,
  RipgrepMatch,
  RipgrepSearchOptions,
  RipgrepServiceLogger,
} from "./ripgrep-service.js"
export { RipgrepServiceImpl, RipgrepUnavailable } from "./ripgrep-service.js"

export type {
  WorkspaceService,
  WalkFilesOptions,
  CompileCommandEntry,
} from "./workspace-service.js"
export { WorkspaceServiceImpl } from "./workspace-service.js"
