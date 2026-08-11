import { ChainKind } from "@wireio/opp-typescript-models"
import {
  convertImportSeedCredits,
  loadIndexBalanceDump,
  type ImportSeedChainKind
} from "@wireio/cluster-tool/tools/wire/WireDclaimSeedTool"

import { WithBootstrapDataScenarioConstants as Constants } from "@wireio/test-flow-with-bootstrap-data/WithBootstrapDataScenarioConstants.js"

/** One fixture and the exact conversion summary pinned by it. */
interface FixtureCase {
  readonly chain: ImportSeedChainKind
  readonly file: string
}

const FixtureCases = [
  {
    chain: ChainKind.EVM,
    file: Constants.EthereumBootstrapJsonFile
  },
  {
    chain: ChainKind.SVM,
    file: Constants.SolanaBootstrapJsonFile
  }
] as const satisfies readonly FixtureCase[]

describe("bootstrap-data fixtures", () => {
  test.each(FixtureCases)(
    "loads and converts the committed $chain fixture exactly",
    async fixture => {
      const dump = await loadIndexBalanceDump(fixture.file, fixture.chain),
        conversion = convertImportSeedCredits(dump, fixture.chain),
        expectedChain = Constants.ExpectedChains.find(
          candidate => candidate.chain === fixture.chain
        ),
        expectedCredits = Constants.ExpectedCredits.filter(
          credit => credit.chain === fixture.chain
        ).map(credit => ({
          native_address: credit.nativeAddress,
          wire_atomic: credit.wireAtomic
        }))
      expect(expectedChain).toBeDefined()
      expect(conversion.credits).toEqual(expectedCredits)
      expect(conversion.uniqueAddresses).toBe(
        expectedChain?.eligibleAddressCount
      )
      expect(conversion.nonZeroCredits).toBe(
        expectedChain?.eligibleAddressCount
      )
      expect(conversion.totalAtomic).toBe(expectedChain?.totalAtomic)
      expect(conversion.droppedDust).toBe(expectedChain?.droppedDust)
    }
  )
})
