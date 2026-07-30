import { getLogger } from "@wireio/shared"
import { APIClient } from "@wireio/sdk-core"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  collectOppEnvelopeSaturationMetrics,
  OppStressRampEvidenceModeKind,
  RunEvidenceEndpoint,
  runOppStressRamp,
  type EnvelopeRecordSource,
  type OppEnvelopeSaturationWindow,
  type OppStressRampDeferredIterationObservation,
  type OppStressRampIterationInput,
  type OppStressRampResult
} from "@wireio/test-opp-stress"

import { apiChainEnvelopeReader } from "../apiChainEnvelopeReader.js"
import { chainEnvelopeSource } from "../chainEnvelopeSource.js"
import { readEnvelopeThroughput } from "../envelopeThroughput.js"
import type { EthLoadWalletFile } from "./ethLoadWallet.js"
import { runEthSwapLoad } from "./ethRunner.js"
import type { EthSwapAmounts, EthSwapRoute } from "./ethSwap.js"
import { runSwapLoad, type SwapLoadResult } from "./loadRunner.js"
import type { LoadWalletFile } from "./loadWalletFile.js"
import type { LoadProfile } from "./LoadProfile.js"
import type { SwapAmounts, SwapRoute } from "./swapFromWire.js"

const log = getLogger(__filename)

/** WIRE-sourced direction: `swapfromwire`, producing depot→outpost envelopes. */
export interface DuplexWireDirection {
  /** Depot HTTP RPC endpoint. */
  readonly url: string
  /** Wallet set from `wire-provision`. */
  readonly wallets: LoadWalletFile
  /** Pre-existing destination route. */
  readonly route: SwapRoute
  /** Per-swap amounts and tolerance. */
  readonly amounts: SwapAmounts
}

/** Ethereum-sourced direction: `requestSwap`, queueing outpost→depot attestations. */
export interface DuplexEthereumDirection {
  /** Ethereum outpost JSON-RPC endpoint. */
  readonly url: string
  /** Deployed ReserveManager contract address. */
  readonly reserveManager: string
  /** Wallet set from `eth-provision`. */
  readonly wallets: EthLoadWalletFile
  /** Pre-existing source/target route slugs. */
  readonly route: EthSwapRoute
  /** Per-swap ETH value and minimum destination amount. */
  readonly amounts: EthSwapAmounts
}

/** Inputs for one bidirectional (duplex) stress campaign. */
export interface DuplexRunOptions {
  /** The depot→outpost half of the bridge. */
  readonly wire: DuplexWireDirection
  /** The outpost→depot half of the bridge. */
  readonly ethereum: DuplexEthereumDirection
  /** Resolved intensity: byte target plus ramp curve and per-direction workload. */
  readonly profile: LoadProfile
}

/** Both directions' results from one concurrent burst. */
export interface DuplexBurstResult {
  /** WIRE-sourced (`swapfromwire`) outcome. */
  readonly wire: SwapLoadResult
  /** Ethereum-sourced (`requestSwap`) outcome. */
  readonly ethereum: SwapLoadResult
}

/** What one duplex iteration measured on each half of the bridge. */
export interface DuplexIterationMeasurement {
  /** Wallets driven per direction this iteration. */
  readonly accountCount: number
  /** Largest depot→outpost envelope observed while the burst ran. */
  readonly outboundPeakBytes: number
  /** Distinct depot→outpost envelopes sampled during the burst. */
  readonly outboundEnvelopeCount: number
  /** Accepted ETH→WIRE swaps — the applied outpost→depot attestation load. */
  readonly inboundAcceptedSwaps: number
  /** Epochs the burst spanned; the divisor for the per-epoch inference. */
  readonly epochsSpanned: number
  /** Inferred outpost→depot attestations landing per epoch. */
  readonly inboundAttestationsPerEpoch: number
  /** Required endpoints this iteration claims saturated. */
  readonly saturatedEndpoints: readonly RunEvidenceEndpoint[]
}

/** Inputs for the pure duplex classification step. */
export interface DuplexMeasurementInput {
  /** Wallets driven per direction this iteration. */
  readonly accountCount: number
  /** Resolved intensity carrying the byte target. */
  readonly profile: LoadProfile
  /** Byte sizes of every distinct depot→outpost envelope sampled. */
  readonly sampledByteSizes: readonly number[]
  /** Accepted ETH→WIRE swaps this iteration. */
  readonly inboundAcceptedSwaps: number
  /** Epochs the burst spanned; always at least one. */
  readonly epochsSpanned: number
}

/** A running depot→outpost envelope sampler. */
export interface OutboundSampler {
  /** Signal the polling loop to finish after its in-flight read. */
  stop(): void
  /** Await the loop and yield each distinct envelope's byte size. */
  collected(): Promise<readonly number[]>
}

/** Mutable state shared between the sampler handle and its polling loop. */
interface OutboundSamplerState {
  running: boolean
  readonly byKey: Map<string, number>
}

/** Both halves of the bridge, required together for a duplex campaign. */
export const DuplexRequiredEndpoints: readonly RunEvidenceEndpoint[] = [
  RunEvidenceEndpoint.DepotOutpostEthereum,
  RunEvidenceEndpoint.OutpostEthereumDepot
]

/**
 * Mean serialized size of one OPP attestation, from the r5–r7 calibration runs.
 *
 * Only used to INFER inbound saturation from applied load: the depot clears an
 * inbound envelope's bytes once consensus is reached, so an un-privileged
 * observer can never measure outpost→depot envelope size directly. Raising this
 * makes the inbound gate stricter (more swaps demanded per epoch).
 */
export const EstimatedAttestationBytes = 300

/** Interval between depot `outenvelopes` samples while a burst runs. */
export const OutboundSampleIntervalMs = 2_000

/** Label carried on the ramp observation; both directions ran as one unit. */
export const DuplexObservationEndpoint = "DUPLEX_ETHEREUM"

/**
 * Run a bidirectional stress campaign against the WIRE↔Ethereum bridge.
 *
 * Both directions are driven CONCURRENTLY at every ramp iteration so a loaded
 * inbound epoch coincides with a loaded outbound queue — the condition
 * `OPPInbound.epochIn` faces when it dispatches an inbound envelope and then
 * drains the outbound queue via its inline `emitOutboundEnvelope`.
 *
 * The two halves are measured differently because only one is observable
 * un-privileged: depot→outpost saturation is MEASURED from `outenvelopes` byte
 * size sampled during the burst, while outpost→depot saturation is INFERRED
 * from accepted swaps per epoch against {@link EstimatedAttestationBytes}.
 *
 * @param options Both directions plus the resolved load profile.
 * @returns The ramp's terminal status and per-iteration evidence.
 */
export async function runDuplexCampaign(
  options: DuplexRunOptions
): Promise<OppStressRampResult> {
  const api = new APIClient({ url: options.wire.url }),
    source = chainEnvelopeSource(apiChainEnvelopeReader(api))
  return runOppStressRamp({
    evidenceMode: OppStressRampEvidenceModeKind.DeferredFlowMigration,
    requiredEndpoints: DuplexRequiredEndpoints,
    config: options.profile.ramp,
    runIteration: (input: OppStressRampIterationInput) =>
      runDuplexIteration(options, api, source, input)
  })
}

/**
 * Drive one ramp iteration: both directions concurrently, then classify.
 *
 * @param options Both directions plus the resolved load profile.
 * @param api Depot client used for the epoch reads.
 * @param source Un-privileged on-chain envelope source.
 * @param input Ramp-supplied iteration index and account count.
 * @returns A deferred-mode observation the ramp controller can decide on.
 */
export async function runDuplexIteration(
  options: DuplexRunOptions,
  api: APIClient,
  source: EnvelopeRecordSource,
  input: OppStressRampIterationInput
): Promise<OppStressRampDeferredIterationObservation> {
  const { profile } = options,
    accountCount = resolveAccountCount(options, input.accountCount),
    observationStartedAtMs = Date.now(),
    startEpoch = await readHeadEpoch(api),
    sampler = startOutboundSampling(source, profile),
    burst = await runDuplexBurst(options, accountCount).finally(() =>
      sampler.stop()
    ),
    sampledByteSizes = await sampler.collected(),
    endEpoch = await readHeadEpoch(api),
    observationEndedAtMs = Date.now(),
    measurement = measureDuplexIteration({
      accountCount,
      profile,
      sampledByteSizes,
      inboundAcceptedSwaps: burst.ethereum.accepted.length,
      epochsSpanned: Math.max(1, endEpoch - startEpoch + 1)
    })
  log.info(
    `duplex iteration ${input.iterationIndex} @ ${accountCount} accounts: ` +
      `outbound peak ${measurement.outboundPeakBytes}B of ` +
      `${profile.saturatedEnvelopeMinBytes}B target, inbound ~` +
      `${measurement.inboundAttestationsPerEpoch}/epoch, saturated ` +
      `[${measurement.saturatedEndpoints.join(", ")}]`
  )
  return {
    kind: "completed",
    phase: DuplexObservationEndpoint,
    endpoint: DuplexObservationEndpoint,
    observationStartedAtMs,
    observationEndedAtMs,
    txSuccesses: burst.wire.accepted.length + burst.ethereum.accepted.length,
    txFailures: burst.wire.failures.length + burst.ethereum.failures.length,
    envelopeCount: sampledByteSizes.length,
    envelopeByteSizes: sampledByteSizes,
    epochStart: startEpoch,
    epochEnd: endEpoch,
    saturatedEndpoints: measurement.saturatedEndpoints,
    observedNonRequiredEndpoints: []
  }
}

/**
 * Drive both directions concurrently over the same wallet prefix.
 *
 * Concurrency is the whole point: the inbound and outbound halves must be in
 * flight together for a single `epochIn` to face both at once.
 *
 * @param options Both directions plus the resolved load profile.
 * @param accountCount Wallets to drive from each direction's set.
 * @returns Each direction's submitted/accepted/failed summary.
 */
export async function runDuplexBurst(
  options: DuplexRunOptions,
  accountCount: number
): Promise<DuplexBurstResult> {
  const { profile } = options,
    [wire, ethereum] = await Promise.all([
      runSwapLoad({
        url: options.wire.url,
        wallets: options.wire.wallets.wallets.slice(0, accountCount),
        route: options.wire.route,
        amounts: options.wire.amounts,
        swapsPerWallet: profile.workload.swapsPerWallet,
        concurrency: profile.workload.concurrency
      }),
      runEthSwapLoad({
        url: options.ethereum.url,
        reserveManager: options.ethereum.reserveManager,
        recipient: options.ethereum.wallets.recipient,
        wallets: options.ethereum.wallets.wallets.slice(0, accountCount),
        route: options.ethereum.route,
        amounts: options.ethereum.amounts,
        swapsPerWallet: profile.workload.swapsPerWallet,
        concurrency: profile.workload.concurrency
      })
    ])
  return { wire, ethereum }
}

/**
 * Classify one duplex iteration against the profile's byte target.
 *
 * Pure — no chain access — so the saturation rules are unit-testable.
 *
 * @param input Sampled bytes, applied inbound load, and the profile.
 * @returns The per-direction measurement and the endpoints it saturates.
 */
export function measureDuplexIteration(
  input: DuplexMeasurementInput
): DuplexIterationMeasurement {
  const { profile, sampledByteSizes, epochsSpanned } = input,
    outboundPeakBytes =
      sampledByteSizes.length === 0 ? 0 : Math.max(...sampledByteSizes),
    inboundAttestationsPerEpoch = Math.floor(
      input.inboundAcceptedSwaps / epochsSpanned
    ),
    requiredAttestations = Math.ceil(
      profile.saturatedEnvelopeMinBytes / EstimatedAttestationBytes
    ),
    saturatedEndpoints: RunEvidenceEndpoint[] = []
  if (outboundPeakBytes >= profile.saturatedEnvelopeMinBytes)
    saturatedEndpoints.push(RunEvidenceEndpoint.DepotOutpostEthereum)
  if (inboundAttestationsPerEpoch >= requiredAttestations)
    saturatedEndpoints.push(RunEvidenceEndpoint.OutpostEthereumDepot)
  return {
    accountCount: input.accountCount,
    outboundPeakBytes,
    outboundEnvelopeCount: sampledByteSizes.length,
    inboundAcceptedSwaps: input.inboundAcceptedSwaps,
    epochsSpanned,
    inboundAttestationsPerEpoch,
    saturatedEndpoints
  }
}

/**
 * Poll the depot's outbound envelopes while a burst runs.
 *
 * `outenvelopes` is one-deep per outpost — it holds only the current tip — so a
 * single read after the burst would miss every envelope the depot already
 * rotated past. Sampling accumulates distinct envelopes by their storage key,
 * which is what makes a peak byte size observable at all.
 *
 * @param source Un-privileged on-chain envelope source.
 * @param profile Resolved intensity supplying the byte gate for the window.
 * @returns A handle to stop the loop and collect its distinct byte sizes.
 */
export function startOutboundSampling(
  source: EnvelopeRecordSource,
  profile: LoadProfile
): OutboundSampler {
  const state: OutboundSamplerState = { running: true, byKey: new Map() },
    window: OppEnvelopeSaturationWindow = {
      saturationStrategy: "byte_threshold",
      saturatedEnvelopeMinBytes: profile.saturatedEnvelopeMinBytes,
      endpointsType: DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
    },
    loop = pollOutboundSamples(source, window, state)
  return {
    stop: () => {
      state.running = false
    },
    collected: async () => {
      await loop
      return [...state.byKey.values()]
    }
  }
}

/** Accumulate distinct outbound envelopes until the sampler is stopped. */
async function pollOutboundSamples(
  source: EnvelopeRecordSource,
  window: OppEnvelopeSaturationWindow,
  state: OutboundSamplerState
): Promise<void> {
  while (state.running) {
    try {
      const metrics = await collectOppEnvelopeSaturationMetrics(source, window)
      metrics.envelopes.forEach(envelope =>
        state.byKey.set(envelope.key, envelope.byteSize)
      )
    } catch (error) {
      log.warn(
        `duplex outbound sample failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
    if (state.running) await delay(OutboundSampleIntervalMs)
  }
}

/** Clamp the ramp's account count to what both wallet sets can actually drive. */
function resolveAccountCount(
  options: DuplexRunOptions,
  requested: number
): number {
  return Math.min(
    requested,
    options.wire.wallets.wallets.length,
    options.ethereum.wallets.wallets.length
  )
}

/** Read the depot's newest epoch from the retained `envlog` window. */
async function readHeadEpoch(api: APIClient): Promise<number> {
  const snapshot = await readEnvelopeThroughput(api),
    last = snapshot.epochs[snapshot.epochs.length - 1]
  return last === undefined ? 0 : last.epoch
}

/** Resolve after `ms`, always clearing the timer it armed. */
function delay(ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      clearTimeout(timer)
      resolve()
    }, ms)
  })
}
