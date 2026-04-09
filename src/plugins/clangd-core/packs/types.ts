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

export type { CallPattern, InitPattern }

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
   * Optional gate. When supplied, the pack is only activated if this
   * predicate returns true for the given workspace. Use it to keep
   * project-specific patterns from polluting other workspaces.
   *
   * If omitted, the pack is always active. Generic packs (like the
   * "core" pack with universal C patterns) should leave this undefined.
   *
   * Future iterations may pass a richer probe object — for now we keep
   * the surface minimal.
   */
  appliesTo?: (workspaceRoot: string) => boolean
}
