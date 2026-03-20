# clangd-mcp Test Suite

Comprehensive test coverage for the clangd-mcp server.

## Test Structure

```
test/
├── unit/              # Fast isolated tests for individual modules
│   ├── daemon.test.ts
│   ├── index-tracker.test.ts
│   ├── log-formatter.test.ts
│   └── log-levels.test.ts
├── integration/       # Tests that verify module interactions
│   ├── daemon-lifecycle.test.ts
│   └── mux-bridge.test.ts
├── e2e/              # Full-stack tests against real workspace
│   ├── full-suite.test.mjs
│   ├── http-daemon.test.js
│   └── stdio-proxy.test.js
├── manual/           # Ad-hoc scripts for manual testing
│   ├── workspace-tools.js
│   ├── schema-check.js
│   └── open-file.mjs
├── fixtures/         # Shared test data and configuration
│   └── test-workspace.ts
└── helpers.ts        # Shared test utilities

## Running Tests

### Unit + Integration Tests (Automated)

```bash
# Run all automated tests
bun test

# Run only unit tests
bun test test/unit/

# Run only integration tests
bun test test/integration/

# Run with coverage
bun test --coverage

# Watch mode
bun test --watch
```

### End-to-End Tests (Manual)

E2E tests require a running clangd-mcp server and real workspace:

```bash
# 1. Start the server
bun dist/index.js --port 7777 --root /path/to/workspace

# 2. Run e2e tests
node test/e2e/full-suite.test.mjs --url http://localhost:7777/mcp
node test/e2e/http-daemon.test.js
node test/e2e/stdio-proxy.test.js
```

### Manual Tests

Ad-hoc scripts for debugging specific scenarios:

```bash
node test/manual/workspace-tools.js
node test/manual/schema-check.js
```

## Test Principles

1. **Unit tests** - Fast, isolated, no external dependencies
   - Test individual functions and classes
   - Mock external dependencies
   - Run in <1 second

2. **Integration tests** - Verify module interactions
   - Test daemon spawning, state management, bridge communication
   - Use real processes but isolated test workspaces
   - Run in <10 seconds

3. **E2E tests** - Full-stack validation
   - Test against real clangd and real workspace
   - Verify actual tool responses with content validation
   - Run in <30 seconds (after index is warm)

4. **Manual tests** - Debugging and exploration
   - Not part of CI
   - Hardcoded paths/ports for specific environments
   - Run on-demand

## Test Coverage Goals

- **Unit tests**: >90% coverage for core modules
- **Integration tests**: All daemon lifecycle paths
- **E2E tests**: All 22 MCP tools with content validation

## Writing New Tests

### Unit Test Template

```typescript
import { describe, it, expect } from "vitest"
import { myFunction } from "../../src/my-module.js"

describe("myFunction", () => {
  it("does what it should", () => {
    expect(myFunction("input")).toBe("expected")
  })
})
```

### Integration Test Template

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

describe("my integration test", () => {
  let testRoot: string

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "test-"))
  })

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true })
  })

  it("integrates correctly", async () => {
    // test code
  })
})
```

## Debugging Tests

```bash
# Run single test file with verbose output
bun test test/unit/daemon.test.ts --verbose

# Run single test by name pattern
bun test -t "normalises VCS marker paths"

# Debug with inspector
node --inspect-brk node_modules/.bin/vitest test/unit/daemon.test.ts
```

## CI Integration

The automated test suite (unit + integration) runs on every commit:

```yaml
- run: bun install
- run: bun run build
- run: bun test
```

E2E tests are run manually before releases due to workspace requirements.

## Known Issues

- **First integration test run**: May take longer while clangd builds index
- **Port conflicts**: If tests fail with "port in use", kill stale processes
- **Stale state**: Delete `.clangd-mcp-state.json` if daemon tests fail

## Contributing

When adding new features:

1. Write unit tests first (TDD)
2. Add integration tests for cross-module behavior
3. Update e2e tests if tool surface changes
4. Ensure `bun test` passes before committing
5. Keep coverage >90%
