import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { Keypair, PublicKey } from "@solana/web3.js"
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync
} from "@solana/spl-token"
import {
  SolanaFundingTool,
  SolanaLiqSyndicationTool,
  SolanaOutpostProgramTool,
  WireState,
  wireStateVariant
} from "@wireio/cluster-tool/tools/solana"
import { Report } from "@wireio/cluster-tool/report"

/** Durable handle of the user keypair the step inputs carry. */
const UserName = "liq-user"
/** Durable handle of the donor keypair the donation step input carries. */
const DonorName = SolanaFundingTool.DeployerKeypairName
/** A depot token slug code for the liq-token mapping step. */
const TokenCode = 1234n

/** Stage a wire-solana tree with a committed keypair per genesis program. */
function stageProgramKeys(solanaPath: string): Map<string, PublicKey> {
  const ids = new Map<string, PublicKey>()
  Fs.mkdirSync(
    Path.join(solanaPath, SolanaOutpostProgramTool.KeysSubdirectory),
    { recursive: true }
  )
  SolanaOutpostProgramTool.GenesisAnchorPrograms.forEach(program => {
    const keypair = Keypair.generate()
    Fs.writeFileSync(
      SolanaOutpostProgramTool.programKeypairFile(solanaPath, program),
      JSON.stringify([...keypair.secretKey])
    )
    ids.set(program, keypair.publicKey)
  })
  return ids
}

describe("SolanaLiqSyndicationTool", () => {
  let solanaPath: string
  let programIds: Map<string, PublicKey>

  beforeAll(() => {
    solanaPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "liq-syndication-"))
    programIds = stageProgramKeys(solanaPath)
  })
  afterAll(() => {
    Fs.rmSync(solanaPath, { recursive: true, force: true })
  })

  describe("PdaSeed", () => {
    it("carries the liqsol-core / liqsol-token / transfer-hook seed spellings", () => {
      expect(SolanaLiqSyndicationTool.PdaSeed.GlobalState).toBe(
        "outpost_global_state"
      )
      expect(SolanaLiqSyndicationTool.PdaSeed.PoolAuthority).toBe("liqsol_pool")
      expect(SolanaLiqSyndicationTool.PdaSeed.LiqsolMint).toBe("liqsol_mint")
      expect(SolanaLiqSyndicationTool.PdaSeed.LiqsolMintAuthority).toBe(
        "mint_authority"
      )
      expect(SolanaLiqSyndicationTool.PdaSeed.ExtraAccountMetaList).toBe(
        "extra-account-metas"
      )
    })
  })

  describe("deriveBasePdas", () => {
    it("derives the mint + hook accounts under their OWN programs", () => {
      const pdas = SolanaLiqSyndicationTool.deriveBasePdas(solanaPath),
        [expectedMint] = PublicKey.findProgramAddressSync(
          [Buffer.from(SolanaLiqSyndicationTool.PdaSeed.LiqsolMint)],
          programIds.get(SolanaOutpostProgramTool.AnchorProgram.liqsolToken)
        ),
        [expectedMetaList] = PublicKey.findProgramAddressSync(
          [
            Buffer.from(
              SolanaLiqSyndicationTool.PdaSeed.ExtraAccountMetaList
            ),
            expectedMint.toBuffer()
          ],
          programIds.get(SolanaOutpostProgramTool.AnchorProgram.transferHook)
        )
      expect(pdas.liqsolMint.equals(expectedMint)).toBe(true)
      expect(pdas.extraAccountMetaList.equals(expectedMetaList)).toBe(true)
      expect(
        pdas.liqsolCoreProgram.equals(
          programIds.get(SolanaOutpostProgramTool.AnchorProgram.liqsolCore)
        )
      ).toBe(true)
    })

    it("derives the pool + bucket token accounts as Token-2022 ATAs", () => {
      const pdas = SolanaLiqSyndicationTool.deriveBasePdas(solanaPath)
      expect(
        pdas.liqsolPoolAta.equals(
          getAssociatedTokenAddressSync(
            pdas.liqsolMint,
            pdas.poolAuthority,
            true,
            TOKEN_2022_PROGRAM_ID
          )
        )
      ).toBe(true)
      expect(
        pdas.bucketTokenAccount.equals(
          getAssociatedTokenAddressSync(
            pdas.liqsolMint,
            pdas.bucketAuthority,
            true,
            TOKEN_2022_PROGRAM_ID
          )
        )
      ).toBe(true)
    })

    it("is deterministic for a given wire-solana tree", () => {
      expect(
        SolanaLiqSyndicationTool.deriveBasePdas(solanaPath).globalState.toBase58()
      ).toBe(
        SolanaLiqSyndicationTool.deriveBasePdas(solanaPath).globalState.toBase58()
      )
    })

    it("throws with the build remediation when a program keypair is absent", () => {
      const emptyPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "liq-empty-"))
      try {
        expect(() =>
          SolanaLiqSyndicationTool.deriveBasePdas(emptyPath)
        ).toThrow(/program keypair missing/)
      } finally {
        Fs.rmSync(emptyPath, { recursive: true, force: true })
      }
    })
  })

  describe("deriveUserPdas", () => {
    it("adds the user's on-curve ATA and its distribution record", () => {
      const user = Keypair.generate().publicKey,
        pdas = SolanaLiqSyndicationTool.deriveUserPdas(solanaPath, user)
      expect(pdas.user.equals(user)).toBe(true)
      expect(
        pdas.userAta.equals(
          getAssociatedTokenAddressSync(
            pdas.liqsolMint,
            user,
            false,
            TOKEN_2022_PROGRAM_ID
          )
        )
      ).toBe(true)
      const [expectedRecord] = PublicKey.findProgramAddressSync(
        [
          Buffer.from(SolanaLiqSyndicationTool.PdaSeed.UserRecord),
          pdas.userAta.toBuffer()
        ],
        pdas.liqsolCoreProgram
      )
      expect(pdas.userUserRecord.equals(expectedRecord)).toBe(true)
    })

    it("gives different users different records but the same pool accounts", () => {
      const first = SolanaLiqSyndicationTool.deriveUserPdas(
          solanaPath,
          Keypair.generate().publicKey
        ),
        second = SolanaLiqSyndicationTool.deriveUserPdas(
          solanaPath,
          Keypair.generate().publicKey
        )
      expect(first.userUserRecord.equals(second.userUserRecord)).toBe(false)
      expect(first.liqsolPoolAta.equals(second.liqsolPoolAta)).toBe(true)
    })
  })

  describe("step factories", () => {
    it("planDepositForLiqsol carries the user + lamports and a named runner", () => {
      const step = SolanaLiqSyndicationTool.planDepositForLiqsol(
        Report.Actor.User,
        "deposit-for-liqsol",
        "deposit for liqSOL",
        {},
        UserName,
        5_000_000_000n
      )
      expect(step.input).toEqual({
        kind: "SolanaLiqSyndicationTool.DepositForLiqsolInput",
        userName: UserName,
        lamports: 5_000_000_000n,
        ephemeralStakeSeed: step.input.ephemeralStakeSeed
      })
      expect(step.runner).toBe(SolanaLiqSyndicationTool.runDepositForLiqsol)
    })

    it("carries the ephemeral-stake seed ON THE INPUT, distinct per plan, no randomness", () => {
      const seeds = [0, 1, 2].map(
        () =>
          SolanaLiqSyndicationTool.planDepositForLiqsol(
            Report.Actor.User,
            "deposit-for-liqsol",
            "deposit for liqSOL",
            {},
            UserName,
            1n
          ).input.ephemeralStakeSeed
      )
      seeds.forEach(seed => {
        expect(Number.isInteger(seed)).toBe(true)
        expect(seed).toBeGreaterThanOrEqual(0)
        // A `u32`, because the instruction's arg is one — `hash >>> 0` is what
        // bounds it, so this asserts the range rather than a named constant.
        expect(seed).toBeLessThan(2 ** 32)
      })
      expect(new Set(seeds).size).toBe(seeds.length)
      // An explicit seed is honoured verbatim, so a caller can pin the address.
      expect(
        SolanaLiqSyndicationTool.planDepositForLiqsol(
          Report.Actor.User,
          "deposit-for-liqsol",
          "deposit for liqSOL",
          {},
          UserName,
          1n,
          7
        ).input.ephemeralStakeSeed
      ).toBe(7)
    })

    it("planSetWireState carries the launch state", () => {
      const step = SolanaLiqSyndicationTool.planSetWireState(
        Report.Actor.SolanaOutpost,
        "set-wire-state-post-launch",
        "flip to PostLaunch",
        {},
        WireState.postLaunch
      )
      expect(step.input.wireState).toBe(WireState.postLaunch)
      expect(step.runner).toBe(SolanaLiqSyndicationTool.runSetWireState)
    })

    it("planSetLiqTokenAddress carries the depot token code", () => {
      const step = SolanaLiqSyndicationTool.planSetLiqTokenAddress(
        Report.Actor.SolanaOutpost,
        "map-liq-token",
        "bind the liqSOL mint",
        {},
        TokenCode
      )
      expect(step.input.tokenCode).toBe(TokenCode)
      expect(step.runner).toBe(SolanaLiqSyndicationTool.runSetLiqTokenAddress)
    })

    it("planSynd / planInjectBonusSyndYield / planReportLiqYield carry their actors", () => {
      expect(
        SolanaLiqSyndicationTool.planSynd(
          Report.Actor.User,
          "syndicate-liqsol",
          "syndicate",
          {},
          UserName,
          1n
        ).input.userName
      ).toBe(UserName)
      expect(
        SolanaLiqSyndicationTool.planInjectBonusSyndYield(
          Report.Actor.SolanaOutpost,
          "inject-bonus-synd-yield",
          "donate",
          {},
          DonorName,
          SolanaLiqSyndicationTool.BonusYieldLamportGranularity
        ).input.donorName
      ).toBe(DonorName)
      expect(
        SolanaLiqSyndicationTool.planReportLiqYield(
          Report.Actor.User,
          "report-liq-yield",
          "crank",
          {},
          UserName
        ).input.crankerName
      ).toBe(UserName)
    })
  })

  describe("epoch-rewards gate", () => {
    /**
     * A context whose only live part is `getAccountInfo` — `isEpochRewardsActive`
     * reads exactly one account and nothing else.
     */
    function contextReturning(data: Buffer) {
      return {
        solana: {
          connection: {
            getAccountInfo: async () => (data == null ? null : { data })
          }
        }
      } as unknown as Parameters<
        typeof SolanaLiqSyndicationTool.isEpochRewardsActive
      >[0]
    }

    /**
     * The three shapes the epoch-rewards refusal reaches this process as — the
     * preflight refusal (logs + message), the raw custom-error code, and the
     * on-chain failure `confirmSignature` renders.
     */
    const RefusalShapes = {
      byName: () =>
        Object.assign(new Error("Simulation failed."), {
          logs: [
            'Program log: ERROR in deposit_to_reserve: AnchorError { error_name: "EpochRewardsActive", error_code_number: 7621 }'
          ]
        }),
      byHex: () =>
        new Error(
          "Transaction simulation failed: Error processing Instruction 1: custom program error: 0x1dc5"
        ),
      onChain: () =>
        new Error(
          'a deposit tx failed: {"InstructionError":[1,{"Custom":7621}]}'
        )
    }

    /** A full `EpochRewards` sysvar buffer whose `active` byte is `flag`. */
    function sysvarData(flag: number): Buffer {
      const data = Buffer.alloc(
        SolanaLiqSyndicationTool.EpochRewardsActiveOffset + 1
      )
      data[SolanaLiqSyndicationTool.EpochRewardsActiveOffset] = flag
      return data
    }

    it("names the runtime's EpochRewards sysvar and its active-flag offset", () => {
      expect(SolanaLiqSyndicationTool.EpochRewardsSysvar.toBase58()).toBe(
        "SysvarEpochRewards1111111111111111111111111"
      )
      // distribution_starting_block_height + num_partitions + parent_blockhash
      // + total_points + total_rewards + distributed_rewards.
      expect(SolanaLiqSyndicationTool.EpochRewardsActiveOffset).toBe(80)
    })

    it("reads the active flag out of the sysvar", async () => {
      await expect(
        SolanaLiqSyndicationTool.isEpochRewardsActive(
          contextReturning(sysvarData(1))
        )
      ).resolves.toBe(true)
      await expect(
        SolanaLiqSyndicationTool.isEpochRewardsActive(
          contextReturning(sysvarData(0))
        )
      ).resolves.toBe(false)
    })

    it("treats an absent or truncated sysvar as idle", async () => {
      await expect(
        SolanaLiqSyndicationTool.isEpochRewardsActive(contextReturning(null))
      ).resolves.toBe(false)
      await expect(
        SolanaLiqSyndicationTool.isEpochRewardsActive(
          contextReturning(Buffer.alloc(8))
        )
      ).resolves.toBe(false)
    })

    it("recognises the refusal in every shape it reaches this process", () => {
      Object.values(RefusalShapes).forEach(error =>
        expect(SolanaLiqSyndicationTool.isEpochRewardsActiveError(error())).toBe(
          true
        )
      )
    })

    it("recognises the ON-CHAIN shape, which carries neither name nor hex", () => {
      // The one that matters most: a tx that PASSED preflight and executed
      // inside the window fails through `confirmSignature`, whose message is
      // the JSON of the transaction error. Matching only the preflight
      // spellings left ~1 % of deposits unretried.
      const onChain = RefusalShapes.onChain()
      expect(onChain.message).not.toContain(
        SolanaLiqSyndicationTool.EpochRewardsActiveErrorName
      )
      expect(onChain.message).not.toContain("0x1dc5")
      expect(
        SolanaLiqSyndicationTool.isEpochRewardsActiveError(onChain)
      ).toBe(true)
    })

    it("does NOT treat an unrelated failure as the epoch-rewards refusal", () => {
      // The retry must not swallow a real failure: anything else rethrows.
      expect(
        SolanaLiqSyndicationTool.isEpochRewardsActiveError(
          new Error("custom program error: 0x1795")
        )
      ).toBe(false)
      expect(
        SolanaLiqSyndicationTool.isEpochRewardsActiveError(
          new Error("Blockhash not found")
        )
      ).toBe(false)
    })

    it("derives every needle from the one error code", () => {
      // 7621 = `#[error_code(offset = 7600)]` + the variant's index. The IDL on
      // disk says 6021 until wire-solana patches it, so the constant is the
      // source of truth here, and the two rendered forms derive from it.
      expect(SolanaLiqSyndicationTool.EpochRewardsActiveErrorCode).toBe(7621)
      expect(SolanaLiqSyndicationTool.epochRewardsActiveErrorNeedles()).toEqual([
        "EpochRewardsActive",
        "0x1dc5",
        '"Custom":7621'
      ])
    })

    it("waits the window out and re-sends EXACTLY once", async () => {
      await Promise.all(
        Object.entries(RefusalShapes).map(async ([shape, refusal]) => {
          let sends = 0
          const send = async () => {
            sends += 1
            if (sends === 1) throw refusal()
          }
          await expect(
            SolanaLiqSyndicationTool.submitWithEpochRewardsRetry(
              contextReturning(sysvarData(0)),
              `a deposit refused ${shape}`,
              send
            )
          ).resolves.toBeUndefined()
          expect(sends).toBe(2)
        })
      )
    })

    it("propagates a SECOND refusal instead of sending a third time", async () => {
      // One retry, not a loop: if the window is somehow still open the step
      // goes red rather than hammering the validator.
      let sends = 0
      const send = async () => {
        sends += 1
        throw RefusalShapes.onChain()
      }
      await expect(
        SolanaLiqSyndicationTool.submitWithEpochRewardsRetry(
          contextReturning(sysvarData(0)),
          "a deposit",
          send
        )
      ).rejects.toThrow(/Custom/)
      expect(sends).toBe(2)
    })

    it("rethrows an unrelated failure without re-sending at all", async () => {
      // The retry must never mask a real failure — and must never re-send a
      // transaction whose outcome it does not understand.
      let sends = 0
      const send = async () => {
        sends += 1
        throw new Error("Blockhash not found")
      }
      await expect(
        SolanaLiqSyndicationTool.submitWithEpochRewardsRetry(
          contextReturning(sysvarData(0)),
          "a deposit",
          send
        )
      ).rejects.toThrow(/Blockhash not found/)
      expect(sends).toBe(1)
    })

    it("sends once when the first attempt succeeds", async () => {
      let sends = 0
      const send = async () => {
        sends += 1
      }
      await expect(
        SolanaLiqSyndicationTool.submitWithEpochRewardsRetry(
          contextReturning(sysvarData(0)),
          "a deposit",
          send
        )
      ).resolves.toBeUndefined()
      expect(sends).toBe(1)
    })

    it("waitForEpochRewardsIdle returns as soon as the window closes", async () => {
      await expect(
        SolanaLiqSyndicationTool.waitForEpochRewardsIdle(
          contextReturning(sysvarData(0)),
          "a deposit"
        )
      ).resolves.toBeUndefined()
    })
  })

  describe("runner input guards", () => {
    /** A context stub: every guard below throws before touching `ctx`. */
    const context = {} as Parameters<
      typeof SolanaLiqSyndicationTool.runSynd
    >[0]
    const signal = new AbortController().signal

    it("runDepositForLiqsol rejects a non-positive deposit", async () => {
      await expect(
        SolanaLiqSyndicationTool.runDepositForLiqsol(
          context,
          {
            kind: "SolanaLiqSyndicationTool.DepositForLiqsolInput",
            userName: UserName,
            lamports: 0n,
            ephemeralStakeSeed: 1
          },
          signal
        )
      ).rejects.toThrow(/lamports must be positive/)
    })

    it("runSynd rejects a non-positive amount", async () => {
      await expect(
        SolanaLiqSyndicationTool.runSynd(
          context,
          {
            kind: "SolanaLiqSyndicationTool.SyndInput",
            userName: UserName,
            amount: 0n
          },
          signal
        )
      ).rejects.toThrow(/amount must be positive/)
    })

    it("runInjectBonusSyndYield rejects an off-granularity donation", async () => {
      await expect(
        SolanaLiqSyndicationTool.runInjectBonusSyndYield(
          context,
          {
            kind: "SolanaLiqSyndicationTool.InjectBonusSyndYieldInput",
            donorName: DonorName,
            lamports:
              SolanaLiqSyndicationTool.BonusYieldLamportGranularity + 1n
          },
          signal
        )
      ).rejects.toThrow(/multiple of/)
    })
  })

  describe("readLiqYieldState", () => {
    it("names the GlobalState account the way Anchor's camelCased coder keys it", () => {
      // `new anchor.Program(...)` converts the IDL to camelCase before building
      // its coder, so the IDL's own `GlobalState` is NOT the coder's key —
      // passing it throws `Account not found: GlobalState` at run time.
      expect(SolanaLiqSyndicationTool.GlobalStateAccountName).toBe("globalState")
    })
  })

  describe("wireStateVariant", () => {
    it("maps each launch state to its Anchor variant tag", () => {
      expect(wireStateVariant(WireState.launching)).toEqual({ launching: {} })
      expect(wireStateVariant(WireState.postLaunch)).toEqual({
        postLaunch: {}
      })
      expect(wireStateVariant(WireState.preLaunch)).toEqual({ preLaunch: {} })
      expect(wireStateVariant(WireState.refund)).toEqual({ refund: {} })
    })
  })
})
