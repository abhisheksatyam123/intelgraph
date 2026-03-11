# clangd-mcp Test Suite

Comprehensive test suite for the clangd-mcp multiplexing bridge. Tests use **real symbols** from the WLAN workspace and **clangd-20**. Every test validates actual content — not just "no error".

## Test Structure

```
test/
  helpers.ts                        ← Shared fixtures, assertions, MCP client
  unit/                             ← Pure logic tests (no clangd)
    lsp-frame-parser.test.ts        ← LSP framing, chunking, ID rewrite
    index-tracker.test.ts           ← Progress events, file states
    daemon.test.ts                  ← State file read/write/clear, liveness
  integration/                      ← Tests with real clangd-20
    lsp-client.test.ts              ← LspClient: all LSP operations
    mux-bridge.test.ts              ← Multi-client bridge, ID routing, broadcast
    tools.test.ts                   ← All 20 MCP tools via HTTP daemon
  e2e/                              ← End-to-end scenarios
    multi-client.test.ts            ← 2 concurrent TCP clients share one clangd
    lsp-passthrough.test.ts         ← --lsp-passthrough mode end-to-end
```

## Workspace Fixtures

All tests use verified symbol positions from the WLAN workspace:

```typescript
WORKSPACE = /local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1
CLANGD    = /usr/local/bin/clangd-20

// esp_calculation.c
POS.PMLO_DEF   = { line: 27,  char: 6  }  // pmlo_account_ppdu_duration (function def)
POS.ESP_DEF    = { line: 47,  char: 6  }  // esp_account_ppdu_duration (function def)
POS.ESP_NEFF   = { line: 69,  char: 10 }  // esp_get_neffective (function def)
POS.PMLO_CALL  = { line: 56,  char: 5  }  // pmlo_account_ppdu_duration (call site)

// ru_allocator.c
POS.RU_INIT    = { line: 188, char: 24 }  // ru_alloc_init (function def)
POS.RU_LEGAL   = { line: 258, char: 8  }  // ru_alloc_legal_ru_size (function def)
POS.RU_STATIC  = { line: 236, char: 8  }  // ru_alloc_is_static_mode_enabled (function def)

// sched_algo.c
POS.SCHED_DELAY= { line: 426, char: 8  }  // sched_algo_delay_lower_ac (function def)
POS.SCHED_POL  = { line: 803, char: 10 }  // sched_algo_get_policy (function def)

// sched_algo.h
POS.SCHED_STRUCT={ line: 789, char: 16 }  // sched_txq_ctxt (struct def)
```

## Running Tests

```bash
# Build first
cd /local/mnt/workspace/qprojects/clangd-mcp
bun run build

# Run all tests
bun test

# Run specific test file
bun test test/unit/lsp-frame-parser.test.ts

# Run with verbose output
bun test --verbose

# Run integration tests only (requires clangd-20)
bun test test/integration/

# Run e2e tests only (spawns full stack)
bun test test/e2e/
```

## Test Categories

### Unit Tests (Fast, No External Dependencies)

**test/unit/lsp-frame-parser.test.ts**
- Parse single complete frame
- Parse multiple frames in one buffer
- Handle chunked/partial frames
- Malformed headers (skip and recover)
- ID rewriting: `clientId:originalId` format
- ID parsing: extract clientId and originalId

**test/unit/index-tracker.test.ts**
- Initial state (not ready, 0%)
- Progress events: begin → report → end
- Multiple concurrent progress tokens
- File status updates (idle, parsing, indexing)
- `markReady()` for reconnect scenario
- Status suffix generation

**test/unit/daemon.test.ts**
- `readState()` / `writeState()` / `clearState()`
- State file version mismatch handling
- `isProcessAlive()` for valid/invalid PIDs
- `isTcpPortOpen()` for open/closed ports
- `checkDaemonAlive()` full liveness check
- `findFreePort()` allocation

### Integration Tests (Spawn clangd-20)

**test/integration/lsp-client.test.ts**
- Spawn clangd-20 and initialize
- `hover` returns type info for `pmlo_account_ppdu_duration`
- `definition` jumps to function body
- `references` finds all call sites
- `documentSymbol` lists all functions in file
- `workspaceSymbol` searches across workspace
- `incomingCalls` / `outgoingCalls` call hierarchy
- `diagnostics` returns compiler errors/warnings
- Reconnect after connection drop

**test/integration/mux-bridge.test.ts**
- Spawn mux bridge + clangd-20
- Single client: request → response with correct ID
- Two clients send requests with same ID → responses routed correctly
- Notification broadcast: all clients receive `$/progress`
- Client disconnect: pending requests cleaned up
- ID rewriting: `"1:5"` → client 1, original ID 5
- Send queue: concurrent requests serialized to clangd

**test/integration/tools.test.ts**
- Spawn HTTP MCP daemon
- Test all 20 MCP tools with real workspace symbols:
  - `lsp_hover` on `esp_account_ppdu_duration`
  - `lsp_definition` on `ru_alloc_init`
  - `lsp_references` on `sched_algo_get_policy`
  - `lsp_document_symbol` on `esp_calculation.c`
  - `lsp_workspace_symbol` query `"ru_alloc"`
  - `lsp_incoming_calls` on `pmlo_account_ppdu_duration`
  - `lsp_outgoing_calls` on `esp_account_ppdu_duration`
  - `lsp_diagnostics` (all files)
  - `lsp_index_status` (verify index ready)
  - ... (all 20 tools)

### E2E Tests (Full Stack)

**test/e2e/multi-client.test.ts**
- Spawn bridge + clangd-20
- Client A connects, sends `hover` request
- Client B connects, sends `definition` request
- Both receive correct responses (not swapped)
- clangd sends `$/progress` notification → both clients receive it
- Client A disconnects → Client B still works
- Verify only ONE clangd-20 process running (`ps aux | grep clangd-20`)

**test/e2e/lsp-passthrough.test.ts**
- Spawn HTTP MCP daemon (ensures bridge is running)
- Spawn `index.js --lsp-passthrough` as child process
- Send raw LSP `initialize` request via stdin
- Receive `initialize` response via stdout
- Send `textDocument/hover` request
- Receive hover response with type info
- Verify passthrough and MCP daemon share same clangd (check state file)
- Kill passthrough → MCP daemon still works

## Writing New Tests

### Test Template

```typescript
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { WORKSPACE, CLANGD, CLANGD_ARGS, POS, FILES, assert, assertContains } from "../helpers"

describe("My Test Suite", () => {
  let cleanup: (() => void) | null = null

  beforeAll(async () => {
    // Setup: spawn processes, allocate ports, etc.
  })

  afterAll(async () => {
    // Cleanup: kill processes, delete temp files
    cleanup?.()
  })

  test("should do something specific", async () => {
    // Arrange
    const input = ...

    // Act
    const result = await doSomething(input)

    // Assert
    assertContains(result, "expected substring")
    assert(result.includes("foo"), "result must contain foo")
  })
})
```

### Assertion Helpers

```typescript
// From test/helpers.ts
assert(condition, "error message")
assertContains(text, "substring", "label")
assertMatches(text, /regex/, "label")
assertNotError(text, "label")  // fails if text contains "error:" or "failed to"
assertFileLineRange(text, file, minLine, maxLine)  // validates file:line format
```

### Real Symbol Positions

Always use `POS.*` constants from `helpers.ts`. These are verified against the actual source files. Never hardcode line numbers in tests.

```typescript
// ✅ GOOD
const result = await client.hover(POS.ESP_DEF.file, POS.ESP_DEF.line - 1, POS.ESP_DEF.character - 1)

// ❌ BAD
const result = await client.hover(FILES.ESP_C, 46, 5)  // will break if source changes
```

## CI Integration

Add to `.github/workflows/test.yml`:

```yaml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun run build
      - run: bun test
```

## Coverage

Run with coverage:

```bash
bun test --coverage
```

Target: 90%+ coverage for all modules except `logger.ts` and `server.ts` (MCP transport boilerplate).

## Debugging Tests

```bash
# Run single test with full output
bun test test/integration/lsp-client.test.ts --verbose

# Check clangd-20 is available
/usr/local/bin/clangd-20 --version

# Check workspace compile_commands.json exists
ls -lh /local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1/compile_commands.json

# Manually test bridge
node dist/bridge.js --port 9999 --root $WORKSPACE --clangd /usr/local/bin/clangd-20 --log /tmp/bridge.log
# In another terminal:
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | nc localhost 9999
```

## Test Principles

1. **Real symbols, real workspace** — No mocks for clangd. Use actual WLAN source files.
2. **Content validation** — Every test checks specific symbol names, file paths, line numbers.
3. **Isolation** — Each test spawns its own processes, uses unique ports, cleans up after.
4. **Fast feedback** — Unit tests run in <1s. Integration tests <10s. E2E tests <30s.
5. **Deterministic** — No flaky tests. Use `waitForPort()` instead of `setTimeout()`.
6. **Readable** — Test names describe exact behavior. Failures show clear diffs.

## Known Issues

- **Index build time**: First run of integration/e2e tests takes 2-5 minutes while clangd indexes the WLAN workspace. Subsequent runs reuse the warm index (if bridge stays alive).
- **Port conflicts**: If tests fail with "port already in use", kill stale processes: `pkill -f clangd-mcp`
- **Stale state files**: If tests fail with "daemon not alive", delete: `rm /tmp/clangd-mcp-test-*/.clangd-mcp-state.json`

## Contributing

When adding new features to clangd-mcp:

1. Write unit tests first (TDD)
2. Add integration test for the feature
3. Update e2e tests if the feature affects multi-client behavior
4. Run full test suite before committing: `bun test`
5. Ensure all tests pass and coverage stays >90%
