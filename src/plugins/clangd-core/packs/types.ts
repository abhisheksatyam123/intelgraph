/**
 * packs/types.ts — PatternPack contract for project-specific pattern bundles.
 *
 * The c/cpp plugin (clangd-core) is generic — it discovers symbols and direct
 * calls via clangd LSP without any project knowledge. **Project-specific
 * registration patterns** (which APIs register callbacks, how to chain a
 * callback to its runtime trigger) live in PatternPack bundles below this
 * folder, so the core plugin stays free of hardcoding.
 *
 * Architecture:
 *
 *   src/plugins/clangd-core/                    ← generic c/cpp extractor
 *   src/plugins/clangd-core/packs/              ← this folder
 *   src/plugins/clangd-core/packs/wlan/         ← Qualcomm/Atheros WLAN patterns
 *   src/plugins/clangd-core/packs/linux/        ← Linux kernel patterns
 *   src/plugins/clangd-core/packs/<future>/     ← FreeBSD, Zephyr, …
 *
 * Each pack contributes CallPattern[] (function-call style registrations
 * like `request_irq(IRQ, handler)`) and InitPattern[] (struct initializer
 * style registrations like the WMI dispatch table). Future extensions can
 * add struct-field, log-emission, and macro-based detectors via the same
 * pack contract.
 *
 * The single source of truth for the underlying CallPattern/InitPattern
 * types remains src/tools/pattern-detector/types.ts so existing call sites
 * keep working — packs re-import them from there.
 */

import type {
  CallPattern,
  InitPattern,
} from "../../../tools/pattern-detector/types.js"
import type { LogLevel } from "../../../intelligence/contracts/common.js"

export type { CallPattern, InitPattern }

// ---------------------------------------------------------------------------
// Log macro definition — the fundamental unit of log-emission detection.
// Lives in the pack so project-specific log APIs (kernel's pr_*, WLAN's
// AR_DEBUG_PRINTF, etc.) are captured without touching the core extractor.
// ---------------------------------------------------------------------------

export interface LogMacroDef {
  /** The function / macro name as it appears in source (e.g. "pr_info"). */
  name: string

  /** Log level this macro implies (e.g. "INFO" for pr_info). */
  level: LogLevel

  /**
   * 0-based index of the format-string argument. Most C log macros put
   * the format string first (`pr_info("fmt", ...)` → 0). `dev_info` puts
   * it second (`dev_info(dev, "fmt", ...)` → 1).
   */
  formatArgIndex: number

  /**
   * Optional subsystem tag to attach. When set, every log emitted by this
   * macro gets this subsystem value. When absent, the extractor may try to
   * derive it from the format string's prefix (e.g. "BPF: ..." → "BPF").
   */
  subsystem?: string
}

// ---------------------------------------------------------------------------
// Dispatch chain template — pre-built runtime dispatch paths for
// registration APIs whose kernel/framework dispatch architecture is
// architecturally fixed and can't be inferred by LSP alone.
// ---------------------------------------------------------------------------

export interface DispatchChainTemplate {
  /**
   * The registration API this template applies to. For function-call
   * registrations this is the API name (e.g. "request_irq"). For
   * struct-field registrations, use the synthetic key format
   * `__struct_field:<struct_type>.<field>` (e.g.
   * `__struct_field:file_operations.read`).
   */
  registrationApi: string

  /**
   * The fixed runtime dispatch chain from trigger to callback. Use
   * `%CALLBACK%` as a placeholder for the actual callback function name
   * and `%KEY%` for the dispatch key (e.g. IRQ number).
   */
  chain: string[]

  /** What kind of external event triggers this dispatch path. */
  triggerKind: "hardware_interrupt" | "timer_expiry" | "workqueue" | "signal" | "event"

  /**
   * Human-readable description template. `%KEY%` is replaced with the
   * dispatch key extracted from the registration site.
   */
  triggerDescription: string
}

export interface PatternPack {
  /** Unique pack identifier (lowercase, kebab-case). */
  name: string

  /** One-line description of what project / family this pack covers. */
  description: string

  /** Function-call style registration patterns this pack contributes. */
  callPatterns: readonly CallPattern[]

  /** Struct-initializer registration patterns this pack contributes. */
  initPatterns: readonly InitPattern[]

  /**
   * Log-emission macro definitions this pack contributes. During the
   * tree-sitter AST walk, any call_expression whose callee matches a
   * LogMacroDef.name from an active pack emits a `logs_event` edge from
   * the enclosing function to the log site, with the format string, log
   * level, and subsystem captured in the edge metadata.
   */
  logMacros: readonly LogMacroDef[]

  /**
   * Pre-built dispatch chain templates for registration APIs whose
   * runtime dispatch path is architecturally fixed. When the resolver's
   * LSP-based store/dispatch/trigger stages fail (common for kernel
   * macros/inlines), it falls back to these templates to fill the chain.
   */
  dispatchChains: readonly DispatchChainTemplate[]

  /**
   * Optional gate. When supplied, the pack is only activated if this
   * predicate returns true for the given workspace. Use it to keep
   * project-specific patterns from polluting other workspaces.
   */
  appliesTo?: (workspaceRoot: string) => boolean
}
