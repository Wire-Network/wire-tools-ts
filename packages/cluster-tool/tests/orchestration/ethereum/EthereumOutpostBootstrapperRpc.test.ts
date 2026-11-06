import { execFile, type ExecFileOptions } from "node:child_process"
import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"

import {
  BindConfigProvider,
  ClusterConfigProvider
} from "@wireio/cluster-tool/config"
import { EthereumOutpostBootstrapper } from "@wireio/cluster-tool/orchestration"
import { scaleTimeoutMs, toURL } from "@wireio/cluster-tool/utils"

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
        deploymentsPath = Path.join(root, "deployments")
      if (inherited) process.env.LOCALHOST_RPC_URL = inheritedRpcUrl
      else delete process.env.LOCALHOST_RPC_URL
      try {
        await new EthereumOutpostBootstrapper({
          ethereumPath: root,
          anvilDataPath: Path.join(root, "anvil"),
          rpcUrl,
          deploymentsPath,
          accountCount: EthereumOutpostBootstrapper.PanicAccountIndex + 1,
          initialRoster: {
            groups: [
              [EthereumOutpostBootstrapper.generateAccounts(1)[0].address]
            ],
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
      } finally {
        if (previous === undefined) delete process.env.LOCALHOST_RPC_URL
        else process.env.LOCALHOST_RPC_URL = previous
      }
    }
  )
})
