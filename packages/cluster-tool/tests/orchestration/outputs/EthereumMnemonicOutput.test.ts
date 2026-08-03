import { ethers } from "ethers"
import { OutputStore } from "@wireio/cluster-tool/orchestration"
import { EthereumMnemonicKey } from "@wireio/cluster-tool/orchestration/outputs"
import { PersistedFixture } from "../../config/clusterConfigFixture.js"

describe("EthereumMnemonicKey", () => {
  it("is a typed, described output key", () => {
    expect(EthereumMnemonicKey.name).toBe("cluster.ethereumMnemonic")
    expect(EthereumMnemonicKey.description.length).toBeGreaterThan(0)
  })

  it("round-trips a mnemonic PHRASE through an OutputStore", () => {
    const store = new OutputStore(),
      phrase = ethers.Mnemonic.fromEntropy(ethers.randomBytes(32)).phrase
    expect(store.get(EthereumMnemonicKey)).toBeNull()
    store.set(EthereumMnemonicKey, phrase)
    expect(store.get(EthereumMnemonicKey)).toBe(phrase)
    // A real phrase, not an opaque blob — the KeyGenerator context parses it.
    expect(ethers.Mnemonic.fromPhrase(phrase).phrase).toBe(phrase)
  })

  it("is NEVER a ClusterConfig member — the config ships inside release archives", () => {
    // A mnemonic on the persisted config would make every operator's EM private
    // key re-derivable from the deployable artifact (D14).
    expect(Object.keys(PersistedFixture)).not.toContain("ethereumMnemonic")
    expect(JSON.stringify(PersistedFixture)).not.toContain("mnemonic")
  })
})
