import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { ethers } from "ethers"
import { Keypair } from "@solana/web3.js"
import { OperatorType, TokenAmount } from "@wireio/opp-typescript-models"
import { KeyType, PrivateKey, SlugName } from "@wireio/sdk-core"
import { Constants } from "@wireio/cluster-tool"
import {
  NodeopProcess,
  ProcessManager
} from "@wireio/cluster-tool/cluster/processes"
import { OperatorDaemonTool } from "@wireio/cluster-tool/tools/wire"
import { KeyGenerator } from "@wireio/cluster-tool/clients/wire"
import { ClusterConfigProvider, NodeRole } from "@wireio/cluster-tool/config"
import {
  AWSAccountName,
  EthereumReadBlockTag,
  NodeopReadMode,
  SignatureProviderType,
  createUnsetEthereumReadConfirmationConfig
} from "@wireio/cluster-tool-shared"
import { SolanaOutpostProgramTool } from "@wireio/cluster-tool/tools/solana"
import {
  OperatorDaemonArtifactsKey,
  type OperatorAccount,
  type OperatorDaemonArtifacts
} from "@wireio/cluster-tool/orchestration/outputs"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"
import {
  fixtureConfig,
  PersistedFixture
} from "../../config/clusterConfigFixture.js"
import {
  ethereumKeyPairFromWallet,
  toDialAddress,
  toURL
} from "@wireio/cluster-tool/utils"
import { AnvilProcess } from "@wireio/cluster-tool/cluster/processes"
import type { ExternalOutpostConfig } from "@wireio/cluster-tool-shared"
import { fixtureOperatorAccount } from "../../orchestration/outputs/operatorAccountFixture.js"
import {
  ExternalOutpostProgramId,
  fixtureExternalOutposts
} from "../../config/resolveEnvironmentFixture.js"

/** anvil's deterministic mnemonic — HD-derived wallets are stable + well-known. */
const AnvilMnemonic =
  "test test test test test test test test test test test junk"

function operatorAccount(label: string, type: OperatorType): OperatorAccount {
  const wallet = ethers.HDNodeWallet.fromMnemonic(
      ethers.Mnemonic.fromPhrase(AnvilMnemonic),
      "m/44'/60'/0'/0/1"
    ),
    edPrivate = PrivateKey.generate(KeyType.ED)
  return {
    label,
    publicationLabel: label,
    account: `wireno.${label}`,
    type,
    wire: {
      type: KeyType.K1,
      publicKey: `PUB_K1_${label}`,
      privateKey: `PVT_K1_${label}`
    },
    ethereum: ethereumKeyPairFromWallet(wallet),
    solana: {
      type: KeyType.ED,
      publicKey: edPrivate.toPublic().toString(),
      privateKey: edPrivate.toString()
    }
  }
}

const artifacts: OperatorDaemonArtifacts = {
  ethereumAbiFiles: [
    "/cluster/data/eth-abis/OPP.json",
    "/cluster/data/eth-abis/OPPInbound.json"
  ],
  ethereumAddresses: {
    OPP: "0x1111111111111111111111111111111111111111",
    OPPInbound: "0x2222222222222222222222222222222222222222"
  },
  solanaProgramId: "GrqvbZLCLkfeSQqvE7rL8XKHVWjNhAG2faLsY8yr9tD5",
  solanaIdlFile: "/cluster/data/solana-idls/liqsol_core.json"
}

const network: OperatorDaemonTool.OperatorDaemonNetwork = {
  ethereumRpcUrl: "http://127.0.0.1:8545",
  ethereumChainId: 31_337,
  ethereumRead: createUnsetEthereumReadConfirmationConfig(),
  solanaRpcUrl: "http://127.0.0.1:8899",
  debuggingServerUrl: "http://127.0.0.1:9901",
  debuggingServerEnabled: true
}

/** The value following `flag` (each occurrence). */
function valuesOf(args: string[], flag: string): string[] {
  return args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : []))
}

/** A live (non-anvil) EVM chain id — proves the anvil default is not assumed. */
const ExternalChainId = 11_155_111
/** An authoritative ETH outpost endpoint no local binding could describe. */
const ExternalEthereumRpcUrl = "https://ethereum-rpc.external.example/"
/** An authoritative SOL outpost endpoint no local binding could describe. */
const ExternalSolanaRpcUrl = "https://solana-rpc.external.example/"

/**
 * An already-deployed-outpost config, optionally carrying the authoritative
 * per-chain RPC endpoints. Omitting either models a DEV external, whose outpost
 * endpoint travels on the cluster's own bind config instead.
 *
 * @param ethereumRpcUrl - Authoritative ETH endpoint (omit for bind-governed).
 * @param solanaRpcUrl - Authoritative SOL endpoint (omit for bind-governed).
 * @returns The external-outpost config.
 */
function externalOutposts(
  ethereumRpcUrl?: string,
  solanaRpcUrl?: string
): ExternalOutpostConfig {
  const { ethereum, solana } = fixtureExternalOutposts()
  return {
    ethereum: {
      ...ethereum,
      chainId: ExternalChainId,
      ...(ethereumRpcUrl != null ? { rpcUrl: ethereumRpcUrl } : {})
    },
    solana: {
      ...solana,
      ...(solanaRpcUrl != null ? { rpcUrl: solanaRpcUrl } : {})
    }
  }
}

/**
 * These daemon-arg assertions pin the byte-identical KEY (default) source; the
 * SSM/KIOD source rendering is covered by the signature-provider tests.
 */
const keySourceFor = () => KeyGenerator.DefaultKeySource

describe("OperatorDaemonTool", () => {
  describe("networkFromConfig", () => {
    // The fixture's ports are ALREADY-RESOLVED persisted values being replayed
    // (no binding happens here) — the sanctioned fixture case of the bind rule.
    const boundEthereumRpcUrl = toURL(
        PersistedFixture.bind.anvil.port,
        toDialAddress(PersistedFixture.bind.anvil.address)
      ),
      boundSolanaRpcUrl = toURL(
        PersistedFixture.bind.solana.ports.http,
        toDialAddress(PersistedFixture.bind.solana.address)
      )

    it("derives BOTH outpost endpoints from the bind when there is no external-outpost config", () => {
      const network = OperatorDaemonTool.networkFromConfig(
        fixtureConfig({ externalOutposts: null })
      )
      expect(network.ethereumRpcUrl).toBe(boundEthereumRpcUrl)
      expect(network.solanaRpcUrl).toBe(boundSolanaRpcUrl)
      expect(network.ethereumChainId).toBe(AnvilProcess.DefaultChainId)
    })

    it("keeps the BIND governing when an external-outpost config omits rpcUrl (dev external)", () => {
      // rpcUrl is OPTIONAL, never defaulted — an external whose outpost sits on
      // the cluster's own binding must not be re-pointed at anything else.
      const network = OperatorDaemonTool.networkFromConfig(
        fixtureConfig({ externalOutposts: externalOutposts() })
      )
      expect(network.ethereumRpcUrl).toBe(boundEthereumRpcUrl)
      expect(network.solanaRpcUrl).toBe(boundSolanaRpcUrl)
    })

    it("lets an external-outpost rpcUrl WIN over the bind-derived URL on BOTH chains", () => {
      const network = OperatorDaemonTool.networkFromConfig(
        fixtureConfig({
          externalOutposts: externalOutposts(
            ExternalEthereumRpcUrl,
            ExternalSolanaRpcUrl
          )
        })
      )
      expect(network.ethereumRpcUrl).toBe(ExternalEthereumRpcUrl)
      expect(network.solanaRpcUrl).toBe(ExternalSolanaRpcUrl)
      expect(network.ethereumRpcUrl).not.toBe(boundEthereumRpcUrl)
      expect(network.solanaRpcUrl).not.toBe(boundSolanaRpcUrl)
    })

    it("resolves each chain's endpoint INDEPENDENTLY (one override never moves the other)", () => {
      const ethereumOnly = OperatorDaemonTool.networkFromConfig(
          fixtureConfig({
            externalOutposts: externalOutposts(ExternalEthereumRpcUrl)
          })
        ),
        solanaOnly = OperatorDaemonTool.networkFromConfig(
          fixtureConfig({
            externalOutposts: externalOutposts(undefined, ExternalSolanaRpcUrl)
          })
        )
      expect(ethereumOnly.ethereumRpcUrl).toBe(ExternalEthereumRpcUrl)
      expect(ethereumOnly.solanaRpcUrl).toBe(boundSolanaRpcUrl)
      expect(solanaOnly.solanaRpcUrl).toBe(ExternalSolanaRpcUrl)
      expect(solanaOnly.ethereumRpcUrl).toBe(boundEthereumRpcUrl)
    })

    it("keeps the chainId precedence intact (external chain id over the anvil default)", () => {
      expect(
        OperatorDaemonTool.networkFromConfig(
          fixtureConfig({
            externalOutposts: externalOutposts(
              ExternalEthereumRpcUrl,
              ExternalSolanaRpcUrl
            )
          })
        ).ethereumChainId
      ).toBe(ExternalChainId)
      // …and it is independent of rpcUrl — an omitted endpoint never reverts it.
      expect(
        OperatorDaemonTool.networkFromConfig(
          fixtureConfig({ externalOutposts: externalOutposts() })
        ).ethereumChainId
      ).toBe(ExternalChainId)
    })

    it("carries the cluster's Ethereum read confirmation", () => {
      const ethereumRead = {
        blockTag: EthereumReadBlockTag.latest,
        confirmations: 20,
        maxFinalityLagSec: null
      }
      expect(
        OperatorDaemonTool.networkFromConfig(fixtureConfig({ ethereumRead }))
          .ethereumRead
      ).toEqual(ethereumRead)
    })

    it("carries the resolved endpoints into the daemon argv (batch)", () => {
      const network = OperatorDaemonTool.networkFromConfig(
          fixtureConfig({
            externalOutposts: externalOutposts(
              ExternalEthereumRpcUrl,
              ExternalSolanaRpcUrl
            )
          })
        ),
        batchArgs = OperatorDaemonTool.batchOperatorArgs(
          operatorAccount("batchopcccc", OperatorType.BATCH),
          artifacts,
          network,
          keySourceFor,
          OperatorDaemonTool.NoBatchUnderwriting
        )
      expect(valuesOf(batchArgs, "--outpost-ethereum-client")).toEqual([
        `${OperatorDaemonTool.EthereumClientId},eth-wireno.batchopcccc,${ExternalEthereumRpcUrl},${ExternalChainId}`
      ])
      expect(valuesOf(batchArgs, "--outpost-solana-client")).toEqual([
        `${OperatorDaemonTool.SolanaClientId},sol-wireno.batchopcccc,${ExternalSolanaRpcUrl}`
      ])
    })
  })

  describe("runDaemonStart", () => {
    it("launches the daemon through NodeopProcess.startWithRecovery (dirty-chainbase resilient)", async () => {
      const ctx = fixtureContext()
      // The context's processManager getter requires the singleton's cluster
      // path to be set (idempotent for the same value).
      ProcessManager.setClusterPath(ctx.config.clusterPath)
      const operator = fixtureOperatorAccount("batchopbbbb", OperatorType.BATCH)
      ctx.keyStore.setOperator(operator)
      ctx.outputs.set(OperatorDaemonArtifactsKey, artifacts)
      const recoverySpy = jest
        .spyOn(NodeopProcess, "startWithRecovery")
        .mockResolvedValue(undefined)
      try {
        await OperatorDaemonTool.runDaemonStart(
          ctx,
          { kind: "OperatorDaemonTool.StartDaemonInput", label: "batchopbbbb" },
          new AbortController().signal
        )
        // A flow rerun reuses the daemon's data dir, so this launch must go
        // through the dirty-chainbase recovery path, not bare create+start.
        // The composed node's ROLE is pinned too: it selects the daemon's
        // plugin set, its ini read-mode, and the SHARED-25 deadline arm.
        expect(recoverySpy).toHaveBeenCalledWith(
          ctx.processManager,
          expect.objectContaining({
            operators: [operator],
            node: expect.objectContaining({ role: NodeRole.batch_operator }),
            extraArgs: expect.arrayContaining(["--batch-operator-account"])
          })
        )
        // A flow-provisioned daemon launches in the BOOTSTRAP form — the
        // SHARED-25 rules arm only after a complete bootstrap.
        expect(recoverySpy.mock.calls[0][1].postBootstrap).toBeUndefined()
      } finally {
        recoverySpy.mockRestore()
      }
    })
  })

  describe("batchOperatorSyncArgs", () => {
    it("is the irreversible read mode alone — no plugin, no outpost client, no debugging sink", () => {
      expect(OperatorDaemonTool.batchOperatorSyncArgs()).toEqual([
        `--${Constants.READ_MODE_OPTION}`,
        NodeopReadMode.irreversible
      ])
    })
  })

  describe("batchOperatorArgs", () => {
    const operator = fixtureOperatorAccount("batchopaaaa", OperatorType.BATCH)
    const args = OperatorDaemonTool.batchOperatorArgs(
      operator,
      artifacts,
      network,
      keySourceFor,
      OperatorDaemonTool.NoBatchUnderwriting
    )

    it("loads the batch plugin set at irreversible read-mode", () => {
      expect(valuesOf(args, `--${Constants.READ_MODE_OPTION}`)).toEqual([
        NodeopReadMode.irreversible
      ])
      expect(valuesOf(args, "--plugin")).toEqual([
        ...OperatorDaemonTool.BatchOperatorPlugins
      ])
    })

    it("starts with the sync-only args, so a node synced on them relaunches on the same read mode", () => {
      const syncArgs = OperatorDaemonTool.batchOperatorSyncArgs()
      expect(args.slice(0, syncArgs.length)).toEqual(syncArgs)
    })

    it("drops the external-debugging plugin AND --ext-debugging-server when the debugging server is disabled", () => {
      const disabledArgs = OperatorDaemonTool.batchOperatorArgs(
        operator,
        artifacts,
        { ...network, debuggingServerEnabled: false },
        keySourceFor,
        OperatorDaemonTool.NoBatchUnderwriting
      )
      expect(valuesOf(disabledArgs, "--plugin")).toEqual(
        OperatorDaemonTool.BatchOperatorPlugins.filter(
          plugin => plugin !== OperatorDaemonTool.ExternalDebuggingPlugin
        )
      )
      expect(valuesOf(disabledArgs, "--plugin")).not.toContain(
        OperatorDaemonTool.ExternalDebuggingPlugin
      )
      expect(valuesOf(disabledArgs, "--ext-debugging-server")).toEqual([])
    })

    it("signs WIRE with the operator's OWN unique wire key (account active)", () => {
      const providers = valuesOf(args, "--signature-provider")
      expect(providers[0]).toBe(
        "wire-PUB_K1_batchopaaaa,wire,wire,PUB_K1_batchopaaaa,KEY:PVT_K1_batchopaaaa"
      )
      // + the ETH and SOL outpost providers, named per-operator
      expect(providers.length).toBe(3)
      // Provider NAMES are built from the CHAIN account, not the durable handle.
      expect(providers[1]).toMatch(
        /^eth-wireno\.batchopaaaa,ethereum,ethereum,0x[0-9a-fA-F]{128},KEY:0x/
      )
      expect(providers[2]).toMatch(/^sol-wireno\.batchopaaaa,solana,solana,/)
    })

    it("configures the batch plugin + both outpost clients + artifacts", () => {
      // The depot matches this argv against `sysio.opreg::operators`, which is
      // keyed by the ON-CHAIN account — passing the handle would start a daemon
      // that silently matches no operator row.
      expect(valuesOf(args, "--batch-operator-account")).toEqual([
        operator.account
      ])
      expect(valuesOf(args, "--batch-operator-account")).not.toEqual([
        operator.label
      ])
      expect(valuesOf(args, "--batch-epoch-poll-ms")).toEqual([
        String(OperatorDaemonTool.BatchEpochPollMs)
      ])
      expect(valuesOf(args, "--batch-delivery-timeout-ms")).toEqual([
        String(OperatorDaemonTool.BatchDeliveryTimeoutMs)
      ])
      expect(valuesOf(args, "--ext-debugging-server")).toEqual([
        network.debuggingServerUrl
      ])
      // The client id IS the chain code: both daemons look a chain's RPC client
      // up under its `sysio.chains` code, so any other id is invisible to them.
      expect(valuesOf(args, "--outpost-ethereum-client")).toEqual([
        `ETHEREUM,eth-${operator.account},${network.ethereumRpcUrl},31337`
      ])
      expect(valuesOf(args, "--outpost-solana-client")).toEqual([
        `SOLANA,sol-${operator.account},${network.solanaRpcUrl}`
      ])
      expect(valuesOf(args, "--ethereum-abi-file")).toEqual(
        artifacts.ethereumAbiFiles
      )
      expect(valuesOf(args, "--solana-idl-file")).toEqual([
        artifacts.solanaIdlFile
      ])
      // The cleanroom hosts the outpost interface in liqsol_core — nodeop's
      // IDL-name gate must be pointed at it.
      expect(valuesOf(args, "--solana-outpost-program-name")).toEqual([
        SolanaOutpostProgramTool.ProgramName
      ])
    })

    it("renders no Ethereum read flag when the cluster sets none, leaving nodeop's defaults", () => {
      expect(
        args.filter(arg => arg.startsWith("--outpost-ethereum-read-"))
      ).toEqual([])
    })

    it("renders each set Ethereum read member beside the Ethereum client", () => {
      const readArgs = OperatorDaemonTool.batchOperatorArgs(
        operator,
        artifacts,
        {
          ...network,
          ethereumRead: {
            blockTag: EthereumReadBlockTag.safe,
            confirmations: null,
            maxFinalityLagSec: null
          }
        },
        keySourceFor,
        OperatorDaemonTool.NoBatchUnderwriting
      )
      expect(valuesOf(readArgs, "--outpost-ethereum-read-block-tag")).toEqual([
        EthereumReadBlockTag.safe
      ])
      expect(valuesOf(readArgs, "--outpost-ethereum-read-confirmations")).toEqual(
        []
      )
    })

    it("declares the client ids as the chain codes", () => {
      expect(OperatorDaemonTool.EthereumClientId).toBe(
        OperatorDaemonTool.EthereumChainCodename
      )
      expect(OperatorDaemonTool.SolanaClientId).toBe(
        OperatorDaemonTool.SolanaChainCodename
      )
    })

    it("emits no per-chain outpost flags (nodeop rejects them)", () => {
      // Removed by wire-sysio #474 …
      expect(valuesOf(args, "--batch-eth-opp-addr")).toEqual([])
      expect(valuesOf(args, "--batch-eth-opp-inbound-addr")).toEqual([])
      expect(valuesOf(args, "--batch-eth-client-id")).toEqual([])
      expect(valuesOf(args, "--batch-sol-program-id")).toEqual([])
      // … and by the sysio.chains outpost-registry change: the addresses live
      // on the chain row and the RPC client is keyed by chain code.
      expect(valuesOf(args, "--batch-enabled")).toEqual([])
      expect(valuesOf(args, "--batch-outpost")).toEqual([])
      expect(valuesOf(args, "--batch-sol-client-id")).toEqual([])
    })

    it("rejects a non-batch operator", () => {
      expect(() =>
        OperatorDaemonTool.batchOperatorArgs(
          fixtureOperatorAccount("uwritaaaaaa", OperatorType.UNDERWRITER),
          artifacts,
          network,
          keySourceFor,
          OperatorDaemonTool.NoBatchUnderwriting
        )
      ).toThrow(/not a batch operator/)
    })

    it("renders the operator's SOLANA (ED) provider as SSM under an SSM cluster", () => {
      // H6: the ED key must obtain its SSM source (not render inline KEY), or
      // the published ED param is orphaned and SSM isolation is defeated.
      const ssmKeySourceFor = ClusterConfigProvider.signatureProviderSource(
          fixtureConfig({
            clusterPath: "/tmp/wire-ssm",
            signatureProvider: {
              type: SignatureProviderType.SSM,
              ssm: {
                awsRegions: ["us-east-1"],
                awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}"
              }
            },
            awsClusterNodeConfig: {
              account: AWSAccountName.dev,
              regions: ["us-east-1"],
              ssm: null
            }
          })
        ),
        ssmArgs = OperatorDaemonTool.batchOperatorArgs(
          operator,
          artifacts,
          network,
          ssmKeySourceFor,
          OperatorDaemonTool.NoBatchUnderwriting
        ),
        solProvider = valuesOf(ssmArgs, "--signature-provider").find(provider =>
          provider.startsWith(`sol-${operator.account}`)
        )
      // REGION-LESS spec — `SSM:` then the id, ONE colon (`{cluster}` = `dev`).
      expect(solProvider).toMatch(/,SSM:\/wire\/dev\//)
      expect(solProvider).not.toMatch(/,KEY:/)
    })
  })

  describe("batchOperatorArgs — underwriter role", () => {
    const operator = fixtureOperatorAccount("batchopaaaa", OperatorType.BATCH),
      relayOnly = OperatorDaemonTool.batchOperatorArgs(
        operator,
        artifacts,
        network,
        keySourceFor,
        OperatorDaemonTool.NoBatchUnderwriting
      ),
      underwriting = OperatorDaemonTool.batchOperatorArgs(
        operator,
        artifacts,
        network,
        keySourceFor,
        OperatorDaemonTool.underwritingFromConfig(underwritingConfig())
      )

    it("renders no underwriter flag on a relay-only node", () => {
      expect(valuesOf(relayOnly, "--batch-underwriter-account")).toEqual([])
      expect(valuesOf(relayOnly, "--batch-underwriter-max-exposure")).toEqual(
        []
      )
    })

    it("underwrites as the relay's own account with the named LIQSOL cap", () => {
      expect(valuesOf(underwriting, "--batch-underwriter-account")).toEqual([
        operator.account
      ])
      expect(valuesOf(underwriting, "--batch-operator-account")).toEqual([
        operator.account
      ])
      expect(
        valuesOf(underwriting, "--batch-underwriter-max-exposure")
      ).toEqual(["10.000000000 LIQSOL"])
      expect(
        OperatorDaemonTool.exposureAsset(
          TokenAmount.create({
            tokenCode: BigInt(SlugName.from("LIQETH")),
            amount: 1n
          })
        ).toString()
      ).toBe("0.000000001 LIQETH")
    })

    it("keeps ONE WIRE signature provider for both roles and changes nothing else", () => {
      const wireProviders = (args: string[]) =>
        valuesOf(args, "--signature-provider").filter(provider =>
          provider.startsWith("wire-")
        )
      expect(wireProviders(underwriting)).toEqual(wireProviders(relayOnly))
      expect(wireProviders(underwriting)).toHaveLength(1)
      const withoutUnderwriter = underwriting.filter(
        (arg, index, all) =>
          ![arg, all[index - 1]].some(value =>
            [
              "--batch-underwriter-account",
              "--batch-underwriter-max-exposure"
            ].includes(value)
          )
      )
      expect(withoutUnderwriter).toEqual(relayOnly)
    })

    it("renders no underwriter role for an empty cap list", () => {
      expect(
        OperatorDaemonTool.batchOperatorArgs(
          operator,
          artifacts,
          network,
          keySourceFor,
          { maxExposure: [] }
        )
      ).toEqual(relayOnly)
    })

    it("derives the role from the cluster option, off by default", () => {
      expect(OperatorDaemonTool.underwritingFromConfig(fixtureConfig())).toBe(
        OperatorDaemonTool.NoBatchUnderwriting
      )
      expect(
        OperatorDaemonTool.underwritingFromConfig(
          underwritingConfig()
        ).maxExposure.map(cap => cap.toString())
      ).toEqual(["10.000000000 LIQSOL"])
    })
  })

  /** A cluster config whose operators run the underwriter role with the default cap. */
  function underwritingConfig() {
    return {
      ...fixtureConfig(),
      batchOperatorUnderwriting: {
        fundedOperatorCount: 3,
        maxExposure: [ClusterConfigProvider.DefaultBatchUnderwriterMaxExposure]
      }
    }
  }

  describe("runArtifactPreparation", () => {
    let dir: string
    beforeAll(() => {
      dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "daemon-artifacts-"))
    })
    afterAll(() => {
      Fs.rmSync(dir, { recursive: true, force: true })
    })

    /** The outpost addresses the deploy record of {@link writeArtifactSources} carries. */
    const DeployedAddresses = {
      OPP: "0xaaa0000000000000000000000000000000000aaa",
      OPPInbound: "0xccc0000000000000000000000000000000000ccc",
      BAR: "0xbbb0000000000000000000000000000000000bbb"
    }

    /** The hardhat artifact of each daemon ABI: source dir, artifact file, one event. */
    const AbiArtifacts = [
      ["OPP.sol", "OPP.json", "OPPEnvelope"],
      ["OPPInbound.sol", "OPPInbound.json", "OPPInboundEnvelope"],
      ["BAR.sol", "BARV2.json", "NodeCommitted"]
    ]

    /**
     * Write every source preparation reads under `root`: the outpost deploy
     * record (`addresses`), the OPP / OPPInbound / BARV2 hardhat artifacts, and
     * the liqsol_core program keypair + built IDL (`instructions` named).
     *
     * @param root - The sandbox root.
     * @param addresses - The deploy record's contract → address map.
     * @param instructions - The built IDL's instruction names.
     * @returns The paths a context needs, plus the program keypair.
     */
    function writeArtifactSources(
      root: string,
      addresses: Record<string, string>,
      instructions: readonly string[] = OperatorDaemonTool.RequiredSolanaIdlInstructions
    ) {
      const ethereumPath = Path.join(root, "wire-ethereum"),
        solanaPath = Path.join(root, "wire-solana"),
        clusterPath = Path.join(root, "cluster"),
        dataPath = Path.join(clusterPath, "data"),
        ethereumDeploymentsPath = Path.join(dataPath, "ethereum-deployments"),
        programKeypair = Keypair.generate()
      Fs.mkdirSync(ethereumDeploymentsPath, { recursive: true })
      Fs.writeFileSync(
        Path.join(ethereumDeploymentsPath, "outpost-addrs.json"),
        JSON.stringify(addresses)
      )
      AbiArtifacts.forEach(([source, artifact, event]) => {
        const artifactDir = Path.join(
          ethereumPath,
          "artifacts",
          "contracts",
          "outpost",
          source
        )
        Fs.mkdirSync(artifactDir, { recursive: true })
        Fs.writeFileSync(
          Path.join(artifactDir, artifact),
          JSON.stringify({ abi: [{ type: "event", name: event }] })
        )
      })
      Fs.mkdirSync(Path.join(solanaPath, ".keys"), { recursive: true })
      Fs.writeFileSync(
        Path.join(solanaPath, ".keys", "liqsol_core-keypair.json"),
        JSON.stringify([...programKeypair.secretKey])
      )
      Fs.mkdirSync(Path.join(solanaPath, "target", "idl"), { recursive: true })
      Fs.writeFileSync(
        Path.join(solanaPath, "target", "idl", "liqsol_core.json"),
        JSON.stringify({
          metadata: { name: "liqsol_core" },
          instructions: instructions.map(name => ({ name }))
        })
      )
      return { ethereumPath, solanaPath, clusterPath, dataPath, programKeypair }
    }

    /** A context over the sources {@link writeArtifactSources} wrote. */
    function sourcesContext(
      sources: ReturnType<typeof writeArtifactSources>,
      externalOutposts: ExternalOutpostConfig = null
    ) {
      return fixtureContext({
        clusterPath: sources.clusterPath,
        dataPath: sources.dataPath,
        ethereumPath: sources.ethereumPath,
        solanaPath: sources.solanaPath,
        externalOutposts
      })
    }

    it("overlays the external-outpost config's program id onto the built IDL", async () => {
      const ctx = sourcesContext(
        writeArtifactSources(Path.join(dir, "external"), DeployedAddresses),
        fixtureExternalOutposts()
      )
      await OperatorDaemonTool.runArtifactPreparation(
        ctx,
        null,
        new AbortController().signal
      )
      const prepared = ctx.outputs.assert(OperatorDaemonArtifactsKey),
        idl = JSON.parse(Fs.readFileSync(prepared.solanaIdlFile, "utf-8"))
      expect(prepared.solanaProgramId).toBe(ExternalOutpostProgramId)
      expect(idl.address).toBe(ExternalOutpostProgramId)
      expect(idl.metadata.name).toBe(SolanaOutpostProgramTool.ProgramName)
      // The ABIs are built from source over the deploy record's addresses.
      expect(
        prepared.ethereumAbiFiles.map(
          file => JSON.parse(Fs.readFileSync(file, "utf-8")).address
        )
      ).toEqual([
        DeployedAddresses.OPP,
        DeployedAddresses.OPPInbound,
        DeployedAddresses.BAR
      ])
    })

    it("refuses an ABI whose contract has no deployed address", async () => {
      const ctx = sourcesContext(
        writeArtifactSources(Path.join(dir, "no-bar"), {
          OPP: DeployedAddresses.OPP,
          OPPInbound: DeployedAddresses.OPPInbound
        })
      )
      await expect(
        OperatorDaemonTool.runArtifactPreparation(
          ctx,
          null,
          new AbortController().signal
        )
      ).rejects.toThrow(/has no BAR address to embed in its ABI/)
    })

    it("refuses a daemon ABI whose hardhat artifact is missing", async () => {
      const sources = writeArtifactSources(
        Path.join(dir, "no-artifact"),
        DeployedAddresses
      )
      Fs.rmSync(
        Path.join(sources.ethereumPath, "artifacts", "contracts", "outpost", "OPPInbound.sol"),
        { recursive: true }
      )
      await expect(
        OperatorDaemonTool.runArtifactPreparation(
          sourcesContext(sources),
          null,
          new AbortController().signal
        )
      ).rejects.toThrow(/no OPPInbound ABI artifact/)
    })

    it("writes address-embedded ABIs + the IDL carrying the program id + resolves the program id", async () => {
      // BAR resolves through the compiled BARV2 artifact name; the program id
      // comes from the committed liqsol_core keypair (local mode).
      const { ethereumPath, solanaPath, clusterPath, dataPath, programKeypair } =
          writeArtifactSources(Path.join(dir, "local"), DeployedAddresses),
        // Real context over the fixture config aimed at this sandbox —
        // `ethereumDeploymentsPath` derives from `dataPath`, matching the
        // fixture layout written above.
        ctx = fixtureContext({ clusterPath, dataPath, ethereumPath, solanaPath })
      await OperatorDaemonTool.runArtifactPreparation(
        ctx,
        null,
        new AbortController().signal
      )

      const prepared = ctx.outputs.assert(OperatorDaemonArtifactsKey)
      expect(prepared.solanaProgramId).toBe(programKeypair.publicKey.toBase58())
      expect(Fs.existsSync(prepared.solanaIdlFile)).toBe(true)
      // Written under the liqsol_core filename with the program id as its
      // `address` — metadata.name is NOT rewritten (nodeop is pointed at it via
      // --solana-outpost-program-name).
      expect(Path.basename(prepared.solanaIdlFile)).toBe(
        OperatorDaemonTool.SolanaIdlFilename
      )
      const copiedIdl = JSON.parse(
        Fs.readFileSync(prepared.solanaIdlFile, "utf-8")
      )
      expect(copiedIdl.metadata.name).toBe(SolanaOutpostProgramTool.ProgramName)
      expect(copiedIdl.address).toBe(programKeypair.publicKey.toBase58())
      expect(prepared.ethereumAbiFiles.length).toBe(
        OperatorDaemonTool.EthereumAbiContractNames.length
      )
      const abi = JSON.parse(
        Fs.readFileSync(prepared.ethereumAbiFiles[0], "utf-8")
      )
      expect(abi).toEqual({
        contractName: "OPP",
        address: DeployedAddresses.OPP,
        abi: [{ type: "event", name: "OPPEnvelope" }]
      })
      const barFile = prepared.ethereumAbiFiles[2]
      expect(Path.basename(barFile)).toBe("BAR.json")
      expect(JSON.parse(Fs.readFileSync(barFile, "utf-8"))).toEqual({
        contractName: "BAR",
        address: DeployedAddresses.BAR,
        abi: [{ type: "event", name: "NodeCommitted" }]
      })
    })

    it("rejects an IDL missing a daemon-invoked instruction (wrong/stale IDL guard)", async () => {
      // epoch_in absent from the built IDL.
      const ctx = sourcesContext(
        writeArtifactSources(Path.join(dir, "stale-idl"), DeployedAddresses, [
          "sol_to_liqsol"
        ])
      )
      await expect(
        OperatorDaemonTool.runArtifactPreparation(
          ctx,
          null,
          new AbortController().signal
        )
      ).rejects.toThrow(/missing the 'epoch_in' instruction/)
    })
  })
})
