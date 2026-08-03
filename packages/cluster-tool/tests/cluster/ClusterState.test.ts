import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType } from "@wireio/sdk-core"

import { ClusterState } from "@wireio/cluster-tool"
import { ClusterKeyStore } from "@wireio/cluster-tool/orchestration/outputs"
import { fixtureContext } from "../config/clusterBuildContextFixture.js"

/** A fully-keyed batch-operator handle — carries wire + ethereum + solana keys. */
const BatchOperatorLabel = "batchopaaaa"
/** The node-owner-generated chain account the sponsored-creation step adopts. */
const BatchOperatorAccount = "wireno.x3f9k"

describe("ClusterState", () => {
  let dir: string

  beforeEach(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "cluster-state-"))
  })

  afterEach(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  /** A real `ClusterBuildContext` rooted at the temp dir, seeded with a node
   *  key set + a fully-keyed batch-operator account. */
  function seededContext() {
    const ctx = fixtureContext({
      clusterPath: dir,
      dataPath: Path.join(dir, "data"),
      walletPath: Path.join(dir, "wallet")
    })
    ctx.keyStore.pushNodes({
      index: 0,
      keys: {
        k1: {
          type: KeyType.K1,
          publicKey: "PUB_K1_node0",
          privateKey: "PVT_K1_node0"
        },
        bls: {
          type: KeyType.BLS,
          publicKey: "PUB_BLS_node0",
          privateKey: "PVT_BLS_node0",
          proofOfPossession: "SIG_BLS_node0"
        }
      }
    })
    ctx.keyStore.setOperator({
      label: BatchOperatorLabel,
      account: BatchOperatorAccount,
      type: OperatorType.BATCH,
      wire: {
        type: KeyType.K1,
        publicKey: `PUB_K1_${BatchOperatorLabel}`,
        privateKey: `PVT_K1_${BatchOperatorLabel}`
      },
      ethereum: {
        type: KeyType.EM,
        publicKey: `PUB_EM_${BatchOperatorLabel}`,
        privateKey: `PVT_EM_${BatchOperatorLabel}`,
        address: "0xabc0000000000000000000000000000000000a"
      },
      solana: {
        type: KeyType.ED,
        publicKey: `PUB_ED_${BatchOperatorLabel}`,
        privateKey: `PVT_ED_${BatchOperatorLabel}`
      }
    })
    return ctx
  }

  describe("capture", () => {
    it("builds a secret-free snapshot of the planned topology", () => {
      const ctx = seededContext()
      const state = ClusterState.capture(ctx)
      expect(state.nodes.length).toBeGreaterThan(0)
      expect(state.nodes.some(node => node.name === "node_bios")).toBe(true)
      expect(state.walletPath).toBe(ctx.config.walletPath)
      expect(state.anvilStateFile).toContain(ctx.config.dataPath)
      expect(state.solanaLedgerPath).toContain(ctx.config.dataPath)
      // No Solana outpost artifacts were prepared in this fixture.
      expect(state.solanaIdlFile).toBeNull()
    })

    it("carries NO private key material", () => {
      const ctx = seededContext()
      const raw = JSON.stringify(ClusterState.capture(ctx))
      expect(raw).not.toContain("PVT_")
    })

    it("nulls the anvil state + solana ledger paths in external-outpost mode", () => {
      const ctx = fixtureContext({
        clusterPath: dir,
        dataPath: Path.join(dir, "data"),
        walletPath: Path.join(dir, "wallet"),
        externalOutposts: {
          ethereum: {
            addressFile: "/ext/outpost-addrs.json",
            abiFiles: ["/ext/eth-abis/OPP.json"],
            chainId: 11_155_111
          },
          solana: { idlFile: "/ext/solana-idls/liqsol_core.json" }
        }
      })
      const state = ClusterState.capture(ctx)
      expect(state.anvilStateFile).toBeNull()
      expect(state.solanaLedgerPath).toBeNull()
    })
  })

  describe("save / load round-trip (cluster-state.json)", () => {
    it("round-trips an identical snapshot", () => {
      const ctx = seededContext(),
        state = ClusterState.capture(ctx)
      ClusterState.save(ctx.config, state)
      expect(ClusterState.load(ctx.config)).toEqual(state)
    })

    it("the on-disk file carries no private key material", () => {
      const ctx = seededContext()
      ClusterState.save(ctx.config, ClusterState.capture(ctx))
      const raw = Fs.readFileSync(
        ClusterState.stateFilePath(ctx.config),
        "utf8"
      )
      expect(raw).not.toContain("PVT_")
    })

    it("throws when cluster-state.json is missing", () => {
      const ctx = seededContext()
      expect(() => ClusterState.load(ctx.config)).toThrow(/not found/)
    })
  })

  describe("captureKeys / save / load round-trip (cluster-keys.json)", () => {
    it("round-trips node key sets and every operator's full key set", () => {
      const ctx = seededContext(),
        keys = ClusterState.captureKeys(ctx)
      ClusterState.saveKeys(ctx.config, keys)
      const loaded = ClusterState.loadKeys(ctx.config)
      expect(loaded).toEqual(keys)
      const operator = loaded.operators.find(
        entry => entry.label === BatchOperatorLabel
      )
      // The persisted record keeps BOTH identities distinct.
      expect(operator?.account).toBe(BatchOperatorAccount)
      expect(operator?.ethereum?.address).toBe(
        "0xabc0000000000000000000000000000000000a"
      )
      expect(operator?.solana?.publicKey).toBe(`PUB_ED_${BatchOperatorLabel}`)
      expect(operator?.wire.privateKey).toBe(`PVT_K1_${BatchOperatorLabel}`)
    })

    it("writes cluster-keys.json with file mode 0600", () => {
      const ctx = seededContext()
      ClusterState.saveKeys(ctx.config, ClusterState.captureKeys(ctx))
      const mode =
        Fs.statSync(ClusterState.keysFilePath(ctx.config)).mode & 0o777
      expect(mode).toBe(0o600)
    })

    it("re-saving over an existing file still enforces 0600", () => {
      const ctx = seededContext(),
        keys = ClusterState.captureKeys(ctx)
      ClusterState.saveKeys(ctx.config, keys)
      Fs.chmodSync(ClusterState.keysFilePath(ctx.config), 0o644)
      ClusterState.saveKeys(ctx.config, keys)
      const mode =
        Fs.statSync(ClusterState.keysFilePath(ctx.config)).mode & 0o777
      expect(mode).toBe(0o600)
    })

    it("throws when cluster-keys.json is missing", () => {
      const ctx = seededContext()
      expect(() => ClusterState.loadKeys(ctx.config)).toThrow(/not found/)
    })

    it("refuses to capture an operator whose sponsored-creation step never ran", () => {
      const ctx = seededContext()
      // Re-set the operator WITHOUT an `account` — the materialize-only state.
      const { account: _dropped, ...materialized } =
        ctx.keyStore.assertOperator(BatchOperatorLabel)
      ctx.keyStore.setOperator(materialized)
      expect(() => ClusterState.captureKeys(ctx)).toThrow(/has no account/)
    })

  })

  describe("rehydrate", () => {
    it("repopulates a fresh ClusterKeyStore from loaded keys", () => {
      const ctx = seededContext(),
        keys = ClusterState.captureKeys(ctx),
        store = new ClusterKeyStore()
      ClusterState.rehydrate(store, keys)
      expect(store.node(0).keys.k1.publicKey).toBe("PUB_K1_node0")
      // The store is keyed by the DURABLE handle, never the chain account.
      expect(store.operator(BatchOperatorAccount)).toBeUndefined()
      const operator = store.assertOperator(BatchOperatorLabel)
      expect(operator.account).toBe(BatchOperatorAccount)
      expect(operator.ethereum?.address).toBe(
        "0xabc0000000000000000000000000000000000a"
      )
      expect(operator.solana?.publicKey).toBe(`PUB_ED_${BatchOperatorLabel}`)
    })
  })
})
