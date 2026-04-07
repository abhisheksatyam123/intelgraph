/**
 * ripgrep-service.test.ts — exercises the RipgrepServiceImpl wrapper.
 *
 * The service shells out to the real `rg` binary against a temp directory.
 * If `rg` is missing from PATH on the test host, the rg-dependent cases
 * are skipped via it.skipIf, but the unavailable-path tests still run.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  RipgrepServiceImpl,
  RipgrepUnavailable,
} from "../../../../src/intelligence/extraction/services/ripgrep-service.js"

// Detect rg once at module load time. it.skipIf takes a boolean, not a
// function — passing a function would always be truthy and never skip.
const HAS_RG = (() => {
  try {
    execFileSync("rg", ["--version"], { stdio: "pipe", timeout: 2000 })
    return true
  } catch {
    return false
  }
})()

let tempRoot: string
let svc: RipgrepServiceImpl

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "rg-svc-test-"))
  // Layout:
  //   tempRoot/
  //     a.c        — contains "wlan_register_handler(foo)"
  //     b.c        — contains "wlan_register_handler(bar)" twice
  //     sub/c.h    — contains "wlan_register_handler(baz)" and an unrelated line
  //     d.txt      — contains "wlan_register_handler(quux)" but is not a C file
  mkdirSync(join(tempRoot, "sub"))
  writeFileSync(
    join(tempRoot, "a.c"),
    "int main(void) {\n  wlan_register_handler(foo);\n  return 0;\n}\n",
  )
  writeFileSync(
    join(tempRoot, "b.c"),
    "void f(void) {\n  wlan_register_handler(bar);\n}\nvoid g(void) {\n  wlan_register_handler(bar);\n}\n",
  )
  writeFileSync(
    join(tempRoot, "sub/c.h"),
    "void h(void) {\n  wlan_register_handler(baz);\n}\nint x = 1;\n",
  )
  writeFileSync(join(tempRoot, "d.txt"), "wlan_register_handler(quux)\n")
  svc = new RipgrepServiceImpl(tempRoot)
})

afterAll(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
})

describe("RipgrepServiceImpl", () => {
  it("detects whether `rg` is available on PATH", () => {
    expect(typeof svc.available).toBe("boolean")
    expect(svc.available).toBe(HAS_RG)
  })

  it.skipIf(!HAS_RG)(
    "search() finds matches across C/C++ files only by default",
    () => {
      const matches = svc.search("wlan_register_handler")
      // Default glob is *.{c,h,cpp,cc,cxx,hpp} — should hit a.c (1), b.c (2),
      // sub/c.h (1) but NOT d.txt.
      expect(matches.length).toBe(4)
      const files = new Set(matches.map((m) => m.filePath))
      expect(files.size).toBe(3)
      expect([...files].some((f) => f.endsWith("/d.txt"))).toBe(false)
    },
  )

  it.skipIf(!HAS_RG)("search() respects custom glob", () => {
    const matches = svc.search("wlan_register_handler", { glob: "*.txt" })
    expect(matches.length).toBe(1)
    expect(matches[0].filePath).toMatch(/d\.txt$/)
  })

  it.skipIf(!HAS_RG)("search() returns empty array when no matches", () => {
    const matches = svc.search("a_pattern_that_should_not_exist_anywhere_xyz")
    expect(matches).toEqual([])
  })

  it.skipIf(!HAS_RG)("search() respects fixedString", () => {
    const matches = svc.search("wlan_register_handler(foo)", { fixedString: true })
    expect(matches.length).toBe(1)
    expect(matches[0].lineText).toContain("wlan_register_handler(foo)")
  })

  it.skipIf(!HAS_RG)(
    "count() returns the number of matching files (not matches)",
    () => {
      // count() uses --count -l which returns one filename per matching file.
      // 3 C files contain matches.
      expect(svc.count("wlan_register_handler")).toBe(3)
    },
  )

  it.skipIf(!HAS_RG)("findFiles() lists files matching a glob", () => {
    const files = svc.findFiles("*.h")
    expect(files.length).toBe(1)
    expect(files[0]).toMatch(/sub\/c\.h$/)
  })

  it.skipIf(!HAS_RG)("submatches expose start/end column ranges", () => {
    const matches = svc.search("wlan_register_handler", { maxCount: 1 })
    expect(matches.length).toBeGreaterThan(0)
    const m = matches[0]
    expect(m.submatches).toBeDefined()
    expect(m.submatches!.length).toBeGreaterThan(0)
    expect(m.submatches![0].text).toBe("wlan_register_handler")
  })

  it("throws RipgrepUnavailable when search() is called and rg is missing", () => {
    const offline = new RipgrepServiceImpl(tempRoot)
    ;(offline as unknown as { _available: boolean })._available = false
    expect(() => offline.search("anything")).toThrow(RipgrepUnavailable)
  })

  it("count() returns 0 when rg is unavailable", () => {
    const offline = new RipgrepServiceImpl(tempRoot)
    ;(offline as unknown as { _available: boolean })._available = false
    expect(offline.count("anything")).toBe(0)
  })

  it("findFiles() returns empty array when rg is unavailable", () => {
    const offline = new RipgrepServiceImpl(tempRoot)
    ;(offline as unknown as { _available: boolean })._available = false
    expect(offline.findFiles("*.c")).toEqual([])
  })
})
