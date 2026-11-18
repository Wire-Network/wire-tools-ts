import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { ethers } from "ethers"
import {
  EthereumPreLaunchStakingTool,
  type EthereumOutpostTarget
} from "@wireio/cluster-tool/tools/ethereum"

/** The trimmed `DepositorV3Deployed` artifact committed beside these cases. */
const DepositorFixture = "depositorV3.abi.json"
const StakingAddress = "0x3333333333333333333333333333333333333333"
const Staker = "0x4444444444444444444444444444444444444444"

/** The part of a hardhat artifact these cases bind: its ABI. */
interface AbiArtifact {
  abi: ethers.InterfaceAbi
}

/** A hardhat-shaped artifact from the fixture file. */
function fixture(): AbiArtifact {
  return JSON.parse(
    Fs.readFileSync(
      Path.join(__dirname, "..", "..", "fixtures", DepositorFixture),
      "utf8"
    )
  )
}

describe("EthereumPreLaunchStakingTool", () => {
  let root: string
  let ethereumPath: string
  const stakingInterface = new ethers.Interface(fixture().abi)

  /** A read-only runner answering each view from `answers`, keyed by function name. */
  function answeringProvider(
    answers: Record<string, ReadonlyArray<unknown>>
  ): ethers.Provider {
    return {
      provider: null,
      call: async (transaction: ethers.TransactionRequest) => {
        const fragment = stakingInterface.getFunction(
            String(transaction.data).slice(0, 10)
          ),
          answer = answers[fragment.name]
        expect(String(transaction.to).toLowerCase()).toBe(
          StakingAddress.toLowerCase()
        )
        expect(answer).toBeDefined()
        return stakingInterface.encodeFunctionResult(fragment, answer)
      }
    } as unknown as ethers.Provider
  }

  /** A target over the staged tree reading through `provider`. */
  function target(
    provider: ethers.Provider = answeringProvider({})
  ): EthereumOutpostTarget {
    return {
      provider,
      ethereumPath,
      chainId: 1,
      outpostAddresses: {
        [EthereumPreLaunchStakingTool.StakingContractName]: StakingAddress
      }
    }
  }

  beforeAll(() => {
    root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "eth-prelaunch-staking-"))
    ethereumPath = Path.join(root, "wire-ethereum")
    const artifactDir = Path.join(
      ethereumPath,
      "artifacts",
      "contracts",
      ...EthereumPreLaunchStakingTool.StakingArtifactSubpath,
      `${EthereumPreLaunchStakingTool.StakingContractName}.sol`
    )
    Fs.mkdirSync(artifactDir, { recursive: true })
    Fs.writeFileSync(
      Path.join(
        artifactDir,
        `${EthereumPreLaunchStakingTool.StakingArtifactContractName}.json`
      ),
      JSON.stringify(fixture())
    )
  })

  afterAll(() => {
    Fs.rmSync(root, { recursive: true, force: true })
  })

  it("names the deployed proxy by mainnet's book key and the snapshot artifact", () => {
    expect(EthereumPreLaunchStakingTool.StakingContractName).toBe("Depositor")
    expect(EthereumPreLaunchStakingTool.StakingArtifactSubpath).toEqual([
      "outpost",
      "v3"
    ])
    expect(EthereumPreLaunchStakingTool.StakingArtifactContractName).toBe(
      "DepositorV3Deployed"
    )
    expect(EthereumPreLaunchStakingTool.StakingFunction.depositAndStake).toBe(
      "depositAndStake"
    )
  })

  it("hasStakingContract reads the address book for the proxy", () => {
    expect(
      EthereumPreLaunchStakingTool.hasStakingContract(target().outpostAddresses)
    ).toBe(true)
    expect(
      EthereumPreLaunchStakingTool.hasStakingContract({ OPP: StakingAddress })
    ).toBe(false)
  })

  it("loadStakingContract binds the book's address to the snapshot artifact", async () => {
    const staking = EthereumPreLaunchStakingTool.loadStakingContract(
      target(),
      answeringProvider({})
    )
    expect(await staking.getAddress()).toBe(StakingAddress)
    expect(staking.interface.getFunction("depositAndStake")).not.toBeNull()
  })

  it("loadStakingContract refuses a book without the proxy", () => {
    expect(() =>
      EthereumPreLaunchStakingTool.loadStakingContract(
        { ...target(), outpostAddresses: {} },
        answeringProvider({})
      )
    ).toThrow(/Depositor not in outpost-addrs\.json/)
  })

  it("depositAndStakeRequest encodes the payable call with the stake attached", () => {
    const staking = EthereumPreLaunchStakingTool.loadStakingContract(
        target(),
        answeringProvider({})
      ),
      request = EthereumPreLaunchStakingTool.depositAndStakeRequest(
        staking,
        123n
      )
    expect(request.to).toBe(StakingAddress)
    expect(request.value).toBe(123n)
    expect(
      stakingInterface.parseTransaction({ data: String(request.data) }).name
    ).toBe(EthereumPreLaunchStakingTool.StakingFunction.depositAndStake)
  })

  it("readLaunchGate reads the three gate flags", async () => {
    await expect(
      EthereumPreLaunchStakingTool.readLaunchGate(
        target(
          answeringProvider({
            dDay: [true],
            isRefundActive: [false],
            paused: [true]
          })
        )
      )
    ).resolves.toEqual({ dDay: true, refundActive: false, paused: true })
  })

  it("readStakedShares reads the staker's shares", async () => {
    await expect(
      EthereumPreLaunchStakingTool.readStakedShares(
        target(answeringProvider({ sharesOf: [42n] })),
        Staker
      )
    ).resolves.toBe(42n)
  })
})
