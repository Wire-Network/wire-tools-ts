import { EventEmitter } from "eventemitter3"

import type { Logger } from "../logging/Logger.js"
import type { Report } from "../report/Report.js"
import { OutputStore } from "./OutputStore.js"

/** Minimal configuration required by the orchestration engine. */
export interface OrchestrationConfig {
  /** Report output configuration for the completed build. */
  report: Report.Config
}

/**
 * Context shared by every orchestration build, including full local clusters
 * and report-only connected-cluster inspections.
 *
 * @typeParam Config - Configuration carried by this build.
 * @typeParam Events - Typed event map exposed to steps.
 */
export class OrchestrationContext<
  Config extends OrchestrationConfig = OrchestrationConfig,
  Events extends EventEmitter.ValidEventTypes = string
> extends EventEmitter<Events> {
  /** Typed cross-step value store. */
  readonly outputs = new OutputStore()

  /** Creates an orchestration context around its configuration and logger. */
  constructor(
    readonly config: Config,
    readonly log: Logger
  ) {
    super()
  }
}
