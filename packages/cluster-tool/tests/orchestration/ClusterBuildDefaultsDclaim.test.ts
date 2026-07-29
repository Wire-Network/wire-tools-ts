import Fs from "node:fs"
import Path from "node:path"
import { ChainKind } from "@wireio/opp-typescript-models"
import {
  ClusterBuildDefaults,
  DistributionClaimBootstrapResultKey,
  DistributionClaimBootstrapSource,
  type ClusterBuildPhase,
  type ClusterBuildPhaseBase
} from "@wireio/cluster-tool/orchestration"
import {
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"

interface PhaseGroupLike {
  readonly children: ReadonlyArray<ClusterBuildPhaseBase>
}

function findPhase(
  children: ReadonlyArray<ClusterBuildPhaseBase>,
  name: string
): ClusterBuildPhase {
  const phase = findPhaseOrNull(children, name)
  if (phase == null) throw new Error(`phase not found: ${name}`)
  return phase
}

function findPhaseOrNull(
  children: ReadonlyArray<ClusterBuildPhaseBase>,
  name: string
): ClusterBuildPhase {
  for (const child of children) {
    if (child.name === name && "steps" in child) {
      return child as ClusterBuildPhase
    }
    if ("children" in child) {
      const found = findPhaseOrNull((child as PhaseGroupLike).children, name)
      if (found != null) return found
    }
  }
  return null
}

describe("ClusterBuildDefaults — distribution-claim bootstrap", () => {
  let environment: ResolveEnvironment

  beforeEach(() => {
    environment = fixtureResolveEnvironment("dclaim-bootstrap-")
  })

  afterEach(() => {
    environment.cleanup()
  })

  function baseOptions() {
    return {
      clusterPath: Path.join(environment.rootPath, "cluster"),
      buildPath: environment.buildPath,
      ethereumPath: "/fake/eth",
      solanaPath: "/fake/sol"
    }
  }

  function writeDump(name: string, dump: object): string {
    const file = Path.join(environment.rootPath, name)
    Fs.writeFileSync(file, JSON.stringify(dump))
    return file
  }

  it("leaves the import window open for ordinary no-input creates", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions())
    expect(
      findPhase(cluster.children, "DistributionClaims").steps.map(
        step => step.name
      )
    ).toEqual(["init-dclaim"])
    expect(
      cluster.context.outputs.assert(DistributionClaimBootstrapResultKey)
    ).toEqual({ chains: [] })
  })

  it("leaves the import window open for an empty flow contribution", async () => {
    const cluster = await ClusterBuildDefaults.create(
      baseOptions(),
      undefined,
      async () => ({
        creditSets: [
          {
            chain: ChainKind.EVM,
            source: DistributionClaimBootstrapSource.Synthetic,
            credits: [],
            droppedDust: 0n
          }
        ]
      })
    )
    expect(
      findPhase(cluster.children, "DistributionClaims").steps.map(
        step => step.name
      )
    ).toEqual(["init-dclaim"])
  })

  it("calls the flow hook after file conversion and merges before composing batches", async () => {
    const file = writeDump("ethereum.json", {
      purchasers: [
        {
          address: `0x${"aa".repeat(20)}`,
          totalPretokens: "2000000000"
        }
      ]
    })
    const cluster = await ClusterBuildDefaults.create(
      {
        ...baseOptions(),
        ethereumBootstrapJsonFile: file
      },
      undefined,
      async (_cluster, core) => {
        expect(core.creditSets[0].credits[0].wire_atomic).toBe(2n)
        return {
          creditSets: [
            {
              chain: ChainKind.EVM,
              source: DistributionClaimBootstrapSource.Controlled,
              credits: [{ native_address: "aa".repeat(20), wire_atomic: 3n }],
              droppedDust: 0n
            }
          ]
        }
      }
    )
    const result = cluster.context.outputs.assert(
      DistributionClaimBootstrapResultKey
    )
    expect(result.chains[0].batches[0].credits).toEqual([
      { native_address: "aa".repeat(20), wire_atomic: 5n }
    ])
    expect(cluster.config.ethereumBootstrapJsonFile).toBe(Path.resolve(file))
    expect(
      findPhase(cluster.children, "DistributionClaims").steps.map(
        step => step.name
      )
    ).toEqual([
      "init-dclaim",
      "import-dclaim-ethereum-1",
      "finalize-dclaim-import"
    ])
  })

  it("rejects an explicitly supplied file with zero eligible credits", async () => {
    const file = writeDump("empty.json", {
      purchasers: [
        {
          address: `0x${"bb".repeat(20)}`,
          totalPretokens: "1"
        }
      ]
    })
    await expect(
      ClusterBuildDefaults.create({
        ...baseOptions(),
        ethereumBootstrapJsonFile: file
      })
    ).rejects.toThrow(/Ethereum bootstrap file .*zero eligible credits/)
  })
})
