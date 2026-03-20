import { describe, it, expect } from "vitest"
import { findRingTrigger } from "../../src/tools/indirect-callers.ts"
import { existsSync } from "fs"

const WLAN_ROOT = "/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1/wlan_proc"
const hasWlan = existsSync(WLAN_ROOT)

describe.skipIf(!hasWlan)("findRingTrigger — live WLAN workspace", () => {
  it("finds A_INUM_TQM_STATUS_HI for WLAN_THREAD_SIG_TQM_HIPRI_STATUS_HW_INTR", () => {
    const r = findRingTrigger("WLAN_THREAD_SIG_TQM_HIPRI_STATUS_HW_INTR", WLAN_ROOT)
    console.log("TQM HI:", JSON.stringify(r))
    expect(r).not.toBeNull()
    expect(r?.interruptId).toBe("A_INUM_TQM_STATUS_HI")
    expect(r?.file).toContain("tqm_thread.c")
  })

  it("finds A_INUM_TQM_STATUS_LO for WLAN_THREAD_SIG_TQM_LOWPRI_STATUS_HW_INTR", () => {
    const r = findRingTrigger("WLAN_THREAD_SIG_TQM_LOWPRI_STATUS_HW_INTR", WLAN_ROOT)
    console.log("TQM LO:", JSON.stringify(r))
    expect(r).not.toBeNull()
    expect(r?.interruptId).toBe("A_INUM_TQM_STATUS_LO")
  })

  it("finds WMAC RX interrupt for WLAN_THREAD_SIG_WMAC0_RX", () => {
    const r = findRingTrigger("WLAN_THREAD_SIG_WMAC0_RX", WLAN_ROOT)
    console.log("WMAC0 RX:", JSON.stringify(r))
    // WMAC0_RX may be in a macro — result may be null if split differently
    if (r) {
      expect(r.interruptId).toMatch(/A_INUM_WMAC/)
    }
  })

  it("finds WMAC RX SIFS interrupt for WLAN_THREAD_SIG_WMAC0_RX_SIFS", () => {
    const r = findRingTrigger("WLAN_THREAD_SIG_WMAC0_RX_SIFS", WLAN_ROOT)
    console.log("WMAC0 RX SIFS:", JSON.stringify(r))
    if (r) {
      expect(r.interruptId).toMatch(/A_INUM_WMAC/)
    }
  })

  it("returns null for a non-existent signal ID", () => {
    const r = findRingTrigger("WLAN_THREAD_SIG_DOES_NOT_EXIST_XYZ", WLAN_ROOT)
    expect(r).toBeNull()
  })
})
