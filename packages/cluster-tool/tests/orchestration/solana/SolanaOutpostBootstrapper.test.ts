import * as anchor from "@coral-xyz/anchor"
import { Keypair, PublicKey } from "@solana/web3.js"

import { OperatorStatus, OperatorType } from "@wireio/opp-typescript-models"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import { SolanaOutpostBootstrapper } from "@wireio/cluster-tool/orchestration"
import { SolanaOutpostProgramTool } from "@wireio/cluster-tool/tools/solana"
import { toURL } from "@wireio/cluster-tool/utils"

/** A minimal roster entry — the asserts under test never read its contents. */
const bootstrapOperator = (): SolanaOutpostBootstrapper.BootstrapOperator => ({
  wireName: new anchor.BN(1),
  solAddress: PublicKey.default,
  role: OperatorType.BATCH,
  status: OperatorStatus.ACTIVE
})

/** A seed of `size` paired roster entries + group members (roster IS the group). */
const seedOfSize = (size: number): SolanaOutpostBootstrapper.OppBootstrapSeed => {
  const operators = Array.from({ length: size }, bootstrapOperator)
  return { operators, groupMembers: operators.map(operator => operator.solAddress) }
}

describe("SolanaOutpostBootstrapper.SplReserveSpecifications", () => {
  it("provisions USDCSOL / USDTSOL / LIQSOL with the expected decimals", () => {
    const byCode = new Map(
      SolanaOutpostBootstrapper.SplReserveSpecifications.map(spec => [
        spec.codeName,
        spec
      ])
    )
    expect(byCode.get("USDCSOL")?.decimals).toBe(6)
    expect(byCode.get("USDTSOL")?.decimals).toBe(6)
    expect(byCode.get("LIQSOL")?.decimals).toBe(9)
  })
})

describe("SolanaOutpostBootstrapper.PdaSeed", () => {
  it("carries the liqsol global_config seed matching the on-chain program", () => {
    // MUST match wire-solana/programs/liqsol-core/src/states/global_config.rs
    // (`GlobalConfig::SEEDS`) — every OPP admin instruction derives the gate PDA
    // from it, so a drift here fails `has_one = admin` on-chain.
    expect(SolanaOutpostBootstrapper.PdaSeed.GlobalConfig).toBe("global_config")
  })
})

describe("SolanaOutpostBootstrapper.BpfLoaderUpgradeableProgramId", () => {
  it("is the canonical upgradeable-loader id (parent of every ProgramData PDA)", () => {
    expect(
      SolanaOutpostBootstrapper.BpfLoaderUpgradeableProgramId.toBase58()
    ).toBe("BPFLoaderUpgradeab1e11111111111111111111111")
  })
})

describe("SolanaOutpostBootstrapper constructor", () => {
  let rpcUrl: string
  beforeAll(async () => {
    rpcUrl = toURL(
      await BindConfigProvider.findAvailable(
        BindConfigProvider.DefaultSolanaRpc
      )
    )
  })

  it("throws when solanaPath is missing", () => {
    expect(
      () => new SolanaOutpostBootstrapper({ solanaPath: "", rpcUrl })
    ).toThrow(/solanaPath is required/)
  })

  it("throws when rpcUrl is missing", () => {
    expect(
      () =>
        new SolanaOutpostBootstrapper({ solanaPath: "/repo/sol", rpcUrl: "" })
    ).toThrow(/rpcUrl is required/)
  })
})

describe("SolanaOutpostBootstrapper.oppBootstrapEncodedBytes", () => {
  it("caps the group at the largest size Anchor's fixed buffer admits", () => {
    const {
      MaxOppBootstrapGroupMembers: max,
      AnchorInstructionBufferBytes: buffer,
      oppBootstrapEncodedBytes
    } = SolanaOutpostBootstrapper
    // The roster IS the group, so BOTH vectors grow with the group size — the
    // cap is on GROUP size, never on the cluster's topology.
    expect(oppBootstrapEncodedBytes(max, max)).toBeLessThanOrEqual(buffer)
    expect(oppBootstrapEncodedBytes(max + 1, max + 1)).toBeGreaterThan(buffer)
  })
})

describe("SolanaOutpostBootstrapper.oppBootstrap argument validation", () => {
  let bootstrapper: SolanaOutpostBootstrapper
  const epochDurationSec = 60

  beforeAll(async () => {
    // The asserts under test run BEFORE any filesystem or RPC access, so an
    // unbuilt repo path and an unbound (registry-issued) URL are enough.
    bootstrapper = new SolanaOutpostBootstrapper({
      solanaPath: "/repo/sol",
      rpcUrl: toURL(
        await BindConfigProvider.findAvailable(
          BindConfigProvider.DefaultSolanaRpc
        )
      )
    })
  })

  it("rejects an empty roster", async () => {
    await expect(
      bootstrapper.oppBootstrap(seedOfSize(0), epochDurationSec)
    ).rejects.toThrow(/at least one operator is required/)
  })

  it("rejects an empty group", async () => {
    await expect(
      bootstrapper.oppBootstrap(
        { operators: [bootstrapOperator()], groupMembers: [] },
        epochDurationSec
      )
    ).rejects.toThrow(/at least one group member is required/)
  })

  it("rejects a non-positive epoch duration", async () => {
    await expect(bootstrapper.oppBootstrap(seedOfSize(1), 0)).rejects.toThrow(
      /epochDurationSec must be positive/
    )
  })

  it("rejects a group that overruns Anchor's instruction buffer", async () => {
    await expect(
      bootstrapper.oppBootstrap(
        seedOfSize(SolanaOutpostBootstrapper.MaxOppBootstrapGroupMembers + 1),
        epochDurationSec
      )
    ).rejects.toThrow(
      new RegExp(
        `exceeds the ${SolanaOutpostBootstrapper.MaxOppBootstrapGroupMembers}-member limit`
      )
    )
  })

  it("admits the largest group the buffer allows (past the size gate)", async () => {
    // The size assert passes, so the call proceeds to program-id resolution and
    // fails THERE — proving the gate is sized, not merely present.
    await expect(
      bootstrapper.oppBootstrap(
        seedOfSize(SolanaOutpostBootstrapper.MaxOppBootstrapGroupMembers),
        epochDurationSec
      )
    ).rejects.toThrow(/program keypair missing/)
  })

  it("encodes, signs, and submits the opp_bootstrap instruction", async () => {
    const seed = seedOfSize(2),
      programId = Keypair.generate().publicKey,
      configPda = Keypair.generate().publicKey,
      operatorRegistryPda = Keypair.generate().publicKey,
      deployer = Keypair.generate(),
      transaction = new anchor.web3.Transaction(),
      transactionMethod = jest.fn().mockResolvedValue(transaction),
      signers = jest
        .fn()
        .mockReturnValue({ transaction: transactionMethod }),
      accounts = jest.fn().mockReturnValue({ signers }),
      oppBootstrap = jest.fn().mockReturnValue({ accounts }),
      program = {
        methods: { oppBootstrap }
      } as unknown as anchor.Program<anchor.Idl>,
      ensureGlobalConfig = jest.fn().mockResolvedValue(undefined),
      deriveProgramAddress = jest
        .fn()
        .mockReturnValueOnce(configPda)
        .mockReturnValueOnce(operatorRegistryPda),
      adminAccounts = {
        admin: deployer.publicKey,
        globalConfig: Keypair.generate().publicKey
      },
      runSimpleAuthorityInstruction = jest.fn().mockResolvedValue(undefined),
      assertProgramId = jest
        .spyOn(SolanaOutpostProgramTool, "assertProgramId")
        .mockReturnValue(programId)
    Object.assign(bootstrapper, {
      loadOrGenerateDeployer: () => deployer,
      loadProgram: () => program,
      ensureGlobalConfig,
      deriveProgramAddress,
      getAdminAccounts: () => adminAccounts,
      runSimpleAuthorityInstruction
    })

    try {
      await bootstrapper.oppBootstrap(seed, epochDurationSec)
    } finally {
      assertProgramId.mockRestore()
    }

    expect(oppBootstrap).toHaveBeenCalledWith(
      seed.operators,
      seed.groupMembers,
      epochDurationSec
    )
    expect(ensureGlobalConfig).toHaveBeenCalledWith(deployer, program)
    expect(deriveProgramAddress).toHaveBeenNthCalledWith(
      1,
      programId,
      SolanaOutpostBootstrapper.PdaSeed.OutpostConfig
    )
    expect(deriveProgramAddress).toHaveBeenNthCalledWith(
      2,
      programId,
      SolanaOutpostBootstrapper.PdaSeed.OperatorRegistry
    )
    expect(accounts).toHaveBeenCalledWith({
      ...adminAccounts,
      config: configPda,
      operatorRegistry: operatorRegistryPda
    })
    expect(signers).toHaveBeenCalledWith([deployer])
    expect(transactionMethod).toHaveBeenCalledTimes(1)
    expect(runSimpleAuthorityInstruction).toHaveBeenCalledWith(
      deployer,
      transaction,
      "opp_bootstrap"
    )
  })
})
