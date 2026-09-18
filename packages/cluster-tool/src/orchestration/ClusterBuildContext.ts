import type { ClusterConfig } from "@wireio/cluster-tool-shared"
import { Keypair } from "@solana/web3.js"
import type { EventEmitter } from "eventemitter3"
import { asOption } from "@3fv/prelude-ts"
import { EthereumClient } from "../clients/ethereum/EthereumClient.js"
import { SolanaClient } from "../clients/solana/SolanaClient.js"
import { SolanaWallet } from "../clients/solana/SolanaWallet.js"
import { WireClient } from "../clients/wire/WireClient.js"
import { ProcessManager } from "../cluster/processes/ProcessManager.js"

import type { Logger } from "../logging/Logger.js"
import { toDialAddress, toURL } from "../utils/netUtils.js"
import { OrchestrationContext } from "./OrchestrationContext.js"
import {
  ClusterKeyStore,
  ClusterKeyStoreKey
} from "./outputs/ClusterKeyStore.js"

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
> extends OrchestrationContext<ClusterConfig, Events> {
  private wireClient: WireClient | null = null
  private ethereumClient: EthereumClient | null = null
  private solanaClient: SolanaClient | null = null

  constructor(config: ClusterConfig, log: Logger) {
    super(config, log)
  }

  /** The WIRE client (clio + RPC), bound to the cluster's nodeop/kiod. */
  get wire(): WireClient {
    return (this.wireClient ??= new WireClient({
      clusterPath: this.config.clusterPath,
      binary: this.config.executables.clio,
      nodeopUrl: ClusterBuildContext.nodeopUrl(this.config),
      kiodUrl: toURL(
        this.config.bind.kiod.port,
        toDialAddress(this.config.bind.kiod.address)
      ),
      // `producerCount` is the intended input for this tool's budget sizing.
      // Note it is the producer ACCOUNT count, which is not always the producer
      // NODE count the genesis finalizer policy is built from (`NodeConfig.plan`
      // fans accounts round-robin across nodes) — the budget is an envelope, not
      // an exact model, and this is the knob the tool sizes against.
      finalizerCount: this.config.producerCount
    }))
  }

  /** The Ethereum client, bound to the cluster's anvil RPC. */
  get ethereum(): EthereumClient {
    return (this.ethereumClient ??= new EthereumClient(
      toURL(
        this.config.bind.anvil.port,
        toDialAddress(this.config.bind.anvil.address)
      )
    ))
  }

  /** The Solana client, bound to the cluster's validator RPC (ambient payer). */
  get solana(): SolanaClient {
    return (this.solanaClient ??= new SolanaClient(
      toURL(
        this.config.bind.solana.ports.http,
        toDialAddress(this.config.bind.solana.address)
      ),
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
    return toURL(
      ports.producers[0]?.http ?? ports.bios.http,
      toDialAddress(config.bind.nodeop.address)
    )
  }
}
