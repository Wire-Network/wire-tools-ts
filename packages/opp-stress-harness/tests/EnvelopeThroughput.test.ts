import type { SystemContracts } from "@wireio/sdk-core"

import {
  classifyEnvelopeLog,
  formatThroughputSummary
} from "@wireio/opp-stress-harness"

const WireKind = 1,
  EthKind = 2

/** Build one `envlog` row with the given endpoint kinds and epoch. */
function row(
  epoch: number,
  startKind: number,
  endKind: number
): SystemContracts.SysioMsgchEnvelopeLogEntryType {
  return {
    id: 0,
    endpoints: {
      start: { kind: startKind, id: { value: 0 } },
      end: { kind: endKind, id: { value: 0 } }
    },
    epoch_index: epoch,
    checksum: "",
    emitted_at: ""
  } as unknown as SystemContracts.SysioMsgchEnvelopeLogEntryType
}

describe("classifyEnvelopeLog", () => {
  it("counts inbound (end=WIRE) and outbound (start=WIRE) per epoch", () => {
    // Given: two inbound and one outbound row in epoch 7, one inbound in epoch 8.
    const snapshot = classifyEnvelopeLog([
      row(7, EthKind, WireKind), // inbound
      row(7, EthKind, WireKind), // inbound
      row(7, WireKind, EthKind), // outbound
      row(8, EthKind, WireKind) // inbound
    ])

    // Then: totals and per-epoch counts reflect the direction split.
    expect(snapshot.totalInbound).toBe(3)
    expect(snapshot.totalOutbound).toBe(1)
    expect(snapshot.epochs).toEqual([
      { epoch: 7, inbound: 2, outbound: 1 },
      { epoch: 8, inbound: 1, outbound: 0 }
    ])
  })

  it("accepts the spelled-out chain-kind name from JSON RPC", () => {
    const snapshot = classifyEnvelopeLog([
      {
        id: 0,
        endpoints: {
          start: { kind: "CHAIN_KIND_EVM", id: { value: 0 } },
          end: { kind: "CHAIN_KIND_WIRE", id: { value: 0 } }
        },
        epoch_index: 5,
        checksum: "",
        emitted_at: ""
      } as unknown as SystemContracts.SysioMsgchEnvelopeLogEntryType
    ])
    expect(snapshot.totalInbound).toBe(1)
  })

  it("returns empty totals for no rows", () => {
    const snapshot = classifyEnvelopeLog([])
    expect(snapshot.totalInbound).toBe(0)
    expect(snapshot.epochs).toEqual([])
  })
})

describe("formatThroughputSummary", () => {
  it("renders totals and per-epoch lines", () => {
    const summary = formatThroughputSummary(
      classifyEnvelopeLog([row(7, EthKind, WireKind), row(7, WireKind, EthKind)])
    )
    expect(summary).toContain("inbound total:  1")
    expect(summary).toContain("outbound total: 1")
    expect(summary).toContain("epoch 7: inbound 1, outbound 1")
  })
})
