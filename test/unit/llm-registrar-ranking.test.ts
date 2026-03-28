import { describe, expect, it } from "vitest"
import { scoreRegistrarCandidate } from "../../src/tools/reason-engine/llm-advisor.js"

describe("rescue registrar ranking prefers production over test", () => {
  it("scores production registrars higher than test/mock registrars", () => {
    const prod = {
      registrarFn: "wlan_bpf_enable_data_path",
      registrationApi: "offldmgr_register_data_offload",
      file: "/src/offloads/src/l2/bpf/bpf_offload_int.c"
    }
    const test = {
      registrarFn: "wlan_bpf_offload_test_route_uc_active",
      registrationApi: "offldmgr_register_data_offload",
      file: "/src/offloads/src/l2/bpf/bpf_offload_unit_test.c"
    }

    const scoreProd = scoreRegistrarCandidate(prod)
    const scoreTest = scoreRegistrarCandidate(test)

    expect(scoreProd).toBeGreaterThan(scoreTest)
  })

  it("penalizes mock and stub filenames", () => {
    const mock = {
      registrarFn: "register_handler",
      registrationApi: "api",
      file: "mock_registration.c"
    }
    const real = {
      registrarFn: "register_handler",
      registrationApi: "api",
      file: "real_registration.c"
    }
    expect(scoreRegistrarCandidate(real)).toBeGreaterThan(scoreRegistrarCandidate(mock))
  })
})
