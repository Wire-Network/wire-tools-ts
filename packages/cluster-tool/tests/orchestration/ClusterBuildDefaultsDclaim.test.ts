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
  return children
    .map(child => {
      if (child.name === name && "steps" in child)
        return child as ClusterBuildPhase
      return "children" in child
        ? findPhaseOrNull((child as PhaseGroupLike).children, name)
        : null
    })
    .find(phase => phase != null)
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

  it("leaves the import window open for an empty programmatic input", async () => {
    const cluster = await ClusterBuildDefaults.create({
      ...baseOptions(),
      distributionClaimBootstrap: {
        fallbackCreditSets: [
          {
            chain: ChainKind.EVM,
            credits: [],
            droppedDust: 0n
          }
        ]
      }
    })
    expect(
      findPhase(cluster.children, "DistributionClaims").steps.map(
        step => step.name
      )
    ).toEqual(["init-dclaim"])
  })

  it("imports a programmatic fallback when its chain has no configured file", async () => {
    const cluster = await ClusterBuildDefaults.create({
      ...baseOptions(),
      distributionClaimBootstrap: {
        fallbackCreditSets: [
          {
            chain: ChainKind.SVM,
            credits: [{ native_address: "cc".repeat(32), wire_atomic: 7n }],
            droppedDust: 2n
          }
        ]
      }
    })
    const result = cluster.context.outputs.assert(
      DistributionClaimBootstrapResultKey
    )
    expect(result.chains[0]).toMatchObject({
      chain: ChainKind.SVM,
      droppedDust: 2n,
      sources: [DistributionClaimBootstrapSource.fallback]
    })
    expect(result.chains[0].batches[0].credits).toEqual([
      { native_address: "cc".repeat(32), wire_atomic: 7n }
    ])
  })

  it("prefers a configured chain over its fallback and merges additive credits before batching", async () => {
    const file = writeDump("ethereum.json", {
      purchasers: [
        {
          address: `0x${"aa".repeat(20)}`,
          totalPretokens: "2000000000"
        }
      ]
    })
    const cluster = await ClusterBuildDefaults.create({
      ...baseOptions(),
      ethereum: { bootstrapJsonFile: file },
      distributionClaimBootstrap: {
        fallbackCreditSets: [
          {
            chain: ChainKind.EVM,
            credits: [{ native_address: "bb".repeat(20), wire_atomic: 9n }],
            droppedDust: 0n
          }
        ],
        additiveCreditSets: [
          {
            chain: ChainKind.EVM,
            credits: [{ native_address: "aa".repeat(20), wire_atomic: 3n }],
            droppedDust: 0n
          }
        ]
      }
    })
    const result = cluster.context.outputs.assert(
      DistributionClaimBootstrapResultKey
    )
    expect(result.chains[0].batches[0].credits).toEqual([
      { native_address: "aa".repeat(20), wire_atomic: 5n }
    ])
    expect(result.chains[0].sources).toEqual([
      DistributionClaimBootstrapSource.configuredFile,
      DistributionClaimBootstrapSource.additive
    ])
    expect(cluster.config.ethereum.bootstrapJsonFile).toBe(Path.resolve(file))
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

  it("selects configured and fallback inputs independently in either chain direction", async () => {
    const ethereumFile = writeDump("mixed-ethereum.json", {
        purchasers: [
          {
            address: `0x${"11".repeat(20)}`,
            totalPretokens: "1000000000"
          }
        ]
      }),
      solanaFile = writeDump("mixed-solana.json", {
        purchasers: [
          {
            address: "4vJ9JU1bJJE96FbKdjWme2JC2nKjpGoxiNzU1S6mYP78",
            totalPretokens: "2"
          }
        ]
      }),
      ethereumConfigured = await ClusterBuildDefaults.create({
        ...baseOptions(),
        ethereum: { bootstrapJsonFile: ethereumFile },
        distributionClaimBootstrap: {
          fallbackCreditSets: [
            {
              chain: ChainKind.EVM,
              credits: [{ native_address: "22".repeat(20), wire_atomic: 3n }],
              droppedDust: 0n
            },
            {
              chain: ChainKind.SVM,
              credits: [{ native_address: "33".repeat(32), wire_atomic: 4n }],
              droppedDust: 0n
            }
          ]
        }
      }),
      solanaConfigured = await ClusterBuildDefaults.create({
        ...baseOptions(),
        solana: { bootstrapJsonFile: solanaFile },
        distributionClaimBootstrap: {
          fallbackCreditSets: [
            {
              chain: ChainKind.EVM,
              credits: [{ native_address: "44".repeat(20), wire_atomic: 5n }],
              droppedDust: 0n
            },
            {
              chain: ChainKind.SVM,
              credits: [{ native_address: "55".repeat(32), wire_atomic: 6n }],
              droppedDust: 0n
            }
          ]
        }
      })

    expect(
      ethereumConfigured.context.outputs
        .assert(DistributionClaimBootstrapResultKey)
        .chains.map(chain => [chain.chain, chain.sources])
    ).toEqual([
      [ChainKind.EVM, [DistributionClaimBootstrapSource.configuredFile]],
      [ChainKind.SVM, [DistributionClaimBootstrapSource.fallback]]
    ])
    expect(
      solanaConfigured.context.outputs
        .assert(DistributionClaimBootstrapResultKey)
        .chains.map(chain => [chain.chain, chain.sources])
    ).toEqual([
      [ChainKind.EVM, [DistributionClaimBootstrapSource.fallback]],
      [ChainKind.SVM, [DistributionClaimBootstrapSource.configuredFile]]
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
        ethereum: { bootstrapJsonFile: file }
      })
    ).rejects.toThrow(/Ethereum bootstrap file .*zero eligible credits/)
  })
})
