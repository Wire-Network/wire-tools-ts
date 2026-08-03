import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import { match } from "ts-pattern"
import { z } from "zod"
import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType } from "@wireio/sdk-core"
import {
  ClusterFiles,
  ClusterStateNodeRole,
  ClusterStateSchemaCodec,
  SchemaCodec,
  SignatureProviderType,
  type ClusterConfig,
  type ClusterState as ClusterStateSnapshot,
  type ClusterStateNode
} from "@wireio/cluster-tool-shared"
import { ClusterConfigProvider } from "../config/ClusterConfigProvider.js"
import { NodeConfig, NodeRole } from "../config/NodeConfig.js"
import { isNotEmpty } from "../utils/predicateUtils.js"
import type { ClusterBuildContext } from "../orchestration/ClusterBuildContext.js"
import { ClusterKeyStore } from "../orchestration/outputs/ClusterKeyStore.js"
import { OperatorDaemonArtifactsKey } from "../orchestration/outputs/OperatorDaemonArtifacts.js"
import type {
  EthereumKeyPair,
  KeyPair,
  SolanaKeyPair,
  WireFinalizerKeyPair,
  WireKeyPair
} from "../types/KeyPair.js"
import { AnvilProcess } from "./processes/AnvilProcess.js"
import { SolanaValidatorProcess } from "./processes/SolanaValidatorProcess.js"

/**
 * One producer node's on-disk key record in `cluster-keys.json` — the
 * persisted mirror of {@link ClusterKeyStore.NodeKeys}.
 */
export interface ClusterKeysNodeEntry {
  /** The producer node's topology index (matches `ClusterKeyStore.NodeKeys.index`). */
  index: number
  /** The node's WIRE block-signing key (network-named, matching an operator's). */
  wire: WireKeyPair
  /** The node's WIRE finality key (network-named, matching an operator's). */
  wireFinalizer: WireFinalizerKeyPair
}

/**
 * One provisioned operator's on-disk key record in `cluster-keys.json` — the
 * persisted mirror of {@link OperatorAccount}. Carries the operator's
 * `ethereum` / `solana` keys too (not just `wire`/`wireFinalizer`) — the daemon
 * `--signature-provider` args (`OperatorDaemonTool.batchOperatorArgs` /
 * `underwriterArgs`) build directly from them on relaunch.
 */
export interface ClusterKeysOperatorEntry {
  /**
   * Durable harness handle (`batchop.a`) — the `ClusterKeyStore` key and the SSM
   * secret-id `{account}` segment. Deterministic and known at plan time; it does
   * NOT exist on chain.
   */
  label: string
  /**
   * WIRE account name ON CHAIN — `wireno.<random>` for batch/underwriter
   * operators (node-owner-sponsored; the suffix is nonce-derived entropy and is
   * not choosable), the deterministic `defproducer*` name for producers.
   */
  account: string
  /** Operator role (batch operator / underwriter / producer). */
  type: OperatorType
  /** The operator's WIRE (K1) signing key. */
  wire: WireKeyPair
  /** Finality (BLS) key — producers only. */
  wireFinalizer?: WireFinalizerKeyPair
  /** Ethereum (secp256k1) key — operators bonded on the ETH outpost. */
  ethereum?: EthereumKeyPair
  /** Solana (ed25519) key — operators bonded on the SOL outpost. */
  solana?: SolanaKeyPair
}

/**
 * The full `cluster-keys.json` payload — every producer node's key set plus
 * every provisioned operator record. `cluster-tool`-private: written 0600 by
 * {@link ClusterState.saveKeys}, read only by `ClusterManager.run` (via
 * {@link ClusterState.loadKeys} + {@link ClusterState.rehydrate}). Never
 * served over the debugging-server RPC surface.
 */
export interface ClusterKeys {
  /** Every generated producer-node key set. */
  nodes: ClusterKeysNodeEntry[]
  /** Every provisioned operator record. */
  operators: ClusterKeysOperatorEntry[]
}

/**
 * The custody members every persisted key record carries. They are mutually
 * exclusive alternatives, not two optional extras — see
 * {@link hasSingleCustodyForm}.
 */
const keyCustodyShape = {
  /** The Wire-canonical key material (KEY / KIOD clusters). */
  privateKey: z.string().optional(),
  /** The SSM parameter id the key material lives under (SSM clusters). */
  awsSecretId: z.string().optional()
}

/** The custody members a persisted key record is validated on. */
interface PersistedKeyCustody {
  /** The Wire-canonical key material, when the record carries it. */
  privateKey?: string
  /** The SSM parameter id, when the record references it instead. */
  awsSecretId?: string
}

/**
 * EXACTLY ONE custody form per record — key material XOR an SSM reference.
 * BOTH means an SSM cluster leaked plaintext into `cluster-keys.json` (§5.6);
 * NEITHER means a record nothing can sign with.
 */
function hasSingleCustodyForm(record: PersistedKeyCustody): boolean {
  return (record.privateKey != null) !== (record.awsSecretId != null)
}

/** Why {@link hasSingleCustodyForm} rejected a record. */
const SingleCustodyFormMessage =
  "a persisted key record carries EXACTLY ONE custody form — privateKey (KEY/KIOD) or awsSecretId (SSM), never both and never neither"

/** Schema validating a WIRE (K1) key pair record against the grandfathered `WireKeyPair`. */
const WireKeyPairSchema: z.ZodType<WireKeyPair> = z
  .object({
    type: z.literal(KeyType.K1),
    publicKey: z.string(),
    ...keyCustodyShape
  })
  .refine(hasSingleCustodyForm, SingleCustodyFormMessage)

/** Schema validating a finalizer (BLS) key pair record. The proof of possession
 *  is a NON-SECRET member and rides BOTH custody variants — genesis
 *  `initial_finalizer_key` and `ConsensusSteps.runSetFinalizer` read it whether
 *  or not the private key is local. */
const WireFinalizerKeyPairSchema: z.ZodType<WireFinalizerKeyPair> = z
  .object({
    type: z.literal(KeyType.BLS),
    publicKey: z.string(),
    proofOfPossession: z.string(),
    ...keyCustodyShape
  })
  .refine(hasSingleCustodyForm, SingleCustodyFormMessage)

/** Schema validating an Ethereum (EM) key pair record. `address` is NON-SECRET
 *  and rides BOTH custody variants — every ETH funding / collateral read uses
 *  it, and `ExternalClusterConfigSteps` emits from the same record. */
const EthereumKeyPairSchema: z.ZodType<EthereumKeyPair> = z
  .object({
    type: z.literal(KeyType.EM),
    publicKey: z.string(),
    address: z.string(),
    ...keyCustodyShape
  })
  .refine(hasSingleCustodyForm, SingleCustodyFormMessage)

/** Schema validating a Solana (ED) key pair record. */
const SolanaKeyPairSchema: z.ZodType<SolanaKeyPair> = z
  .object({
    type: z.literal(KeyType.ED),
    publicKey: z.string(),
    ...keyCustodyShape
  })
  .refine(hasSingleCustodyForm, SingleCustodyFormMessage)

/** The persisted `OperatorType` value (numeric, as stored in `cluster-keys.json`). */
const OperatorTypeValueSchema = z.custom<OperatorType>(
  value => typeof value === "number"
)

/** Schema for one producer node's key record. */
const ClusterKeysNodeEntrySchema: z.ZodType<ClusterKeysNodeEntry> = z.object({
  index: z.number(),
  wire: WireKeyPairSchema,
  wireFinalizer: WireFinalizerKeyPairSchema
})

/** Schema for one provisioned operator's key record. */
const ClusterKeysOperatorEntrySchema: z.ZodType<ClusterKeysOperatorEntry> =
  z.object({
    label: z.string(),
    account: z.string(),
    type: OperatorTypeValueSchema,
    wire: WireKeyPairSchema,
    wireFinalizer: WireFinalizerKeyPairSchema.optional(),
    ethereum: EthereumKeyPairSchema.optional(),
    solana: SolanaKeyPairSchema.optional()
  })

/** Schema for the full `cluster-keys.json` payload. */
const ClusterKeysSchema: z.ZodType<ClusterKeys> = z.object({
  nodes: z.array(ClusterKeysNodeEntrySchema),
  operators: z.array(ClusterKeysOperatorEntrySchema)
})

/** Validated codec for `cluster-keys.json` (the 0600 handling stays on the writer). */
const ClusterKeysSchemaCodec = SchemaCodec.create<ClusterKeys>(ClusterKeysSchema)

/** `NodeRole` (cluster-tool) → `ClusterStateNodeRole` (debugging-shared) —
 *  distinct nominal string enums with identical values; bridged by value via
 *  `match`, never a raw cast. */
function toClusterStateNodeRole(role: NodeRole): ClusterStateNodeRole {
  return match(role)
    .with(NodeRole.bios, () => ClusterStateNodeRole.bios)
    .with(NodeRole.producer, () => ClusterStateNodeRole.producer)
    .with(NodeRole.operator, () => ClusterStateNodeRole.operator)
    .exhaustive()
}

/**
 * The persistence bridge between a finished cluster build and
 * `wire-cluster-tool run`: capture the post-bootstrap topology + key material
 * from a {@link ClusterBuildContext}, persist it as `cluster-state.json`
 * (secret-free) + `cluster-keys.json` (0600), and reload/rehydrate it on a
 * later `run`. `cluster-state.json` is written by `create` for the debugging
 * surface (`PidSources` / the TUI cannot call `NodeConfig.plan`) — `run`
 * itself never reads it, since the topology is re-derived deterministically
 * from `NodeConfig.plan(config)`; {@link ClusterState.load} exists as
 * {@link ClusterState.save}'s round-trip-test counterpart and for tooling.
 */
export namespace ClusterState {
  /** File permission `cluster-keys.json` is written with (owner read/write only). */
  export const KeysFileMode = 0o600

  /**
   * Absolute path of `cluster-state.json` for `config`.
   *
   * @param config - The cluster configuration.
   * @returns `<clusterPath>/cluster-state.json`.
   */
  export function stateFilePath(config: ClusterConfig): string {
    return Path.join(config.clusterPath, ClusterFiles.StateFilename)
  }

  /**
   * Absolute path of `cluster-keys.json` for `config`.
   *
   * @param config - The cluster configuration.
   * @returns `<clusterPath>/cluster-keys.json`.
   */
  export function keysFilePath(config: ClusterConfig): string {
    return Path.join(config.clusterPath, ClusterFiles.KeysFilename)
  }

  /**
   * Build the secret-free `cluster-state.json` snapshot from a finished
   * build's context: the planned topology (`NodeConfig.plan`), the wallet /
   * anvil-state / solana-ledger paths, and the prepared Solana IDL path (null
   * when no operator daemon artifacts were prepared — no Solana outpost).
   *
   * @param ctx - The build's context (config + outputs).
   * @returns The cluster-state snapshot.
   */
  export function capture(ctx: ClusterBuildContext): ClusterStateSnapshot {
    const { config } = ctx
    const nodes: ClusterStateNode[] = NodeConfig.plan(config).map(node => ({
      name: node.name,
      role: toClusterStateNodeRole(node.role),
      nodePath: node.nodePath,
      ports: { http: node.ports.http, p2p: node.ports.p2p },
      producers: [...node.producers],
      batchOperatorLabel: node.batchOperatorLabel,
      underwriterLabel: node.underwriterLabel
    }))
    return {
      createdAt: new Date().toISOString(),
      nodes,
      walletPath: config.walletPath,
      // External-outpost clusters run no local anvil / solana-test-validator, so
      // there is no anvil state file or solana ledger to record.
      anvilStateFile:
        config.externalOutposts != null
          ? null
          : Path.join(
              config.dataPath,
              AnvilProcess.StateSubpath,
              AnvilProcess.StateFilename
            ),
      solanaLedgerPath:
        config.externalOutposts != null
          ? null
          : Path.join(config.dataPath, SolanaValidatorProcess.LedgerSubpath),
      solanaIdlFile:
        ctx.outputs.get(OperatorDaemonArtifactsKey)?.solanaIdlFile ?? null
    }
  }

  /** Projects a stored key pair into the custody form `cluster-keys.json` persists. */
  type PersistedKeyCustodyProjection = <T extends KeyType>(
    account: string,
    keyPair: KeyPair<T>
  ) => KeyPair<T>

  /** KEY / KIOD: the pair persists verbatim, plaintext `privateKey` included. */
  const retainKeyMaterial: PersistedKeyCustodyProjection = (_account, keyPair) =>
    keyPair

  /**
   * The custody projection `config` persists key records under (§5.6).
   *
   * Under `SSM` the plaintext `privateKey` is REPLACED by the `awsSecretId` its
   * publish step put it under, so an SSM cluster's `cluster-keys.json` carries
   * no key material at all — the daemons' `SSM:<id>` specs fetch it at startup.
   * Under `KEY` / `KIOD` the pair persists unchanged.
   *
   * Every NON-SECRET per-curve member (BLS `proofOfPossession`, EM `address`)
   * survives both variants: `ExternalClusterConfigSteps.keyProviderFor`, the
   * genesis finalizer key, and the ETH funding/collateral reads all consume them
   * regardless of who holds the secret.
   *
   * The id is rendered through `ClusterConfigProvider.signatureProviderSource`,
   * the same renderer `KeySteps` publishes and adopts through, so a persisted
   * ref can never point at an id that was never published.
   */
  function keyCustodyFor(config: ClusterConfig): PersistedKeyCustodyProjection {
    if (config.signatureProvider.type !== SignatureProviderType.SSM) {
      return retainKeyMaterial
    }
    const sourceFor = ClusterConfigProvider.signatureProviderSource(config)
    return <T extends KeyType>(account: string, keyPair: KeyPair<T>) => {
      const { privateKey: _material, ...custodyFree } = keyPair
      // The ONE cast — TS cannot relate a spread of `Omit<KeyPair<T>, …>` back
      // to the generic `KeyPair<T>` its conditional extension is keyed on.
      return {
        ...custodyFree,
        awsSecretId: sourceFor(account, keyPair.type).awsSecretId
      } as unknown as KeyPair<T>
    }
  }

  /**
   * Producer node NAME by key-store node index — the secret-id `{account}`
   * segment `KeySteps.signatureProviderKeyPublications` publishes that node's
   * keys under, resolved from the SAME `NodeConfig.plan` both derive from so
   * the persisted refs and the published ids can never drift.
   */
  function producerNodeNames(config: ClusterConfig): Map<number, string> {
    return new Map(
      NodeConfig.plan(config)
        .filter(node => node.role === NodeRole.producer)
        .map(node => [node.index, node.name] as const)
    )
  }

  /**
   * Build the `cluster-keys.json` payload from a finished build's
   * `ctx.keyStore` — every generated producer-node key set plus every
   * provisioned operator record (with its full key set, including
   * `ethereum` / `solana` when present).
   *
   * Key CUSTODY follows the cluster's signature provider: plaintext under
   * `KEY` / `KIOD`, SSM refs only under `SSM` (see {@link keyCustodyFor}).
   *
   * @param ctx - The build's context (holds `keyStore`).
   * @returns The key payload, in the custody form the provider dictates.
   */
  export function captureKeys(ctx: ClusterBuildContext): ClusterKeys {
    const { config } = ctx,
      toCustody = keyCustodyFor(config),
      nodeNames = producerNodeNames(config)
    return {
      nodes: ctx.keyStore.nodes.map(nodeKeys => {
        const nodeName = nodeNames.get(nodeKeys.index)
        Assert.ok(
          isNotEmpty(nodeName),
          `ClusterState.captureKeys: no producer node planned at index ${nodeKeys.index}`
        )
        return {
          index: nodeKeys.index,
          wire: toCustody(nodeName, nodeKeys.keys.wire),
          wireFinalizer: toCustody(nodeName, nodeKeys.keys.wireFinalizer)
        }
      }),
      // Every persisted operator carries its on-chain name: `account` is
      // optional on `OperatorAccount` only for the window between an OPP
      // operator's materialize and sponsored-creation steps, both of which run
      // long before this capture.
      operators: ctx.keyStore.operators.map(operator => {
        Assert.ok(
          isNotEmpty(operator.account),
          `ClusterState.captureKeys: operator ${operator.label} has no account — its sponsored-creation step did not run`
        )
        // Custody is keyed by the DURABLE `label`, never the on-chain
        // `account` — the label is the secret-id `{account}` segment the keys
        // were published under.
        const { label, account } = operator
        return {
          ...operator,
          account,
          wire: toCustody(label, operator.wire),
          ...(operator.wireFinalizer != null
            ? { wireFinalizer: toCustody(label, operator.wireFinalizer) }
            : {}),
          ...(operator.ethereum != null
            ? { ethereum: toCustody(label, operator.ethereum) }
            : {}),
          ...(operator.solana != null
            ? { solana: toCustody(label, operator.solana) }
            : {})
        }
      })
    }
  }

  /** Write `state` to {@link stateFilePath} (validated via `ClusterStateSchemaCodec`). */
  export function save(
    config: ClusterConfig,
    state: ClusterStateSnapshot
  ): void {
    Fs.writeFileSync(
      stateFilePath(config),
      ClusterStateSchemaCodec.serialize(state)
    )
  }

  /** Write `keys` to {@link keysFilePath}, then enforce {@link KeysFileMode} — `writeFileSync`'s
   *  `mode` option is honored only on file CREATION, so a re-write over an
   *  existing file needs the explicit `chmodSync` to guarantee 0600. */
  export function saveKeys(config: ClusterConfig, keys: ClusterKeys): void {
    const file = keysFilePath(config)
    Fs.writeFileSync(file, ClusterKeysSchemaCodec.serialize(keys), {
      mode: KeysFileMode
    })
    Fs.chmodSync(file, KeysFileMode)
  }

  /**
   * Read `cluster-state.json`.
   *
   * @throws If the file is missing.
   */
  export function load(config: ClusterConfig): ClusterStateSnapshot {
    const file = stateFilePath(config)
    Assert.ok(
      Fs.existsSync(file),
      `ClusterState.load: ${file} not found — run "wire-cluster-tool create" first`
    )
    return ClusterStateSchemaCodec.deserialize(Fs.readFileSync(file, "utf8"))
  }

  /**
   * Read `cluster-keys.json`.
   *
   * @throws If the file is missing.
   */
  export function loadKeys(config: ClusterConfig): ClusterKeys {
    const file = keysFilePath(config)
    Assert.ok(
      Fs.existsSync(file),
      `ClusterState.loadKeys: ${file} not found — run "wire-cluster-tool create" first`
    )
    return ClusterKeysSchemaCodec.deserialize(Fs.readFileSync(file, "utf8"))
  }

  /**
   * Repopulate a fresh {@link ClusterKeyStore} from a loaded {@link ClusterKeys}
   * payload — every node key set + every operator label, so relaunch-time
   * operator/daemon-arg resolution (`NodeopProcessSteps.resolveOperator` /
   * `resolveOperatorDaemonArgs`) works unchanged against the rehydrated store.
   *
   * @param keyStore - The (empty) store to populate.
   * @param keys - The loaded key payload.
   */
  export function rehydrate(
    keyStore: ClusterKeyStore,
    keys: ClusterKeys
  ): void {
    keyStore.pushNodes(
      ...keys.nodes.map(entry => ({
        index: entry.index,
        keys: { wire: entry.wire, wireFinalizer: entry.wireFinalizer }
      }))
    )
    keys.operators.forEach(entry => keyStore.setOperator(entry))
  }
}
