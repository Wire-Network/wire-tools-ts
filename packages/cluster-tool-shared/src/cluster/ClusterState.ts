import { z } from "zod"

import { SchemaCodec } from "../schema/index.js"

/**
 * Role a cluster node plays. Identity-mapped string enum matching
 * `cluster-tool`'s `NodeRole` (`bios` / `producer` / `operator`) — the
 * identical string values mean a `cluster-tool` `NodeRole` member satisfies
 * this type with no cast.
 */
export enum ClusterStateNodeRole {
  bios = "bios",
  producer = "producer",
  operator = "operator"
}

/** One `nodeop` instance's `{ http, p2p }` listen ports. */
export const ClusterStateNodePortsSchema = z.object({
  /** HTTP (RPC) listen port. */
  http: z.number(),
  /** P2P listen port. */
  p2p: z.number()
})
/** One `nodeop` instance's `{ http, p2p }` listen ports — the shape of {@link ClusterStateNodePortsSchema}. */
export type ClusterStateNodePorts = z.infer<typeof ClusterStateNodePortsSchema>

/**
 * Post-bootstrap snapshot of a single cluster node, planned deterministically
 * by `cluster-tool`'s `NodeConfig.plan` and persisted read-only for tooling
 * and for `wire-cluster-tool run`'s relaunch path. Carries no key material —
 * see `cluster-keys.json` (`ClusterFiles.KeysFilename`) for that.
 */
export const ClusterStateNodeSchema = z.object({
  /** Canonical node name (`bios`, `node_00`, …). */
  name: z.string(),
  /** Role this node plays. */
  role: z.enum(ClusterStateNodeRole),
  /** Absolute on-disk directory for this node's data + logs. */
  nodePath: z.string(),
  /** This node's `{ http, p2p }` listen ports. */
  ports: ClusterStateNodePortsSchema,
  /** Producer account names scheduled on this node (empty for pure operator nodes). */
  producers: z.array(z.string()),
  /** Batch-operator account this node acts for, when `role === operator`. */
  batchOperatorAccount: z.string().nullable(),
  /** Underwriter account this node acts for, when `role === operator`. */
  underwriterAccount: z.string().nullable()
})
/** Post-bootstrap snapshot of a single cluster node — the shape of {@link ClusterStateNodeSchema}. */
export type ClusterStateNode = z.infer<typeof ClusterStateNodeSchema>

/**
 * Post-bootstrap snapshot of cluster runtime layout. Written once by
 * `wire-cluster-tool create` (via `ClusterManager.create`'s persist phase)
 * and reloaded — read-only — by `run`, the debugging server, the TUI, and
 * `PidSources`. Secret-free by design: signing key material lives in the
 * separate `cluster-keys.json`, never here. `anvilStateFile` /
 * `solanaLedgerPath` are `null` in external-outpost mode (no local daemons).
 */
export const ClusterStateSchema = z.object({
  /** ISO-8601 timestamp of when this snapshot was written. */
  createdAt: z.string(),
  /** Every node in the cluster — bios, producers, and operator nodes alike. */
  nodes: z.array(ClusterStateNodeSchema),
  /** Absolute path of the cluster's `kiod` wallet directory. */
  walletPath: z.string(),
  /** Absolute path of anvil's `--dump-state` / `--load-state` file, or `null` in external-outpost mode. */
  anvilStateFile: z.string().nullable(),
  /** Absolute path of the solana-test-validator ledger directory, or `null` in external-outpost mode. */
  solanaLedgerPath: z.string().nullable(),
  /** Absolute path of the primary IDL shared with batch operators, or `null` when no Solana outpost is configured. */
  solanaIdlFile: z.string().nullable()
})
/** Post-bootstrap snapshot of cluster runtime layout — the shape of {@link ClusterStateSchema}. */
export type ClusterState = z.infer<typeof ClusterStateSchema>

/** Validated codec for `cluster-state.json`. */
export const ClusterStateSchemaCodec =
  SchemaCodec.create<ClusterState>(ClusterStateSchema)
