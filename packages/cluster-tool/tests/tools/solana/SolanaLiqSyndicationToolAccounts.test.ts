import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import * as anchor from "@coral-xyz/anchor"
import { ACCOUNT_SIZE, AccountLayout, AccountState, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token"
import { Connection, Keypair, PublicKey } from "@solana/web3.js"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import {
  AnchorEnumVariant,
  PendingPayoutReason,
  SolanaLiqSyndicationTool,
  SolanaOutpostProgramTool,
  WireState,
  pendingPayoutAddress,
  wireStateVariant
} from "@wireio/cluster-tool/tools/solana"
import { toURL } from "@wireio/cluster-tool/utils"


/**
 * The nine `liqsol_core` instructions `SolanaLiqSyndicationTool` drives, built
 * from the REAL IDL and the runners' OWN account maps.
 *
 * wire-solana's `Anchor.toml` sets `resolution = false`, so Anchor resolves
 * NOTHING: every account is whatever the map supplies, in the IDL's order. A
 * renamed key therefore throws only at run time deep inside a flow, and
 * non-strict `.accounts()` silently IGNORES an extra key — neither is visible
 * to a test that only checks seeds and step inputs. These cases close that gap
 * by asserting the instruction Anchor actually produces: the same pubkeys the
 * map carries, in the IDL's order, with the IDL's writable/signer flags.
 *
 * The same fixture also carries the `GlobalState`, `GlobalConfig` and
 * `PendingPayout` accounts, because the tool READS them (the pre-flip state,
 * the liq-yield watermark, the freeze flag, the panic account and maximum, the
 * stored payouts) and each read is keyed by a name whose CASE depends on how
 * the coder was built.
 *
 * The fixture is a TRIMMED copy of `wire-solana/target/idl/liqsol_core.json`
 * (feature/syndication-underwriting 866b9e03) — these nine instructions, the
 * three accounts and the types they reference — because that file is a build
 * artifact of a sibling repo and is not resolvable from here. Regenerate it
 * from a current wire-solana build when an account list or a read layout
 * changes.
 */
/** The trimmed `liqsol_core` IDL committed alongside these cases. */
const FixtureIdlFilename = "liqsolCoreInstructions.idl.json"

describe("SolanaLiqSyndicationTool instruction account maps", () => {
  /**
   * The trimmed fixture, READ at run time rather than `import`ed: the jest
   * project's `include` covers `tests/**\/*.ts`, and pulling a `.json` into the
   * program would mean widening the build's file list for a test fixture.
   */
  const FixtureIdl = JSON.parse(
    Fs.readFileSync(
      Path.join(__dirname, "..", "..", "fixtures", FixtureIdlFilename),
      "utf8"
    )
  ) as anchor.Idl

  /** The IDL account names, in order, with their declared metadata. */
  interface IdlAccount {
    name: string
    writable?: boolean
    signer?: boolean
    optional?: boolean
  }

  /** One instruction's entry in the trimmed fixture. */
  interface IdlInstruction {
    name: string
    accounts: IdlAccount[]
  }

  /**
   * `GlobalState` as the camelCased coder decodes it. Only the four fields
   * `SolanaLiqSyndicationTool` reads are named; the rest ride the encode side.
   */
  interface GlobalStateFixture {
    yieldAccumulatedLiqsol: anchor.BN
    liqYieldReported: anchor.BN
    liqSequence: anchor.BN
    wireState: AnchorEnumVariant
    frozen: boolean
  }

  /** Every `GlobalState` field, camelCased, as `accounts.encode` requires. */
  function globalState(): Record<string, unknown> {
    return {
      layoutVersion: new anchor.BN(1),
      yieldIndexRemainder: new anchor.BN(0),
      paused: false,
      totalStakedLiqsol: new anchor.BN(5_000_000_000),
      totalPurchasedLiqsol: new anchor.BN(0),
      totalShares: new anchor.BN(5_000_000_000),
      protocolShares: new anchor.BN(0),
      currentIndex: new anchor.BN(0),
      expectedPoolBalance: new anchor.BN(5_000_000_000),
      yieldAccumulatedLiqsol: new anchor.BN(900),
      rolePrincipals: [
        new anchor.BN(0),
        new anchor.BN(0),
        new anchor.BN(0),
        new anchor.BN(0)
      ],
      roleWarmupDuration: new anchor.BN(0),
      wireState: wireStateVariant(WireState.preLaunch),
      bump: 255,
      liqSequence: new anchor.BN(7),
      liqYieldReported: new anchor.BN(400),
      frozen: true
    }
  }

  /** A fixed-length array field type, as the fixture spells it. */
  interface IdlArrayType {
    array: [IdlFieldType, number]
  }

  /** One IDL field type, as the fixture spells it. */
  type IdlFieldType = string | IdlArrayType

  /** One named struct field in the fixture. */
  interface IdlField {
    name: string
    type: IdlFieldType
  }

  /** A struct type's body in the fixture. */
  interface IdlStructBody {
    fields: IdlField[]
  }

  /** A struct type in the fixture. */
  interface IdlStructType {
    name: string
    type: IdlStructBody
  }

  /** The zero value the coder accepts for a primitive or array field. */
  function zeroOf(type: IdlFieldType): unknown {
    if (typeof type !== "string") {
      const [inner, length] = type.array
      return Array.from({ length }, () => zeroOf(inner))
    }
    if (type === "pubkey") return PublicKey.default
    if (type === "bool") return false
    return ["u8", "u16", "u32"].includes(type) ? 0 : new anchor.BN(0)
  }

  /**
   * Every field of the fixture's struct `typeName`, camelCased and zeroed,
   * with `overrides` laid over it — `accounts.encode` requires every field,
   * and `GlobalConfig` carries two dozen the tool never reads.
   */
  function zeroedAccount(
    typeName: string,
    overrides: Record<string, unknown>
  ): Record<string, unknown> {
    const declared = (FixtureIdl.types as unknown as IdlStructType[]).find(
      entry => entry.name === typeName
    )
    return {
      ...Object.fromEntries(
        declared.type.fields.map(({ name, type }) => [
          name.replace(/_([a-z0-9])/g, (_, letter) => letter.toUpperCase()),
          zeroOf(type)
        ])
      ),
      ...overrides
    }
  }

  let solanaPath: string
  let program: anchor.Program<anchor.Idl>
  let basePdas: SolanaLiqSyndicationTool.BasePdas
  let userPdas: SolanaLiqSyndicationTool.UserPdas

  const signer = Keypair.generate().publicKey,
    ephemeralStake = Keypair.generate().publicKey

  let connection: Connection

  /** Write `idl` into the staged tree, carrying the staged program id. */
  function writeIdl(idl: anchor.Idl): void {
    Fs.writeFileSync(
      SolanaOutpostProgramTool.programIdlFile(solanaPath),
      JSON.stringify({
        ...idl,
        address: basePdas.liqsolCoreProgram.toBase58()
      })
    )
  }

  /** The two context members `assertAccountMapsMatchIdl` reads. */
  function surfaceContext(): Parameters<
    typeof SolanaLiqSyndicationTool.assertAccountMapsMatchIdl
  >[0] {
    return {
      solana: { connection },
      config: { solanaPath }
    } as unknown as Parameters<
      typeof SolanaLiqSyndicationTool.assertAccountMapsMatchIdl
    >[0]
  }

  beforeAll(async () => {
    // A staged wire-solana tree: the PDA helpers resolve the three program ids
    // from `.keys`, and the fixture IDL stands in for `target/idl`.
    solanaPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "liq-accounts-"))
    Fs.mkdirSync(
      Path.join(solanaPath, SolanaOutpostProgramTool.KeysSubdirectory),
      { recursive: true }
    )
    SolanaOutpostProgramTool.GenesisAnchorPrograms.forEach(name =>
      Fs.writeFileSync(
        SolanaOutpostProgramTool.programKeypairFile(solanaPath, name),
        JSON.stringify([...Keypair.generate().secretKey])
      )
    )
    basePdas = SolanaLiqSyndicationTool.deriveBasePdas(solanaPath)
    userPdas = SolanaLiqSyndicationTool.deriveUserPdas(solanaPath, signer)
    Fs.mkdirSync(
      Path.join(solanaPath, SolanaOutpostProgramTool.IdlSubdirectory),
      { recursive: true }
    )
    writeIdl(FixtureIdl)

    // `.instruction()` never dials, but the URL still comes from the registry.
    const rpcUrl = toURL(
      await BindConfigProvider.findAvailable(
        BindConfigProvider.DefaultSolanaRpc
      )
    )
    connection = new Connection(rpcUrl)
    program = new anchor.Program(
      { ...FixtureIdl, address: basePdas.liqsolCoreProgram.toBase58() },
      new anchor.AnchorProvider(
        connection,
        new anchor.Wallet(Keypair.generate()),
        {}
      )
    )
  })

  afterAll(() => {
    Fs.rmSync(solanaPath, { recursive: true, force: true })
  })

  /** The fixture's declaration of `name`, by its snake_case IDL spelling. */
  function idlInstruction(name: string): IdlInstruction {
    const found = (
      FixtureIdl.instructions as unknown as IdlInstruction[]
    ).find(entry => entry.name === name)
    expect(found).toBeDefined()
    return found
  }

  /** The IDL's snake_case account name as Anchor's camelCased map key. */
  function mapKey(idlName: string): string {
    return idlName.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
  }

  /**
   * Assert the built instruction's keys are EXACTLY the IDL's accounts, in
   * order, carrying the pubkey the runner's map supplied and the IDL's
   * writable/signer flags.
   *
   * An `Option` account passed `null` (Anchor's `None`) resolves to the program
   * id itself, never writable, never a signer — that is what "the account is
   * absent" looks like on the wire.
   */
  function expectAccountsMatchIdl(
    instruction: anchor.web3.TransactionInstruction,
    idlName: string,
    accounts: SolanaLiqSyndicationTool.InstructionAccounts
  ): void {
    const declared = idlInstruction(idlName).accounts
    expect(instruction.keys).toHaveLength(declared.length)
    expect(instruction.programId.equals(basePdas.liqsolCoreProgram)).toBe(true)
    declared.forEach((account, index) => {
      const key = instruction.keys[index],
        supplied = accounts[mapKey(account.name)]
      // Every IDL account must be named by the runner's map — `undefined` here
      // is the renamed/missing key this whole suite exists to catch.
      expect(Object.keys(accounts)).toContain(mapKey(account.name))
      if (supplied == null) {
        expect(key.pubkey.equals(basePdas.liqsolCoreProgram)).toBe(true)
        expect(key.isSigner).toBe(false)
        expect(key.isWritable).toBe(false)
        return
      }
      expect(key.pubkey.toBase58()).toBe(supplied.toBase58())
      expect(key.isSigner).toBe(account.signer === true)
      expect(key.isWritable).toBe(account.writable === true)
    })
    // …and no EXTRA key, which non-strict `.accounts()` would silently drop.
    expect(Object.keys(accounts).sort()).toEqual(
      declared.map(account => mapKey(account.name)).sort()
    )
  }

  it("sol_to_liqsol resolves every account from depositForLiqsolAccounts", async () => {
    const accounts = SolanaLiqSyndicationTool.depositForLiqsolAccounts(
        userPdas,
        ephemeralStake
      ),
      instruction = await program.methods
        .solToLiqsol(new anchor.BN(1), 7)
        .accounts(accounts)
        .instruction()
    expectAccountsMatchIdl(instruction, "sol_to_liqsol", accounts)
  })

  it("set_wire_state resolves every account from setWireStateAccounts", async () => {
    const accounts = SolanaLiqSyndicationTool.setWireStateAccounts(
        basePdas,
        signer
      ),
      instruction = await program.methods
        .setWireState(wireStateVariant(WireState.postLaunch))
        .accounts(accounts)
        .instruction()
    expectAccountsMatchIdl(instruction, "set_wire_state", accounts)
  })

  it("set_token_address resolves every account from setLiqTokenAddressAccounts", async () => {
    const accounts = SolanaLiqSyndicationTool.setLiqTokenAddressAccounts(
        basePdas,
        signer
      ),
      instruction = await program.methods
        .setTokenAddress(new anchor.BN(1), basePdas.liqsolMint)
        .accountsStrict(accounts)
        .instruction()
    expectAccountsMatchIdl(instruction, "set_token_address", accounts)
  })

  it("synd resolves every account from syndAccounts, with both Options as None", async () => {
    const accounts = SolanaLiqSyndicationTool.syndAccounts(userPdas),
      instruction = await program.methods
        .synd(new anchor.BN(1))
        .accountsStrict(accounts)
        .instruction()
    expectAccountsMatchIdl(instruction, "synd", accounts)
    expect(accounts.outpostAccount).toBeNull()
    expect(accounts.pretokenPurchaseHistory).toBeNull()
  })

  it("synd passes the global_config its per-transfer maximum lives on", () => {
    // `StakeLiqsolContext.global_config`: absent, the strict builder throws and
    // the non-strict one would have dropped nothing and reverted on chain.
    expect(
      SolanaLiqSyndicationTool.syndAccounts(userPdas).globalConfig.toBase58()
    ).toBe(basePdas.globalConfig.toBase58())
  })

  it("synd's strict builder refuses a map without globalConfig", async () => {
    const accounts = SolanaLiqSyndicationTool.syndAccounts(userPdas)
    delete accounts.globalConfig
    await expect(
      program.methods.synd(new anchor.BN(1)).accountsStrict(accounts).instruction()
    ).rejects.toThrow()
  })

  it("set_panic resolves every account from setPanicAccounts", async () => {
    const panic = Keypair.generate().publicKey,
      accounts = SolanaLiqSyndicationTool.setPanicAccounts(
        basePdas,
        signer,
        panic
      ),
      instruction = await program.methods
        .setPanic()
        .accountsStrict(accounts)
        .instruction()
    expectAccountsMatchIdl(instruction, "set_panic", accounts)
    expect(accounts.newAuthority.toBase58()).toBe(panic.toBase58())
  })

  it("set_frozen resolves every account from setFrozenAccounts", async () => {
    const accounts = SolanaLiqSyndicationTool.setFrozenAccounts(
        basePdas,
        signer
      ),
      instruction = await program.methods
        .setFrozen(true)
        .accountsStrict(accounts)
        .instruction()
    expectAccountsMatchIdl(instruction, "set_frozen", accounts)
  })

  it("pay_pending_desyndication resolves its named accounts, then the payment manifest", async () => {
    const requestId = 7n,
      rentPayer = Keypair.generate().publicKey,
      pendingPayout = pendingPayoutAddress(basePdas.liqsolCoreProgram, requestId),
      accounts = SolanaLiqSyndicationTool.payPendingDesyndicationAccounts(
        basePdas,
        signer,
        pendingPayout,
        rentPayer
      ),
      manifest = SolanaLiqSyndicationTool.payPendingDesyndicationManifest(userPdas),
      instruction = await program.methods
        .payPendingDesyndication(new anchor.BN(requestId.toString()))
        .accountsStrict(accounts)
        .remainingAccounts(manifest)
        .instruction(),
      declared = idlInstruction("pay_pending_desyndication").accounts.length
    // The IDL's six named accounts first, exactly as the map supplies them…
    expectAccountsMatchIdl(
      { ...instruction, keys: instruction.keys.slice(0, declared) } as anchor.web3.TransactionInstruction,
      "pay_pending_desyndication",
      accounts
    )
    // …then the manifest verbatim, in order.
    expect(instruction.keys.slice(declared)).toEqual(manifest)
  })

  it("the payment manifest is the playbook's fourteen accounts, none signing", () => {
    const manifest = SolanaLiqSyndicationTool.payPendingDesyndicationManifest(userPdas)
    expect(manifest.map(({ pubkey }) => pubkey.toBase58())).toEqual(
      [
        userPdas.globalState,
        userPdas.distributionState,
        userPdas.poolAuthority,
        userPdas.liqsolPoolAta,
        userPdas.userAta,
        userPdas.liqsolPoolUserRecord,
        userPdas.userUserRecord,
        userPdas.bucketAuthority,
        userPdas.bucketTokenAccount,
        userPdas.liqsolMint,
        TOKEN_2022_PROGRAM_ID,
        userPdas.extraAccountMetaList,
        userPdas.transferHookProgram,
        userPdas.liqsolCoreProgram
      ].map(key => key.toBase58())
    )
    expect(manifest.map(({ isWritable }) => isWritable)).toEqual([
      true, true, false, true, true, true, true, false, true, false, false, false, false, false
    ])
    expect(manifest.every(({ isSigner }) => !isSigner)).toBe(true)
  })

  it("inject_bonus_synd_yield resolves every account from injectBonusSyndYieldAccounts", async () => {
    const accounts = SolanaLiqSyndicationTool.injectBonusSyndYieldAccounts(
        basePdas,
        signer
      ),
      instruction = await program.methods
        .injectBonusSyndYield(new anchor.BN(100_000_000))
        .accounts(accounts)
        .instruction()
    expectAccountsMatchIdl(instruction, "inject_bonus_synd_yield", accounts)
  })

  it("report_liq_yield resolves every account from reportLiqYieldAccounts", async () => {
    const accounts = SolanaLiqSyndicationTool.reportLiqYieldAccounts(
        basePdas,
        signer
      ),
      instruction = await program.methods
        .reportLiqYield()
        .accountsStrict(accounts)
        .instruction()
    expectAccountsMatchIdl(instruction, "report_liq_yield", accounts)
  })

  it("rejects a map whose key was renamed (the failure mode with resolution = false)", async () => {
    const accounts = SolanaLiqSyndicationTool.reportLiqYieldAccounts(
      basePdas,
      signer
    )
    delete accounts.cranker
    await expect(
      program.methods
        .reportLiqYield()
        .accountsStrict({ ...accounts, crankerSigner: signer })
        .instruction()
    ).rejects.toThrow()
  })

  it("decodes GlobalState under the name the tool's coder is keyed by", async () => {
    // The camelCase/PascalCase split is the whole hazard here. `anchor.Program`
    // converts the IDL to camelCase before building its coder, so the account
    // table is keyed `globalState`; a bare `anchor.BorshCoder` over the raw IDL
    // is keyed `GlobalState` and decodes `snake_case` fields. Anchor exports no
    // converter, so the two are not interchangeable — and the wrong one costs a
    // four-minute cluster to discover, as `Account not found: <name>`.
    const encoded = program.coder.accounts.encode(
      SolanaLiqSyndicationTool.GlobalStateAccountName,
      globalState()
    )
    const decoded = program.coder.accounts.decode<GlobalStateFixture>(
      SolanaLiqSyndicationTool.GlobalStateAccountName,
      await encoded
    )
    // The four fields `readLiqYieldState` / `readWireState` consume, by the
    // exact spellings those readers use.
    expect(decoded.yieldAccumulatedLiqsol.toString()).toBe("900")
    expect(decoded.liqYieldReported.toString()).toBe("400")
    expect(decoded.liqSequence.toString()).toBe("7")
    expect(decoded.frozen).toBe(true)
    // …and the enum decodes to the SAME single-key tag `wireStateVariant`
    // encodes, so `readWireState`'s `variant in WireState` holds.
    expect(Object.keys(decoded.wireState)).toEqual([WireState.preLaunch])
  })

  it("assertAccountMapsMatchIdl accepts the maps against the IDL on disk", () => {
    // The bootstrap check, run here against the committed fixture: the same
    // comparison `verify-instruction-accounts` makes against the DEPLOYED IDL.
    expect(() =>
      SolanaLiqSyndicationTool.assertAccountMapsMatchIdl(surfaceContext())
    ).not.toThrow()
  })

  it("assertAccountMapsMatchIdl names the instruction and the drifted key", () => {
    // A renamed IDL account is invisible with `resolution = false`, so the
    // check has to say WHICH instruction and WHICH key — that is the whole
    // value over "the flow reverted".
    const drifted = JSON.parse(JSON.stringify(FixtureIdl))
    drifted.instructions.find(
      (entry: IdlInstruction) => entry.name === "report_liq_yield"
    ).accounts[0].name = "cranker_signer"
    writeIdl(drifted)
    try {
      expect(() =>
        SolanaLiqSyndicationTool.assertAccountMapsMatchIdl(surfaceContext())
      ).toThrow(/reportLiqYield.*crankerSigner/s)
    } finally {
      writeIdl(FixtureIdl)
    }
  })

  it("enumerates every instruction the tool drives", () => {
    expect(
      SolanaLiqSyndicationTool.instructionAccountMaps(solanaPath).map(
        ({ instruction }) => instruction
      )
    ).toEqual([
      "solToLiqsol",
      "setWireState",
      "setTokenAddress",
      "synd",
      "injectBonusSyndYield",
      "reportLiqYield",
      "setPanic",
      "setFrozen",
      "payPendingDesyndication"
    ])
  })

  describe("reads", () => {
    /** A context whose connection answers `getAccountInfo` / `getProgramAccounts` from `accounts`. */
    function readContext(
      accounts: Map<string, Buffer>,
      owner: PublicKey = basePdas.liqsolCoreProgram
    ): Parameters<typeof SolanaLiqSyndicationTool.readGlobalConfig>[0] {
      return {
        solana: {
          connection: {
            getAccountInfo: async (address: PublicKey) =>
              accounts.has(address.toBase58())
                ? { data: accounts.get(address.toBase58()), owner, lamports: 1, executable: false }
                : null,
            getProgramAccounts: async () =>
              [...accounts.entries()].map(([address, data]) => ({
                pubkey: new PublicKey(address),
                account: { data, owner, lamports: 1, executable: false }
              }))
          }
        },
        config: { solanaPath }
      } as unknown as Parameters<typeof SolanaLiqSyndicationTool.readGlobalConfig>[0]
    }

    it("readGlobalConfig decodes the panic account and the maximum", async () => {
      const panic = Keypair.generate().publicKey,
        admin = Keypair.generate().publicKey,
        data = await program.coder.accounts.encode(
          SolanaLiqSyndicationTool.GlobalConfigAccountName,
          zeroedAccount("GlobalConfig", {
            admin,
            panic,
            maxSyndicationPerTransfer: new anchor.BN("250000000000")
          })
        )
      const config = await SolanaLiqSyndicationTool.readGlobalConfig(
        readContext(new Map([[basePdas.globalConfig.toBase58(), data]]))
      )
      expect(config.panic.toBase58()).toBe(panic.toBase58())
      expect(config.admin.toBase58()).toBe(admin.toBase58())
      expect(config.maxSyndicationPerTransfer).toBe(250_000_000_000n)
    })

    it("readGlobalConfig refuses an uninitialized global_config", async () => {
      await expect(
        SolanaLiqSyndicationTool.readGlobalConfig(readContext(new Map()))
      ).rejects.toThrow(/globalConfig .* does not exist/)
    })

    it("readGlobalStateFrozen decodes GlobalState.frozen", async () => {
      const data = await program.coder.accounts.encode(
        SolanaLiqSyndicationTool.GlobalStateAccountName,
        globalState()
      )
      await expect(
        SolanaLiqSyndicationTool.readGlobalStateFrozen(
          readContext(new Map([[basePdas.globalState.toBase58(), data]]))
        )
      ).resolves.toBe(true)
      await expect(
        SolanaLiqSyndicationTool.readGlobalStateFrozen(readContext(new Map()))
      ).rejects.toThrow(/globalState .* does not exist/)
    })

    /** Encode a `PendingPayout` for `requestId` with `reason`. */
    async function pendingPayout(
      requestId: bigint,
      reason: Record<string, Record<string, anchor.BN>>
    ): Promise<Buffer> {
      return program.coder.accounts.encode(
        SolanaLiqSyndicationTool.PendingPayoutAccountName,
        {
          requestId: new anchor.BN(requestId.toString()),
          user: signer,
          tokenCode: new anchor.BN(42),
          amount: new anchor.BN(1_000),
          rentPayer: signer,
          reason,
          bump: 254
        }
      )
    }

    it("readPendingPayout decodes one stored payout, with a shortfall's evidence", async () => {
      const address = pendingPayoutAddress(basePdas.liqsolCoreProgram, 9n),
        data = await pendingPayout(9n, {
          custodyShortfall: {
            poolBalance: new anchor.BN(500),
            depotOutstanding: new anchor.BN(700)
          }
        }),
        record = await SolanaLiqSyndicationTool.readPendingPayout(
          readContext(new Map([[address.toBase58(), data]])),
          9n
        )
      expect(record).toEqual({
        address,
        requestId: 9n,
        user: signer,
        tokenCode: 42n,
        amount: 1_000n,
        rentPayer: signer,
        reason: PendingPayoutReason.custodyShortfall,
        custodyShortfall: { poolBalance: 500n, depotOutstanding: 700n }
      })
    })

    it("readPendingPayout returns undefined once the payout is paid (the account is closed)", async () => {
      await expect(
        SolanaLiqSyndicationTool.readPendingPayout(readContext(new Map()), 9n)
      ).resolves.toBeUndefined()
    })

    it("readPendingPayouts decodes every stored payout", async () => {
      const frozenAddress = pendingPayoutAddress(basePdas.liqsolCoreProgram, 3n),
        records = await SolanaLiqSyndicationTool.readPendingPayouts(
          readContext(
            new Map([[frozenAddress.toBase58(), await pendingPayout(3n, { outpostFrozen: {} })]])
          )
        )
      expect(records).toHaveLength(1)
      expect(records[0].requestId).toBe(3n)
      expect(records[0].reason).toBe(PendingPayoutReason.outpostFrozen)
      expect(records[0].custodyShortfall).toBeUndefined()
    })

    it("toPendingPayoutRecord refuses a reason no member names", () => {
      expect(() =>
        SolanaLiqSyndicationTool.toPendingPayoutRecord(signer, {
          requestId: new anchor.BN(1),
          user: signer,
          tokenCode: new anchor.BN(1),
          amount: new anchor.BN(1),
          rentPayer: signer,
          reason: { somethingNew: {} },
          bump: 1
        })
      ).toThrow(/names no PendingPayoutReason member/)
    })

    it("readPoolBalance reads the pool ATA's Token-2022 amount", async () => {
      const data = Buffer.alloc(ACCOUNT_SIZE)
      AccountLayout.encode(
        {
          mint: basePdas.liqsolMint,
          owner: basePdas.poolAuthority,
          amount: 123_456n,
          delegateOption: 0,
          delegate: PublicKey.default,
          state: AccountState.Initialized,
          isNativeOption: 0,
          isNative: 0n,
          delegatedAmount: 0n,
          closeAuthorityOption: 0,
          closeAuthority: PublicKey.default
        },
        data
      )
      await expect(
        SolanaLiqSyndicationTool.readPoolBalance(
          readContext(
            new Map([[basePdas.liqsolPoolAta.toBase58(), data]]),
            TOKEN_2022_PROGRAM_ID
          )
        )
      ).resolves.toBe(123_456n)
    })

    it("readPoolBalance refuses a pool ATA that does not exist", async () => {
      await expect(
        SolanaLiqSyndicationTool.readPoolBalance(readContext(new Map()))
      ).rejects.toThrow()
    })
  })

  it("the fixture's account lists are the ones the runners build", () => {
    expect(
      Object.keys(
        SolanaLiqSyndicationTool.depositForLiqsolAccounts(
          userPdas,
          ephemeralStake
        )
      )
    ).toHaveLength(idlInstruction("sol_to_liqsol").accounts.length)
    expect(
      Object.keys(SolanaLiqSyndicationTool.syndAccounts(userPdas))
    ).toHaveLength(idlInstruction("synd").accounts.length)
  })
})
