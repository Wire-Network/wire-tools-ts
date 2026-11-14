import { execFile, type ExecFileOptions } from "node:child_process"
import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { ethers } from "ethers"

import {
  BindConfigProvider,
  ClusterConfigProvider
} from "@wireio/cluster-tool/config"
import { EthereumOutpostBootstrapper } from "@wireio/cluster-tool/orchestration"
import type { EthereumKeyPair } from "@wireio/cluster-tool/types"
import {
  ethereumKeyPairFromWallet,
  ethereumPrivateKeyHex,
  scaleTimeoutMs,
  toURL
} from "@wireio/cluster-tool/utils"

jest.mock("node:child_process", () => ({
  ...jest.requireActual<typeof import("node:child_process")>(
    "node:child_process"
  ),
  execFile: jest.fn(
    (
      _file: string,
      _args: readonly string[],
      _options: ExecFileOptions,
      callback: (
        error: Error,
        output: Awaited<ReturnType<typeof execFile.__promisify__>>
      ) => void
    ) => callback(null, { stdout: "", stderr: "" })
  )
}))

/** A random EM pair — the shape the Ethereum outpost phase persists for the deployer and the panic account. */
const randomKeyPair = (): EthereumKeyPair =>
  ethereumKeyPairFromWallet(ethers.Wallet.createRandom())

/** The deploy config `deployLocal.ts` reads, as far as the signer and panic account go. */
interface DeployConfigFile {
  key: string
  panicAccount: string
  initialOperatorGroups?: string[][]
}

/** Read one of the deploy configs the bootstrap wrote under `deploymentsPath`. */
function readDeployConfig(deploymentsPath: string, name: string): DeployConfigFile {
  return JSON.parse(Fs.readFileSync(Path.join(deploymentsPath, name), "utf-8"))
}

describe("EthereumOutpostBootstrapper cluster RPC routing", () => {
  let root: string

  beforeEach(() => {
    root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "wire432-ethereum-rpc-"))
    jest.mocked(execFile).mockClear()
  })

  afterEach(() => {
    Fs.rmSync(root, { recursive: true, force: true })
  })

  it.each([false, true])(
    "uses the registry-issued URL with inherited override = %s",
    async inherited => {
      const rpcUrl = toURL(
          await BindConfigProvider.findAvailable(
            BindConfigProvider.DefaultAnvil
          )
        ),
        inheritedRpcUrl = toURL(
          await BindConfigProvider.findAvailable(
            BindConfigProvider.DefaultAnvil
          )
        ),
        previous = process.env.LOCALHOST_RPC_URL,
        deploymentsPath = Path.join(root, "deployments"),
        deployer = randomKeyPair(),
        panicAccount = randomKeyPair(),
        operator = ethers.Wallet.createRandom().address
      if (inherited) process.env.LOCALHOST_RPC_URL = inheritedRpcUrl
      else delete process.env.LOCALHOST_RPC_URL
      try {
        await new EthereumOutpostBootstrapper({
          ethereumPath: root,
          rpcUrl,
          deploymentsPath,
          deployer,
          panicAccount,
          initialRoster: {
            groups: [[operator]],
            epochDurationSec: ClusterConfigProvider.DefaultEpochDurationSec
          }
        }).bootstrap()
        expect(execFile).toHaveBeenCalledTimes(1)
        const [command, args, options] = jest.mocked(execFile).mock.calls[0]
        expect(command).toBe("npx")
        expect(args).toEqual([
          "hardhat",
          "run",
          "src/scripts/deployLocal.ts",
          "--network",
          "localhost"
        ])
        expect(options.cwd).toBe(root)
        expect(options.timeout).toBe(
          scaleTimeoutMs(EthereumOutpostBootstrapper.HardhatDeployTimeoutMs)
        )
        expect(options.maxBuffer).toBe(
          EthereumOutpostBootstrapper.HardhatDeployBufferBytes
        )
        expect(options.env.HARDHAT_NETWORK).toBe("localhost")
        expect(options.env.LOCALHOST_RPC_URL).toBe(rpcUrl)
        expect(options.env.WIRE_ETH_DEPLOYMENTS_PATH).toBe(deploymentsPath)
        expect(process.env.LOCALHOST_RPC_URL).toBe(
          inherited ? inheritedRpcUrl : undefined
        )
        // Both deploy configs are signed by the PERSISTED deployer's secret and
        // name the persisted panic account — nothing drawn from an anvil
        // genesis account; the deployer never seats itself in the roster.
        const deployerPrivateKey = ethereumPrivateKeyHex(deployer),
          outpost = readDeployConfig(deploymentsPath, "outpost.json"),
          liqEth = readDeployConfig(deploymentsPath, "liqeth.json")
        expect(outpost.key).toBe(deployerPrivateKey)
        expect(outpost.panicAccount).toBe(panicAccount.address)
        expect(outpost.initialOperatorGroups).toEqual([[operator]])
        expect(liqEth.key).toBe(deployerPrivateKey)
        expect(liqEth.panicAccount).toBe(panicAccount.address)
      } finally {
        if (previous === undefined) delete process.env.LOCALHOST_RPC_URL
        else process.env.LOCALHOST_RPC_URL = previous
      }
    }
  )
})
