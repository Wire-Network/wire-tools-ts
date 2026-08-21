import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { KeyType } from "@wireio/sdk-core"
import { OperatorType } from "@wireio/opp-typescript-models"
import { EthereumOutpostManagerTool } from "@wireio/cluster-tool/tools/ethereum"
import type { ClusterBuildContext } from "@wireio/cluster-tool/orchestration"
import type { OperatorAccount } from "@wireio/cluster-tool/orchestration/outputs"
import type { EthereumKeyPair } from "@wireio/cluster-tool/types"
import { Report } from "@wireio/cluster-tool/report"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"

/** A syntactically-valid deployed address for the fixture address map. */
const OUTPOST_MANAGER_ADDRESS = "0x00000000000000000000000000000000000000c1"
/** The batch operator's own EOA — the address that actually sends `epochIn`. */
const OPERATOR_ADDRESS = "0x00000000000000000000000000000000000000d1"
const OPERATOR_LABEL = "batchop.a"

/** The two `OutpostManager` members the tool binds. */
const OutpostManagerAbi = [
  "function grantRole(uint64 role, address grantee)",
  "function OPP_INBOUND_ROLE() view returns (uint64)"
]

/**
 * A provisioned batch operator. `address` omitted models the operator that
 * never received an EM key — the case the runner must refuse.
 */
function fixtureOperator(address?: string): OperatorAccount {
  let ethereum: EthereumKeyPair
  if (address != null) {
    ethereum = { type: KeyType.EM, publicKey: "PUB_EM_fixture", address }
  }
  return {
    label: OPERATOR_LABEL,
    publicationLabel: OPERATOR_LABEL,
    type: OperatorType.BATCH,
    wire: { type: KeyType.K1, publicKey: "PUB_K1_fixture" },
    ethereum
  }
}

describe("EthereumOutpostManagerTool", () => {
  let dataPath: string, ethereumPath: string

  beforeEach(() => {
    dataPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "outpost-manager-data-"))
    ethereumPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "outpost-manager-eth-"))

    const deploymentsPath = Path.join(dataPath, "ethereum-deployments")
    Fs.mkdirSync(deploymentsPath, { recursive: true })
    Fs.writeFileSync(
      Path.join(deploymentsPath, "outpost-addrs.json"),
      JSON.stringify({ OutpostManager: OUTPOST_MANAGER_ADDRESS })
    )

    const artifactDir = Path.join(
      ethereumPath,
      "artifacts",
      "contracts",
      "outpost",
      "OutpostManager.sol"
    )
    Fs.mkdirSync(artifactDir, { recursive: true })
    Fs.writeFileSync(
      Path.join(artifactDir, "OutpostManager.json"),
      JSON.stringify({ abi: OutpostManagerAbi })
    )
  })

  afterEach(() => {
    Fs.rmSync(dataPath, { recursive: true, force: true })
    Fs.rmSync(ethereumPath, { recursive: true, force: true })
  })

  function contextWithOperator(address?: string): ClusterBuildContext {
    const ctx = fixtureContext({ dataPath, ethereumPath })
    ctx.keyStore.setOperator(fixtureOperator(address))
    return ctx
  }

  describe("planGrantBootstrapDelivery", () => {
    it("captures the typed input and binds the named runner", () => {
      const step = EthereumOutpostManagerTool.planGrantBootstrapDelivery(
        Report.Actor.EthereumOutpost,
        "grant-bootstrap-delivery-batchop.a",
        "grant opp_inbound to batchop.a",
        {},
        OPERATOR_LABEL
      )
      expect(step.input).toEqual({
        kind: "EthereumOutpostManagerTool.GrantBootstrapDeliveryInput",
        operatorLabel: OPERATOR_LABEL
      })
      expect(step.runner).toBe(
        EthereumOutpostManagerTool.runGrantBootstrapDelivery
      )
    })
  })

  describe("loadOutpostManager", () => {
    it("binds the artifact ABI to the deployed address, as the deploy owner", () => {
      const ctx = contextWithOperator(OPERATOR_ADDRESS)
      const manager = EthereumOutpostManagerTool.loadOutpostManager(ctx)

      expect(manager.target).toBe(OUTPOST_MANAGER_ADDRESS)
      // `grantRole` is `restricted`; only the deploy owner (the client's own
      // signer, anvil HD index 0) holds ADMIN_ROLE on the outpost authority.
      // Identity, not just address: a same-address signer on another provider
      // would submit to the wrong chain.
      expect(manager.runner).toBe(ctx.ethereum.wallet.signer)
    })

    it("throws LOUDLY when OutpostManager is absent from the address map", () => {
      Fs.writeFileSync(
        Path.join(dataPath, "ethereum-deployments", "outpost-addrs.json"),
        JSON.stringify({})
      )
      expect(() =>
        EthereumOutpostManagerTool.loadOutpostManager(
          contextWithOperator(OPERATOR_ADDRESS)
        )
      ).toThrow(/OutpostManager not in outpost-addrs\.json/)
    })
  })

  describe("runGrantBootstrapDelivery", () => {
    it("rejects an operator with no Ethereum address before touching the chain", async () => {
      // A batch operator with no EM key has no EOA to authorize — granting the
      // zero address would leave `epochIn` callable by nobody, silently.
      await expect(
        EthereumOutpostManagerTool.runGrantBootstrapDelivery(
          contextWithOperator(),
          {
            kind: "EthereumOutpostManagerTool.GrantBootstrapDeliveryInput",
            operatorLabel: OPERATOR_LABEL
          },
          new AbortController().signal
        )
      ).rejects.toThrow(/has no Ethereum address/)
    })

    it("rejects an unknown operator label", async () => {
      await expect(
        EthereumOutpostManagerTool.runGrantBootstrapDelivery(
          contextWithOperator(OPERATOR_ADDRESS),
          {
            kind: "EthereumOutpostManagerTool.GrantBootstrapDeliveryInput",
            operatorLabel: "batchop.missing"
          },
          new AbortController().signal
        )
      ).rejects.toThrow()
    })

    it("honours an already-aborted signal", async () => {
      const controller = new AbortController()
      controller.abort()
      await expect(
        EthereumOutpostManagerTool.runGrantBootstrapDelivery(
          contextWithOperator(OPERATOR_ADDRESS),
          {
            kind: "EthereumOutpostManagerTool.GrantBootstrapDeliveryInput",
            operatorLabel: OPERATOR_LABEL
          },
          controller.signal
        )
      ).rejects.toThrow()
    })
  })
})
