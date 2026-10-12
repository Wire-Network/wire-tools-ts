import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { noop } from "lodash"
import { SysioContracts } from "@wireio/sdk-core"
import { match } from "ts-pattern"
import { WireClient } from "@wireio/cluster-tool/clients/wire"
import { Steps } from "@wireio/cluster-tool/orchestration"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"

const { SysioTokensChainkind } = SysioContracts
const SolanaChainCode = "SOLANA"
const SolanaMintTokenCodes = ["LIQSOL", "USDCSOL", "USDTSOL"]
const ExpectedChainRegistrations = 3

enum ActionName {
  regchain = "regchain",
  regtoken = "regtoken",
  regctok = "regctok"
}

/** The registry payloads the seed pushed, each typed by its generated action-data shape. */
interface Recorded {
  regchain: SysioContracts.SysioChainsRegchainAction[]
  regtoken: SysioContracts.SysioTokensRegtokenAction[]
  regctok: SysioContracts.SysioTokensRegctokAction[]
}

describe("Steps.registry.runSeedRegistry without sol-mock-mints.json (launch policy)", () => {
  let directory: string
  let spy: jest.SpyInstance
  let recorded: Recorded

  beforeEach(() => {
    directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), "registry-seed-"))
    recorded = { regchain: [], regtoken: [], regctok: [] }
    // Every typed action invoke ends in `WireClient.invoke(account, action, data, …)`:
    // record the registry payloads by action name instead of pushing a transaction.
    // The resolved `null` stands in for the send response, which the seed never reads.
    spy = jest
      .spyOn(WireClient.prototype, "invoke")
      .mockImplementation(async (_account, action, data) => {
        match(action)
          .with(ActionName.regchain, () =>
            recorded.regchain.push(data as SysioContracts.SysioChainsRegchainAction)
          )
          .with(ActionName.regtoken, () =>
            recorded.regtoken.push(data as SysioContracts.SysioTokensRegtokenAction)
          )
          .with(ActionName.regctok, () =>
            recorded.regctok.push(data as SysioContracts.SysioTokensRegctokAction)
          )
          .otherwise(noop)
        return null
      })
  })

  afterEach(() => {
    spy.mockRestore()
    Fs.rmSync(directory, { recursive: true, force: true })
  })

  it("seeds the Solana mint tokens and bindings with the empty-address fallback", async () => {
    const ctx = fixtureContext({ dataPath: directory })
    await Steps.registry.runSeedRegistry(
      ctx,
      null,
      new AbortController().signal
    )

    const { regtoken: tokens, regctok: bindings } = recorded
    SolanaMintTokenCodes.forEach(code => {
      expect(tokens.find(token => token.code === code)?.address).toEqual({
        kind: SysioTokensChainkind.CHAIN_KIND_UNKNOWN,
        address: ""
      })
      expect(
        bindings.find(
          binding =>
            binding.chain_code === SolanaChainCode && binding.token_code === code
        )?.contract_addr
      ).toBe("")
    })
    expect(recorded.regchain).toHaveLength(ExpectedChainRegistrations)
  })

  it("rejects when an already-aborted signal is supplied (nothing is pushed)", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      Steps.registry.runSeedRegistry(
        fixtureContext({ dataPath: directory }),
        null,
        controller.signal
      )
    ).rejects.toBeDefined()
    expect(recorded.regtoken).toHaveLength(0)
  })
})
