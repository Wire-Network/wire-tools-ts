import { Keypair } from "@solana/web3.js"
import { EventEmitter } from "eventemitter3"
import { asOption } from "@3fv/prelude-ts"
import { EthereumClient } from "../clients/ethereum/EthereumClient.js"
import { SolanaClient } from "../clients/solana/SolanaClient.js"
import { SolanaWallet } from "../clients/solana/SolanaWallet.js"
import { WireClient } from "../clients/wire/WireClient.js"
import { ProcessManager } from "../cluster/processes/ProcessManager.js"
import type { ClusterConfig } from "../config/ClusterConfig.js"
import type { Logger } from "../logging/Logger.js"
import { Localhost, toURL } from "../utils/netUtils.js"
import { OutputStore } from "./OutputStore.js"
import { ClusterKeyStore, ClusterKeyStoreKey } from "./outputs/ClusterKeyStore.js"

/**
 * The surface every step in a build shares: the resolved {@link ClusterConfig},
 * the three chain clients, a {@link Logger}, and a typed {@link OutputStore} for
 * cross-step values. It is ALSO a strongly-typed `eventemitter3` `EventEmitter`,
 * so flows can signal reactively — a flow subclasses it with its own event map:
 * `class SwapScenarioContext extends ClusterBuildContext<SwapEvents> {}`.
 *
 * The chain clients are LAZY (built on first access) — the orchestration engine
 * itself never touches them, so engine-only builds make no client at all.
 */
export class ClusterBuildContext<
  Events extends EventEmitter.ValidEventTypes = string
> extends EventEmitter<Events> {
  /** Typed cross-step value store. */
  readonly outputs = new OutputStore()

  private wireClient: WireClient | null = null
  private ethereumClient: EthereumClient | null = null
  private solanaClient: SolanaClient | null = null

  constructor(
    readonly config: ClusterConfig,
    readonly log: Logger
  ) {
    super()
  }

  /** The WIRE client (clio + RPC), bound to the cluster's nodeop/kiod. */
  get wire(): WireClient {
    return (this.wireClient ??= new WireClient({
      clusterPath: this.config.clusterPath,
      binary: this.config.executables.clio,
      nodeopUrl: ClusterBuildContext.nodeopUrl(this.config),
      kiodUrl: toURL(this.config.bind.kiod.port, Localhost)
    }))
  }

  /** The Ethereum client, bound to the cluster's anvil RPC. */
  get ethereum(): EthereumClient {
    return (this.ethereumClient ??= new EthereumClient(
      toURL(this.config.bind.anvil.port, Localhost)
    ))
  }

  /** The Solana client, bound to the cluster's validator RPC (ambient payer). */
  get solana(): SolanaClient {
    return (this.solanaClient ??= new SolanaClient(
      toURL(this.config.bind.solana.ports.http, Localhost),
      new SolanaWallet(Keypair.generate())
    ))
  }

  /**
   * THE single cluster key store — producer-node signing sets plus every
   * provisioned {@link OperatorAccount}, accumulated as accounts are provisioned.
   * Get-or-create over `outputs` ({@link ClusterKeyStoreKey}) so key generation,
   * every materialize step, and every consumer share the one instance.
   */
  get keyStore(): ClusterKeyStore {
    return asOption(this.outputs.get(ClusterKeyStoreKey)).getOrCall(() => {
      const store = new ClusterKeyStore()
      this.outputs.set(ClusterKeyStoreKey, store)
      return store
    })
  }

  /**
   * The cluster's {@link ProcessManager} — the registry of managed OS processes
   * (kiod / nodeop / anvil / solana-test-validator). Process-start steps read it
   * from here to get-or-create + start their process; they never reach for the
   * global. The `create()` CLI middleware sets the cluster path before any build
   * runs, satisfying the singleton's precondition.
   */
  get processManager(): ProcessManager {
    return ProcessManager.get()
  }
}

export namespace ClusterBuildContext {
  /** The nodeop HTTP dial URL — the first producer (bios retires after handoff). */
  export function nodeopUrl(config: ClusterConfig): string {
    const ports = config.bind.nodeop.ports
    return toURL(ports.producers[0]?.http ?? ports.bios.http, Localhost)
  }
}
