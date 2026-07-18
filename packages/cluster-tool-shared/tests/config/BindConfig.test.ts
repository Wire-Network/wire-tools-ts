import {
  BindConfigPortProtocol,
  type BindConfig,
  type BindConfigPortRange,
  type BindDaemonOptions,
  type BindNodeopClusterPortsOptions,
  type BindNodeopOptions,
  type BindNodeopPortsOptions,
  type BindOptions,
  type BindSolanaOptions,
  type BindSolanaPortsOptions
} from "@wireio/cluster-tool-shared"

// ---------------------------------------------------------------------------
// Type-identity pins: `BindOverrides<T>` DERIVES the options family that the
// pre-extraction code hand-wrote. The `Reference*` interfaces below are that
// hand-written surface, reproduced verbatim as the spec; the assertions prove
// each derived alias is mutually assignable with it (both directions), so
// consumers provably see the identical types.
// ---------------------------------------------------------------------------

/** `true` only when `A` and `B` are mutually assignable. */
type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false

/** Compile-time truth pin — instantiating it with anything but `true` errors. */
type Assert<T extends true> = T

/** The checkpoint's hand-written single-daemon options. */
interface ReferenceBindDaemonOptions {
  address?: string
  port?: number
}

/** The checkpoint's hand-written per-nodeop port-pair options. */
interface ReferenceBindNodeopPortsOptions {
  http?: number
  p2p?: number
}

/** The checkpoint's hand-written cluster-wide nodeop port options. */
interface ReferenceBindNodeopClusterPortsOptions {
  bios?: ReferenceBindNodeopPortsOptions
  producers?: ReferenceBindNodeopPortsOptions[]
  batch?: ReferenceBindNodeopPortsOptions[]
  underwriters?: ReferenceBindNodeopPortsOptions[]
}

/** The checkpoint's hand-written nodeop options. */
interface ReferenceBindNodeopOptions {
  address?: string
  ports?: ReferenceBindNodeopClusterPortsOptions
}

/** The checkpoint's hand-written solana port options (`dynamicRange` pin-whole). */
interface ReferenceBindSolanaPortsOptions {
  http?: number
  faucet?: number
  gossip?: number
  dynamicRange?: BindConfigPortRange
}

/** The checkpoint's hand-written solana options. */
interface ReferenceBindSolanaOptions {
  address?: string
  ports?: ReferenceBindSolanaPortsOptions
}

/** The checkpoint's hand-written top-level bind options. */
interface ReferenceBindOptions {
  kiod?: ReferenceBindDaemonOptions
  nodeop?: ReferenceBindNodeopOptions
  anvil?: ReferenceBindDaemonOptions
  solana?: ReferenceBindSolanaOptions
  debuggingServer?: ReferenceBindDaemonOptions
}

type _daemonIdentity = Assert<
  MutuallyAssignable<BindDaemonOptions, ReferenceBindDaemonOptions>
>
type _nodeopPortsIdentity = Assert<
  MutuallyAssignable<BindNodeopPortsOptions, ReferenceBindNodeopPortsOptions>
>
type _nodeopClusterPortsIdentity = Assert<
  MutuallyAssignable<
    BindNodeopClusterPortsOptions,
    ReferenceBindNodeopClusterPortsOptions
  >
>
type _nodeopIdentity = Assert<
  MutuallyAssignable<BindNodeopOptions, ReferenceBindNodeopOptions>
>
type _solanaPortsIdentity = Assert<
  MutuallyAssignable<BindSolanaPortsOptions, ReferenceBindSolanaPortsOptions>
>
type _solanaIdentity = Assert<
  MutuallyAssignable<BindSolanaOptions, ReferenceBindSolanaOptions>
>
type _bindIdentity = Assert<
  MutuallyAssignable<BindOptions, ReferenceBindOptions>
>

describe("BindConfigPortProtocol", () => {
  it("is an identity-mapped string enum (value === key) for every member", () => {
    expect(BindConfigPortProtocol.tcp).toBe("tcp")
    expect(BindConfigPortProtocol.udp).toBe("udp")
  })
})

describe("BindOverrides<T>", () => {
  it("derives BindOptions as the deep-optional projection of BindConfig", () => {
    // Every field optional at every depth — a single leaf override typechecks.
    const options: BindOptions = {
      solana: { ports: { dynamicRange: { first: 8100, last: 8200 } } }
    }
    expect(options.solana?.ports?.dynamicRange?.last).toBe(8200)
  })

  it("treats BindAtom shapes as pin-whole (a full window is supplied or none)", () => {
    const halfWindow: BindOptions = {
      solana: {
        ports: {
          // @ts-expect-error half a port window is meaningless — BindAtom shapes must be supplied whole
          dynamicRange: { first: 8100 }
        }
      }
    }
    expect(halfWindow.solana?.ports?.dynamicRange?.first).toBe(8100)
  })

  it("recurses through arrays element-wise (per-nodeop port overrides)", () => {
    const options: BindOptions = {
      nodeop: { ports: { producers: [{ http: 8988 }, {}] } }
    }
    expect(options.nodeop?.ports?.producers).toHaveLength(2)
  })

  it("keeps the resolved BindConfig fully-required (a partial literal is rejected)", () => {
    // @ts-expect-error the resolved shape requires every daemon — BindOverrides applies to options only
    const partialResolved: BindConfig = {
      kiod: { address: "127.0.0.1", port: 8900 }
    }
    expect(partialResolved.kiod.port).toBe(8900)
  })
})
