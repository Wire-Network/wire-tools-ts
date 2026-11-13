import Assert from "node:assert"

import { Connection, PublicKey } from "@solana/web3.js"
import { isObject, isString } from "lodash"
import type {
  ExternalOutpostConfigSolana,
  SolanaMintRecord
} from "@wireio/cluster-tool-shared"

import { SolanaClient } from "../../clients/solana/SolanaClient.js"
import type { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"
import { SolanaOutpostProgramTool } from "./SolanaOutpostProgramTool.js"

/**
 * The MINIMUM real data every liqsol read, PDA derivation and instruction
 * build needs — what `SolanaLiqSyndicationTool` used to pull off a
 * `ClusterBuildContext` (`ctx.solana.connection` + `ctx.config.solanaPath`),
 * made a domain type so a CLUSTER-LESS surface (`fund-batch-operators`,
 * which has no context) composes one from an `ExternalOutpostConfig` and the
 * wire-solana repo root, and a Step runner derives one from its `ctx`.
 *
 * `programId` is the DEPLOYED `liqsol_core` id: the committed `.keys` id on a
 * local cluster, the trusted config's on an external outpost — the liqsol-token
 * and transfer-hook ids are the `declare_id!`s the build commits under
 * `solanaPath`, the same on every chain, so `solanaPath` carries them.
 */
export interface SolanaOutpostTarget {
  /** The RPC connection every read and submission goes over. */
  readonly connection: Connection
  /** The `wire-solana` repo root — the generated IDL + the sibling programs' committed ids. */
  readonly solanaPath: string
  /** The deployed `liqsol_core` program id. */
  readonly programId: PublicKey
  /** The outpost's SPL mints, when a config carries them (an external outpost); absent on a local cluster. */
  readonly mints?: readonly SolanaMintRecord[]
  /**
   * The finalized slot the describing document was generated at — the slot a
   * post-launch `fund-batch-operators` counts this campaign's `synd`s from;
   * absent when the document carries none (a pre-launch funding needs none)
   * and on a local cluster.
   */
  readonly asOfSlot?: ExternalOutpostConfigSolana["asOfSlot"]
}

/**
 * What a liqsol read or build may be addressed with: a build context (a Step
 * runner's `ctx`, from which {@link SolanaOutpostTarget.fromContext} derives
 * the target) or the target itself (a cluster-less caller). One parameter
 * type, so every read keeps its one name across both callers.
 */
export type SolanaOutpostSource<
  C extends ClusterBuildContext = ClusterBuildContext
> = C | SolanaOutpostTarget

export namespace SolanaOutpostTarget {
  /**
   * Whether `value` is a {@link SolanaOutpostTarget} rather than a build
   * context — structural: a context carries `solana` + `config`, never these
   * three members at its top level.
   *
   * @param value - A {@link SolanaOutpostSource}.
   * @returns `true` for a target.
   */
  export function is(value: unknown): value is SolanaOutpostTarget {
    return (
      isObject(value) &&
      "connection" in value &&
      "solanaPath" in value &&
      "programId" in value
    )
  }

  /**
   * The target a Step runner's context addresses: the context's recording
   * connection, its `solanaPath`, and the deployed program id — the trusted
   * external config's when the cluster runs against an external outpost, else
   * the committed keypair's.
   *
   * @param ctx - The build context.
   * @returns The target.
   * @throws If the context is an external-outpost cluster's (its `solana`
   *   client throws — the harness never contacts an external outpost from a
   *   build), or the program keypair is absent.
   */
  export function fromContext<C extends ClusterBuildContext>(
    ctx: C
  ): SolanaOutpostTarget {
    const { solanaPath, externalOutposts } = ctx.config,
      external = externalOutposts?.solana
    return {
      connection: ctx.solana.connection,
      solanaPath,
      programId:
        external?.programId != null
          ? new PublicKey(external.programId)
          : SolanaOutpostProgramTool.assertProgramId(solanaPath),
      ...(external?.mints != null ? { mints: external.mints } : {})
    }
  }

  /**
   * The target an already-deployed outpost's trusted config describes.
   *
   * @param solana - The config's Solana outpost (program id, mints, RPC endpoint, as-of slot).
   * @param solanaPath - The `wire-solana` repo root (IDL + sibling program ids).
   * @param connection - The connection to the outpost ({@link createConnection}).
   * @returns The target.
   */
  export function fromExternalOutpost(
    solana: ExternalOutpostConfigSolana,
    solanaPath: string,
    connection: Connection
  ): SolanaOutpostTarget {
    return {
      connection,
      solanaPath,
      programId: new PublicKey(solana.programId),
      ...(solana.mints != null ? { mints: solana.mints } : {}),
      ...(solana.asOfSlot != null ? { asOfSlot: solana.asOfSlot } : {})
    }
  }

  /**
   * The RPC endpoint an external outpost config MUST carry for a cluster-less
   * command to reach the outpost (a `create` may leave it to the bind config;
   * a command with no cluster has no bind config to fall back to).
   *
   * @param solana - The config's Solana outpost.
   * @returns The endpoint.
   * @throws If the config carries none.
   */
  export function assertRpcUrl(solana: ExternalOutpostConfigSolana): string {
    Assert.ok(
      isString(solana.rpcUrl) && solana.rpcUrl.length > 0,
      "SolanaOutpostTarget: the external outpost config must carry solana.rpcUrl — a cluster-less command has no bind config to fall back to"
    )
    return solana.rpcUrl
  }

  /**
   * A connection to an outpost at the harness's commitment
   * (`SolanaClient.DefaultCommitment`) — the plain web3.js `Connection` a
   * cluster-less command dials with (no Step, so no recording connection).
   *
   * @param rpcUrl - The outpost RPC endpoint.
   * @returns The connection.
   */
  export function createConnection(rpcUrl: string): Connection {
    return new Connection(rpcUrl, SolanaClient.DefaultCommitment)
  }

  /**
   * The target a source addresses — the target itself, or the one derived
   * from a build context.
   *
   * @param source - A context or a target.
   * @returns The target.
   */
  export function resolve<C extends ClusterBuildContext>(
    source: SolanaOutpostSource<C>
  ): SolanaOutpostTarget {
    return is(source) ? source : fromContext(source)
  }
}
