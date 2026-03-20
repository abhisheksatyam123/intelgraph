# End-to-End Tests

These tests verify the full clangd-mcp stack against a real workspace.

## Test Files

- `full-suite.test.mjs` - Comprehensive functional test suite with content validation
- `http-daemon.test.js` - HTTP daemon mode with tool parameter passing
- `stdio-proxy.test.js` - Default stdio proxy mode (simulates OpenCode)

## Running E2E Tests

```bash
# Run all e2e tests
bun test test/e2e/

# Run specific test
node test/e2e/full-suite.test.mjs --url http://localhost:7777/mcp
```

## Requirements

- A running clangd-mcp server (HTTP mode)
- Valid workspace with compile_commands.json
- clangd binary available

## Test Workspace

Tests use the WLAN workspace by default. Update paths in test files if needed.
EOF
