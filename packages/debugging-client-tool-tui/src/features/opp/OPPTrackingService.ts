import {
  ClosedReason,
  StreamTopic,
  type EnvelopeEvent
} from "@wireio/debugging-shared"
import type {
  DebuggingClient,
  DebuggingSubscription
} from "@wireio/debugging-client-shared"

import { LoggingManager } from "../../logging/LoggingManager.js"
import { DebuggingClientService } from "../../services/DebuggingClientService.js"
import { ReduxService } from "../../services/ReduxService.js"
import { ServiceId } from "../../services/ServiceId.js"
import type { Service } from "../../services/Service.js"
import type { ServiceManager } from "../../services/ServiceManager.js"
import { appendEnvelope } from "../../store/opp/OPPSlice.js"

/**
 * Subscribes to the {@link StreamTopic.EnvelopeWatch} stream on the
 * configured {@link DebuggingClient} and dispatches each event to the OPP
 * Redux slice as `appendEnvelope`. Both `Hydrated` (replayed) and `Added`
 * (live) events share the same path because `appendEnvelope` dedupes on
 * `(endpointsType, checksum)` — a record can't land twice no matter how
 * many times the producer replays it.
 *
 * An earlier buffer-then-bulk-`hydrate` shape was an optimization that
 * assumed the producer's hydrate dump completed synchronously; with the
 * stream transport the dump is interleaved with `Added` events over a
 * potentially long-running WebSocket, so a fixed-window flush silently
 * dropped late hydration events. Per-event dispatch is correct under
 * any timing.
 */
export class OPPTrackingService implements Service {
  static readonly id = ServiceId.OPPTracking
  static readonly dependsOn: readonly string[] = [
    ServiceId.Redux,
    ServiceId.DebuggingClient
  ]

  private readonly log = LoggingManager.getLogger(OPPTrackingService.Category)
  private redux: ReduxService | null = null
  private client: DebuggingClient | null = null
  private subscription: DebuggingSubscription<EnvelopeEvent> | null = null

  async init(manager: ServiceManager): Promise<this> {
    this.redux = manager.get<ReduxService>(ServiceId.Redux)
    this.client = manager.get<DebuggingClientService>(
      ServiceId.DebuggingClient
    ).client
    return this
  }

  async start(_manager: ServiceManager): Promise<this> {
    if (!this.client || !this.redux) return this
    this.subscription = await this.client.subscribe(
      StreamTopic.EnvelopeWatch,
      {}
    )
    this.subscription.on("event", evt => this.onEvent(evt))
    this.subscription.on("closed", reason =>
      this.log.warn(`OPP envelope subscription closed: ${reason}`)
    )
    return this
  }

  async stop(_manager: ServiceManager): Promise<this> {
    this.subscription?.close(ClosedReason.ClientRequested)
    this.subscription = null
    return this
  }

  private onEvent(evt: EnvelopeEvent): void {
    this.redux?.dispatch(
      appendEnvelope({ epoch: evt.epoch, record: evt.record })
    )
  }

  /**
   * Pull `chunkSize` older epochs from the producer (server or local
   * disk), starting strictly below `oldestKnownEpoch`. Each envelope in
   * each returned epoch is dispatched as `appendEnvelope` (the slice
   * dedupes on `(endpointsType, checksum)`, so re-loading a region is a
   * no-op). Returns the lowest epoch index actually fetched, so the
   * caller can stop hammering when the producer has nothing older.
   *
   * @param oldestKnownEpoch The lowest epoch currently in the slice.
   * @param chunkSize        Inclusive epoch-window width to request.
   *                         Defaults to {@link OPPTrackingService.LoadOlderChunkSize}.
   * @returns The lowest epoch index returned by the producer, or `null`
   *          when nothing older is available.
   */
  async loadOlder(
    oldestKnownEpoch: number,
    chunkSize: number = OPPTrackingService.LoadOlderChunkSize
  ): Promise<number | null> {
    if (!this.client || !this.redux) return null
    if (oldestKnownEpoch <= 0) return null
    const epochEnd = oldestKnownEpoch - 1,
      epochStart = Math.max(0, epochEnd - chunkSize + 1)
    try {
      const { records } = await this.client.loadEnvelopeRecords({
        epochStart,
        epochEnd
      })
      if (records.length === 0) return null
      records.forEach(epochRec =>
        epochRec.envelopes.forEach(envRec =>
          this.redux!.dispatch(
            appendEnvelope({ epoch: epochRec.epoch, record: envRec })
          )
        )
      )
      return Math.min(...records.map(r => r.epoch))
    } catch (err) {
      this.log.error("loadOlder failed", err)
      return null
    }
  }
}

export namespace OPPTrackingService {
  /** Log category. */
  export const Category = "tui:opp-tracking" as const
  /**
   * Default epoch-window size requested per "load older" press. 20 keeps
   * each round trip small and lets the user incrementally page back
   * without bringing down a 1000-epoch cluster's history in one shot.
   */
  export const LoadOlderChunkSize = 20
}
