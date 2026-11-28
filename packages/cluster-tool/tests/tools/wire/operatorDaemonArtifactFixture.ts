import type * as anchor from "@coral-xyz/anchor"
import { ethers } from "ethers"
import { OperatorDaemonTool } from "@wireio/cluster-tool/tools/wire"
import { SolanaOutpostProgramTool } from "@wireio/cluster-tool/tools/solana"

/** The record type wire-solana's `EpochDeliveries.deliveries` Vec holds. */
export const FixtureDeliveryRecordType = "OperatorDelivery"

/** wire-solana's `OutboundMessageBuffer` header: the relay decodes `attestation_count` at its fixed offset. */
const FixtureOutboundBufferFields: readonly OperatorDaemonTool.SolanaIdlField[] = [
  { name: "next_swap_id", type: "u64" },
  { name: "used_data_bytes", type: "u32" },
  { name: "attestation_count", type: "u16" },
  { name: "bump", type: "u8" }
]

/** wire-solana's `LatestOutboundEnvelope`: the relay decodes `epoch_index` at its fixed offset. */
const FixtureLatestEnvelopeFields: readonly OperatorDaemonTool.SolanaIdlField[] = [
  { name: "bump", type: "u8" },
  { name: "epoch_index", type: "u32" },
  { name: "checksum", type: { array: ["u8", 32] } },
  { name: "data", type: "bytes" }
]

/** The `OperatorDelivery` field wire-solana declares after the deliverer's key. */
const FixtureDeliveryRecordTrailer: OperatorDaemonTool.SolanaIdlField = {
  name: "envelope_hash",
  type: { array: ["u8", 32] }
}

/** The IDL spec version the fixture's metadata names (Anchor 0.31's). */
const FixtureIdlSpec = "0.1.0"

/** What {@link fixtureOutpostIdl} declares; every member defaults to what the daemons require. */
export interface FixtureOutpostIdlOptions {
  /** The IDL's top-level `address` (default: empty, as the wire-solana build leaves it unread). */
  readonly address?: string
  /** The instructions it declares (default: every daemon-invoked instruction). */
  readonly instructions?: readonly string[]
  /** The accounts left out of its `accounts` list (default: none). */
  readonly omittedAccounts?: readonly string[]
  /** The `OutboundMessageBuffer` struct's fields (default: wire-solana's header). */
  readonly outboundBufferFields?: readonly OperatorDaemonTool.SolanaIdlField[]
  /** The `LatestOutboundEnvelope` struct's fields (default: wire-solana's). */
  readonly latestEnvelopeFields?: readonly OperatorDaemonTool.SolanaIdlField[]
  /** The type of `EpochDeliveries.deliveries` (default: a Vec of {@link FixtureDeliveryRecordType}). */
  readonly deliveriesType?: OperatorDaemonTool.SolanaIdlField["type"]
  /** The {@link FixtureDeliveryRecordType} record's fields (default: `operator` pubkey, then the hash). */
  readonly deliveryRecordFields?: readonly OperatorDaemonTool.SolanaIdlField[]
}

/** A named struct type definition of the fixture IDL. */
function structType(
  name: string,
  fields: readonly OperatorDaemonTool.SolanaIdlField[]
): anchor.Idl["types"][number] {
  return { name, type: { kind: "struct", fields: [...fields] } }
}

/**
 * A `liqsol_core` IDL carrying what `OperatorDaemonTool.assertSolanaIdl` requires of the OPP
 * outpost — the daemon-invoked instructions, the `OutboundMessageBuffer` and
 * `LatestOutboundEnvelope` layouts the relay decodes at fixed offsets, and
 * `EpochDeliveries.deliveries` holding records that name their `operator` — each overridable to
 * model a wrong or stale IDL.
 *
 * @param options - What the IDL declares; omitted members take the daemons' requirements.
 * @returns The IDL.
 */
export function fixtureOutpostIdl(options: FixtureOutpostIdlOptions = {}): anchor.Idl {
  const {
      address = "",
      instructions = OperatorDaemonTool.RequiredSolanaIdlInstructions,
      omittedAccounts = [],
      outboundBufferFields = FixtureOutboundBufferFields,
      latestEnvelopeFields = FixtureLatestEnvelopeFields,
      deliveriesType = { vec: { defined: { name: FixtureDeliveryRecordType } } },
      deliveryRecordFields = [
        OperatorDaemonTool.RequiredSolanaDeliveryRecordField,
        FixtureDeliveryRecordTrailer
      ]
    } = options,
    accounts = [
      OperatorDaemonTool.SolanaOutboundBufferAccount,
      OperatorDaemonTool.SolanaLatestOutboundEnvelopeAccount,
      OperatorDaemonTool.SolanaEpochDeliveriesAccount
    ].filter(name => !omittedAccounts.includes(name))
  return {
    address,
    metadata: {
      name: SolanaOutpostProgramTool.ProgramName,
      version: FixtureIdlSpec,
      spec: FixtureIdlSpec
    },
    instructions: instructions.map(name => ({
      name,
      discriminator: [],
      accounts: [],
      args: []
    })),
    accounts: accounts.map(name => ({ name, discriminator: [] })),
    types: [
      structType(OperatorDaemonTool.SolanaOutboundBufferAccount, outboundBufferFields),
      structType(OperatorDaemonTool.SolanaLatestOutboundEnvelopeAccount, latestEnvelopeFields),
      structType(OperatorDaemonTool.SolanaEpochDeliveriesAccount, [
        { name: OperatorDaemonTool.SolanaEpochDeliveriesRecordsField, type: deliveriesType }
      ]),
      structType(FixtureDeliveryRecordType, deliveryRecordFields)
    ]
  }
}

/**
 * A daemon ABI's hardhat `abi`: one event, plus a view for every function
 * `OperatorDaemonTool.RequiredEthereumAbiFunctions` requires of `contractName`, less `omitted`.
 *
 * @param contractName - The daemon ABI's contract.
 * @param event - The event it declares.
 * @param omitted - Required functions to leave out (a stale ABI).
 * @returns The ABI fragments.
 */
export function fixtureEthereumAbi(
  contractName: OperatorDaemonTool.EthereumAbiContractName,
  event: string,
  omitted: readonly string[] = []
): ethers.JsonFragment[] {
  return [
    { type: "event", name: event, inputs: [] },
    ...OperatorDaemonTool.RequiredEthereumAbiFunctions[contractName]
      .filter(name => !omitted.includes(name))
      .map(name => ({
        type: "function",
        name,
        inputs: [],
        outputs: [],
        stateMutability: "view"
      }))
  ]
}
