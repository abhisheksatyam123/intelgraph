/**
 * test-setup.ts — Global test setup for vitest.
 * Initializes tree-sitter parser before any tests run.
 */
import { initParser } from "../src/tools/pattern-detector/c-parser.js"

export async function setup() {
  await initParser()
}
