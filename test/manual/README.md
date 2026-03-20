# Manual Tests

Ad-hoc test scripts for manual verification and debugging.

## Files

- `workspace-tools.js` - Test workspace-specific tool calls
- `schema-check.js` - Verify MCP tool schemas are exposed correctly
- `open-file.mjs` - Test file opening behavior
- `mcp-sdk-test.ts` - Minimal MCP SDK test

## Usage

These are not part of the automated test suite. Run them manually:

```bash
node test/manual/workspace-tools.js
node test/manual/schema-check.js
```

Update hardcoded ports/paths as needed for your environment.
EOF
