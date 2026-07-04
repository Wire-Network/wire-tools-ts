import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { ethers } from "ethers"
import { Keypair } from "@solana/web3.js"
import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType, PrivateKey } from "@wireio/sdk-core"
import { OperatorDaemonTool } from "@wireio/test-cluster-tool/tools/wire"
import {
  OperatorDaemonArtifactsKey,
  type OperatorAccount,
  type OperatorDaemonArtifacts
} from "@wireio/test-cluster-tool/orchestration/outputs"
import { OutputStore, type ClusterBuildContext } from "@wireio/test-cluster-tool/orchestration"
import { ethereumKeyPairFromWallet } from "@wireio/test-cluster-tool/utils"

/** anvil's deterministic mnemonic — HD-derived wallets are stable + well-known. */
const AnvilMnemonic = "test test test test test test test test test test test junk"

function operatorAccount(account: string, type: OperatorType): OperatorAccount {
  const wallet = ethers.HDNodeWallet.fromMnemonic(
      ethers.Mnemonic.fromPhrase(AnvilMnemonic),
      "m/44'/60'/0'/0/1"
    ),
    edPrivate = PrivateKey.generate(KeyType.ED)
  return {
    account,
    type,
    wire: { type: KeyType.K1, publicKey: `PUB_K1_${account}`, privateKey: `PVT_K1_${account}` },
    ethereum: ethereumKeyPairFromWallet(wallet),
    solana: {
      type: KeyType.ED,
      publicKey: edPrivate.toPublic().toString(),
      privateKey: edPrivate.toString()
    }
  }
}

const artifacts: OperatorDaemonArtifacts = {
  ethereumAbiFiles: ["/cluster/data/eth-abis/OPP.json", "/cluster/data/eth-abis/OPPInbound.json"],
  ethereumAddresses: {
    OPP: "0x1111111111111111111111111111111111111111",
    OPPInbound: "0x2222222222222222222222222222222222222222",
    OperatorRegistry: "0x3333333333333333333333333333333333333333",
    ReserveManager: "0x4444444444444444444444444444444444444444"
  },
  solanaProgramId: "GrqvbZLCLkfeSQqvE7rL8XKHVWjNhAG2faLsY8yr9tD5",
  solanaIdlFile: "/cluster/data/solana-idls/opp_outpost.json"
}

const network: OperatorDaemonTool.OperatorDaemonNetwork = {
  ethereumRpcUrl: "http://127.0.0.1:8545",
  ethereumChainId: 31_337,
  solanaRpcUrl: "http://127.0.0.1:8899",
  debuggingServerUrl: "http://127.0.0.1:9901"
}

/** The value following `flag` (each occurrence). */
function valuesOf(args: string[], flag: string): string[] {
  return args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : []))
}

describe("OperatorDaemonTool", () => {
  describe("batchOperatorArgs", () => {
    const operator = operatorAccount("batchopaaaa", OperatorType.BATCH)
    const args = OperatorDaemonTool.batchOperatorArgs(operator, artifacts, network)

    it("loads the batch plugin set at irreversible read-mode", () => {
      expect(valuesOf(args, "--read-mode")).toEqual(["irreversible"])
      expect(valuesOf(args, "--plugin")).toEqual([...OperatorDaemonTool.BatchOperatorPlugins])
    })

    it("signs WIRE with the operator's OWN unique wire key (account active)", () => {
      const providers = valuesOf(args, "--signature-provider")
      expect(providers[0]).toBe(
        "wire-PUB_K1_batchopaaaa,wire,wire,PUB_K1_batchopaaaa,KEY:PVT_K1_batchopaaaa"
      )
      // + the ETH and SOL outpost providers, named per-operator
      expect(providers.length).toBe(3)
      expect(providers[1]).toMatch(/^eth-batchopaaaa,ethereum,ethereum,0x[0-9a-fA-F]{128},KEY:0x/)
      expect(providers[2]).toMatch(/^sol-batchopaaaa,solana,solana,/)
    })

    it("configures the batch plugin + both outpost clients + artifacts", () => {
      expect(valuesOf(args, "--batch-enabled")).toEqual(["true"])
      expect(valuesOf(args, "--batch-operator-account")).toEqual(["batchopaaaa"])
      expect(valuesOf(args, "--batch-epoch-poll-ms")).toEqual([String(OperatorDaemonTool.BatchEpochPollMs)])
      expect(valuesOf(args, "--batch-delivery-timeout-ms")).toEqual([String(OperatorDaemonTool.BatchDeliveryTimeoutMs)])
      expect(valuesOf(args, "--ext-debugging-server")).toEqual([network.debuggingServerUrl])
      expect(valuesOf(args, "--outpost-ethereum-client")).toEqual([
        `eth-default,eth-batchopaaaa,${network.ethereumRpcUrl},31337`
      ])
      expect(valuesOf(args, "--outpost-solana-client")).toEqual([
        `sol-default,sol-batchopaaaa,${network.solanaRpcUrl}`
      ])
      expect(valuesOf(args, "--ethereum-abi-file")).toEqual(artifacts.ethereumAbiFiles)
      expect(valuesOf(args, "--batch-eth-opp-addr")).toEqual([artifacts.ethereumAddresses.OPP])
      expect(valuesOf(args, "--batch-eth-opp-inbound-addr")).toEqual([artifacts.ethereumAddresses.OPPInbound])
      expect(valuesOf(args, "--batch-eth-client-id")).toEqual(["eth-default"])
      expect(valuesOf(args, "--batch-sol-client-id")).toEqual(["sol-default"])
      expect(valuesOf(args, "--solana-idl-file")).toEqual([artifacts.solanaIdlFile])
      expect(valuesOf(args, "--batch-sol-program-id")).toEqual([artifacts.solanaProgramId])
    })

    it("rejects a non-batch operator", () => {
      expect(() =>
        OperatorDaemonTool.batchOperatorArgs(
          operatorAccount("uwritaaaaaa", OperatorType.UNDERWRITER),
          artifacts,
          network
        )
      ).toThrow(/not a batch operator/)
    })
  })

  describe("underwriterArgs", () => {
    const operator = operatorAccount("uwritaaaaaa", OperatorType.UNDERWRITER)
    const args = OperatorDaemonTool.underwriterArgs(operator, artifacts, network)

    it("passes the SCALED action timeout (flow timing scale reaches the daemon)", () => {
      process.env.WIRE_FLOW_TIMEOUT_SCALE = "4"
      try {
        const scaled = OperatorDaemonTool.underwriterArgs(operator, artifacts, network)
        expect(valuesOf(scaled, "--underwriter-action-timeout-ms")).toEqual([
          String(OperatorDaemonTool.UnderwriterActionTimeoutMs * 4)
        ])
      } finally {
        delete process.env.WIRE_FLOW_TIMEOUT_SCALE
      }
    })

    it("loads the underwriter plugin set + source-deposit verification targets", () => {
      expect(valuesOf(args, "--plugin")).toEqual([...OperatorDaemonTool.UnderwriterPlugins])
      expect(valuesOf(args, "--underwriter-enabled")).toEqual(["true"])
      expect(valuesOf(args, "--underwriter-account")).toEqual(["uwritaaaaaa"])
      expect(valuesOf(args, "--underwriter-eth-source-deposit-function")).toEqual(["requestSwap"])
      expect(valuesOf(args, "--underwriter-sol-source-deposit-instruction")).toEqual(["request_swap"])
      expect(valuesOf(args, "--solana-idl-file")).toEqual([artifacts.solanaIdlFile])
    })

    it("wires each outpost with one consolidated per-chain CSV spec", () => {
      expect(valuesOf(args, "--underwriter-eth-outpost")).toEqual([
        [
          OperatorDaemonTool.EthereumChainCodename,
          OperatorDaemonTool.EthereumClientId,
          artifacts.ethereumAddresses.OperatorRegistry,
          artifacts.ethereumAddresses.ReserveManager
        ].join(",")
      ])
      expect(valuesOf(args, "--underwriter-sol-outpost")).toEqual([
        [
          OperatorDaemonTool.SolanaChainCodename,
          OperatorDaemonTool.SolanaClientId,
          artifacts.solanaProgramId
        ].join(",")
      ])
    })
  })

  describe("runArtifactPreparation", () => {
    let dir: string
    beforeAll(() => {
      dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "daemon-artifacts-"))
    })
    afterAll(() => {
      Fs.rmSync(dir, { recursive: true, force: true })
    })

    it("writes address-embedded ABIs + copies the IDL + resolves the program id", async () => {
      const ethereumPath = Path.join(dir, "wire-ethereum"),
        solanaPath = Path.join(dir, "wire-solana"),
        dataPath = Path.join(dir, "cluster", "data"),
        ethereumDeploymentsPath = Path.join(dataPath, "ethereum-deployments")
      // ETH fixtures: outpost-addrs.json (in the per-cluster deployments dir)
      // + one hardhat artifact (OPP only).
      Fs.mkdirSync(ethereumDeploymentsPath, { recursive: true })
      Fs.writeFileSync(
        Path.join(ethereumDeploymentsPath, "outpost-addrs.json"),
        JSON.stringify({ OPP: "0xaaa0000000000000000000000000000000000aaa" })
      )
      const oppArtifactDir = Path.join(ethereumPath, "artifacts", "contracts", "outpost", "OPP.sol")
      Fs.mkdirSync(oppArtifactDir, { recursive: true })
      Fs.writeFileSync(
        Path.join(oppArtifactDir, "OPP.json"),
        JSON.stringify({ abi: [{ type: "event", name: "OPPEnvelope" }] })
      )
      // SOL fixtures: program keypair + IDL.
      const programKeypair = Keypair.generate()
      Fs.mkdirSync(Path.join(solanaPath, "wallets"), { recursive: true })
      Fs.writeFileSync(
        Path.join(solanaPath, "wallets", "opp-outpost-keypair.json"),
        JSON.stringify([...programKeypair.secretKey])
      )
      Fs.mkdirSync(Path.join(solanaPath, "target", "idl"), { recursive: true })
      Fs.writeFileSync(
        Path.join(solanaPath, "target", "idl", "opp_outpost.json"),
        JSON.stringify({ name: "opp_outpost" })
      )

      const outputs = new OutputStore(),
        ctx = {
          config: { ethereumPath, solanaPath, dataPath, ethereumDeploymentsPath },
          outputs,
          log: { info: () => undefined }
        } as unknown as ClusterBuildContext
      await OperatorDaemonTool.runArtifactPreparation(ctx, null, new AbortController().signal)

      const prepared = outputs.assert(OperatorDaemonArtifactsKey)
      expect(prepared.solanaProgramId).toBe(programKeypair.publicKey.toBase58())
      expect(Fs.existsSync(prepared.solanaIdlFile)).toBe(true)
      expect(prepared.ethereumAbiFiles.length).toBe(1)
      const abi = JSON.parse(Fs.readFileSync(prepared.ethereumAbiFiles[0], "utf-8"))
      expect(abi).toEqual({
        contractName: "OPP",
        address: "0xaaa0000000000000000000000000000000000aaa",
        abi: [{ type: "event", name: "OPPEnvelope" }]
      })
    })
  })
})
