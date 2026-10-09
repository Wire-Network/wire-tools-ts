import { act } from "react"

import type { ConnectionProfile } from "@wireio/ql-shared"

import type { CliContext } from "@wireio/ql-tool-cli/cli/index.js"
import {
  TuiServiceId,
  createTuiServiceRegistry,
  createTuiStore,
  type CatalogService,
  type QueryService,
  type TuiServiceRegistry,
  type TuiStore
} from "@wireio/ql-tool-cli/tui/index.js"

import { createFakeChainAPI, type FakeChainAPI } from "./fakeChainAPI.js"
import { createTestContext } from "./testContext.js"

/** A started TUI service stack over temp stores. */
export interface TuiHarness {
  /** The CLI context. */
  context: CliContext
  /** The store. */
  store: TuiStore
  /** The started registry. */
  registry: TuiServiceRegistry
  /** The boot profile. */
  profile: ConnectionProfile
  /** The fake chain API (get_abi). */
  chain: FakeChainAPI
}

/**
 * Start every TUI service against `endpoint` (owners: `sample`).
 *
 * @param endpoint - The (stub) engine endpoint.
 * @returns The harness.
 */
export async function startTuiHarness(endpoint: string): Promise<TuiHarness> {
  const chain = createFakeChainAPI(),
    { context } = createTestContext({ catalogOptions: { chainAPI: chain.client } }),
    store = createTuiStore(),
    registry = createTuiServiceRegistry(context),
    profile = context.resolveProfile({ url: endpoint, owners: ["sample"], retries: 0 })
  await registry.startAll({ store, profile })
  return { context, store, registry, profile, chain }
}

/**
 * Wait (inside act) until the in-flight query run and catalog load settle.
 *
 * @param harness - The harness.
 */
export async function idle(harness: TuiHarness): Promise<void> {
  await act(async () => {
    await harness.registry.get<QueryService>(TuiServiceId.query).running
    await harness.registry.get<CatalogService>(TuiServiceId.catalog).loading
  })
}
