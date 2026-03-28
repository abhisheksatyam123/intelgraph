/**
 * test-setup-per-worker.ts — Per-worker test setup for vitest.
 * Initializes tree-sitter parser in each test worker process.
 * This runs in every forked worker, unlike globalSetup which only runs in the main process.
 */
import { initParser } from "../src/tools/pattern-detector/c-parser.js"

// Initialize tree-sitter before any tests run in this worker
await initParser()
