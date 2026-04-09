# WLAN Fixture Gap Audit Report

Generated: 2026-04-05T16:54:40.483Z
Source root: /local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1/wlan_proc
Fixtures root: test/fixtures/wlan

- Total fixtures: 60
- OK fixtures: 4
- Fixtures with issues: 56

## Top issue classes

| Issue class | Count |
|---|---:|
| callee_symbol_missing | 52 |
| caller_symbol_missing | 35 |
| registrar_symbol_missing | 2 |

## Issue class counts (before → after)

| Issue class | Before | After | Delta |
|---|---:|---:|---:|
| callee_symbol_missing | 52 | 52 | 0 |
| caller_symbol_missing | 35 | 35 | 0 |
| registrar_symbol_missing | 2 | 2 | 0 |
| source_path_mismatch | 3 | 0 | -3 |

## Rerun command

```bash
node scripts/wlan-fixture-gap-audit.mjs --source-root=/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1/wlan_proc --index=test/fixtures/wlan/index.json --fixtures-root=test/fixtures/wlan --report-json=test/fixtures/wlan/wlan-gap-audit-report.json --report-md=test/fixtures/wlan/wlan-gap-audit-report.md
```
