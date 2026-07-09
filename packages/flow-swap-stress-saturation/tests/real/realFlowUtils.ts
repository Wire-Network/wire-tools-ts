import * as Path from "node:path"

import { PublicKey } from "@solana/web3.js"
import { oppDebuggingPath } from "@wireio/debugging-shared"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import { SystemContracts } from "@wireio/sdk-core"
import { pollUntil } from "@wireio/test-cluster-tool"
import { collectEnvelopeSaturationMetrics } from "@wireio/test-flow-swap-stress-saturation"

import { RequiredEnvVars, Reserves, Timing } from "./realFlowConstants.js"
import type {
  AnchorAccountFetcher,
  RealStressFlow,
  ReserveRow,
  SplMintRecord
} from "./realFlowTypes.js"
import type { FlowTestContext } from "@wireio/test-cluster-tool"
import type {
  StressPrivateReserveSnapshot,
  SwapStressEnvelopeMetricRequest,
  SwapStressPhaseEnvelopeMetrics,
  SwapStressReservePairSnapshot,
  SwapStressRouteCodes
} from "@wireio/test-flow-swap-stress-saturation"

type PhaseMetricsOptions = {
  readonly evidenceTimeoutMs: number
  readonly evidencePollIntervalMs: number
}

const DefaultPhaseMetricsOptions: PhaseMetricsOptions = {
  evidenceTimeoutMs: Timing.RelayDeadlineMs,
  evidencePollIntervalMs: Timing.LongPollIntervalMs
}

/** True when all real-flow env paths are configured. */
export function requiredEnvPresent(): boolean {
  return RequiredEnvVars.every(
    name => process.env[name] !== undefined && process.env[name] !== ""
  )
}

/** Return a bootstrapped flow or fail the test with an explicit message. */
export function requireFlow(flow: RealStressFlow | null): RealStressFlow {
  if (flow === null) throw new Error("real stress flow was not bootstrapped")
  return flow
}

/** Evidence directory used by the real saturation ramp. */
export function evidenceDir(clusterPath: string): string {
  return Path.join(clusterPath, "data", "swap-stress-saturation")
}

/** Locate the USDCSOL SPL mint from bootstrap records. */
export function findSplMint(records: readonly SplMintRecord[]): PublicKey {
  const record = records.find(entry => entry.code === Reserves.Solana.TokenCode)
  if (record === undefined)
    throw new Error("Bootstrap did not persist the USDCSOL SPL mint")
  return new PublicKey(record.mint)
}

/** Convert a slug_name number into the Solana PDA seed shape. */
export function slugNameToLeBuffer(value: number): Buffer {
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64LE(BigInt(value))
  return buffer
}

/** Read one depot reserve row. */
export async function reserveRow(
  context: FlowTestContext,
  chainCode: number,
  tokenCode: number,
  reserveCode: number = Reserves.PrivateReserveCode
): Promise<ReserveRow | null> {
  const result = await context.wireClient.getTableRows<ReserveRow>({
    code: "sysio.reserv",
    scope: "sysio.reserv",
    table: "reserves"
  })
  return (
    result.rows.find(
      row =>
        slugValue(row.chain_code) === chainCode &&
        slugValue(row.token_code) === tokenCode &&
        slugValue(row.reserve_code) === reserveCode
    ) ?? null
  )
}

/** Read one stress private reserve row or fail with route context. */
export async function reserveRowOrThrow(
  context: FlowTestContext,
  chainCode: number,
  tokenCode: number
): Promise<ReserveRow> {
  const row = await reserveRow(context, chainCode, tokenCode)
  if (row === null)
    throw new Error(
      `missing stress private reserve row ${chainCode}/${tokenCode}`
    )
  return row
}

/** Check a depot reserve row against either supported enum wire shape. */
export function reserveStatusIs(
  row: ReserveRow | null,
  expected: SystemContracts.SysioReservReservestatus
): boolean {
  return (
    row !== null &&
    (Number(row.status) === expected ||
      row.status === SystemContracts.SysioReservReservestatus[expected])
  )
}

/** Read ACTIVE private reserve amounts for setup evidence. */
export async function readActiveSnapshot(
  context: FlowTestContext
): Promise<StressPrivateReserveSnapshot> {
  const ethereum = await reserveRowOrThrow(
      context,
      Reserves.Ethereum.ChainCode,
      Reserves.Ethereum.TokenCode
    ),
    solana = await reserveRowOrThrow(
      context,
      Reserves.Solana.ChainCode,
      Reserves.Solana.TokenCode
    )
  return {
    ethereumDepotChainAmount: BigInt(ethereum.reserve_chain_amount),
    ethereumDepotWireAmount: BigInt(ethereum.reserve_wire_amount),
    solanaDepotChainAmount: BigInt(solana.reserve_chain_amount),
    solanaDepotWireAmount: BigInt(solana.reserve_wire_amount)
  }
}

/** Read the live quote baseline consumed by the phase runner. */
export async function readReservePairSnapshot(
  context: FlowTestContext
): Promise<SwapStressReservePairSnapshot> {
  const snapshot = await readActiveSnapshot(context),
    ethereumPublic = await reserveRow(
      context,
      Reserves.Ethereum.ChainCode,
      Reserves.Ethereum.TokenCode,
      Reserves.Wire.SentinelReserveCode
    )
  if (ethereumPublic === null)
    throw new Error("missing ETH primary reserve row for stress quote")
  return {
    ethereum: {
      chain: BigInt(ethereumPublic.reserve_chain_amount),
      wire: BigInt(ethereumPublic.reserve_wire_amount)
    },
    solana: {
      chain: snapshot.solanaDepotChainAmount,
      wire: snapshot.solanaDepotWireAmount
    }
  }
}

/** Route codes for ETH <-> WIRE stress swaps. */
export function routeCodes(): SwapStressRouteCodes {
  return {
    ethereumChainCode: BigInt(Reserves.Ethereum.ChainCode),
    ethereumTokenCode: BigInt(Reserves.Ethereum.TokenCode),
    solanaChainCode: BigInt(Reserves.Solana.ChainCode),
    solanaTokenCode: BigInt(Reserves.Solana.TokenCode),
    wireChainCode: BigInt(Reserves.Wire.ChainCode),
    wireTokenCode: BigInt(Reserves.Wire.TokenCode),
    wireSentinelReserveCode: BigInt(Reserves.Wire.SentinelReserveCode),
    privateReserveCode: BigInt(Reserves.PrivateReserveCode)
  }
}

/** Project one phase's persisted OPP envelopes into ramp telemetry. */
export async function collectPhaseMetrics(
  clusterPath: string,
  request: SwapStressEnvelopeMetricRequest,
  options: PhaseMetricsOptions = DefaultPhaseMetricsOptions
): Promise<SwapStressPhaseEnvelopeMetrics> {
  const storageDir = oppDebuggingPath(clusterPath)
  await pollUntil(
    `${request.phase} ${DebugOutpostEndpointsType[request.endpointsType]} OPP evidence observed`,
    async () =>
      (await collectWindowMetrics(storageDir, request, Date.now()))
        .envelopeCount > 0,
    options.evidenceTimeoutMs,
    options.evidencePollIntervalMs
  )
  const metrics = await collectWindowMetrics(storageDir, request, Date.now())
  return {
    phase: request.phase,
    saturated: metrics.saturated,
    envelopeCount: metrics.envelopeCount,
    envelopeByteSizes: metrics.byteSizes,
    endpoint: DebugOutpostEndpointsType[request.endpointsType],
    epochStart: metrics.envelopes[0]?.epoch ?? 0,
    epochEnd: metrics.envelopes[metrics.envelopes.length - 1]?.epoch ?? 0
  }
}

async function collectWindowMetrics(
  storageDir: string,
  request: SwapStressEnvelopeMetricRequest,
  endedAtMs: number
) {
  return collectEnvelopeSaturationMetrics(storageDir, {
    endpointsType: request.endpointsType,
    timestampStartMs: request.startedAtMs,
    timestampEndMs: endedAtMs
  })
}

/** Narrow an Anchor account namespace by name. */
export function accountNamespace(
  account: unknown,
  key: string
): AnchorAccountFetcher {
  if (!objectHasKey(account, key))
    throw new Error(`Anchor account namespace missing: ${key}`)
  const value = account[key]
  if (!hasAnchorFetch(value)) {
    throw new Error(`Anchor account namespace cannot fetch: ${key}`)
  }
  return {
    fetch: async address =>
      narrowAnchorReserveAccount(await value.fetch(address), key)
  }
}

/** Narrow an object with a known key. */
export function objectHasKey<Key extends string>(
  value: unknown,
  key: Key
): value is Record<Key, unknown> {
  return typeof value === "object" && value !== null && key in value
}

function slugValue(value: unknown): number {
  return objectHasKey(value, "value") ? Number(value.value) : Number(value)
}

function narrowAnchorReserveAccount(
  value: unknown,
  key: string
): { readonly status: unknown } {
  if (!objectHasKey(value, "status"))
    throw new Error(`Anchor account result missing status: ${key}`)
  return { status: value.status }
}

function hasAnchorFetch(value: unknown): value is AnchorAccountFetcher {
  return objectHasKey(value, "fetch") && typeof value.fetch === "function"
}
