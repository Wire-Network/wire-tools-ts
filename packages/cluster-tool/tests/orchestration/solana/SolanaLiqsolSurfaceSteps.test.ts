import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js"
import {
  ClusterBuild,
  ClusterBuildContext,
  SolanaLiqsolSurfaceSteps
} from "@wireio/cluster-tool/orchestration"
import { getLogger } from "@wireio/cluster-tool/logging"
import { Report } from "@wireio/cluster-tool/report"
import {
  SolanaFundingTool,
  SolanaOutpostProgramTool
} from "@wireio/cluster-tool/tools/solana"
import { fixtureConfig } from "../../config/clusterConfigFixture.js"
import { collectStepNames } from "../clusterBuildFixture.js"

/** A fresh build root for the liqsol-surface phase to register on. */
function newBuild(): ClusterBuild {
  return ClusterBuild.forContext(
    new ClusterBuildContext(fixtureConfig(), getLogger("liqsol-surface-test"))
  )
}

/**
 * The init-script order `wire-solana/bash-scripts/reset-local-cluster.sh` runs.
 * Duplicated here ON PURPOSE: the harness phase must not silently drift from
 * the script a developer's local cluster is built with.
 *
 * The harness runs this order minus {@link ExcludedFromInitScripts} — see the
 * cases below for why each one is left out.
 */
const ResetLocalClusterOrder = [
  "init-token-mint",
  "init-transfer-hook",
  "init-distro",
  "init-wire-config",
  "init-controller",
  "init-global-config",
  "init-validators-active-list",
  "init-validators-graveyard-list",
  "init-validator-leaderboard",
  "init-leaderboard-config",
  "init-allocation-state",
  "init-stake-state",
  "init-liqsol-bucket",
  "init-pay-rate-history",
  "init-withdraw-global",
  "init-withdraw-metadata",
  "init-tranche-state",
  "init-pretoken-purchase-history",
  "init-reserve"
]

/**
 * The `reset-local-cluster.sh` steps the harness does not drive as SCRIPTS.
 * `fund-treasury`, `init-distro` and `init-controller` are driven as harness
 * Steps instead (not get-or-create, and the latter two cannot fail);
 * `init-tranche-state` cannot succeed against a deployable build at all.
 */
const ExcludedFromInitScripts = [
  "fund-treasury",
  "init-distro",
  "init-controller",
  "init-tranche-state"
]

/** Stage a wire-solana tree whose `.keys` ids match (or deliberately do not) its IDLs. */
function stageSolanaTree(matched: boolean): string {
  const solanaPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "liqsol-surface-"))
  Fs.mkdirSync(
    Path.join(solanaPath, SolanaOutpostProgramTool.KeysSubdirectory),
    { recursive: true }
  )
  Fs.mkdirSync(Path.join(solanaPath, SolanaOutpostProgramTool.IdlSubdirectory), {
    recursive: true
  })
  SolanaOutpostProgramTool.GenesisAnchorPrograms.forEach((program, index) => {
    const keypair = Keypair.generate()
    Fs.writeFileSync(
      SolanaOutpostProgramTool.programKeypairFile(solanaPath, program),
      JSON.stringify([...keypair.secretKey])
    )
    // The mismatch is injected on the LAST program so the assertion has to walk
    // the whole set rather than stopping at the first.
    const declared =
      matched || index < SolanaOutpostProgramTool.GenesisAnchorPrograms.length - 1
        ? keypair.publicKey
        : Keypair.generate().publicKey
    Fs.writeFileSync(
      SolanaOutpostProgramTool.programIdlFile(solanaPath, program),
      JSON.stringify({
        address: declared.toBase58(),
        metadata: { name: program, version: "0.1.0", spec: "0.1.0" },
        instructions: []
      })
    )
  })
  return solanaPath
}

describe("SolanaLiqsolSurfaceSteps", () => {
  describe("InitScripts", () => {
    it("matches reset-local-cluster.sh's order, minus the excluded steps", () => {
      expect(
        SolanaLiqsolSurfaceSteps.InitScripts.map(({ script }) => script)
      ).toEqual(
        ResetLocalClusterOrder.filter(
          script => !ExcludedFromInitScripts.includes(script)
        )
      )
    })

    it("describes every script and needs no script arguments", () => {
      SolanaLiqsolSurfaceSteps.InitScripts.forEach(entry =>
        expect(entry.description.length).toBeGreaterThan(0)
      )
      expect(
        SolanaLiqsolSurfaceSteps.InitScripts.filter(
          entry => (entry.args ?? []).length > 0
        )
      ).toEqual([])
    })

    it("excludes fund-treasury — the reset-local-cluster step that is not get-or-create", () => {
      expect(
        SolanaLiqsolSurfaceSteps.InitScripts.map(({ script }) => script)
      ).not.toContain("fund-treasury")
    })

    it("excludes the two scripts that cannot report their own failure", () => {
      // Both end in `main().catch(console.error)` and write unconditionally, so
      // `runScript` — which sees only the exit code — would pass their Steps on
      // a failed write. They are harness Steps instead.
      const scripts = SolanaLiqsolSurfaceSteps.InitScripts.map(
        ({ script }) => script
      )
      expect(scripts).not.toContain("init-distro")
      expect(scripts).not.toContain("init-controller")
    })

    it("runs the distribution write before init-wire-config reads it", () => {
      // `init_wire_config` now creates the pool ATA and the pool's distribution
      // record itself, so it reads `distribution_state` — which the harness
      // Step standing in for `init-distro` creates.
      const cluster = newBuild()
      SolanaLiqsolSurfaceSteps.planLiqsolSurface(
        cluster,
        "SolanaLiqsolSurface",
        "stand up the liqsol surface",
        {}
      )
      const names = collectStepNames(cluster.children),
        at = (name: string) => names.indexOf(name)
      expect(at("init-distribution-state")).toBe(
        at(SolanaLiqsolSurfaceSteps.WireConfigScript) - 1
      )
      // …and the stake-controller writes stay at init-controller's position,
      // after the wire config and before init-global-config.
      expect(at(SolanaLiqsolSurfaceSteps.WireConfigScript)).toBeLessThan(
        at("init-stake-controller-state")
      )
      expect(at("init-stake-vault")).toBe(
        at(SolanaLiqsolSurfaceSteps.GlobalConfigScript) - 1
      )
    })

    it("names the three scripts the harness Steps are keyed to", () => {
      // The Steps are inserted by SCRIPT NAME, not by index, so a new init
      // script cannot silently move them — but the names must still be real.
      const scripts = SolanaLiqsolSurfaceSteps.InitScripts.map(
        ({ script }) => script
      )
      expect(scripts).toContain(SolanaLiqsolSurfaceSteps.WireConfigScript)
      expect(scripts).toContain(SolanaLiqsolSurfaceSteps.GlobalConfigScript)
      expect(scripts).toContain(SolanaLiqsolSurfaceSteps.PretokenHistoryScript)
    })

    it("excludes init-tranche-state — it pins the MAINNET Chainlink feed", () => {
      // Outside `--features development`, `initialize_tranche_state` constrains
      // `chainlink_feed`/`chainlink_program` to real mainnet addresses, which a
      // test validator does not host: the script passes the system program and
      // the instruction refuses with `InvalidChainlinkFeed` (7701). Running it
      // would make a DEVELOPMENT build a prerequisite of the bootstrap.
      expect(
        SolanaLiqsolSurfaceSteps.InitScripts.map(({ script }) => script)
      ).not.toContain("init-tranche-state")
      // Nothing else in the list names the tranche either — the omission is
      // the whole concern leaving, not one step removed from a chain.
      SolanaLiqsolSurfaceSteps.InitScripts.forEach(({ script, description }) => {
        expect(script).not.toMatch(/tranche/)
        expect(description).not.toMatch(/tranche/)
      })
    })

    // L5: the copy above catches a REORDER, but a rename in both places would
    // pass it. These three relative orders are the ones the programs enforce,
    // so they are pinned by index rather than by list equality.
    it("pins the four load-bearing relative orders", () => {
      const at = (script: string) =>
        SolanaLiqsolSurfaceSteps.InitScripts.findIndex(
          entry => entry.script === script
        )
      // the mint must exist before its ExtraAccountMetaList is written
      expect(at("init-token-mint")).toBeLessThan(at("init-transfer-hook"))
      // init_wire_config creates the pool's accounting, and init-global-config
      // is what opens deposits — the instruction refuses a non-empty bootstrap
      // state, so the accounting has to exist first
      expect(at("init-wire-config")).toBeLessThan(at("init-global-config"))
      // the leaderboard config is seeded from global_config.admin
      expect(at("init-global-config")).toBeLessThan(at("init-leaderboard-config"))
      // the pretoken history reads the GlobalState init-wire-config creates
      expect(at("init-wire-config")).toBeLessThan(
        at("init-pretoken-purchase-history")
      )
      SolanaLiqsolSurfaceSteps.InitScripts.forEach(entry =>
        expect(at(entry.script)).toBeGreaterThanOrEqual(0)
      )
    })
  })

  describe("pretoken-history epoch gate", () => {
    it("waits for the epoch wire-solana's own deploy gate waits for", () => {
      // bash-scripts/wait-for-validators.sh MIN_EPOCH, same reason.
      expect(SolanaLiqsolSurfaceSteps.MinimumPretokenHistoryEpoch).toBe(2)
    })

    /** `getEpochInfo()`'s shape, with only the fields the budget reads. */
    const epochInfo = (epoch: number, slotIndex: number, slotsInEpoch = 100) =>
      ({ epoch, slotIndex, slotsInEpoch }) as Parameters<
        typeof SolanaLiqsolSurfaceSteps.pretokenHistoryEpochBudgetMs
      >[0]

    it("budgets the slot time actually REMAINING, not whole epochs", () => {
      // Mid epoch 0: the rest of this epoch (60 slots) plus all of epoch 1.
      expect(
        SolanaLiqsolSurfaceSteps.pretokenHistoryEpochBudgetMs(epochInfo(0, 40))
      ).toBe(
        160 *
          SolanaLiqsolSurfaceSteps.SlotDurationMs *
          SolanaLiqsolSurfaceSteps.PretokenHistoryEpochBudgetSlack
      )
      // Late in epoch 1: only the remainder of epoch 1 is left.
      expect(
        SolanaLiqsolSurfaceSteps.pretokenHistoryEpochBudgetMs(epochInfo(1, 90))
      ).toBe(
        10 *
          SolanaLiqsolSurfaceSteps.SlotDurationMs *
          SolanaLiqsolSurfaceSteps.PretokenHistoryEpochBudgetSlack
      )
    })

    it("scales with the cluster's epoch length", () => {
      // STYLE.md "Timing Budgets": a cluster with longer epochs waits longer.
      expect(
        SolanaLiqsolSurfaceSteps.pretokenHistoryEpochBudgetMs(epochInfo(0, 0))
      ).toBeLessThan(
        SolanaLiqsolSurfaceSteps.pretokenHistoryEpochBudgetMs(
          epochInfo(0, 0, 432_000)
        )
      )
    })

    it("budgets nothing once the epoch is already reached", () => {
      // The caller returns before polling; a zero deadline must never be handed
      // to `pollUntil`, which would expire instantly.
      expect(
        SolanaLiqsolSurfaceSteps.pretokenHistoryEpochBudgetMs(epochInfo(2, 0))
      ).toBe(0)
      expect(
        SolanaLiqsolSurfaceSteps.pretokenHistoryEpochBudgetMs(epochInfo(7, 50))
      ).toBe(0)
    })

    it("tolerates a validator slower than agave's target", () => {
      // The budget is the remaining slot time times this, so it IS the whole
      // tolerance — at 2, half-speed slots still make the deadline.
      expect(
        SolanaLiqsolSurfaceSteps.PretokenHistoryEpochBudgetSlack
      ).toBeGreaterThan(1)
    })

    it("waits a few slots for the history to become readable", () => {
      // The script confirms at `processed`; this connection reads at
      // `confirmed`, at least one slot behind.
      expect(
        SolanaLiqsolSurfaceSteps.PretokenHistoryVisibilitySlots
      ).toBeGreaterThan(1)
      expect(
        SolanaLiqsolSurfaceSteps.pretokenHistoryVisibilityBudgetMs()
      ).toBe(
        SolanaLiqsolSurfaceSteps.PretokenHistoryVisibilitySlots *
          SolanaLiqsolSurfaceSteps.SlotDurationMs
      )
      // …and polls several times per slot, so it returns as soon as it lands.
      expect(
        SolanaLiqsolSurfaceSteps.PretokenHistoryVisibilityPollMs
      ).toBeLessThan(SolanaLiqsolSurfaceSteps.SlotDurationMs)
    })

    it("reads the history under the name the camelCased coder uses", () => {
      expect(SolanaLiqsolSurfaceSteps.PretokenPurchaseHistoryAccountName).toBe(
        "pretokenPurchaseHistory"
      )
    })
  })

  describe("surface init Steps", () => {
    it("names one instruction per Step — one write each, never batched", () => {
      expect(
        Object.values(SolanaLiqsolSurfaceSteps.InitInstruction).sort()
      ).toEqual(
        ["initialize", "initializeStakeControllerState", "initializeVault"].sort()
      )
    })

    it("carries the instruction on the typed input and a named runner", () => {
      const cases = [
        {
          plan: SolanaLiqsolSurfaceSteps.planInitDistribution,
          runner: SolanaLiqsolSurfaceSteps.runInitDistribution,
          instruction: SolanaLiqsolSurfaceSteps.InitInstruction.Distribution
        },
        {
          plan: SolanaLiqsolSurfaceSteps.planInitStakeControllerState,
          runner: SolanaLiqsolSurfaceSteps.runInitStakeControllerState,
          instruction:
            SolanaLiqsolSurfaceSteps.InitInstruction.StakeControllerState
        },
        {
          plan: SolanaLiqsolSurfaceSteps.planInitVault,
          runner: SolanaLiqsolSurfaceSteps.runInitVault,
          instruction: SolanaLiqsolSurfaceSteps.InitInstruction.Vault
        }
      ]
      cases.forEach(({ plan, runner, instruction }) => {
        const step = plan(
          Report.Actor.SolanaOutpost,
          "init-something",
          "create it",
          {}
        )
        expect(step.input.kind).toBe(
          "SolanaLiqsolSurfaceSteps.InitAccountInput"
        )
        expect(step.input.instruction).toBe(instruction)
        expect(step.runner).toBe(runner)
      })
    })
  })

  describe("toolchain pins", () => {
    /** The `[toolchain]` table wire-solana's Anchor.toml carries. */
    const Manifest = [
      "[toolchain]",
      'anchor_version = "0.31.0"',
      'solana_version = "4.2.0"',
      'package_manager = "npm"',
      "",
      "[features]",
      "resolution = false"
    ].join("\n")

    it("reads each pinned version out of the manifest", () => {
      expect(
        SolanaLiqsolSurfaceSteps.toolchainPin(Manifest, "solana_version")
      ).toBe("4.2.0")
      expect(
        SolanaLiqsolSurfaceSteps.toolchainPin(Manifest, "anchor_version")
      ).toBe("0.31.0")
    })

    it("returns an empty string for a key the manifest does not pin", () => {
      expect(
        SolanaLiqsolSurfaceSteps.toolchainPin(Manifest, "rustc_version")
      ).toBe("")
    })

    it("names both binaries anchor-cli would reinstall", () => {
      expect(
        SolanaLiqsolSurfaceSteps.ToolchainPins.map(({ command }) => command)
      ).toEqual(["solana", "anchor"])
      expect(
        SolanaLiqsolSurfaceSteps.ToolchainPins.map(({ key }) => key)
      ).toEqual(["solana_version", "anchor_version"])
    })

    it("matches a version anywhere in a --version line, not the whole line", () => {
      // `solana --version` carries build metadata after the version; `anchor
      // --version` does not. Both have to satisfy the same check.
      expect(
        SolanaLiqsolSurfaceSteps.versionOutputMatches(
          "solana-cli 4.2.0 (src:ac82b5d4; feat:21b0d33a, client:Agave)\n",
          "4.2.0"
        )
      ).toBe(true)
      expect(
        SolanaLiqsolSurfaceSteps.versionOutputMatches(
          "anchor-cli 0.31.0\n",
          "0.31.0"
        )
      ).toBe(true)
    })

    it("rejects a near-miss version rather than substring-matching it", () => {
      expect(
        SolanaLiqsolSurfaceSteps.versionOutputMatches(
          "solana-cli 4.2.10 (src:ac82b5d4)",
          "4.2.1"
        )
      ).toBe(false)
      expect(
        SolanaLiqsolSurfaceSteps.versionOutputMatches("anchor-cli 0.30.1", "0.31.0")
      ).toBe(false)
    })
  })

  describe("planLiqsolSurface", () => {
    it("verifies the program ids, airdrops the deployer, then runs every init script", () => {
      const cluster = newBuild()
      SolanaLiqsolSurfaceSteps.planLiqsolSurface(
        cluster,
        "SolanaLiqsolSurface",
        "stand up the liqsol surface",
        {}
      )
      const scripts = ResetLocalClusterOrder.filter(
          script => !ExcludedFromInitScripts.includes(script)
        ),
        // Every script, with the harness Steps spliced in at the two scripts
        // they are keyed to.
        expected = scripts.flatMap(script =>
          script === SolanaLiqsolSurfaceSteps.WireConfigScript
            ? // init-distro's write, which init_wire_config reads
              ["init-distribution-state", script]
            : script === SolanaLiqsolSurfaceSteps.GlobalConfigScript
              ? // init-controller's two writes, at the position
                // reset-local-cluster.sh runs that script
                ["init-stake-controller-state", "init-stake-vault", script]
            : script === SolanaLiqsolSurfaceSteps.PretokenHistoryScript
              ? // the epoch gate the history's starting_epoch depends on, and
                // the read-back that proves it was not written as the sentinel
                ["await-pretoken-history-epoch", script, "verify-pretoken-history"]
              : [script]
        )
      expect(collectStepNames(cluster.children)).toEqual([
        "verify-toolchain",
        "verify-program-ids",
        "airdrop-deployer",
        ...expected,
        // the treasury top-up is a harness Step too
        "fund-treasury"
      ])
    })

    it("gates the pretoken history on the epoch, and reads it back after", () => {
      // The ordering IS the fix: before the script, because `starting_epoch =
      // current_epoch - 1` underflows in epoch 0 and stores the "uninitialized"
      // sentinel in epoch 1; after it, because a regression in the gate would
      // otherwise stay invisible until a pre-launch syndication fails.
      const cluster = newBuild()
      SolanaLiqsolSurfaceSteps.planLiqsolSurface(
        cluster,
        "SolanaLiqsolSurface",
        "stand up the liqsol surface",
        {}
      )
      const names = collectStepNames(cluster.children),
        at = (name: string) => names.indexOf(name)
      expect(at("await-pretoken-history-epoch")).toBe(
        at(SolanaLiqsolSurfaceSteps.PretokenHistoryScript) - 1
      )
      expect(at("verify-pretoken-history")).toBe(
        at(SolanaLiqsolSurfaceSteps.PretokenHistoryScript) + 1
      )
    })

    it("airdrops the DEPLOYER keypair to the documented floor", () => {
      const cluster = newBuild(),
        phase = SolanaLiqsolSurfaceSteps.planLiqsolSurface(
          cluster,
          "SolanaLiqsolSurface",
          "stand up the liqsol surface",
          {}
        ),
        airdrop = phase.steps.find(step => step.name === "airdrop-deployer")
      expect(airdrop.input).toEqual({
        kind: "SolanaFundingTool.KeypairAirdropInput",
        keypairName: SolanaFundingTool.DeployerKeypairName,
        floorLamports: SolanaLiqsolSurfaceSteps.DeployerFloorLamports
      })
    })

    it("tops the treasury up to a FLOOR, as a harness Step (not the non-idempotent script)", () => {
      const cluster = newBuild(),
        phase = SolanaLiqsolSurfaceSteps.planLiqsolSurface(
          cluster,
          "SolanaLiqsolSurface",
          "stand up the liqsol surface",
          {}
        ),
        treasury = phase.steps.find(step => step.name === "fund-treasury")
      expect(SolanaLiqsolSurfaceSteps.TreasuryFloorLamports).toBe(
        BigInt(LAMPORTS_PER_SOL)
      )
      expect(treasury.input).toEqual({
        kind: "SolanaLiqsolSurfaceSteps.FundTreasuryInput",
        floorLamports: SolanaLiqsolSurfaceSteps.TreasuryFloorLamports
      })
      expect(treasury.runner).toBe(SolanaLiqsolSurfaceSteps.runFundTreasury)
    })
  })

  describe("treasuryAddress", () => {
    it("derives the system-owned treasury PDA under liqsol_core", () => {
      const solanaPath = stageSolanaTree(true)
      try {
        const [expected] = PublicKey.findProgramAddressSync(
          [Buffer.from(SolanaLiqsolSurfaceSteps.TreasurySeed)],
          SolanaOutpostProgramTool.assertProgramId(
            solanaPath,
            SolanaOutpostProgramTool.AnchorProgram.liqsolCore
          )
        )
        expect(
          SolanaLiqsolSurfaceSteps.treasuryAddress(solanaPath).equals(expected)
        ).toBe(true)
        expect(SolanaLiqsolSurfaceSteps.TreasurySeed).toBe("treasury")
      } finally {
        Fs.rmSync(solanaPath, { recursive: true, force: true })
      }
    })
  })

  describe("assertProgramIdsMatch", () => {
    it("passes when every IDL declares the id its keypair carries", async () => {
      const solanaPath = stageSolanaTree(true)
      try {
        await expect(
          SolanaLiqsolSurfaceSteps.assertProgramIdsMatch({
            config: fixtureConfig({ solanaPath })
          } as Parameters<
            typeof SolanaLiqsolSurfaceSteps.assertProgramIdsMatch
          >[0])
        ).resolves.toBeUndefined()
      } finally {
        Fs.rmSync(solanaPath, { recursive: true, force: true })
      }
    })

    it("names the mismatching program and the remediation", async () => {
      const solanaPath = stageSolanaTree(false)
      try {
        await expect(
          SolanaLiqsolSurfaceSteps.assertProgramIdsMatch({
            config: fixtureConfig({ solanaPath })
          } as Parameters<
            typeof SolanaLiqsolSurfaceSteps.assertProgramIdsMatch
          >[0])
        ).rejects.toThrow(/prep-anchor-toml\.sh/)
      } finally {
        Fs.rmSync(solanaPath, { recursive: true, force: true })
      }
    })
  })
})
