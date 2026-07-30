import Path from "node:path"
import { SignatureProviderType } from "@wireio/cluster-tool-shared"
import { ClusterBuildDefaults } from "@wireio/cluster-tool/orchestration"
import {
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"

/** A phase or group node — a group carries `children`, a phase is a leaf. */
interface NamedNode {
  name: string
  children?: ReadonlyArray<NamedNode>
}

/** Every phase/group name in a built cluster, recursively (tree order). */
function collectNames(children: ReadonlyArray<NamedNode>): string[] {
  return children.flatMap(child => [
    child.name,
    ...(child.children ? collectNames(child.children) : [])
  ])
}

describe("ClusterBuildDefaults — SSM signature-provider key-publication gating", () => {
  let environment: ResolveEnvironment

  beforeEach(() => {
    environment = fixtureResolveEnvironment("ssm-publish-")
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

  function ssmOptions() {
    return {
      ...baseOptions(),
      signatureProvider: {
        type: SignatureProviderType.SSM,
        ssm: {
          awsRegion: "us-east-1",
          awsSecretIdPattern: "/wire/{cluster}/{account}/{keyType}"
        }
      }
    }
  }

  it("omits both publish phases under the default KEY provider", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions())
    const names = collectNames(cluster.children as unknown as NamedNode[])
    expect(names).not.toContain("PublishNodeSignatureProviderKeys")
    expect(names).not.toContain("PublishOperatorSignatureProviderKeys")
  })

  it("publishes node keys AFTER WalletAndKeys and BEFORE any node starts (SSM)", async () => {
    const cluster = await ClusterBuildDefaults.create(ssmOptions())
    const names = collectNames(cluster.children as unknown as NamedNode[])
    const publishIndex = names.indexOf("PublishNodeSignatureProviderKeys")
    expect(publishIndex).toBe(names.indexOf("WalletAndKeys") + 1)
    // The consumers — the SSM-spec'd producer nodes — start strictly after.
    expect(publishIndex).toBeLessThan(names.indexOf("BiosNode"))
    expect(publishIndex).toBeLessThan(names.indexOf("ProducerNodes"))
  })

  it("publishes operator keys AFTER provisioning and BEFORE the operator daemons start (SSM)", async () => {
    const cluster = await ClusterBuildDefaults.create(ssmOptions())
    const names = collectNames(cluster.children as unknown as NamedNode[])
    const publishIndex = names.indexOf("PublishOperatorSignatureProviderKeys")
    expect(publishIndex).toBeGreaterThan(names.indexOf("Create batchops & uws"))
    expect(publishIndex).toBeLessThan(names.indexOf("OperatorNodes"))
  })
})
