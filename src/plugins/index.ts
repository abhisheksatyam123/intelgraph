/**
 * plugins/index.ts — static plugin registry.
 *
 * Lists every in-tree extractor plugin. The ExtractorRunner consumes this
 * list (or a filtered subset of it) when ingest-tool starts a snapshot.
 *
 * Adding a plugin:
 *   1. Create a new directory under src/plugins/<name>/
 *   2. Implement the IExtractor contract via defineExtractor()
 *   3. Add the import + array entry below
 *
 * Future (Problem 6): plugin discovery from disk and npm packages will
 * replace this static list with a manifest-driven loader. Until then the
 * compile-time list keeps things simple and type-safe.
 */

import type { IExtractor } from "../intelligence/extraction/contract.js"
import { clangdCoreExtractor } from "./clangd-core/index.js"
import { tsCoreExtractor } from "./ts-core/index.js"

export const BUILT_IN_EXTRACTORS: IExtractor[] = [
  clangdCoreExtractor,
  tsCoreExtractor,
]

export { clangdCoreExtractor, tsCoreExtractor }
