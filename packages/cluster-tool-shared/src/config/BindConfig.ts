import { z } from "zod"

import { SchemaCodec } from "../schema/index.js"

/**
 * The transport a resolved port will be bound with. TCP ports are fully
 * covered by `get-port`'s probe; UDP ports (the validator's gossip socket and
 * dynamic-range sockets) additionally require a UDP-bind probe — see
 * `BindConfigProvider` in `cluster-tool` for the failure class this closes.
 */
export enum BindConfigPortProtocol {
  tcp = "tcp",
  udp = "udp"
}

/** One nodeop's `{ http, p2p }` listen ports. */
export const BindConfigNodeopPortsSchema = z.object({
  /** HTTP (RPC) listen port. */
  http: z.number(),
  /** P2P listen port. */
  p2p: z.number()
})
/** One nodeop's `{ http, p2p }` listen ports. */
export type BindConfigNodeopPorts = z.infer<typeof BindConfigNodeopPortsSchema>

/** The full nodeop port set across the cluster (one pair per node, per role). */
export const BindConfigNodeopClusterPortsSchema = z.object({
  /** The bios node's port pair. */
  bios: BindConfigNodeopPortsSchema,
  /** One port pair per producer node. */
  producers: z.array(BindConfigNodeopPortsSchema),
  /** One port pair per batch-operator node. */
  batch: z.array(BindConfigNodeopPortsSchema),
  /** One port pair per underwriter node. */
  underwriters: z.array(BindConfigNodeopPortsSchema)
})
/** The full nodeop port set across the cluster (one pair per node, per role). */
export type BindConfigNodeopClusterPorts = z.infer<
  typeof BindConfigNodeopClusterPortsSchema
>

/** A daemon that listens on one address + one port (kiod, anvil, debuggingServer). */
export const BindConfigDaemonSchema = z.object({
  /** Listen address (loopback by default; `0.0.0.0` under bind-all). */
  address: z.string(),
  /** Listen port. */
  port: z.number()
})
/** A daemon that listens on one address + one port (kiod, anvil, debuggingServer). */
export type BindConfigDaemon = z.infer<typeof BindConfigDaemonSchema>

/** nodeop: one bind address, the cluster-wide nodeop port set. */
export const BindConfigNodeopSchema = z.object({
  /** Listen address shared by every nodeop in the cluster. */
  address: z.string(),
  /** The cluster-wide nodeop port set, by role. */
  ports: BindConfigNodeopClusterPortsSchema
})
/** nodeop: one bind address, the cluster-wide nodeop port set. */
export type BindConfigNodeop = z.infer<typeof BindConfigNodeopSchema>

/** An inclusive contiguous port window (`first`..`last`). */
export const BindConfigPortRangeSchema = z.object({
  /** First port of the window (inclusive). */
  first: z.number(),
  /** Last port of the window (inclusive). */
  last: z.number()
})
/** An inclusive contiguous port window (`first`..`last`). */
export type BindConfigPortRange = z.infer<typeof BindConfigPortRangeSchema>

/**
 * solana ports — `http` is the RPC port, `faucet` the airdrop faucet.
 * `gossip` is the validator's `--gossip-port`: agave 4.x binds the test
 * validator's gossip socket at its FIXED default (8000) instead of carving it
 * from the dynamic range, so a second concurrent validator panics with
 * `gossip_addr bind_to port 8000: Address already in use` unless each cluster
 * passes its own resolved gossip port.
 * `dynamicRange` is the validator's `--dynamic-port-range` window
 * (TPU/TVU/repair sockets). Without a per-cluster window every
 * solana-test-validator carves its dynamic sockets from the SAME agave default
 * range; two concurrent validators then UDP-double-bind (the kernel allows it
 * silently) and each forwards transactions into the other's TPU, which drops
 * foreign-genesis packets — airdrops/txs return signatures that never land.
 */
export const BindConfigSolanaPortsSchema = z.object({
  /** JSON-RPC listen port. */
  http: z.number(),
  /** Airdrop faucet port. */
  faucet: z.number(),
  /** The validator's `--gossip-port` (see the schema note). */
  gossip: z.number(),
  /** The validator's `--dynamic-port-range` window (see the schema note). */
  dynamicRange: BindConfigPortRangeSchema
})
/** solana-test-validator's resolved port set (see {@link BindConfigSolanaPortsSchema}). */
export type BindConfigSolanaPorts = z.infer<typeof BindConfigSolanaPortsSchema>

/** solana-test-validator: one bind address + its port set. */
export const BindConfigSolanaSchema = z.object({
  /** Listen address. */
  address: z.string(),
  /** The validator's resolved port set. */
  ports: BindConfigSolanaPortsSchema
})
/** solana-test-validator: one bind address + its port set. */
export type BindConfigSolana = z.infer<typeof BindConfigSolanaSchema>

/**
 * A cluster's complete network binding — the five daemons' resolved
 * address/port shapes. THE canonical `BindConfig` schema — plain data;
 * `BindConfigProvider` (cluster-tool) resolves, validates, and registers it.
 * Persisted verbatim as the `bind` member of `cluster-config.json`.
 */
export const BindConfigSchema = z.object({
  /** kiod wallet daemon binding. */
  kiod: BindConfigDaemonSchema,
  /** nodeop fleet binding. */
  nodeop: BindConfigNodeopSchema,
  /** anvil (Ethereum) binding. */
  anvil: BindConfigDaemonSchema,
  /** solana-test-validator binding. */
  solana: BindConfigSolanaSchema,
  /** embedded debugging server binding. */
  debuggingServer: BindConfigDaemonSchema
})
/** THE canonical `BindConfig` type — the schema-inferred shape of {@link BindConfigSchema}. */
export type BindConfig = z.infer<typeof BindConfigSchema>

/** Validated codec for the persisted `BindConfig` (the `--bind-config` / `--external-bind-config` gate). */
export const BindConfigSchemaCodec = SchemaCodec.create<BindConfig>(BindConfigSchema)

const BindConfigDaemonOptionsSchema = BindConfigDaemonSchema.partial()
const BindConfigNodeopPortsOptionsSchema = BindConfigNodeopPortsSchema.partial()
const BindConfigNodeopClusterPortsOptionsSchema = z.object({
  bios: BindConfigNodeopPortsOptionsSchema.optional(),
  producers: z.array(BindConfigNodeopPortsOptionsSchema).optional(),
  batch: z.array(BindConfigNodeopPortsOptionsSchema).optional(),
  underwriters: z.array(BindConfigNodeopPortsOptionsSchema).optional()
})
const BindConfigNodeopOptionsSchema = z.object({
  address: z.string().optional(),
  ports: BindConfigNodeopClusterPortsOptionsSchema.optional()
})
const BindConfigSolanaPortsOptionsSchema = z.object({
  http: z.number().optional(),
  faucet: z.number().optional(),
  gossip: z.number().optional(),
  // dynamicRange stays pin-whole (a BindAtom — half a window is meaningless).
  dynamicRange: BindConfigPortRangeSchema.optional()
})
const BindConfigSolanaOptionsSchema = z.object({
  address: z.string().optional(),
  ports: BindConfigSolanaPortsOptionsSchema.optional()
})

/**
 * Runtime validator for a PARTIAL (or complete) caller-supplied bind override —
 * every field optional at every level (zod v4 has no deep-partial, so this is
 * composed per-level from the resolved schemas, with `dynamicRange` kept
 * pin-whole). `--bind-config` (Phase 5) classifies complete-vs-partial via
 * {@link BindConfigSchemaCodec}'s `check`, then validates the partial form here.
 */
export const BindOptionsSchema = z.object({
  kiod: BindConfigDaemonOptionsSchema.optional(),
  nodeop: BindConfigNodeopOptionsSchema.optional(),
  anvil: BindConfigDaemonOptionsSchema.optional(),
  solana: BindConfigSolanaOptionsSchema.optional(),
  debuggingServer: BindConfigDaemonOptionsSchema.optional()
})

/**
 * Shapes treated as indivisible when deriving caller overrides: a pinned value
 * must be supplied whole or not at all (half a port window is meaningless).
 */
export type BindAtom = BindConfigPortRange

/**
 * Caller-override projection of a resolved bind shape: every field optional,
 * recursing through nested shapes and arrays, while {@link BindAtom} shapes
 * stay pin-whole. Deriving (rather than hand-writing) the options family means
 * a field added to a resolved shape appears in its options automatically —
 * the drift class hand-maintained option mirrors invite is unrepresentable.
 */
export type BindOverrides<T> = {
  [K in keyof T]?: T[K] extends BindAtom
    ? T[K]
    : T[K] extends ReadonlyArray<infer Element>
      ? BindOverrides<Element>[]
      : T[K] extends object
        ? BindOverrides<T[K]>
        : T[K]
}

/** Caller bind options for a single-port daemon (kiod, anvil, debuggingServer). */
export type BindDaemonOptions = BindOverrides<BindConfigDaemon>

/** Caller bind options for one nodeop's `{ http, p2p }` pair. */
export type BindNodeopPortsOptions = BindOverrides<BindConfigNodeopPorts>

/** Caller bind options for the cluster-wide nodeop port set. */
export type BindNodeopClusterPortsOptions =
  BindOverrides<BindConfigNodeopClusterPorts>

/** Caller bind options for the nodeop fleet. */
export type BindNodeopOptions = BindOverrides<BindConfigNodeop>

/**
 * Caller bind options for the solana-test-validator's ports. A pinned
 * `gossip` port must be free (TCP + UDP) or resolution throws; a pinned
 * `dynamicRange` must be supplied whole ({@link BindAtom}) with every port
 * free, or resolution throws.
 */
export type BindSolanaPortsOptions = BindOverrides<BindConfigSolanaPorts>

/** Caller bind options for the solana-test-validator. */
export type BindSolanaOptions = BindOverrides<BindConfigSolana>

/**
 * Caller-facing bind overrides — exactly the optional projection of
 * {@link BindConfig} (all fields optional; `BindConfigProvider.resolve`
 * fills the rest). NOT a `Partial` of any runtime class — the options derive
 * from the DATA shapes alone.
 */
export type BindOptions = BindOverrides<BindConfig>

/** Topology + bind-all the port resolver needs (counts mirror ClusterBuildOptions). */
export interface ClusterTopologyOptions {
  /** Number of producer nodes. */
  producerCount?: number
  /** Number of batch-operator nodes. */
  batchOperatorCount?: number
  /** Number of underwriter nodes. */
  underwriterCount?: number
  /** Bind every daemon on `0.0.0.0` instead of loopback. */
  bindAll?: boolean
}
