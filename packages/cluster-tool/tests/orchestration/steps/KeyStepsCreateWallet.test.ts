import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType } from "@wireio/sdk-core"
import { Constants } from "@wireio/cluster-tool/Constants"
import { NodeConfig } from "@wireio/cluster-tool/config"
import { Steps } from "@wireio/cluster-tool/orchestration"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"

const signal = new AbortController().signal

/** A WIRE (K1) pair with a distinguishable private half. */
function wireKey(tag: string) {
  return {
    type: KeyType.K1 as const,
    publicKey: `PUB_K1_${tag}`,
    privateKey: `PVT_K1_${tag}`
  }
}

/** A finalizer (BLS) pair with a distinguishable private half. */
function finalizerKey(tag: string) {
  return {
    type: KeyType.BLS as const,
    publicKey: `PUB_BLS_${tag}`,
    privateKey: `PVT_BLS_${tag}`,
    proofOfPossession: `SIG_BLS_${tag}`
  }
}

/**
 * A context whose wallet RECORDS the keys it is asked to import, so the test
 * asserts on the exact argument list `runCreateWallet` produces.
 */
function walletContext() {
  const imported: string[] = [],
    ctx = fixtureContext()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double for the clio-backed wallet
  ;(ctx.wire as any).wallet = {
    getOrCreate: async () => ({
      addPrivateKey: async (...keys: string[]) => {
        imported.push(...keys)
      }
    })
  }
  return { ctx, imported }
}

describe("KeySteps.runCreateWallet", () => {
  it("imports the SEEDED genesis keys, not the dev constants", async () => {
    const { ctx, imported } = walletContext()
    ctx.keyStore
      .setOperator({
        label: NodeConfig.BiosName,
        account: NodeConfig.BiosProducer,
        type: OperatorType.UNKNOWN,
        wire: wireKey("bios"),
        wireFinalizer: finalizerKey("bios")
      })
      .setOperator({
        label: Constants.BOOTSTRAP_NODE_OWNER,
        account: Constants.BOOTSTRAP_NODE_OWNER,
        type: OperatorType.UNKNOWN,
        wire: wireKey("owner")
      })

    await Steps.keys.runCreateWallet(ctx, null, signal)

    // Under SSM these are GENERATED and `genesis.initial_key` carries the
    // generated public half — importing `DEV_K1_PRIVATE_KEY` instead left the
    // wallet unable to sign as `sysio` or as the node owner.
    expect(imported).toEqual(
      expect.arrayContaining(["PVT_K1_bios", "PVT_BLS_bios", "PVT_K1_owner"])
    )
    expect(imported).not.toContain(Constants.DEV_K1_PRIVATE_KEY)
  })

  it("DEDUPES — the genesis identities share one key under KEY/KIOD and kiod rejects a re-import", async () => {
    const { ctx, imported } = walletContext()
    // `ClusterConfigProvider.resolveWithBiosKeys` hands back the SAME dev pair
    // for the bios node and the bootstrap node owner under KEY/KIOD. Importing
    // it twice makes clio fail the whole bootstrap with
    // `3120008 key_exist_exception: Key already exists` — which is exactly what
    // a real flow run hit before this dedupe.
    const shared = wireKey("shared")
    ctx.keyStore
      .setOperator({
        label: NodeConfig.BiosName,
        account: NodeConfig.BiosProducer,
        type: OperatorType.UNKNOWN,
        wire: shared,
        wireFinalizer: finalizerKey("shared")
      })
      .setOperator({
        label: Constants.BOOTSTRAP_NODE_OWNER,
        account: Constants.BOOTSTRAP_NODE_OWNER,
        type: OperatorType.UNKNOWN,
        wire: shared
      })

    await Steps.keys.runCreateWallet(ctx, null, signal)

    expect(imported).toContain("PVT_K1_shared")
    expect(new Set(imported).size).toBe(imported.length)
  })

  it("also dedupes a node key that repeats a genesis key", async () => {
    const { ctx, imported } = walletContext()
    const shared = wireKey("both")
    ctx.keyStore.setOperator({
      label: NodeConfig.BiosName,
      account: NodeConfig.BiosProducer,
      type: OperatorType.UNKNOWN,
      wire: shared,
      wireFinalizer: finalizerKey("both")
    })
    ctx.keyStore.pushNodes({
      index: 0,
      keys: { wire: shared, wireFinalizer: finalizerKey("node0") }
    })

    await Steps.keys.runCreateWallet(ctx, null, signal)

    expect(new Set(imported).size).toBe(imported.length)
  })
})
