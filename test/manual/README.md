# Manual Tests

Ad-hoc test scripts for manual verification and debugging.

## Files

- `workspace-tools.js` - Test workspace-specific tool calls
- `schema-check.js` - Verify MCP tool schemas are exposed correctly
- `open-file.mjs` - Test file opening behavior
- `mcp-sdk-test.ts` - Minimal MCP SDK test
- `wlan-source-audit.mjs` - Validate source-backed fixture probes against a real WLAN workspace

## Usage

These are not part of the automated test suite. Run them manually:

```bash
node test/manual/workspace-tools.js
node test/manual/schema-check.js
node test/manual/wlan-source-audit.mjs
```

Update hardcoded ports/paths as needed for your environment.
