import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import * as anchor from "@coral-xyz/anchor"
import {
  ACCOUNT_SIZE,
  AccountLayout,
  AccountState,
  TOKEN_2022_PROGRAM_ID
} from "@solana/spl-token"
import {
  Connection,
  Keypair,
  PublicKey,
  type TransactionInstruction
} from "@solana/web3.js"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import {
  SolanaLiqSyndicationTool,
  SolanaOutpostProgramTool,
  WireState,
  wireStateVariant,
  type SolanaOutpostTarget
} from "@wireio/cluster-tool/tools/solana"
import { solanaSignerFromKeypair, toURL } from "@wireio/cluster-tool/utils"

/** The trimmed `liqsol_core` IDL committed alongside the account-map cases. */
const FixtureIdlFilename = "liqsolCoreInstructions.idl.json"

/** A fixed-length array field type, as the fixture spells it. */
interface IdlArrayType {
  array: [IdlFieldType, number]
}
/** The reference a `defined` field type carries. */
interface IdlDefinedName {
  name: string
}
/** A named (`defined`) field type, as the fixture spells it — `GlobalState.wire_state`. */
interface IdlDefinedType {
  defined: IdlDefinedName
}
/** One IDL field type, as the fixture spells it. */
type IdlFieldType = string | IdlArrayType | IdlDefinedType
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

/** The on-chain account a fake connection answers with. */
interface FakeAccount {
  data: Buffer
  owner: PublicKey
}

/**
 * The launch-state forms of `synd`, the program-id override every derivation
 * and build takes from a {@link SolanaOutpostTarget}, and the target-addressed
 * reads / submission a cluster-less caller drives — built from the REAL
 * fixture IDL so the instructions Anchor produces are the ones checked.
 */
describe("SolanaLiqSyndicationTool — launch forms + outpost targets", () => {
  const FixtureIdl = JSON.parse(
    Fs.readFileSync(
      Path.join(__dirname, "..", "..", "fixtures", FixtureIdlFilename),
      "utf8"
    )
  ) as anchor.Idl

  let solanaPath: string
  let keysProgramId: PublicKey
  /** The DEPLOYED program id — deliberately NOT the committed keypair's. */
  let deployedProgramId: PublicKey
  let program: anchor.Program<anchor.Idl>
  let connection: Connection
  const user = solanaSignerFromKeypair(Keypair.generate())

  /**
   * The zero value the coder accepts for a field: a primitive, an array, or
   * the one named enum `GlobalState` carries (`WireState`, zeroed to its first
   * variant, PreLaunch).
   */
  function zeroOf(type: IdlFieldType): unknown {
    if (typeof type !== "string") {
      if ("defined" in type) return wireStateVariant(WireState.preLaunch)
      const [inner, length] = type.array
      return Array.from({ length }, () => zeroOf(inner))
    }
    if (type === "pubkey") return PublicKey.default
    if (type === "bool") return false
    return ["u8", "u16", "u32"].includes(type) ? 0 : new anchor.BN(0)
  }

  /** The IDL's snake_case field name as Anchor's camelCased coder keys it (`_reserved` → `reserved`). */
  function coderFieldName(name: string): string {
    return name
      .replace(/^_+/, "")
      .replace(/_([a-z0-9])/g, (_, letter) => letter.toUpperCase())
  }

  /** Every field of the fixture's struct `typeName`, camelCased and zeroed, with `overrides` laid over it. */
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
          coderFieldName(name),
          zeroOf(type)
        ])
      ),
      ...overrides
    }
  }

  /** A target over the staged tree whose connection answers `getAccountInfo` from `accounts`. */
  function target(
    accounts: Map<string, FakeAccount> = new Map(),
    extra: Partial<Connection> = {}
  ): SolanaOutpostTarget {
    return {
      connection: {
        getAccountInfo: async (address: PublicKey) =>
          accounts.has(address.toBase58())
            ? { ...accounts.get(address.toBase58()), lamports: 1, executable: false }
            : null,
        ...extra
      } as unknown as Connection,
      solanaPath,
      programId: deployedProgramId
    }
  }

  /** The `synd` instruction of a built transaction (the compute-budget one precedes it). */
  function programInstruction(
    transaction: anchor.web3.Transaction
  ): TransactionInstruction {
    expect(transaction.instructions).toHaveLength(2)
    return transaction.instructions[1]
  }

  beforeAll(async () => {
    solanaPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "liq-launch-forms-"))
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
    keysProgramId = SolanaOutpostProgramTool.assertProgramId(solanaPath)
    deployedProgramId = Keypair.generate().publicKey
    Fs.mkdirSync(
      Path.join(solanaPath, SolanaOutpostProgramTool.IdlSubdirectory),
      { recursive: true }
    )
    // The IDL on disk declares the BUILD's id; a target overlays the deployed one.
    Fs.writeFileSync(
      SolanaOutpostProgramTool.programIdlFile(solanaPath),
      JSON.stringify({ ...FixtureIdl, address: keysProgramId.toBase58() })
    )
    // `.transaction()` never dials, but the URL still comes from the registry.
    connection = new Connection(
      toURL(
        await BindConfigProvider.findAvailable(
          BindConfigProvider.DefaultSolanaRpc
        )
      )
    )
    program = new anchor.Program(
      { ...FixtureIdl, address: deployedProgramId.toBase58() },
      new anchor.AnchorProvider(connection, user, {})
    )
  })

  afterAll(() => {
    Fs.rmSync(solanaPath, { recursive: true, force: true })
  })

  describe("deriveBasePdas / deriveUserPdas with a deployed program id", () => {
    it("derives every liqsol_core PDA under the override, the sibling programs' under theirs", () => {
      const byKeys = SolanaLiqSyndicationTool.deriveBasePdas(solanaPath),
        byDeployed = SolanaLiqSyndicationTool.deriveBasePdas(
          solanaPath,
          deployedProgramId
        )
      expect(byDeployed.liqsolCoreProgram.equals(deployedProgramId)).toBe(true)
      expect(byKeys.liqsolCoreProgram.equals(keysProgramId)).toBe(true)
      expect(byDeployed.globalState.equals(byKeys.globalState)).toBe(false)
      expect(
        byDeployed.globalState.equals(
          PublicKey.findProgramAddressSync(
            [Buffer.from(SolanaLiqSyndicationTool.PdaSeed.GlobalState)],
            deployedProgramId
          )[0]
        )
      ).toBe(true)
      // The mint + hook live under THEIR programs, untouched by the override.
      expect(byDeployed.liqsolMint.equals(byKeys.liqsolMint)).toBe(true)
      expect(byDeployed.extraAccountMetaList.equals(byKeys.extraAccountMetaList)).toBe(true)
      expect(
        SolanaLiqSyndicationTool.deriveUserPdas(
          solanaPath,
          user.publicKey,
          deployedProgramId
        ).outpostAccount.equals(
          PublicKey.findProgramAddressSync(
            [
              Buffer.from(SolanaLiqSyndicationTool.PdaSeed.OutpostAccount),
              user.publicKey.toBuffer()
            ],
            deployedProgramId
          )[0]
        )
      ).toBe(true)
    })

    it("derives the pretoken purchase-history ring under the pool authority", () => {
      const pdas = SolanaLiqSyndicationTool.deriveBasePdas(
        solanaPath,
        deployedProgramId
      )
      expect(
        pdas.pretokenPurchaseHistory.equals(
          PublicKey.findProgramAddressSync(
            [
              Buffer.from(SolanaLiqSyndicationTool.PdaSeed.PretokenPurchaseHistory),
              pdas.poolAuthority.toBuffer()
            ],
            deployedProgramId
          )[0]
        )
      ).toBe(true)
    })
  })

  describe("syndAccounts launch forms", () => {
    it("defaults to the PostLaunch form and flips the four launch-dependent accounts PreLaunch", () => {
      const pdas = SolanaLiqSyndicationTool.deriveUserPdas(
          solanaPath,
          user.publicKey,
          deployedProgramId
        ),
        post = SolanaLiqSyndicationTool.syndAccounts(pdas),
        pre = SolanaLiqSyndicationTool.syndAccounts(pdas, WireState.preLaunch)
      expect(SolanaLiqSyndicationTool.syndAccounts(pdas, WireState.postLaunch)).toEqual(post)
      // The key SET is identical — what the IDL check compares.
      expect(Object.keys(pre)).toEqual(Object.keys(post))
      expect(post.outboundMessageBuffer.equals(pdas.outboundMessageBuffer)).toBe(true)
      expect(post.config.equals(pdas.outpostConfig)).toBe(true)
      expect(post.outpostAccount).toBeNull()
      expect(post.pretokenPurchaseHistory).toBeNull()
      expect(pre.outboundMessageBuffer).toBeNull()
      expect(pre.config).toBeNull()
      expect(pre.outpostAccount.equals(pdas.outpostAccount)).toBe(true)
      expect(pre.pretokenPurchaseHistory.equals(pdas.pretokenPurchaseHistory)).toBe(true)
      // Every launch-independent account is the same in both forms.
      Object.entries(post)
        .filter(([name]) => !["outboundMessageBuffer", "config", "outpostAccount", "pretokenPurchaseHistory"].includes(name))
        .forEach(([name, value]) => expect(pre[name]).toBe(value))
    })

    it("refuses the states in which liqsol_core refuses synd", () => {
      const pdas = SolanaLiqSyndicationTool.deriveUserPdas(
        solanaPath,
        user.publicKey,
        deployedProgramId
      )
      expect(() =>
        SolanaLiqSyndicationTool.syndAccounts(pdas, WireState.launching)
      ).toThrow(/refuses synd in launching/)
      expect(() =>
        SolanaLiqSyndicationTool.syndAccounts(pdas, WireState.refund)
      ).toThrow(/refuses synd in refund/)
    })
  })

  describe("transaction builders at the deployed program id", () => {
    it("syndTransaction targets the deployed program and carries the launch form's accounts", async () => {
      const pdas = SolanaLiqSyndicationTool.deriveUserPdas(
          solanaPath,
          user.publicKey,
          deployedProgramId
        ),
        pre = programInstruction(
          await SolanaLiqSyndicationTool.syndTransaction(
            target(),
            user,
            5n,
            WireState.preLaunch
          )
        ),
        post = programInstruction(
          await SolanaLiqSyndicationTool.syndTransaction(target(), user, 5n)
        ),
        keysOf = (instruction: TransactionInstruction) =>
          instruction.keys.map(meta => meta.pubkey.toBase58())
      expect(pre.programId.equals(deployedProgramId)).toBe(true)
      expect(post.programId.equals(deployedProgramId)).toBe(true)
      expect(keysOf(pre)).toContain(pdas.outpostAccount.toBase58())
      expect(keysOf(pre)).toContain(pdas.pretokenPurchaseHistory.toBase58())
      expect(keysOf(pre)).not.toContain(pdas.outboundMessageBuffer.toBase58())
      expect(keysOf(post)).toContain(pdas.outboundMessageBuffer.toBase58())
      expect(keysOf(post)).toContain(pdas.outpostConfig.toBase58())
      expect(keysOf(post)).not.toContain(pdas.outpostAccount.toBase58())
      // Both carry the ONE encoding the program decodes: the same data for the same amount.
      expect(Buffer.from(pre.data).equals(Buffer.from(post.data))).toBe(true)
    })

    it("depositForLiqsolTransaction targets the deployed program and the seeded ephemeral stake", async () => {
      const seed = 42,
        ephemeralStake = await PublicKey.createWithSeed(
          user.publicKey,
          `${SolanaLiqSyndicationTool.EphemeralStakeSeedPrefix}${seed}`,
          anchor.web3.StakeProgram.programId
        ),
        instruction = programInstruction(
          await SolanaLiqSyndicationTool.depositForLiqsolTransaction(
            target(),
            user,
            7n,
            seed
          )
        )
      expect(instruction.programId.equals(deployedProgramId)).toBe(true)
      expect(instruction.keys.map(meta => meta.pubkey.toBase58())).toContain(
        ephemeralStake.toBase58()
      )
    })

    it("loadLiqsolProgram binds the deployed program id, not the IDL file's", () => {
      expect(
        SolanaLiqSyndicationTool.loadLiqsolProgram(target(), user).programId.equals(
          deployedProgramId
        )
      ).toBe(true)
    })
  })

  describe("target-addressed reads", () => {
    it("readLiqsolBalanceOf reads the owner's Token-2022 ATA, 0n before it exists", async () => {
      const { userAta, liqsolMint } = SolanaLiqSyndicationTool.deriveUserPdas(
          solanaPath,
          user.publicKey,
          deployedProgramId
        ),
        data = Buffer.alloc(ACCOUNT_SIZE)
      AccountLayout.encode(
        {
          mint: liqsolMint,
          owner: user.publicKey,
          amount: 9_876n,
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
        SolanaLiqSyndicationTool.readLiqsolBalanceOf(
          target(new Map([[userAta.toBase58(), { data, owner: TOKEN_2022_PROGRAM_ID }]])),
          user.publicKey
        )
      ).resolves.toBe(9_876n)
      await expect(
        SolanaLiqSyndicationTool.readLiqsolBalanceOf(target(), user.publicKey)
      ).resolves.toBe(0n)
    })

    it("readGlobalStatePaused decodes GlobalState.paused through the coder", async () => {
      const { globalState } = SolanaLiqSyndicationTool.deriveBasePdas(
          solanaPath,
          deployedProgramId
        ),
        paused = await program.coder.accounts.encode(
          SolanaLiqSyndicationTool.GlobalStateAccountName,
          zeroedAccount("GlobalState", {
            paused: true,
            wireState: wireStateVariant(WireState.preLaunch)
          })
        ),
        accounts = new Map([
          [globalState.toBase58(), { data: paused, owner: deployedProgramId }]
        ])
      await expect(
        SolanaLiqSyndicationTool.readGlobalStatePaused(target(accounts))
      ).resolves.toBe(true)
      await expect(
        SolanaLiqSyndicationTool.readWireState(target(accounts))
      ).resolves.toBe(WireState.preLaunch)
      await expect(
        SolanaLiqSyndicationTool.readGlobalStatePaused(target())
      ).rejects.toThrow(/globalState .* does not exist/)
    })

    it("submit sets the signer as fee payer, signs over the latest blockhash, sends the raw bytes through the target's connection and returns the confirmed signature", async () => {
      const blockhash = Keypair.generate().publicKey.toBase58(),
        sendRawTransaction = jest.fn(async () => "signature-1"),
        transaction = new anchor.web3.Transaction().add(
          anchor.web3.SystemProgram.transfer({
            fromPubkey: user.publicKey,
            toPubkey: user.publicKey,
            lamports: 1
          })
        ),
        signature = await SolanaLiqSyndicationTool.submit(
          target(new Map(), {
            getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 1 }),
            sendRawTransaction,
            getSignatureStatus: async () => ({
              context: { slot: 1 },
              value: { confirmationStatus: "confirmed", err: null }
            })
          } as unknown as Partial<Connection>),
          transaction,
          user,
          "launch-forms submit"
        )
      expect(signature).toBe("signature-1")
      expect(transaction.feePayer.equals(user.publicKey)).toBe(true)
      expect(transaction.recentBlockhash).toBe(blockhash)
      expect(transaction.verifySignatures()).toBe(true)
      expect(sendRawTransaction).toHaveBeenCalledTimes(1)
      expect(sendRawTransaction).toHaveBeenCalledWith(transaction.serialize(), {
        skipPreflight: false
      })
    })
  })
})
