import { describe, expect, it } from "vitest"

type MaybeSocket = { destroyed: boolean; destroy: () => void }

function replaceActiveSocket(active: MaybeSocket | null, incoming: MaybeSocket): MaybeSocket {
  if (active && !active.destroyed) {
    active.destroy()
  }
  return incoming
}

describe("bridge active connection replacement rule", () => {
  it("replaces previous active socket when a new connection arrives", () => {
    let firstDestroyed = false
    const first: MaybeSocket = {
      destroyed: false,
      destroy: () => {
        firstDestroyed = true
        first.destroyed = true
      },
    }
    const second: MaybeSocket = {
      destroyed: false,
      destroy: () => {
        second.destroyed = true
      },
    }

    let active: MaybeSocket | null = first
    active = replaceActiveSocket(active, second)

    expect(firstDestroyed).toBe(true)
    expect(active).toBe(second)
    expect(second.destroyed).toBe(false)
  })

  it("does not destroy already-closed socket", () => {
    const first: MaybeSocket = {
      destroyed: true,
      destroy: () => {
        throw new Error("should not be called for already-destroyed socket")
      },
    }
    const second: MaybeSocket = {
      destroyed: false,
      destroy: () => {
        second.destroyed = true
      },
    }

    const active = replaceActiveSocket(first, second)
    expect(active).toBe(second)
    expect(second.destroyed).toBe(false)
  })
})
