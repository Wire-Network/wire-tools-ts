import {
  ClusterReadinessCheckId,
  ClusterReadinessCheckStatus,
  ClusterReadinessEndpointKind,
  ClusterReadinessEndpointSource,
  ClusterReadinessFeature,
  ClusterReadinessReasonCode
} from "@wireio/cluster-tool-shared"
import { getLogger } from "@wireio/cluster-tool/logging"
import { Steps } from "@wireio/cluster-tool/orchestration"
import {
  ReadinessContext,
  ReadinessOutputs
} from "@wireio/cluster-tool/readiness"
import { Report } from "@wireio/cluster-tool/report"
import {
  OutpostChainFamily,
  OutpostDeploymentVerifier,
  type OutpostDeploymentProfile
} from "@wireio/sdk-outpost"

import {
  createReadinessDeploymentProfileFixture,
  ReadinessWireChainId
} from "../../readiness/readinessProfileFixture.js"

const WireEndpointUrl = "https://wire.example",
  EthereumEndpointUrl = "https://ethereum.example",
  SolanaEndpointUrl = "https://solana.example"

function readinessContext(
  outpostDeploymentProfile?: OutpostDeploymentProfile,
  request: typeof fetch = globalThis.fetch
): ReadinessContext {
  return new ReadinessContext(
    {
      feature: ClusterReadinessFeature.swap,
      catalogUrl: "https://catalog.example",
      requestedWireChainId: ReadinessWireChainId,
      outpostDeploymentProfile,
      endpoints: [
        {
          kind: ClusterReadinessEndpointKind.wire,
          url: WireEndpointUrl,
          source: ClusterReadinessEndpointSource.explicit
        },
        {
          kind: ClusterReadinessEndpointKind.ethereum,
          url: EthereumEndpointUrl,
          source: ClusterReadinessEndpointSource.explicit
        },
        {
          kind: ClusterReadinessEndpointKind.solana,
          url: SolanaEndpointUrl,
          source: ClusterReadinessEndpointSource.explicit
        }
      ],
      catalogRecordCount: 0,
      catalogErrors: [],
      observationMs: 1,
      timeoutMs: 1,
      report: { path: "/tmp", basename: "readiness", formats: [] }
    },
    getLogger("outpost-deployment-readiness-steps-test"),
    request
  )
}

describe("OutpostDeploymentReadinessSteps", () => {
  afterEach(() => jest.restoreAllMocks())

  it("records the Wire deployment-profile identity", async () => {
    const profile = createReadinessDeploymentProfileFixture(),
      request = jest
        .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              server_version: "0".repeat(40),
              chain_id: ReadinessWireChainId,
              head_block_num: 10,
              last_irreversible_block_num: 9,
              last_irreversible_block_id: "0".repeat(64),
              head_block_id: "1".repeat(64),
              head_block_time: "2026-08-05T12:00:00.000",
              head_block_producer: "sysio",
              virtual_block_cpu_limit: 1_000_000,
              virtual_block_net_limit: 1_000_000,
              block_cpu_limit: 100_000,
              block_net_limit: 100_000
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          )
        ),
      context = readinessContext(profile, request),
      step = Steps.readiness.outpostDeployment.planWireDeploymentProfile(
        Report.Actor.Sysio,
        "wire-deployment-profile",
        "Verify the Wire profile",
        {}
      )
    await step.runner(context, step.input, new AbortController().signal)

    expect(context.outputs.assert(ReadinessOutputs.checks)).toEqual([
      expect.objectContaining({
        id: ClusterReadinessCheckId["wire.deployment-profile"],
        status: ClusterReadinessCheckStatus.pass,
        evidence: {
          profileId: profile.id,
          chainId: ReadinessWireChainId
        }
      })
    ])
  })

  it.each([
    [
      OutpostChainFamily.ethereum,
      ClusterReadinessCheckId["ethereum.deployment-profile"],
      Steps.readiness.outpostDeployment.planEthereumDeploymentProfile,
      Report.Actor.EthereumOutpost
    ],
    [
      OutpostChainFamily.solana,
      ClusterReadinessCheckId["solana.deployment-profile"],
      Steps.readiness.outpostDeployment.planSolanaDeploymentProfile,
      Report.Actor.SolanaOutpost
    ]
  ])(
    "verifies the %s runtime through sdk-outpost",
    async (family, id, plan, actor) => {
      const profile = createReadinessDeploymentProfileFixture(),
        context = readinessContext(profile),
        verify = jest
          .spyOn(OutpostDeploymentVerifier, "verify")
          .mockResolvedValue(),
        step = plan(actor, `${family}-deployment-profile`, "Verify runtime", {})

      await step.runner(context, step.input, new AbortController().signal)

      expect(verify).toHaveBeenCalledWith(
        expect.objectContaining({ family, profile })
      )
      expect(context.outputs.assert(ReadinessOutputs.checks)).toEqual([
        expect.objectContaining({
          id,
          status: ClusterReadinessCheckStatus.pass
        })
      ])
    }
  )

  it("fails closed when no deployment profile is configured", async () => {
    const context = readinessContext(),
      step = Steps.readiness.outpostDeployment.planEthereumDeploymentProfile(
        Report.Actor.EthereumOutpost,
        "ethereum-deployment-profile",
        "Verify runtime",
        {}
      )

    await expect(
      step.runner(context, step.input, new AbortController().signal)
    ).rejects.toThrow("Outpost deployment profile is not configured")
    expect(context.outputs.assert(ReadinessOutputs.checks)).toEqual([
      expect.objectContaining({
        status: ClusterReadinessCheckStatus.fail,
        reason: ClusterReadinessReasonCode["configuration-incomplete"]
      })
    ])
  })

  it("reports an exact runtime mismatch as version-incompatible", async () => {
    const context = readinessContext(createReadinessDeploymentProfileFixture()),
      verify = jest
        .spyOn(OutpostDeploymentVerifier, "verify")
        .mockRejectedValue(new Error("implementation code hash mismatch")),
      step = Steps.readiness.outpostDeployment.planEthereumDeploymentProfile(
        Report.Actor.EthereumOutpost,
        "ethereum-deployment-profile",
        "Verify runtime",
        {}
      )

    await expect(
      step.runner(context, step.input, new AbortController().signal)
    ).rejects.toThrow("implementation code hash mismatch")
    expect(verify).toHaveBeenCalledTimes(1)
    expect(context.outputs.assert(ReadinessOutputs.checks)).toEqual([
      expect.objectContaining({
        status: ClusterReadinessCheckStatus.fail,
        reason: ClusterReadinessReasonCode["version-incompatible"]
      })
    ])
  })

  it("fails closed when a profiled chain endpoint is missing", async () => {
    const profile = createReadinessDeploymentProfileFixture(),
      context = readinessContext(profile),
      verify = jest.spyOn(OutpostDeploymentVerifier, "verify"),
      step = Steps.readiness.outpostDeployment.planSolanaDeploymentProfile(
        Report.Actor.SolanaOutpost,
        "solana-deployment-profile",
        "Verify runtime",
        {}
      )
    context.config.endpoints = context.config.endpoints.filter(
      endpoint => endpoint.kind !== ClusterReadinessEndpointKind.solana
    )

    await expect(
      step.runner(context, step.input, new AbortController().signal)
    ).rejects.toThrow("solana endpoint is missing")
    expect(verify).not.toHaveBeenCalled()
    expect(context.outputs.assert(ReadinessOutputs.checks)).toEqual([
      expect.objectContaining({
        status: ClusterReadinessCheckStatus.fail,
        reason: ClusterReadinessReasonCode["configuration-incomplete"]
      })
    ])
  })
})
