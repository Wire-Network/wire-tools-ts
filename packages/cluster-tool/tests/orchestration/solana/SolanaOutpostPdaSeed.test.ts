import {
  SolanaOutpostBootstrapper,
  SolanaOutpostPdaSeed
} from "@wireio/cluster-tool/orchestration"

/** Every string seed exposed on {@link SolanaOutpostPdaSeed}. */
const StringSeeds = [
  "OutpostConfig",
  "OutboundMessageBuffer",
  "OperatorRegistry",
  "InboundEnvelopes",
  "OutboundEnvelopes",
  "LatestOutboundEnvelope",
  "ReserveAggregate",
  "Reserve",
  "ReserveVault",
  "OutpostVault",
  "CollateralVault"
] as const

describe("SolanaOutpostPdaSeed", () => {
  it("publishes the wire-solana opp_states seed spellings", () => {
    expect(SolanaOutpostPdaSeed.OutpostConfig).toBe("outpost_config")
    expect(SolanaOutpostPdaSeed.OutboundMessageBuffer).toBe(
      "outbound_message_buffer"
    )
    expect(SolanaOutpostPdaSeed.OperatorRegistry).toBe("operator_registry")
    expect(SolanaOutpostPdaSeed.InboundEnvelopes).toBe("inbound_envelopes")
    expect(SolanaOutpostPdaSeed.OutboundEnvelopes).toBe("outbound_envelopes")
    expect(SolanaOutpostPdaSeed.LatestOutboundEnvelope).toBe(
      "latest_outbound_envelope"
    )
    expect(SolanaOutpostPdaSeed.ReserveAggregate).toBe("reserve_aggregate")
    expect(SolanaOutpostPdaSeed.Reserve).toBe("reserve")
    expect(SolanaOutpostPdaSeed.ReserveVault).toBe("reserve_vault")
    expect(SolanaOutpostPdaSeed.OutpostVault).toBe("outpost_vault")
    expect(SolanaOutpostPdaSeed.CollateralVault).toBe("collateral_vault")
  })

  it("Bytes buffers match Buffer.from of the string seeds", () => {
    for (const name of StringSeeds) {
      expect(SolanaOutpostPdaSeed.Bytes[name]).toEqual(
        Buffer.from(SolanaOutpostPdaSeed[name])
      )
    }
  })

  it("rejects silent drift: Bytes and strings stay paired", () => {
    // A missing Bytes entry would leave a tool able to import a string seed
    // that has no shared buffer — catch that at unit-test time.
    for (const name of StringSeeds) {
      expect(Buffer.isBuffer(SolanaOutpostPdaSeed.Bytes[name])).toBe(true)
      expect(typeof SolanaOutpostPdaSeed[name]).toBe("string")
    }
  })
})

describe("SolanaOutpostBootstrapper.PdaSeed alias", () => {
  it("is the same namespace as SolanaOutpostPdaSeed", () => {
    expect(SolanaOutpostBootstrapper.PdaSeed).toBe(SolanaOutpostPdaSeed)
  })

  it("exposes the vault seeds tools previously declared locally", () => {
    expect(SolanaOutpostBootstrapper.PdaSeed.OutpostVault).toBe("outpost_vault")
    expect(SolanaOutpostBootstrapper.PdaSeed.CollateralVault).toBe(
      "collateral_vault"
    )
    expect(SolanaOutpostBootstrapper.PdaSeed.Bytes.OutpostVault).toEqual(
      Buffer.from("outpost_vault")
    )
  })
})
