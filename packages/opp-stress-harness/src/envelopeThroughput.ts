import { APIClient, SystemContracts } from "@wireio/sdk-core"

/** `sysio.msgch::envlog` row — one envelope's direction/epoch metadata. */
type EnvelopeLogRow = SystemContracts.SysioMsgchEnvelopeLogEntryType
/** Chain kind of an envelope endpoint (enum value or JSON-RPC name). */
type EndpointKind =
  | SystemContracts.SysioMsgchChainkind
  | keyof typeof SystemContracts.SysioMsgchChainkind

const MsgchAccount = "sysio.msgch",
  /** Bounded, head-evicted log of recent inbound/outbound envelopes. */
  EnvLogTable = "envlog",
  /** Row cap; the table is already bounded to recent epochs on chain. */
  DefaultRowLimit = 1_000

/** Inbound/outbound envelope counts for one epoch. */
export interface EpochEnvelopeCounts {
  /** Epoch index. */
  readonly epoch: number
  /** Outpost→depot envelopes recorded for the epoch. */
  readonly inbound: number
  /** Depot→outpost envelopes recorded for the epoch. */
  readonly outbound: number
}

/**
 * Inbound/outbound envelope throughput over the retained `envlog` window.
 *
 * The `envlog` table is head-evicted to a few recent epochs, so this is a
 * rolling snapshot, not lifetime totals. Inbound count is the signal an
 * ETH-sourced load run moves (its swaps are outpost→depot); the byte-saturation
 * monitor cannot see it because inbound bytes are cleared after consensus.
 */
export interface ThroughputSnapshot {
  /** Inbound envelopes across the retained window. */
  readonly totalInbound: number
  /** Outbound envelopes across the retained window. */
  readonly totalOutbound: number
  /** Per-epoch counts, ascending by epoch. */
  readonly epochs: readonly EpochEnvelopeCounts[]
}

/** Whether an endpoint kind is the WIRE depot. */
function isWireKind(kind: EndpointKind): boolean {
  const normalized =
    typeof kind === "number"
      ? kind
      : SystemContracts.SysioMsgchChainkind[kind]
  return normalized === SystemContracts.SysioMsgchChainkind.CHAIN_KIND_WIRE
}

/**
 * Classify `envlog` rows into per-epoch inbound/outbound counts.
 *
 * An envelope is inbound (outpost→depot) when its destination endpoint is the
 * WIRE depot, and outbound (depot→outpost) when its source endpoint is.
 *
 * @param rows Decoded `envlog` rows.
 * @returns The throughput snapshot, epochs ascending.
 */
export function classifyEnvelopeLog(
  rows: readonly EnvelopeLogRow[]
): ThroughputSnapshot {
  const byEpoch = new Map<number, { inbound: number; outbound: number }>()
  let totalInbound = 0,
    totalOutbound = 0
  rows.forEach(row => {
    const counts = byEpoch.get(row.epoch_index) ?? { inbound: 0, outbound: 0 }
    if (isWireKind(row.endpoints.end.kind)) {
      counts.inbound += 1
      totalInbound += 1
    } else if (isWireKind(row.endpoints.start.kind)) {
      counts.outbound += 1
      totalOutbound += 1
    }
    byEpoch.set(row.epoch_index, counts)
  })
  const epochs = [...byEpoch.entries()]
    .map(([epoch, counts]) => ({ epoch, ...counts }))
    .sort((left, right) => left.epoch - right.epoch)
  return { totalInbound, totalOutbound, epochs }
}

/**
 * Render a throughput snapshot for CLI stdout.
 *
 * @param snapshot Snapshot from `readEnvelopeThroughput`.
 * @returns A multi-line summary (no trailing newline).
 */
export function formatThroughputSummary(snapshot: ThroughputSnapshot): string {
  const header = [
      "OPP envelope throughput (retained envlog window)",
      `  inbound total:  ${snapshot.totalInbound}`,
      `  outbound total: ${snapshot.totalOutbound}`
    ],
    perEpoch = snapshot.epochs.map(
      epoch =>
        `  epoch ${epoch.epoch}: inbound ${epoch.inbound}, outbound ${epoch.outbound}`
    )
  return [...header, ...perEpoch].join("\n")
}

/**
 * Read inbound/outbound envelope throughput from the depot over RPC.
 *
 * Un-privileged: reads the depot's bounded `envlog` table. This is the lens for
 * ETH-sourced (inbound) load, which the saturation monitor cannot measure.
 *
 * @param api API client pointed at a WIRE depot HTTP endpoint.
 * @returns The current throughput snapshot.
 */
export async function readEnvelopeThroughput(
  api: APIClient
): Promise<ThroughputSnapshot> {
  const result = await api.v1.chain.get_table_rows({
    code: MsgchAccount,
    scope: MsgchAccount,
    table: EnvLogTable,
    limit: DefaultRowLimit,
    json: true
  } as Parameters<APIClient["v1"]["chain"]["get_table_rows"]>[0])
  const rows: readonly unknown[] =
    (result as { rows?: readonly unknown[] }).rows ?? []
  return classifyEnvelopeLog(
    rows.map(row =>
      row !== null && typeof row === "object" && "value" in row
        ? (row as { value: EnvelopeLogRow }).value
        : (row as EnvelopeLogRow)
    )
  )
}
