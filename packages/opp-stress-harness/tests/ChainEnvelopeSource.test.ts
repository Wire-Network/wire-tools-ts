import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import { SystemContracts } from "@wireio/sdk-core"
import {
  OppEnvelopeTelemetryHealthKind,
  projectSnapshotSaturationMetrics,
  SaturatedEnvelopeMinBytes
} from "@wireio/test-opp-stress"

import {
  chainEnvelopeSource,
  resolveOutpostDirection,
  type ChainEnvelopeReader
} from "@wireio/opp-stress-harness"

const EthereumChainCode = 111,
  UnregisteredChainCode = 999,
  EnvelopeHash =
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  TruncatedChecksum = "abcdef0123456789",
  ByteThresholdWindow = { saturationStrategy: "byte_threshold" } as const

/** One `sysio.chains` registry row. */
function chainRow(
  codeValue: number,
  kind: SystemContracts.SysioChainsChainkind
): SystemContracts.SysioChainsChainRowType {
  return {
    code: { value: codeValue },
    kind,
    external_chain_id: 0,
    name: "test-chain",
    description: "",
    is_depot: false,
    active: true,
    registered_at_ms: 0,
    activated_at_ms: 0
  }
}

/** One `sysio.msgch::outenvelopes` row whose `raw_envelope` holds `byteCount` bytes. */
function outboundRow(
  chainCode: number,
  epochIndex: number,
  byteCount: number
): SystemContracts.SysioMsgchOutboundEnvelopeType {
  return {
    id: 1,
    chain_code: chainCode,
    epoch_index: epochIndex,
    envelope_hash: EnvelopeHash,
    status:
      SystemContracts.SysioMsgchEnvelopestatus.ENVELOPE_STATUS_CONFIRMED,
    raw_envelope: "ab".repeat(byteCount),
    last_message_id: "0"
  }
}

/** A reader over fixed chain-registry and outbound-envelope rows. */
function reader(
  chains: readonly SystemContracts.SysioChainsChainRowType[],
  envelopes: readonly SystemContracts.SysioMsgchOutboundEnvelopeType[]
): ChainEnvelopeReader {
  return {
    readChains: async () => chains,
    readOutboundEnvelopes: async () => envelopes
  }
}

describe("resolveOutpostDirection", () => {
  it("maps EVM to the Ethereum outbound direction", () => {
    expect(
      resolveOutpostDirection(
        SystemContracts.SysioChainsChainkind.CHAIN_KIND_EVM
      )
    ).toBe(DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM)
  })

  it("maps SVM to the Solana outbound direction", () => {
    expect(
      resolveOutpostDirection(
        SystemContracts.SysioChainsChainkind.CHAIN_KIND_SVM
      )
    ).toBe(DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA)
  })

  it("returns null for the WIRE depot kind", () => {
    expect(
      resolveOutpostDirection(
        SystemContracts.SysioChainsChainkind.CHAIN_KIND_WIRE
      )
    ).toBeNull()
  })

  it("accepts the spelled-out chain-kind name from JSON RPC", () => {
    expect(resolveOutpostDirection("CHAIN_KIND_EVM")).toBe(
      DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
    )
  })
})

describe("chainEnvelopeSource", () => {
  it("maps an outbound row into a directional metric record", async () => {
    // Given: an EVM chain and its one outbound envelope tip.
    const source = chainEnvelopeSource(
      reader(
        [chainRow(EthereumChainCode, SystemContracts.SysioChainsChainkind.CHAIN_KIND_EVM)],
        [outboundRow(EthereumChainCode, 7, 1_024)]
      )
    )

    // When: the source snapshots the depot's on-chain envelopes.
    const snapshot = await source.snapshot()

    // Then: the row becomes one directional record sized from raw_envelope.
    expect(snapshot.kind).toBe("collected")
    expect(snapshot.candidateCount).toBe(1)
    expect(snapshot.records).toHaveLength(1)
    const [record] = snapshot.records
    expect(record?.endpointsType).toBe(
      DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
    )
    expect(record?.epochIndex).toBe(7)
    expect(record?.checksum).toBe(TruncatedChecksum)
    expect(record?.dataBytes.byteLength).toBe(1_024)
    expect(record?.batchOpNames).toEqual([])
  })

  it("skips envelopes whose chain is not in the registry but still counts them", async () => {
    // Given: one registered EVM chain and one envelope for an unregistered chain.
    const source = chainEnvelopeSource(
      reader(
        [chainRow(EthereumChainCode, SystemContracts.SysioChainsChainkind.CHAIN_KIND_EVM)],
        [
          outboundRow(EthereumChainCode, 7, 512),
          outboundRow(UnregisteredChainCode, 7, 512)
        ]
      )
    )

    // When: the source maps rows to records.
    const snapshot = await source.snapshot()

    // Then: only the resolvable chain yields a record; candidate count is total.
    expect(snapshot.records).toHaveLength(1)
    expect(snapshot.candidateCount).toBe(2)
    expect(snapshot.records[0]?.endpointsType).toBe(
      DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
    )
  })

  it("drives byte-threshold saturation metrics end to end", async () => {
    // Given: an Ethereum outbound envelope at the saturation byte floor.
    const source = chainEnvelopeSource(
      reader(
        [chainRow(EthereumChainCode, SystemContracts.SysioChainsChainkind.CHAIN_KIND_EVM)],
        [outboundRow(EthereumChainCode, 7, SaturatedEnvelopeMinBytes)]
      )
    )

    // When: the on-chain snapshot feeds the source-agnostic saturation core.
    const metrics = projectSnapshotSaturationMetrics(
      await source.snapshot(),
      ByteThresholdWindow
    )

    // Then: the live-testnet path reports saturation with no filesystem involved.
    expect(metrics.envelopeCount).toBe(1)
    expect(metrics.byteSizes).toEqual([SaturatedEnvelopeMinBytes])
    expect(metrics.saturated).toBe(true)
    expect(metrics.health.kind).toBe(OppEnvelopeTelemetryHealthKind.Healthy)
  })
})
