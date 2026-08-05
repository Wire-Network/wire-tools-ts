import {
  EthereumContractName,
  OutpostArtifactManifests,
  type OutpostDeploymentProfile,
  SolanaProgramName,
  parseOutpostDeploymentProfile
} from "@wireio/sdk-outpost"

/** Wire chain identity shared by readiness profile tests. */
export const ReadinessWireChainId = "a".repeat(64)

const DeploymentChecksum = "b".repeat(64),
  RuntimeHash = "c".repeat(64)

/**
 * Create a mutable deployment profile aligned with the compiled SDK artifacts.
 *
 * @returns A schema-validated deployment profile fixture.
 */
export function createReadinessDeploymentProfileFixture(): OutpostDeploymentProfile {
  return parseOutpostDeploymentProfile({
    schemaVersion: 1,
    id: `${ReadinessWireChainId}-${DeploymentChecksum.slice(0, 12)}`,
    deploymentChecksum: DeploymentChecksum,
    wire: { chainId: ReadinessWireChainId },
    ethereum: {
      chainId: 31_337,
      contracts: {
        [EthereumContractName.OPP]: {
          address: "0x1111111111111111111111111111111111111111",
          implementationAddress: "0x2111111111111111111111111111111111111111",
          abiSha256:
            OutpostArtifactManifests.ethereum.contracts[
              EthereumContractName.OPP
            ].abiSha256,
          implementationCodeSha256: RuntimeHash
        },
        [EthereumContractName.OPPInbound]: {
          address: "0x3111111111111111111111111111111111111111",
          implementationAddress: "0x4111111111111111111111111111111111111111",
          abiSha256:
            OutpostArtifactManifests.ethereum.contracts[
              EthereumContractName.OPPInbound
            ].abiSha256,
          implementationCodeSha256: RuntimeHash
        },
        [EthereumContractName.OperatorRegistry]: {
          address: "0x5111111111111111111111111111111111111111",
          implementationAddress: "0x6111111111111111111111111111111111111111",
          abiSha256:
            OutpostArtifactManifests.ethereum.contracts[
              EthereumContractName.OperatorRegistry
            ].abiSha256,
          implementationCodeSha256: RuntimeHash
        },
        [EthereumContractName.ReserveManager]: {
          address: "0x7111111111111111111111111111111111111111",
          implementationAddress: "0x8111111111111111111111111111111111111111",
          abiSha256:
            OutpostArtifactManifests.ethereum.contracts[
              EthereumContractName.ReserveManager
            ].abiSha256,
          implementationCodeSha256: RuntimeHash
        }
      }
    },
    solana: {
      genesisHash: "11111111111111111111111111111111",
      programs: {
        [SolanaProgramName.liqsolCore]: {
          address: "11111111111111111111111111111111",
          programDataAddress: "SysvarRent111111111111111111111111111111111",
          idlSha256:
            OutpostArtifactManifests.solana.programs[
              SolanaProgramName.liqsolCore
            ].idlSha256,
          programDataSha256: RuntimeHash
        }
      }
    }
  })
}
