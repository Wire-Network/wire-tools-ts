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
export interface BindConfigNodeopPorts {
  /** HTTP (RPC) listen port. */
  http: number
  /** P2P listen port. */
  p2p: number
}

/** The full nodeop port set across the cluster (one pair per node, per role). */
export interface BindConfigNodeopClusterPorts {
  /** The bios node's port pair. */
  bios: BindConfigNodeopPorts
  /** One port pair per producer node. */
  producers: BindConfigNodeopPorts[]
  /** One port pair per batch-operator node. */
  batch: BindConfigNodeopPorts[]
  /** One port pair per underwriter node. */
  underwriters: BindConfigNodeopPorts[]
}

/** A daemon that listens on one address + one port (kiod, anvil, debuggingServer). */
export interface BindConfigDaemon {
  /** Listen address (loopback by default; `0.0.0.0` under bind-all). */
  address: string
  /** Listen port. */
  port: number
}

/** nodeop: one bind address, the cluster-wide nodeop port set. */
export interface BindConfigNodeop {
  /** Listen address shared by every nodeop in the cluster. */
  address: string
  /** The cluster-wide node
   *
   *
   *
   *
   *
   *
   *
   *
   *
   *
   *
   *
   *
   *
   *
   *
   *
   *
   *
   *
   *
   *
   *
   *
   *
   *
   *
   *
   *
   *
   *
   * op port set, by role. */
  ports: BindConfigNodeopClusterPorts
}

/** An inclusive contiguous port window (`first`..`last`). */
export interface BindConfigPortRange {
  /** First port of the window (inclusive). */
  first: number
  /** Last port of the window (inclusive). */
  last: number
}

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
export interface BindConfigSolanaPorts {
  /** JSON-RPC listen port. */
  http: number
  /** Airdrop faucet port. */
  faucet: number
  /** The validator's `--gossip-port` (see the interface note). */
  gossip: number
  /** The validator's `--dynamic-port-range` window (see the interface note). */
  dynamicRange: BindConfigPortRange
}

/** solana-test-validator: one bind address + its port set. */
export interface BindConfigSolana {
  /** Listen address. */
  address: string
  /** The validator's resolved port set. */
  ports: BindConfigSolanaPorts
}

/**
 * A cluster's complete network binding — the five daemons' resolved
 * address/port shapes. THE canonical `BindConfig` type — plain data;
 * `BindConfigProvider` (cluster-tool) resolves, validates, and registers it.
 * Persisted verbatim as the `bind` member of `cluster-config.json`.
 */
export interface BindConfig {
  /** kiod wallet daemon binding. */
  kiod: BindConfigDaemon
  /** nodeop fleet binding. */
  nodeop: BindConfigNodeop
  /** anvil (Ethereum) binding. */
  anvil: BindConfigDaemon
  /** solana-test-validator binding. */
  solana: BindConfigSolana
  /** embedded debugging server binding. */
  debuggingServer: BindConfigDaemon
}

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
