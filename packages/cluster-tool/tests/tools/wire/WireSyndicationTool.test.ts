import { SysioContracts } from "@wireio/sdk-core"

import { ProtocolTiming } from "@wireio/cluster-tool/Constants"
import {
  ClusterBuild,
  ClusterBuildContext,
  ClusterBuildPhase,
  Steps,
  outputKey
} from "@wireio/cluster-tool/orchestration"
import { WireClient } from "@wireio/cluster-tool/clients/wire"
import { getLogger } from "@wireio/cluster-tool/logging"
import { Report } from "@wireio/cluster-tool/report"
import { WireSyndicationTool } from "@wireio/cluster-tool/tools/wire"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"
import { fixtureConfig } from "../../config/clusterConfigFixture.js"

const {
  SysioContractName,
  SysioBondRequestState,
  SysioSyndBucketDirection,
  SysioSyndChainkind,
  SysioSyndEnvelopeState,
  SysioSyndItemKind,
  SysioSyndRequestOutcome,
  SysioTokensTokenkind,
  SysioTokensChainkind
} = SysioContracts

const Solana = "SOLANA",
  Ethereum = "ETHEREUM",
  Liqsol = "LIQSOL",
  Liqeth = "LIQETH",
  Bonder = "bonder.a",
  RequestId = 7,
  signal = new AbortController().signal

/**
 * A fixture context whose `getSysioContract` hands back ONE shared client per contract,
 * so a test can spy on that client's table queries and actions.
 */
function stubbedContext() {
  const ctx = fixtureContext(),
    clients = {
      synd: ctx.wire.getSysioContract(SysioContractName.synd),
      bond: ctx.wire.getSysioContract(SysioContractName.bond),
      andon: ctx.wire.getSysioContract(SysioContractName.andon),
      liq: ctx.wire.getSysioContract(SysioContractName.liq),
      tokens: ctx.wire.getSysioContract(SysioContractName.tokens)
    }
  jest
    .spyOn(ctx.wire, "getSysioContract")
    .mockImplementation(name => clients[name as keyof typeof clients] as never)
  return { ctx, clients }
}

/** Serve `rows` (complete, unless `more`) from every query of one table. */
function serve<
  Name extends SysioContracts.SysioContractName,
  Table extends WireClient.TableName<Name>
>(
  table: WireClient.TableQuery<Name, Table>,
  rows: WireClient.TableRow<Name, Table>[],
  more = false
): void {
  jest.spyOn(table, "query").mockResolvedValue({ rows, more })
}

/** One `sysio.synd::envelopes` row. */
function envelope(
  chainCode: string,
  tokenCode: string,
  epochIndex: number,
  state: SysioContracts.SysioSyndEnvelopeState,
  requestId = RequestId,
  outcome = SysioSyndRequestOutcome.PENDING
): SysioContracts.SysioSyndEnvelopeRowType {
  return {
    chain_code: chainCode,
    token_code: tokenCode,
    epoch_index: epochIndex,
    digest: "00".repeat(32),
    synd_total: 5_000_000_000,
    yield_total: 0,
    item_count: 1,
    state,
    request_id: requestId,
    released: 0,
    burned: 0,
    outcome,
    forfeit: 0,
    bounty_returned: 0,
    hold_share: 0,
    hold_beneficiary: "",
    share_pending: false
  }
}

/** One `sysio.bond::requests` row. */
function request(
  covered: number,
  bonded: number,
  state:
    SysioContracts.SysioBondRequestState | keyof typeof SysioBondRequestState
): SysioContracts.SysioBondRequestRowType {
  return {
    id: String(RequestId),
    issuer: "sysio.synd",
    schema: "oppenvelope",
    statement: "",
    statement_digest: "00".repeat(32),
    token_code: Liqsol,
    covered,
    bonded,
    bounty: 0,
    window_sec: 60,
    state,
    created_at: "2026-09-30T00:00:00.000",
    bonded_at: "2026-09-30T00:00:00.000",
    hold_bond: 0,
    hold_beneficiary: "",
    held_at: "1970-01-01T00:00:00.000",
    resolved_at: "1970-01-01T00:00:00.000",
    resolved_index: "0",
    forfeit_pending: 0
  }
}

/** A `sysio.liq::stat` row of a shadow at `precision`. */
function stat(supply: string): SysioContracts.SysioLiqCurrencyStatsType {
  return {
    supply,
    chain_code: Solana,
    token_code: Liqsol,
    pair_symbol: "9,LIQSOLP"
  }
}

/** A fresh build root for a composite to register on. */
function newBuild(): ClusterBuild {
  return ClusterBuild.forContext(
    new ClusterBuildContext(fixtureConfig(), getLogger("syndication-tool-test"))
  )
}

afterEach(() => jest.restoreAllMocks())

describe("WireSyndicationTool — sysio.synd reads", () => {
  it("readEnvelopes keeps only the pair's rows, whatever the other pairs hold", async () => {
    const { ctx, clients } = stubbedContext()
    serve(clients.synd.tables.envelopes, [
      envelope(Solana, Liqsol, 3, SysioSyndEnvelopeState.DONE),
      envelope(Ethereum, Liqeth, 3, SysioSyndEnvelopeState.WAITING),
      envelope(Solana, Liqsol, 4, SysioSyndEnvelopeState.REQUESTED)
    ])
    const rows = await WireSyndicationTool.readEnvelopes(ctx, Solana, Liqsol)
    expect(rows.map(row => row.epoch_index)).toEqual([3, 4])
  })

  it("readEnvelope finds the pair's row at one epoch, and nothing at another", async () => {
    const { ctx, clients } = stubbedContext()
    serve(clients.synd.tables.envelopes, [
      envelope(Solana, Liqsol, 4, SysioSyndEnvelopeState.REQUESTED)
    ])
    expect(
      (await WireSyndicationTool.readEnvelope(ctx, Solana, Liqsol, 4))
        .epoch_index
    ).toBe(4)
    expect(
      await WireSyndicationTool.readEnvelope(ctx, Solana, Liqsol, 5)
    ).toBeUndefined()
  })

  it("refuses a truncated read rather than report a row absent", async () => {
    const { ctx, clients } = stubbedContext()
    serve(clients.synd.tables.envelopes, [], true)
    await expect(
      WireSyndicationTool.readEnvelopes(ctx, Solana, Liqsol)
    ).rejects.toThrow(/envelopes has more than 1000 rows/)
  })

  it("readItems keeps the items of one envelope", async () => {
    const { ctx, clients } = stubbedContext(),
      item = (
        epochIndex: number,
        id: number
      ): SysioContracts.SysioSyndItemRowType => ({
        id,
        chain_code: Solana,
        token_code: Liqsol,
        epoch_index: epochIndex,
        kind: SysioSyndItemKind.SYNDICATION,
        chain_kind: SysioSyndChainkind.CHAIN_KIND_SVM,
        pubkey: "ab".repeat(32),
        amount: 5_000_000_000,
        remaining: 5_000_000_000,
        position: { index_checkpoint: "0", owed_wire: 0 }
      })
    serve(clients.synd.tables.items, [item(3, 1), item(4, 2), item(4, 3)])
    const rows = await WireSyndicationTool.readItems(ctx, Solana, Liqsol, 4)
    expect(rows.map(row => row.id)).toEqual([2, 3])
  })

  it("readLedger and readSyndicationConfig find the pair's row", async () => {
    const { ctx, clients } = stubbedContext(),
      config: SysioContracts.SysioSyndSyndConfigType = {
        ...Steps.registry.SyndicationConfigRegistrations[1]
      }
    serve(clients.synd.tables.ledger, [
      {
        chain_code: Solana,
        token_code: Liqsol,
        syndicated_sum: 5_000_000_000,
        yield_sum: 0,
        desyndicated_sum: 0,
        queue_epoch: 4
      }
    ])
    serve(clients.synd.tables.syndconfig, [
      Steps.registry.SyndicationConfigRegistrations[0],
      config
    ])
    expect(
      (await WireSyndicationTool.readLedger(ctx, Solana, Liqsol)).queue_epoch
    ).toBe(4)
    expect(
      await WireSyndicationTool.readSyndicationConfig(ctx, Solana, Liqsol)
    ).toBe(config)
    expect(
      await WireSyndicationTool.readLedger(ctx, Ethereum, Liqeth)
    ).toBeUndefined()
  })

  it("readBucket matches the direction whether the cell is the value or its spelling", async () => {
    const { ctx, clients } = stubbedContext()
    serve(clients.synd.tables.buckets, [
      {
        chain_code: Solana,
        token_code: Liqsol,
        direction: "SYNDICATION",
        level: 10,
        last_epoch: 4,
        frozen_mark: 0
      },
      {
        chain_code: Solana,
        token_code: Liqsol,
        direction: SysioSyndBucketDirection.DESYNDICATION,
        level: 20,
        last_epoch: 4,
        frozen_mark: 0
      }
    ])
    const syndication = await WireSyndicationTool.readBucket(
        ctx,
        Solana,
        Liqsol,
        SysioSyndBucketDirection.SYNDICATION
      ),
      desyndication = await WireSyndicationTool.readBucket(
        ctx,
        Solana,
        Liqsol,
        SysioSyndBucketDirection.DESYNDICATION
      )
    expect(syndication.level).toBe(10)
    expect(desyndication.level).toBe(20)
  })

  it("readParked matches token, key family and pubkey", async () => {
    const { ctx, clients } = stubbedContext(),
      pubkey = "cd".repeat(32)
    serve(clients.synd.tables.parked, [
      {
        token_code: Liqsol,
        chain_kind: "CHAIN_KIND_SVM",
        pubkey,
        balance: 5_000_000_000,
        position: { index_checkpoint: "0", owed_wire: 0 }
      }
    ])
    expect(
      (
        await WireSyndicationTool.readParked(
          ctx,
          Liqsol,
          SysioSyndChainkind.CHAIN_KIND_SVM,
          pubkey
        )
      ).balance
    ).toBe(5_000_000_000)
    expect(
      await WireSyndicationTool.readParked(
        ctx,
        Liqsol,
        SysioSyndChainkind.CHAIN_KIND_EVM,
        pubkey
      )
    ).toBeUndefined()
  })

  it("readFeepot finds the token's row; readMismatches returns every row", async () => {
    const { ctx, clients } = stubbedContext(),
      mismatch: SysioContracts.SysioSyndMismatchRowType = {
        chain_code: Solana,
        token_code: Liqsol,
        epoch_index: 4,
        sequence: 9,
        kind: SysioSyndItemKind.SYNDICATION,
        reported: 1,
        expected: 2,
        at: "2026-09-30T00:00:00.000"
      }
    serve(clients.synd.tables.feepot, [
      {
        token_code: Liqsol,
        balance: 42,
        position: { index_checkpoint: "0", owed_wire: 0 }
      }
    ])
    serve(clients.synd.tables.mismatch, [mismatch])
    expect((await WireSyndicationTool.readFeepot(ctx, Liqsol)).balance).toBe(42)
    expect(await WireSyndicationTool.readFeepot(ctx, Liqeth)).toBeUndefined()
    expect(await WireSyndicationTool.readMismatches(ctx)).toEqual([mismatch])
  })
})

describe("WireSyndicationTool — sysio.bond and sysio.andon reads", () => {
  it("readRequest matches the id across number and string carriers", async () => {
    const { ctx, clients } = stubbedContext()
    serve(clients.bond.tables.requests, [
      request(5, 0, SysioBondRequestState.OPEN)
    ])
    expect(
      (await WireSyndicationTool.readRequest(ctx, RequestId)).covered
    ).toBe(5)
    expect(await WireSyndicationTool.readRequest(ctx, 8)).toBeUndefined()
  })

  it("readBonds keeps the request's bond rows", async () => {
    const { ctx, clients } = stubbedContext(),
      bond = (
        requestId: number,
        underwriter: string
      ): SysioContracts.SysioBondBondRowType => ({
        request_id: requestId,
        underwriter,
        amount: 1,
        yield: { index_checkpoint: "0", owed_wire: 0 },
        paid: false
      })
    serve(clients.bond.tables.bonds, [
      bond(RequestId, Bonder),
      bond(8, Bonder),
      bond(RequestId, "bonder.b")
    ])
    const rows = await WireSyndicationTool.readBonds(ctx, RequestId)
    expect(rows.map(row => row.underwriter)).toEqual([Bonder, "bonder.b"])
  })

  it("readCord and readAndonConfig return the singleton, or nothing before it exists", async () => {
    const { ctx, clients } = stubbedContext(),
      config: SysioContracts.SysioAndonAndonConfigType = {
        panic: "andon.panic",
        pullers: ["sysio.synd"]
      }
    serve(clients.andon.tables.cord, [])
    serve(clients.andon.tables.andonconfig, [config])
    expect(await WireSyndicationTool.readCord(ctx)).toBeUndefined()
    expect(await WireSyndicationTool.readAndonConfig(ctx)).toBe(config)
  })
})

describe("WireSyndicationTool — shadow ledger and registry reads", () => {
  it("readOutstanding is the supply plus the yield parked in liqpending", async () => {
    const { ctx, clients } = stubbedContext()
    serve(clients.liq.tables.stat, [stat("12.000000000 LIQSOL")])
    serve(clients.liq.tables.liqpending, [{ quantity: "0.500000000 LIQSOL" }])
    expect(await WireSyndicationTool.readOutstanding(ctx, Liqsol)).toBe(
      12_500_000_000n
    )
  })

  it("readOutstanding is the supply alone when no yield is pending", async () => {
    const { ctx, clients } = stubbedContext()
    serve(clients.liq.tables.stat, [stat("12.000000000 LIQSOL")])
    serve(clients.liq.tables.liqpending, [])
    expect(await WireSyndicationTool.readOutstanding(ctx, Liqsol)).toBe(
      12_000_000_000n
    )
  })

  it("readShadowStat refuses a shadow that was never opened", async () => {
    const { ctx, clients } = stubbedContext()
    serve(clients.liq.tables.stat, [])
    await expect(
      WireSyndicationTool.readShadowStat(ctx, Liqsol)
    ).rejects.toThrow(/no LIQSOL row/)
  })

  it("readToken and readChainToken find the registry rows", async () => {
    const { ctx, clients } = stubbedContext()
    serve(clients.tokens.tables.tokens, [liqToken(true)])
    serve(clients.tokens.tables.chaintokens, [chainToken(true)])
    expect((await WireSyndicationTool.readToken(ctx, Liqeth)).code).toBe(Liqeth)
    expect(
      (await WireSyndicationTool.readChainToken(ctx, Ethereum, Liqeth)).active
    ).toBe(true)
    expect(
      await WireSyndicationTool.readChainToken(ctx, Solana, Liqeth)
    ).toBeUndefined()
  })
})

/** The LIQETH `sysio.tokens::tokens` row. */
function liqToken(
  active: boolean,
  kind: SysioContracts.SysioTokensTokenkind = SysioTokensTokenkind.TOKEN_KIND_LIQ
): SysioContracts.SysioTokensTokenRowType {
  return {
    code: Liqeth,
    kind,
    symbol_name: "Liquid ETH",
    description: "",
    precision: 9,
    address: { kind: SysioTokensChainkind.CHAIN_KIND_EVM, address: "" },
    active,
    registered_at_ms: 0,
    activated_at_ms: 0
  }
}

/** The ETHEREUM/LIQETH `sysio.tokens::chaintokens` row. */
function chainToken(
  active: boolean
): SysioContracts.SysioTokensChainTokenRowType {
  return {
    chain_code: Ethereum,
    token_code: Liqeth,
    contract_addr: "",
    is_native: false,
    active,
    registered_at_ms: 0,
    activated_at_ms: 0
  }
}

describe("WireSyndicationTool.planBondEnvelope", () => {
  it("returns one phase: the underwriter's accept, then the BONDED verify", () => {
    const phase = WireSyndicationTool.planBondEnvelope(
      newBuild(),
      "bond-envelope",
      "underwrite the envelope",
      {},
      Bonder,
      Solana,
      Liqsol,
      4
    )
    expect(phase).toBeInstanceOf(ClusterBuildPhase)
    expect(phase.steps.map(step => step.name)).toEqual([
      "bond-envelope",
      "bond-envelope-bonded"
    ])
    expect(phase.steps.map(step => step.actor)).toEqual([
      Report.Actor.Underwriter,
      Report.Actor.Sysio
    ])
    expect(phase.steps[0].input).toEqual({
      kind: "WireSyndicationTool.AcceptRemainderInput",
      bonderAccount: Bonder,
      chainCode: Solana,
      tokenCode: Liqsol,
      epoch: 4
    })
    expect(phase.steps[0].runner).toBe(WireSyndicationTool.runAcceptRemainder)
    expect(phase.steps[1].runner).toBe(WireSyndicationTool.runVerifyBonded)
  })

  const acceptInput: WireSyndicationTool.AcceptRemainderInput = {
    kind: "WireSyndicationTool.AcceptRemainderInput",
    bonderAccount: Bonder,
    chainCode: Solana,
    tokenCode: Liqsol,
    epoch: 4
  }

  it("runAcceptRemainder bonds exactly what the request still needs, as the underwriter", async () => {
    const { ctx, clients } = stubbedContext(),
      accept = jest
        .spyOn(Steps.contracts.sysio.bond, "runAccept")
        .mockResolvedValue(undefined)
    serve(clients.synd.tables.envelopes, [
      envelope(Solana, Liqsol, 4, SysioSyndEnvelopeState.REQUESTED)
    ])
    serve(clients.bond.tables.requests, [
      request(5_000_000_000, 2_000_000_000, SysioBondRequestState.OPEN)
    ])
    await WireSyndicationTool.runAcceptRemainder(ctx, acceptInput, signal)
    expect(accept).toHaveBeenCalledWith(
      ctx,
      {
        kind: "BondContractSteps.AcceptInput",
        data: {
          underwriter: Bonder,
          request_id: RequestId,
          amount: "3000000000"
        }
      },
      signal
    )
  })

  it("runAcceptRemainder refuses a request that is already fully bonded", async () => {
    const { ctx, clients } = stubbedContext(),
      accept = jest
        .spyOn(Steps.contracts.sysio.bond, "runAccept")
        .mockResolvedValue(undefined)
    serve(clients.synd.tables.envelopes, [
      envelope(Solana, Liqsol, 4, SysioSyndEnvelopeState.REQUESTED)
    ])
    serve(clients.bond.tables.requests, [
      request(5_000_000_000, 5_000_000_000, SysioBondRequestState.BONDED)
    ])
    await expect(
      WireSyndicationTool.runAcceptRemainder(ctx, acceptInput, signal)
    ).rejects.toThrow(/already fully bonded/)
    expect(accept).not.toHaveBeenCalled()
  })

  it("runAcceptRemainder refuses an envelope that names a request sysio.bond does not hold", async () => {
    const { ctx, clients } = stubbedContext(),
      accept = jest
        .spyOn(Steps.contracts.sysio.bond, "runAccept")
        .mockResolvedValue(undefined)
    serve(clients.synd.tables.envelopes, [
      envelope(Solana, Liqsol, 4, SysioSyndEnvelopeState.REQUESTED)
    ])
    serve(clients.bond.tables.requests, [])
    await expect(
      WireSyndicationTool.runAcceptRemainder(ctx, acceptInput, signal)
    ).rejects.toThrow(/does not hold/)
    expect(accept).not.toHaveBeenCalled()
  })

  /** The key a flow's earlier Step records the envelope's depot epoch under. */
  const EpochKey = outputKey<number>(
    "test.envelopeEpoch",
    "the depot epoch of the envelope"
  )

  it("plans the same phase when the epoch is only known at run time, under an output key", () => {
    const phase = WireSyndicationTool.planBondEnvelope(
      newBuild(),
      "bond-envelope",
      "underwrite the envelope",
      {},
      Bonder,
      Solana,
      Liqsol,
      EpochKey
    )
    expect(phase.steps[0].input).toEqual({ ...acceptInput, epoch: EpochKey })
    expect(phase.steps[1].input).toEqual({
      kind: "WireSyndicationTool.VerifyBondedInput",
      chainCode: Solana,
      tokenCode: Liqsol,
      epoch: EpochKey
    })
    expect(phase.steps[0].description).toContain(
      "the epoch in test.envelopeEpoch"
    )
  })

  it("runAcceptRemainder reads the epoch an earlier Step stored under the key", async () => {
    const { ctx, clients } = stubbedContext(),
      accept = jest
        .spyOn(Steps.contracts.sysio.bond, "runAccept")
        .mockResolvedValue(undefined)
    ctx.outputs.set(EpochKey, 4)
    serve(clients.synd.tables.envelopes, [
      envelope(Solana, Liqsol, 3, SysioSyndEnvelopeState.DONE, 6),
      envelope(Solana, Liqsol, 4, SysioSyndEnvelopeState.REQUESTED)
    ])
    serve(clients.bond.tables.requests, [
      request(5_000_000_000, 0, SysioBondRequestState.OPEN)
    ])
    await WireSyndicationTool.runAcceptRemainder(
      ctx,
      { ...acceptInput, epoch: EpochKey },
      signal
    )
    expect(accept).toHaveBeenCalledWith(
      ctx,
      {
        kind: "BondContractSteps.AcceptInput",
        data: {
          underwriter: Bonder,
          request_id: RequestId,
          amount: "5000000000"
        }
      },
      signal
    )
  })

  it("runAcceptRemainder fails, bonding nothing, when no Step has stored the epoch yet", async () => {
    const { ctx } = stubbedContext(),
      accept = jest
        .spyOn(Steps.contracts.sysio.bond, "runAccept")
        .mockResolvedValue(undefined)
    await expect(
      WireSyndicationTool.runAcceptRemainder(
        ctx,
        { ...acceptInput, epoch: EpochKey },
        signal
      )
    ).rejects.toThrow(/test.envelopeEpoch/)
    expect(accept).not.toHaveBeenCalled()
  })

  const verifyInput: WireSyndicationTool.VerifyBondedInput = {
    kind: "WireSyndicationTool.VerifyBondedInput",
    chainCode: Solana,
    tokenCode: Liqsol,
    epoch: 4
  }

  it("runVerifyBonded passes when the envelope's request is BONDED", async () => {
    const { ctx, clients } = stubbedContext()
    serve(clients.synd.tables.envelopes, [
      envelope(Solana, Liqsol, 4, SysioSyndEnvelopeState.RELEASABLE)
    ])
    serve(clients.bond.tables.requests, [request(5, 5, "BONDED")])
    await expect(
      WireSyndicationTool.runVerifyBonded(ctx, verifyInput, signal)
    ).resolves.toBeUndefined()
  })

  it("runVerifyBonded fails while the request is still OPEN", async () => {
    const { ctx, clients } = stubbedContext()
    serve(clients.synd.tables.envelopes, [
      envelope(Solana, Liqsol, 4, SysioSyndEnvelopeState.REQUESTED)
    ])
    serve(clients.bond.tables.requests, [
      request(5, 2, SysioBondRequestState.OPEN)
    ])
    await expect(
      WireSyndicationTool.runVerifyBonded(ctx, verifyInput, signal)
    ).rejects.toThrow(/expected BONDED/)
  })

  it("runVerifyBonded fails for an envelope still WAITING for its request", async () => {
    const { ctx, clients } = stubbedContext()
    serve(clients.synd.tables.envelopes, [
      envelope(Solana, Liqsol, 4, SysioSyndEnvelopeState.WAITING)
    ])
    await expect(
      WireSyndicationTool.runVerifyBonded(ctx, verifyInput, signal)
    ).rejects.toThrow(/no issued sysio.bond request/)
  })
})

describe("WireSyndicationTool.planApproveAndClaim", () => {
  /** The chain time the fixture request was bonded at. */
  const BondedAt = "2026-09-30T00:00:00.000"
  /** The fixture request's challenge window (s). */
  const WindowSec = 60

  /** A `get_info` response whose head block is `offsetSec` after {@link BondedAt}. */
  function headAt(offsetSec: number): WireClient.GetInfoResponse {
    return {
      server_version: "v6",
      chain_id: "00".repeat(32),
      head_block_num: 100,
      last_irreversible_block_num: 99,
      head_block_time: new Date(
        WireClient.chainTimeMs(BondedAt) +
          offsetSec * ProtocolTiming.MsPerSecond
      )
        .toISOString()
        .replace(/Z$/, ""),
      head_block_id: "00".repeat(32),
      head_block_producer: "defproducera"
    }
  }

  const approveInput: WireSyndicationTool.ApproveAfterWindowInput = {
    kind: "WireSyndicationTool.ApproveAfterWindowInput",
    account: Bonder,
    requestId: RequestId
  }

  it("returns one phase: the window-gated approve, then claim for the account, both signed by it", () => {
    const phase = WireSyndicationTool.planApproveAndClaim(
      newBuild(),
      "approve-request",
      "close the request",
      {},
      Bonder,
      RequestId
    )
    expect(phase.steps.map(step => step.name)).toEqual([
      "approve-request",
      "approve-request-claim"
    ])
    expect(phase.steps[0].input).toEqual(approveInput)
    expect(phase.steps[0].runner).toBe(
      WireSyndicationTool.runApproveAfterWindow
    )
    expect(phase.steps[1].input).toEqual({
      kind: "WireSyndicationTool.ClaimRequestInput",
      requestId: RequestId,
      account: Bonder
    })
  })

  it("resolves one runtime request for both approval and claim", async () => {
    const { ctx, clients } = stubbedContext(),
      key = outputKey<SysioContracts.SysioBondApproveAction["request_id"]>(
        "request",
        "runtime request"
      ),
      phase = WireSyndicationTool.planApproveAndClaim(
        newBuild(),
        "approve",
        "approve",
        {},
        Bonder,
        key
      ),
      approve = jest
        .spyOn(Steps.contracts.sysio.bond, "runApprove")
        .mockResolvedValue(undefined),
      claim = jest
        .spyOn(Steps.contracts.sysio.bond, "runClaim")
        .mockResolvedValue(undefined)
    ctx.outputs.set(key, RequestId)
    serve(clients.bond.tables.requests, [
      request(5, 5, SysioBondRequestState.BONDED)
    ])
    jest.spyOn(ctx.wire, "getInfo").mockResolvedValue(headAt(WindowSec))
    await Promise.all(
      phase.steps.map(step => step.runner(ctx, step.input, signal))
    )
    expect(approve).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ data: { request_id: RequestId } }),
      signal
    )
    expect(claim).toHaveBeenCalledWith(
      ctx,
      {
        kind: "BondContractSteps.ClaimInput",
        data: { request_id: RequestId, account: Bonder },
        signer: Bonder
      },
      signal
    )
    expect(WireSyndicationTool.resolveRequestId(ctx, String(RequestId))).toBe(
      String(RequestId)
    )
  })

  it("refuses an unset runtime request before either write", async () => {
    const { ctx } = stubbedContext(),
      key = outputKey<SysioContracts.SysioBondApproveAction["request_id"]>(
        "missing",
        "unset request"
      ),
      phase = WireSyndicationTool.planApproveAndClaim(
        newBuild(),
        "approve",
        "approve",
        {},
        Bonder,
        key
      ),
      approve = jest
        .spyOn(Steps.contracts.sysio.bond, "runApprove")
        .mockResolvedValue(undefined),
      claim = jest
        .spyOn(Steps.contracts.sysio.bond, "runClaim")
        .mockResolvedValue(undefined)
    await Promise.all(
      phase.steps.map(step =>
        expect(step.runner(ctx, step.input, signal)).rejects.toThrow()
      )
    )
    expect(approve).not.toHaveBeenCalled()
    expect(claim).not.toHaveBeenCalled()
  })

  it("opens the window at bonded_at + window_sec, and budgets the window plus the poll margin", () => {
    const row = request(5, 5, SysioBondRequestState.BONDED)
    expect(WireSyndicationTool.approveOpensAtMs(row)).toBe(
      WireClient.chainTimeMs(BondedAt) + WindowSec * ProtocolTiming.MsPerSecond
    )
    expect(WireSyndicationTool.approveWindowBudgetMs(WindowSec)).toBe(
      WindowSec * ProtocolTiming.MsPerSecond +
        ProtocolTiming.PollDeadlineBufferMs
    )
  })

  it("runApproveAfterWindow approves at once when the window has already passed", async () => {
    const { ctx, clients } = stubbedContext(),
      approve = jest
        .spyOn(Steps.contracts.sysio.bond, "runApprove")
        .mockResolvedValue(undefined)
    serve(clients.bond.tables.requests, [
      request(5, 5, SysioBondRequestState.BONDED)
    ])
    jest.spyOn(ctx.wire, "getInfo").mockResolvedValue(headAt(WindowSec + 1))
    await WireSyndicationTool.runApproveAfterWindow(ctx, approveInput, signal)
    expect(approve).toHaveBeenCalledWith(
      ctx,
      {
        kind: "BondContractSteps.ApproveInput",
        data: { request_id: RequestId },
        signer: Bonder
      },
      signal
    )
  })

  it("runApproveAfterWindow waits while the head block is inside the window, then approves", async () => {
    const { ctx, clients } = stubbedContext(),
      approve = jest
        .spyOn(Steps.contracts.sysio.bond, "runApprove")
        .mockResolvedValue(undefined),
      getInfo = jest
        .spyOn(ctx.wire, "getInfo")
        .mockResolvedValueOnce(headAt(WindowSec - 1))
        .mockResolvedValue(headAt(WindowSec))
    serve(clients.bond.tables.requests, [
      request(5, 5, SysioBondRequestState.BONDED)
    ])
    await WireSyndicationTool.runApproveAfterWindow(ctx, approveInput, signal)
    expect(getInfo).toHaveBeenCalledTimes(2)
    expect(approve).toHaveBeenCalledTimes(1)
  })

  it("runApproveAfterWindow refuses a request that is not BONDED, approving nothing", async () => {
    const { ctx, clients } = stubbedContext(),
      approve = jest
        .spyOn(Steps.contracts.sysio.bond, "runApprove")
        .mockResolvedValue(undefined)
    serve(clients.bond.tables.requests, [
      request(5, 5, SysioBondRequestState.HELD)
    ])
    await expect(
      WireSyndicationTool.runApproveAfterWindow(ctx, approveInput, signal)
    ).rejects.toThrow(/only a BONDED request can be approved/)
    expect(approve).not.toHaveBeenCalled()
  })
})

describe("WireSyndicationTool — the SyndicationConfig verifies", () => {
  const precisionInput: WireSyndicationTool.VerifyShadowPrecisionInput = {
    kind: "WireSyndicationTool.VerifyShadowPrecisionInput",
    symbolCodes: [Liqsol]
  }

  it("runVerifyShadowPrecision passes a shadow at the depot frame's 9 decimals", async () => {
    const { ctx, clients } = stubbedContext()
    serve(clients.liq.tables.stat, [stat("0.000000000 LIQSOL")])
    await expect(
      WireSyndicationTool.runVerifyShadowPrecision(ctx, precisionInput, signal)
    ).resolves.toBeUndefined()
  })

  it("runVerifyShadowPrecision names a shadow at any other precision", async () => {
    const { ctx, clients } = stubbedContext()
    serve(clients.liq.tables.stat, [stat("0.000000 LIQSOL")])
    await expect(
      WireSyndicationTool.runVerifyShadowPrecision(ctx, precisionInput, signal)
    ).rejects.toThrow(/LIQSOL=6/)
  })

  const tokenInput: WireSyndicationTool.VerifyLiqTokenActiveInput = {
    kind: "WireSyndicationTool.VerifyLiqTokenActiveInput",
    chainCode: Ethereum,
    tokenCode: Liqeth
  }

  it("runVerifyLiqTokenActive passes an active liq token with an active binding", async () => {
    const { ctx, clients } = stubbedContext()
    serve(clients.tokens.tables.tokens, [liqToken(true)])
    serve(clients.tokens.tables.chaintokens, [chainToken(true)])
    await expect(
      WireSyndicationTool.runVerifyLiqTokenActive(ctx, tokenInput, signal)
    ).resolves.toBeUndefined()
  })

  it("runVerifyLiqTokenActive fails a token of another kind", async () => {
    const { ctx, clients } = stubbedContext()
    serve(clients.tokens.tables.tokens, [
      liqToken(true, SysioTokensTokenkind.TOKEN_KIND_ERC20)
    ])
    serve(clients.tokens.tables.chaintokens, [chainToken(true)])
    await expect(
      WireSyndicationTool.runVerifyLiqTokenActive(ctx, tokenInput, signal)
    ).rejects.toThrow(/not an active TOKEN_KIND_LIQ/)
  })

  it("runVerifyLiqTokenActive fails an inactive binding", async () => {
    const { ctx, clients } = stubbedContext()
    serve(clients.tokens.tables.tokens, [liqToken(true)])
    serve(clients.tokens.tables.chaintokens, [chainToken(false)])
    await expect(
      WireSyndicationTool.runVerifyLiqTokenActive(ctx, tokenInput, signal)
    ).rejects.toThrow(/no active sysio.tokens::chaintokens binding/)
  })
})

describe("WireSyndicationTool.isRequestIssued", () => {
  it("reads a request as issued from REQUESTED on, and not before", () => {
    const at = (state: SysioContracts.SysioSyndEnvelopeState) =>
      WireSyndicationTool.isRequestIssued(envelope(Solana, Liqsol, 4, state))
    expect(at(SysioSyndEnvelopeState.OPEN)).toBe(false)
    expect(at(SysioSyndEnvelopeState.WAITING)).toBe(false)
    expect(at(SysioSyndEnvelopeState.REQUESTED)).toBe(true)
    expect(at(SysioSyndEnvelopeState.RELEASABLE)).toBe(true)
    expect(at(SysioSyndEnvelopeState.HELD)).toBe(true)
    expect(at(SysioSyndEnvelopeState.DONE)).toBe(true)
  })

  it("tells a ruled INVALID envelope from one dropped before any request", () => {
    expect(
      WireSyndicationTool.isRequestIssued(
        envelope(
          Solana,
          Liqsol,
          4,
          SysioSyndEnvelopeState.INVALID,
          RequestId,
          SysioSyndRequestOutcome.INVALID
        )
      )
    ).toBe(true)
    expect(
      WireSyndicationTool.isRequestIssued(
        envelope(Solana, Liqsol, 4, SysioSyndEnvelopeState.INVALID)
      )
    ).toBe(false)
    expect(WireSyndicationTool.isRequestIssued(undefined)).toBe(false)
  })
})

describe("WireSyndicationTool held-envelope and final health reads", () => {
  const amount = 5_000_000_000n,
    pubkey = "ab".repeat(32),
    item: SysioContracts.SysioSyndItemRowType = {
      id: 1,
      chain_code: Solana,
      token_code: Liqsol,
      epoch_index: 4,
      kind: SysioSyndItemKind.SYNDICATION,
      chain_kind: SysioSyndChainkind.CHAIN_KIND_SVM,
      pubkey,
      amount: amount.toString(),
      remaining: amount.toString(),
      position: { index_checkpoint: "0", owed_wire: 0 }
    }

  it.each([SysioSyndEnvelopeState.WAITING, SysioSyndEnvelopeState.REQUESTED])(
    "finds fully held items at state %s",
    async state => {
      const { ctx, clients } = stubbedContext(),
        row = envelope(Solana, Liqsol, 4, state)
      serve(clients.synd.tables.items, [item])
      serve(clients.synd.tables.envelopes, [row])
      expect(
        await WireSyndicationTool.readHeldEnvelope(
          ctx,
          Solana,
          Liqsol,
          SysioSyndItemKind.SYNDICATION,
          amount,
          pubkey
        )
      ).toEqual(row)
      expect(
        await WireSyndicationTool.readHeldEnvelope(
          ctx,
          Solana,
          Liqsol,
          SysioSyndItemKind.YIELD,
          amount
        )
      ).toBeUndefined()
      expect(
        await WireSyndicationTool.readHeldEnvelope(
          ctx,
          Solana,
          Liqsol,
          SysioSyndItemKind.SYNDICATION,
          amount,
          "cd".repeat(32)
        )
      ).toBeUndefined()
    }
  )

  it("refuses released and partially consumed items", async () => {
    const { ctx, clients } = stubbedContext()
    serve(clients.synd.tables.items, [item])
    serve(clients.synd.tables.envelopes, [
      envelope(Solana, Liqsol, 4, SysioSyndEnvelopeState.DONE)
    ])
    expect(
      await WireSyndicationTool.readHeldEnvelope(
        ctx,
        Solana,
        Liqsol,
        SysioSyndItemKind.SYNDICATION,
        amount
      )
    ).toBeUndefined()
    jest.mocked(clients.synd.tables.envelopes.query).mockResolvedValue({
      rows: [envelope(Solana, Liqsol, 4, SysioSyndEnvelopeState.WAITING)],
      more: false
    })
    jest
      .mocked(clients.synd.tables.items.query)
      .mockResolvedValue({ rows: [{ ...item, remaining: 1 }], more: false })
    expect(
      await WireSyndicationTool.readHeldEnvelope(
        ctx,
        Solana,
        Liqsol,
        SysioSyndItemKind.SYNDICATION,
        amount
      )
    ).toBeUndefined()
  })

  it("refuses truncated held-item reads", async () => {
    const { ctx, clients } = stubbedContext()
    serve(clients.synd.tables.items, [], true)
    await expect(
      WireSyndicationTool.readHeldEnvelope(
        ctx,
        Solana,
        Liqsol,
        SysioSyndItemKind.YIELD,
        amount
      )
    ).rejects.toThrow(/items has more/)
  })

  it("passes an absent clear cord and empty mismatches", async () => {
    const { ctx, clients } = stubbedContext(),
      step = WireSyndicationTool.planVerifyHealthy(
        Report.Actor.Sysio,
        "healthy",
        "healthy",
        {}
      )
    serve(clients.andon.tables.cord, [])
    serve(clients.synd.tables.mismatch, [])
    await expect(step.runner(ctx, step.input, signal)).resolves.toBeUndefined()
  })

  it("refuses a pulled cord", async () => {
    const { ctx, clients } = stubbedContext()
    serve(clients.andon.tables.cord, [
      {
        pulled: true,
        pulled_by: Bonder,
        pulled_at: "",
        reason: "test",
        pulled_at_epoch: 4,
        cleared_by: "",
        cleared_at: "",
        note: "",
        cleared_at_epoch: 0,
        pull_count: 1,
        frozen_epochs: 0
      }
    ])
    await expect(
      WireSyndicationTool.runVerifyHealthy(ctx, null, signal)
    ).rejects.toThrow(/emergency cord/)
  })
  it("refuses a mismatch even when the cord is clear", async () => {
    const { ctx, clients } = stubbedContext()
    serve(clients.andon.tables.cord, [])
    serve(clients.synd.tables.mismatch, [
      {
        chain_code: Solana,
        token_code: Liqsol,
        epoch_index: 4,
        sequence: 9,
        kind: SysioSyndItemKind.SYNDICATION,
        reported: 1,
        expected: 2,
        at: "2026-09-30T00:00:00.000"
      }
    ])
    await expect(
      WireSyndicationTool.runVerifyHealthy(ctx, null, signal)
    ).rejects.toThrow(/custody mismatch/)
  })
})
