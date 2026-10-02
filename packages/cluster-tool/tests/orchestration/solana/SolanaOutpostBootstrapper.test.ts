import Path from "node:path"
import * as anchor from "@coral-xyz/anchor"
import { Connection, Keypair, PublicKey } from "@solana/web3.js"
import { OperatorStatus, OperatorType } from "@wireio/opp-typescript-models"
import { SolanaOutpostBootstrapper } from "@wireio/cluster-tool/orchestration"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import { getLogger } from "@wireio/cluster-tool/logging"
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
})

const BootstrapperSourceFile = Path.resolve(
  __dirname,
  "../../../src/orchestration/solana/SolanaOutpostBootstrapper.ts"
)

describe("SolanaOutpostBootstrapper.seedWithheldOperations (launch policy)", () => {
  const ProgramName = "launch_policy_fixture"
  const ProgramVersion = "0.0.0"
  const IdlSpecVersion = "0.1.0"
  let rpcUrl: string

  beforeAll(async () => {
    rpcUrl = toURL(
      await BindConfigProvider.findAvailable(
        BindConfigProvider.DefaultSolanaRpc
      )
    )
  })

  /** An instruction-less program: any `program.methods.<x>` call would throw, and no RPC is ever issued. */
  function createEmptyProgram(deployer: Keypair): anchor.Program<anchor.Idl> {
    const provider = new anchor.AnchorProvider(
      new Connection(rpcUrl),
      new anchor.Wallet(deployer),
      {}
    )
    return new anchor.Program(
      {
        address: PublicKey.default.toBase58(),
        metadata: {
          name: ProgramName,
          version: ProgramVersion,
          spec: IdlSpecVersion
        },
        instructions: []
      },
      provider
    )
  }

  it("skips every withheld call by default and reports it did not run", async () => {
    const deployer = Keypair.generate(),
      bootstrapper = new SolanaOutpostBootstrapper({
        solanaPath: "/repo/sol",
        rpcUrl
      })
    // the bootstrapper's `log` is `getLogger(__filename)`, cached per category
    const info = jest.spyOn(getLogger(BootstrapperSourceFile), "info")
    try {
      await expect(
        bootstrapper.seedWithheldOperations(
          deployer,
          createEmptyProgram(deployer),
          PublicKey.default,
          new anchor.BN(1)
        )
      ).resolves.toBe(false)
      expect(info).toHaveBeenCalledWith(
        SolanaOutpostBootstrapper.LaunchWithheldOperationsSkippedMessage
      )
    } finally {
      info.mockRestore()
    }
  })

  it("opens the gate once the policy flag is set (reaches the programId assertion)", async () => {
    const deployer = Keypair.generate(),
      bootstrapper = new SolanaOutpostBootstrapper({
        solanaPath: "/repo/sol",
        rpcUrl,
        enableLaunchWithheldOperations: true
      })
    // programId is absent without a program keypair → the enabled path asserts
    // before touching the chain, proving the gate opened.
    await expect(
      bootstrapper.seedWithheldOperations(
        deployer,
        createEmptyProgram(deployer),
        PublicKey.default,
        new anchor.BN(1)
      )
    ).rejects.toThrow(/programId required/)
  })
})
