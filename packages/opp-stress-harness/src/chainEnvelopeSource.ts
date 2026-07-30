import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import { SystemContracts } from "@wireio/sdk-core"
import type {
  EnvelopeMetricRecord,
  EnvelopeMetricSnapshot,
  EnvelopeRecordSource
} from "@wireio/test-opp-stress"

/** Generated `sysio.msgch::outenvelopes` row — one depot→outpost chain tip. */
type OutboundEnvelopeRow = SystemContracts.SysioMsgchOutboundEnvelopeType
/** Generated `sysio.chains::chains` registry row. */
type ChainRow = SystemContracts.SysioChainsChainRowType
/** Chain kind as it arrives over JSON RPC: enum value or its spelled-out name. */
type ChainKind =
  | SystemContracts.SysioChainsChainkind
  | keyof typeof SystemContracts.SysioChainsChainkind
/**
 * An outbound depot→outpost direction, or `null` for the WIRE depot and any
 * chain kind that has no outpost. This package compiles with
 * `strictNullChecks`, so the nullable leg is a load-bearing part of the
 * contract and is named rather than spelled inline at each return position.
 */
type ResolvedOutpostDirection = DebugOutpostEndpointsType | null

/** Digits the debug storage key zero-pads the epoch index to. */
const EpochKeyDigits = 8,
  /** Truncated-checksum length used by the debug storage key. */
  ChecksumKeyLength = 16,
  /**
   * Rollover ordinal for an on-chain record. The depot's `outenvelopes` table is
   * one-deep per outpost, so intra-epoch rollover order is not recoverable via
   * RPC — every on-chain record is the current tip. Consequently the `rollover`
   * saturation strategy is unavailable to a chain source; use `byte_threshold`.
   */
  OnChainEpochEnvelopeIndex = 0

/**
 * Outbound depot→outpost direction each chain kind maps to.
 *
 * `outenvelopes` rows are always outbound, so an EVM chain's envelopes are
 * `DEPOT_OUTPOST_ETHEREUM` and an SVM chain's are `DEPOT_OUTPOST_SOLANA`. The
 * WIRE depot and unknown kinds have no outpost direction and are omitted.
 */
const OutpostDirectionByChainKind: Partial<
  Record<SystemContracts.SysioChainsChainkind, DebugOutpostEndpointsType>
> = {
  [SystemContracts.SysioChainsChainkind.CHAIN_KIND_EVM]:
    DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM,
  [SystemContracts.SysioChainsChainkind.CHAIN_KIND_SVM]:
    DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA
}

/**
 * The minimal un-privileged read surface a `ChainEnvelopeSource` needs.
 *
 * A live-testnet client implements this over ordinary `get_table_rows` calls
 * (no privileged access): the depot's outbound envelopes and the chain
 * registry. Injecting it keeps the source decoupled from any specific RPC
 * client and trivially testable.
 */
export interface ChainEnvelopeReader {
  /** Read the depot's `sysio.msgch::outenvelopes` rows (per-outpost chain tips). */
  readOutboundEnvelopes(): Promise<readonly OutboundEnvelopeRow[]>
  /** Read the `sysio.chains::chains` registry rows for chain-kind resolution. */
  readChains(): Promise<readonly ChainRow[]>
}

/**
 * Resolve the outbound depot→outpost direction for a chain kind.
 *
 * @param kind Chain kind from a `sysio.chains` row (enum value or name string).
 * @returns The outbound direction, or null for the WIRE depot / unknown kinds.
 */
export function resolveOutpostDirection(
  kind: ChainKind
): ResolvedOutpostDirection {
  const normalized =
    typeof kind === "number" ? kind : SystemContracts.SysioChainsChainkind[kind]
  return OutpostDirectionByChainKind[normalized] ?? null
}

/**
 * Build an un-privileged on-chain OPP envelope source.
 *
 * Reads the depot's outbound envelopes via the injected reader and maps each
 * row into an `EnvelopeMetricRecord` — `raw_envelope`'s decoded byte length is
 * the saturation signal — so the same `projectSnapshotSaturationMetrics` core
 * drives metrics against a live testnet with no debug-artifact filesystem and
 * no privileged access. Rows whose chain has no outpost direction are skipped.
 *
 * @param reader Un-privileged depot table reader.
 * @returns An envelope record source over the depot's on-chain outbound tips.
 */
export function chainEnvelopeSource(
  reader: ChainEnvelopeReader
): EnvelopeRecordSource {
  return {
    snapshot: async (): Promise<EnvelopeMetricSnapshot> => {
      const [chains, envelopes] = await Promise.all([
          reader.readChains(),
          reader.readOutboundEnvelopes()
        ]),
        directionByChainCode = directionIndex(chains),
        records = envelopes.flatMap(envelope => {
          const direction = directionByChainCode.get(String(envelope.chain_code))
          return direction === undefined ? [] : [toRecord(envelope, direction)]
        })
      return {
        kind: "collected",
        records,
        candidateCount: envelopes.length,
        issues: []
      }
    }
  }
}

/** Index each chain's outbound direction by its packed `chain_code` value. */
function directionIndex(
  chains: readonly ChainRow[]
): ReadonlyMap<string, DebugOutpostEndpointsType> {
  const index = new Map<string, DebugOutpostEndpointsType>()
  chains.forEach(chain => {
    const direction = resolveOutpostDirection(chain.kind)
    if (direction !== null) index.set(String(chain.code.value), direction)
  })
  return index
}

/** Map one outbound envelope row into a source-agnostic metric record. */
function toRecord(
  envelope: OutboundEnvelopeRow,
  direction: DebugOutpostEndpointsType
): EnvelopeMetricRecord {
  const checksum = envelope.envelope_hash.slice(0, ChecksumKeyLength)
  return {
    baseKey: buildBaseKey(envelope.epoch_index, direction, checksum),
    epochIndex: envelope.epoch_index,
    endpointsType: direction,
    checksum,
    epochEnvelopeIndex: OnChainEpochEnvelopeIndex,
    dataBytes: hexToBytes(envelope.raw_envelope),
    batchOpNames: []
  }
}

/** Mirror the debug storage key: `<8-digit epoch>-<DIRECTION>-<16-hex checksum>`. */
function buildBaseKey(
  epochIndex: number,
  direction: DebugOutpostEndpointsType,
  checksum: string
): string {
  const epoch = String(epochIndex).padStart(EpochKeyDigits, "0")
  return `${epoch}-${DebugOutpostEndpointsType[direction]}-${checksum}`
}

/** Decode an Antelope `bytes` hex string (no `0x` prefix) to raw bytes. */
function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"))
}
