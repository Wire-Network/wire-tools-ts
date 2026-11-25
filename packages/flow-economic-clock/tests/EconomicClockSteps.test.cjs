const Assert = require("node:assert/strict")
const { test, describe, afterEach, mock } = require("node:test")

const { SysioContracts } = require("@wireio/sdk-core")
const {
  OutputStore,
  Steps,
  WireCollateralTool,
  WireEconomicClockTool,
  formatWireAsset
} = require("@wireio/cluster-tool")

const { EconomicClockSteps } = require("../lib/steps/EconomicClockSteps.js")
const {
  EconomicClockScenarioConstants: Constants
} = require("../lib/EconomicClockScenarioConstants.js")

const { WithdrawalWait } = EconomicClockSteps,
  { SysioEpochEmissionsblockreason: BlockReason, SysioMsgchChainkind: ChainKind } = SysioContracts,
  signal = new AbortController().signal

afterEach(() => mock.restoreAll())

/** The fixture grid: 120 s economic epochs, 60 s consensus epochs. */
const GridStartMs = Date.UTC(2026, 10, 23, 0, 0, 0),
  EconomicMs = 120_000,
  ConsensusSec = 60,
  LagMs = 5_000

/** A reading of economic epoch `index`, `LagMs` after it opened. */
function reading(index, consensus, paused = false, headMs = GridStartMs + (index - 1) * EconomicMs + LagMs) {
  return {
    economicEpochIndex: index,
    economicEpochStartMs: GridStartMs + (index - 1) * EconomicMs,
    economicNextEpochStartMs: GridStartMs + index * EconomicMs,
    consensusEpochIndex: consensus,
    consensusPaused: paused,
    headBlockTimeMs: headMs
  }
}

/** An epochlog payment row. */
function payment(index, count, total = 1_000n) {
  return { economic_epoch_index: index, epoch_count: String(count), total_emission: String(total) }
}

/** A queued withdrawal requested at economic epoch `economic`, consensus epoch `consensus`. */
function request(economic, consensus, amount = Constants.WithdrawAmount, id = 7) {
  return {
    request_id: String(id),
    account: "withdrawer",
    chain_code: "WIRE",
    token_code: "WIRE",
    amount: amount.toString(),
    requested_at_economic_epoch: economic,
    eligible_at_economic_epoch: economic + Constants.WithdrawWaitEconomicEpochs,
    eligible_at_consensus_epoch: consensus + Constants.WithdrawWaitConsensusEpochs
  }
}

/** A blocklog episode first blocked at `first`, last at `last`. */
function blockRow(first, last, attempted, reason = BlockReason.EMISSIONS_BLOCK_REASON_BALANCE_INSUFFICIENT) {
  return {
    epoch_index: first,
    last_epoch_index: last,
    reason,
    attempted_emission: String(attempted),
    treasury_remaining: "1",
    sysio_balance: "0",
    first_blocked_at: 0,
    last_blocked_at: 0,
    blocked_epochs: last - first + 1
  }
}

/** A t5state row. */
function t5(last, pending, periodStart, lastShare = 100n, unsettled = 0n) {
  return {
    last_epoch_index: last,
    pending_emission_amount: String(pending),
    period_start_epoch: periodStart,
    last_epoch_emission: String(lastShare),
    unsettled_batch_emission: String(unsettled),
    epoch_count: "1"
  }
}

/** An envlog row routed start → end at `epoch`. */
function envelope(id, start, end, epoch) {
  return { id: String(id), endpoints: { start: { kind: start, id: 0 }, end: { kind: end, id: 0 } }, epoch_index: epoch }
}

describe("emissions per economic epoch", () => {
  const observation = { start: reading(3, 4), ticks: [reading(4, 6), reading(5, 8)] }

  test("one payment per economic epoch, in consecutive payment order", () => {
    const paid = EconomicClockSteps.assertEmissionsPaidPerEconomicEpoch(observation, [
      payment(3, 10),
      payment(4, 11),
      payment(5, 12)
    ])
    Assert.deepEqual(paid.map(row => row.economic_epoch_index), [4, 5])
  })

  test("an economic epoch that paid nothing fails", () => {
    Assert.throws(
      () => EconomicClockSteps.assertEmissionsPaidPerEconomicEpoch(observation, [payment(4, 11)]),
      /economic epoch 5 paid no period/
    )
  })

  test("an empty period fails", () => {
    Assert.throws(
      () =>
        EconomicClockSteps.assertEmissionsPaidPerEconomicEpoch(observation, [
          payment(4, 11),
          payment(5, 12, 0n)
        ]),
      /paid an empty period/
    )
  })

  test("payments that are not one per economic epoch fail", () => {
    Assert.throws(
      () =>
        EconomicClockSteps.assertEmissionsPaidPerEconomicEpoch(observation, [
          payment(4, 11),
          payment(5, 13)
        ]),
      /is not the payment after economic epoch 4/
    )
  })
})

describe("consensus cadence", () => {
  test("consensus advancing twice per economic epoch passes", () => {
    const ticks = [1, 2, 3, 4, 5].map(index => reading(index, 2 * index))
    Assert.equal(
      EconomicClockSteps.assertConsensusCadence({ start: reading(1, 2), ticks }, ConsensusSec),
      8
    )
  })

  test("consensus no faster than the economic clock fails", () => {
    const ticks = [1, 2, 3].map(index => reading(index, index))
    Assert.throws(
      () => EconomicClockSteps.assertConsensusCadence({ start: reading(1, 1), ticks }, ConsensusSec),
      /consensus advanced 2 epoch\(s\) while the economic clock opened 2/
    )
  })

  test("consensus behind its envelope fails", () => {
    const ticks = [reading(1, 1), reading(5, 4)]
    Assert.throws(
      () => EconomicClockSteps.assertConsensusCadence({ start: reading(1, 1), ticks }, ConsensusSec),
      /so at least 5/
    )
  })

  test("one economic epoch is too few to time consensus against", () => {
    Assert.throws(
      () =>
        EconomicClockSteps.assertConsensusCadence({ start: reading(1, 1), ticks: [reading(2, 3)] }, ConsensusSec),
      /too few economic epochs/
    )
  })
})

describe("pay claims", () => {
  const before = { balance: 1_000n, payClaim: 250n, economicEpochIndex: 9 }

  test("with no economic epoch between, the claim pays exactly and the row is gone", () => {
    EconomicClockSteps.assertPayClaimPaid(before, { balance: 1_250n, payClaim: 0n, economicEpochIndex: 9 })
  })

  test("with no economic epoch between, a different payout fails", () => {
    Assert.throws(
      () => EconomicClockSteps.assertPayClaimPaid(before, { balance: 1_300n, payClaim: 0n, economicEpochIndex: 9 }),
      /other than the recorded claim/
    )
  })

  test("with no economic epoch between, a claim left in payclaims fails", () => {
    Assert.throws(
      () => EconomicClockSteps.assertPayClaimPaid(before, { balance: 1_250n, payClaim: 5n, economicEpochIndex: 9 }),
      /left part of the claim/
    )
  })

  test("an economic epoch between may credit more, which the claim also pays", () => {
    EconomicClockSteps.assertPayClaimPaid(before, { balance: 1_400n, payClaim: 30n, economicEpochIndex: 10 })
  })

  test("a payout below the recorded claim fails even across an economic epoch", () => {
    Assert.throws(
      () => EconomicClockSteps.assertPayClaimPaid(before, { balance: 1_100n, payClaim: 0n, economicEpochIndex: 10 }),
      /less than the recorded claim/
    )
  })

  test("recording refuses an account payepoch credited nothing", async () => {
    const ctx = {
      outputs: new OutputStore(),
      wire: { getWireBalance: async () => 5n, getPayClaimable: async () => 0n }
    }
    mock.method(Steps.contracts.sysio.epoch, "readEconomyState", async () => ({ current_epoch_index: 3 }))
    await Assert.rejects(
      EconomicClockSteps.runRecordPayClaim(
        ctx,
        { kind: "EconomicClockSteps.PayClaimInput", account: "defproducera", snapshotName: "x" },
        signal
      ),
      /credited defproducera no epoch pay/
    )
  })

  test("record then verify compares the account before and after its claim", async () => {
    const balances = [1_000n, 1_250n],
      claims = [250n, 0n],
      ctx = {
        outputs: new OutputStore(),
        wire: {
          getWireBalance: async () => balances.shift(),
          getPayClaimable: async () => claims.shift()
        }
      },
      input = { kind: "EconomicClockSteps.PayClaimInput", account: "defproducera", snapshotName: "clock" }
    mock.method(Steps.contracts.sysio.epoch, "readEconomyState", async () => ({ current_epoch_index: 9 }))
    await EconomicClockSteps.runRecordPayClaim(ctx, input, signal)
    Assert.deepEqual(ctx.outputs.assert(EconomicClockSteps.payClaimKey("clock")), before)
    await EconomicClockSteps.runVerifyPayClaimPaid(ctx, input, signal)
  })
})

describe("withdrawal eligibility", () => {
  const row = request(4, 10)

  test("both fields follow from the clocks bracketing the request", () => {
    EconomicClockSteps.assertWithdrawalEligibility(row, Constants.WithdrawAmount, reading(4, 10), reading(4, 10))
    EconomicClockSteps.assertWithdrawalEligibility(row, Constants.WithdrawAmount, reading(4, 9), reading(4, 11))
  })

  test("a request in the epoch past an unticked boundary is in range", () => {
    EconomicClockSteps.assertWithdrawalEligibility(request(5, 10), Constants.WithdrawAmount, reading(4, 10), reading(4, 10))
  })

  test("another amount fails", () => {
    Assert.throws(
      () => EconomicClockSteps.assertWithdrawalEligibility(row, 1n, reading(4, 10), reading(4, 10)),
      /another amount/
    )
  })

  test("an economic wait other than two economic epochs fails", () => {
    Assert.throws(
      () =>
        EconomicClockSteps.assertWithdrawalEligibility(
          { ...row, eligible_at_economic_epoch: 7 },
          Constants.WithdrawAmount,
          reading(4, 10),
          reading(4, 10)
        ),
      /eligible_at_economic_epoch/
    )
  })

  test("a request dated outside the bracketing readings fails", () => {
    Assert.throws(
      () => EconomicClockSteps.assertWithdrawalEligibility(request(3, 10), Constants.WithdrawAmount, reading(4, 10), reading(4, 10)),
      /outside 4..5/
    )
  })

  test("a consensus guard from outside the bracketing readings fails", () => {
    Assert.throws(
      () => EconomicClockSteps.assertWithdrawalEligibility(request(4, 12), Constants.WithdrawAmount, reading(4, 10), reading(4, 11)),
      /eligible_at_consensus_epoch 14/
    )
  })

  test("the eligibility verify stores the single queued row", async () => {
    const ctx = {
      outputs: new OutputStore().set(WireEconomicClockTool.observationKey("before"), {
        start: reading(3, 9),
        ticks: [reading(4, 10)]
      }),
      keyStore: { assertOperator: () => ({ account: "withdrawer" }) }
    }
    mock.method(WireCollateralTool, "readWithdrawRequests", async () => [row])
    mock.method(WireEconomicClockTool, "readReading", async () => reading(4, 10))
    const input = {
      kind: "EconomicClockSteps.WithdrawalEligibilityInput",
      label: "withdrawer",
      amount: Constants.WithdrawAmount,
      observationName: "before",
      withdrawalName: "first"
    }
    await EconomicClockSteps.runVerifyWithdrawalEligibility(ctx, input, signal)
    Assert.equal(ctx.outputs.assert(EconomicClockSteps.withdrawalKey("first")), row)
    mock.method(WireCollateralTool, "readWithdrawRequests", async () => [row, request(4, 10, 1n, 8)])
    await Assert.rejects(
      EconomicClockSteps.runVerifyWithdrawalEligibility(ctx, input, signal),
      /exactly one queued withdrawal/
    )
  })
})

describe("withdrawal waits", () => {
  const row = request(4, 10)

  test("waitPassed reads each clock against its own eligibility", () => {
    Assert.equal(EconomicClockSteps.waitPassed(row, reading(5, 12), WithdrawalWait.consensus), true)
    Assert.equal(EconomicClockSteps.waitPassed(row, reading(5, 11), WithdrawalWait.consensus), false)
    Assert.equal(EconomicClockSteps.waitPassed(row, reading(6, 10), WithdrawalWait.economic), true)
    Assert.equal(EconomicClockSteps.waitPassed(row, reading(5, 20), WithdrawalWait.economic), false)
  })

  test("held by its economic wait after the consensus guard passed", () => {
    EconomicClockSteps.assertWithdrawalHeld(
      row,
      { reading: reading(5, 12), queued: true, remitClaim: 0n },
      WithdrawalWait.consensus,
      0n
    )
  })

  test("held by its consensus guard after the economic wait passed", () => {
    EconomicClockSteps.assertWithdrawalHeld(
      row,
      { reading: reading(6, 10, true), queued: true, remitClaim: 5n },
      WithdrawalWait.economic,
      5n
    )
  })

  test("a withdrawal that matured on one wait alone fails", () => {
    Assert.throws(
      () =>
        EconomicClockSteps.assertWithdrawalHeld(
          row,
          { reading: reading(6, 10, true), queued: false, remitClaim: 5n },
          WithdrawalWait.economic,
          5n
        ),
      /matured on its economic wait alone/
    )
  })

  test("a snapshot where both waits had passed shows nothing held", () => {
    Assert.throws(
      () =>
        EconomicClockSteps.assertWithdrawalHeld(
          row,
          { reading: reading(6, 12), queued: true, remitClaim: 0n },
          WithdrawalWait.consensus,
          0n
        ),
      /economic wait had also passed/
    )
  })

  test("a snapshot taken before its wait passed fails", () => {
    Assert.throws(
      () =>
        EconomicClockSteps.assertWithdrawalHeld(
          row,
          { reading: reading(5, 11), queued: true, remitClaim: 0n },
          WithdrawalWait.consensus,
          0n
        ),
      /before the consensus wait passed/
    )
  })

  test("a remit claim that moved while held fails", () => {
    Assert.throws(
      () =>
        EconomicClockSteps.assertWithdrawalHeld(
          row,
          { reading: reading(5, 12), queued: true, remitClaim: 1n },
          WithdrawalWait.consensus,
          0n
        ),
      /remit claim moved/
    )
  })

  test("matured only once out of the queue with both clocks past their eligibility", () => {
    EconomicClockSteps.assertWithdrawalMatured(row, [], reading(6, 12))
    Assert.throws(
      () => EconomicClockSteps.assertWithdrawalMatured(row, [row], reading(6, 12)),
      /still queued/
    )
    Assert.throws(
      () => EconomicClockSteps.assertWithdrawalMatured(row, [], reading(6, 11)),
      /before its consensus wait passed/
    )
    Assert.throws(
      () => EconomicClockSteps.assertWithdrawalMatured(row, [], reading(5, 12)),
      /before its economic wait passed/
    )
  })

  test("deadlines cover the wait's epochs plus the epoch of the request", () => {
    const config = { economicEpochDurationSec: 120, epochDurationSec: 60 }
    Assert.equal(EconomicClockSteps.withdrawalWaitDeadlineMs(config, WithdrawalWait.economic), 3 * 150_000)
    Assert.equal(EconomicClockSteps.withdrawalWaitDeadlineMs(config, WithdrawalWait.consensus), 3 * 90_000)
    Assert.equal(
      EconomicClockSteps.withdrawalWaitStepTimeoutMs(config, WithdrawalWait.consensus),
      3 * 90_000 + 30_000
    )
  })

  test("the await stores the first consistent snapshot at which the wait passed", async () => {
    const readings = [reading(5, 11), reading(5, 11), reading(5, 12), reading(5, 12)],
      ctx = {
        config: { economicEpochDurationSec: 120, epochDurationSec: 60 },
        outputs: new OutputStore().set(EconomicClockSteps.withdrawalKey("first"), row),
        keyStore: { assertOperator: () => ({ account: "withdrawer" }) }
      }
    mock.method(WireEconomicClockTool, "readReading", async () => readings.shift())
    mock.method(WireCollateralTool, "readWithdrawRequests", async () => [row])
    mock.method(WireCollateralTool, "readRemitClaim", async () => 0n)
    await EconomicClockSteps.runAwaitWithdrawalWaitPassed(
      ctx,
      {
        kind: "EconomicClockSteps.AwaitWithdrawalWaitInput",
        label: "withdrawer",
        withdrawalName: "first",
        wait: WithdrawalWait.consensus
      },
      signal
    )
    Assert.deepEqual(
      ctx.outputs.assert(EconomicClockSteps.withdrawalSnapshotKey("first", WithdrawalWait.consensus)),
      { reading: reading(5, 12), queued: true, remitClaim: 0n }
    )
  })
})

describe("treasury", () => {
  test("spendable WIRE is the balance less the pay owed and the batch emission settling", () => {
    Assert.equal(EconomicClockSteps.spendableWire(1_000n, 300n, 200n), 500n)
    Assert.equal(EconomicClockSteps.spendableWire(100n, 300n, 0n), -200n)
  })

  /** A context whose treasury reads report `balance`, `owed` and `unsettled`. */
  function treasuryContext(balance, owed, unsettled) {
    mock.method(Steps.contracts.sysio.system, "readOutstandingPay", async () => owed)
    mock.method(Steps.contracts.sysio.system, "readT5State", async () => t5(1, 0n, 1, 0n, unsettled))
    return { outputs: new OutputStore(), wire: { getWireBalance: async () => balance } }
  }

  test("the drain moves every unit of spendable WIRE to the holder and records it", async () => {
    const ctx = treasuryContext(1_000n, 100n, 50n),
      transfer = mock.method(Steps.contracts.sysio.token, "runTransfer", async () => {})
    await EconomicClockSteps.runDrainSpendableWire(
      ctx,
      { kind: "EconomicClockSteps.TreasuryTransferInput", holder: Constants.TreasuryHolder },
      signal
    )
    Assert.equal(transfer.mock.calls.length, 1)
    Assert.deepEqual(transfer.mock.calls[0].arguments[1], {
      kind: "TokenContractSteps.TransferInput",
      data: {
        from: "sysio",
        to: Constants.TreasuryHolder,
        quantity: formatWireAsset(850n),
        memo: Constants.DrainMemo
      }
    })
    Assert.equal(ctx.outputs.assert(Constants.DrainedWire), 850n)
  })

  test("the drain refuses a treasury with nothing spendable and transfers nothing", async () => {
    const ctx = treasuryContext(100n, 100n, 0n),
      transfer = mock.method(Steps.contracts.sysio.token, "runTransfer", async () => {})
    await Assert.rejects(
      EconomicClockSteps.runDrainSpendableWire(
        ctx,
        { kind: "EconomicClockSteps.TreasuryTransferInput", holder: Constants.TreasuryHolder },
        signal
      ),
      /no spendable WIRE/
    )
    Assert.equal(transfer.mock.calls.length, 0)
  })

  test("the refund returns exactly the drained WIRE to sysio", async () => {
    const ctx = { outputs: new OutputStore().set(Constants.DrainedWire, 850n) },
      transfer = mock.method(Steps.contracts.sysio.token, "runTransfer", async () => {})
    await EconomicClockSteps.runRefundSpendableWire(
      ctx,
      { kind: "EconomicClockSteps.TreasuryTransferInput", holder: Constants.TreasuryHolder },
      signal
    )
    Assert.deepEqual(transfer.mock.calls[0].arguments[1].data, {
      from: Constants.TreasuryHolder,
      to: "sysio",
      quantity: formatWireAsset(850n),
      memo: Constants.RefundMemo
    })
  })

  test("the drained verify passes at no spendable WIRE and fails with any left", async () => {
    await EconomicClockSteps.runVerifySpendableWireDrained(treasuryContext(100n, 100n, 0n), null, signal)
    mock.restoreAll()
    await Assert.rejects(
      EconomicClockSteps.runVerifySpendableWireDrained(treasuryContext(101n, 100n, 0n), null, signal),
      /still has 1 spendable WIRE/
    )
  })
})

describe("emissions hold", () => {
  const hold = {
    blockLog: blockRow(20, 20, 500n),
    t5: t5(20, 500n, 20),
    reading: reading(20, 40),
    envelopeLogTip: 100n
  }

  test("the reason spelled either way is BALANCE_INSUFFICIENT", () => {
    Assert.equal(EconomicClockSteps.isBalanceInsufficient(blockRow(1, 1, 1n)), true)
    Assert.equal(
      EconomicClockSteps.isBalanceInsufficient({
        ...blockRow(1, 1, 1n),
        reason: "EMISSIONS_BLOCK_REASON_BALANCE_INSUFFICIENT"
      }),
      true
    )
    Assert.equal(
      EconomicClockSteps.isBalanceInsufficient(
        blockRow(1, 1, 1n, BlockReason.EMISSIONS_BLOCK_REASON_TREASURY_EXHAUSTED)
      ),
      false
    )
  })

  test("a hold for want of WIRE that still accrued passes", () => {
    EconomicClockSteps.assertEmissionsHeld(hold, [payment(19, 5)])
  })

  test("another reason fails", () => {
    Assert.throws(
      () =>
        EconomicClockSteps.assertEmissionsHeld(
          { ...hold, blockLog: blockRow(20, 20, 500n, BlockReason.EMISSIONS_BLOCK_REASON_TREASURY_EXHAUSTED) },
          []
        ),
      /the hold's reason/
    )
  })

  test("a treasury that could have paid fails", () => {
    Assert.throws(
      () => EconomicClockSteps.assertEmissionsHeld({ ...hold, blockLog: { ...hold.blockLog, sysio_balance: "500" } }, []),
      /enough for the attempted/
    )
  })

  test("a held epoch that did not accrue the attempted total fails", () => {
    Assert.throws(
      () => EconomicClockSteps.assertEmissionsHeld({ ...hold, t5: t5(20, 499n, 20) }, []),
      /did not accrue the period total/
    )
  })

  test("a held period that began before the first blocked epoch fails", () => {
    Assert.throws(
      () => EconomicClockSteps.assertEmissionsHeld({ ...hold, t5: t5(20, 500n, 19) }, []),
      /does not begin at the first blocked/
    )
  })

  test("a held epoch that paid fails", () => {
    Assert.throws(() => EconomicClockSteps.assertEmissionsHeld(hold, [payment(20, 6)]), /a held economic epoch paid/)
  })

  test("the envelope log tip is its highest id", () => {
    Assert.equal(EconomicClockSteps.envelopeLogTip([]), 0n)
    Assert.equal(
      EconomicClockSteps.envelopeLogTip([envelope(3, 1, 2, 1), envelope(9, 2, 1, 1), envelope(4, 1, 3, 1)]),
      9n
    )
  })

  test("a round trip is the depot's envelope out and the outpost's back at one epoch, past the tip", () => {
    const log = [
      envelope(100, ChainKind.CHAIN_KIND_WIRE, ChainKind.CHAIN_KIND_EVM, 41),
      envelope(101, ChainKind.CHAIN_KIND_WIRE, ChainKind.CHAIN_KIND_EVM, 42),
      envelope(102, "CHAIN_KIND_EVM", "CHAIN_KIND_WIRE", 42),
      envelope(103, ChainKind.CHAIN_KIND_WIRE, ChainKind.CHAIN_KIND_SVM, 42)
    ]
    Assert.equal(EconomicClockSteps.findEnvelopeRoundTrip(log, ChainKind.CHAIN_KIND_EVM, 100n), 42)
    Assert.equal(EconomicClockSteps.findEnvelopeRoundTrip(log, ChainKind.CHAIN_KIND_SVM, 100n), undefined)
    Assert.equal(EconomicClockSteps.findEnvelopeRoundTrip(log, ChainKind.CHAIN_KIND_EVM, 101n), undefined)
  })

  test("the round-trip await waits for both outposts", async () => {
    const pages = [
        [envelope(101, ChainKind.CHAIN_KIND_WIRE, ChainKind.CHAIN_KIND_EVM, 42), envelope(102, ChainKind.CHAIN_KIND_EVM, ChainKind.CHAIN_KIND_WIRE, 42)],
        [
          envelope(101, ChainKind.CHAIN_KIND_WIRE, ChainKind.CHAIN_KIND_EVM, 42),
          envelope(102, ChainKind.CHAIN_KIND_EVM, ChainKind.CHAIN_KIND_WIRE, 42),
          envelope(103, ChainKind.CHAIN_KIND_WIRE, ChainKind.CHAIN_KIND_SVM, 42),
          envelope(104, ChainKind.CHAIN_KIND_SVM, ChainKind.CHAIN_KIND_WIRE, 42)
        ]
      ],
      ctx = {
        outputs: new OutputStore().set(EconomicClockSteps.holdKey("held"), hold),
        wire: { getSysioContract: () => ({ tables: { envlog: { queryAll: async () => pages.shift() } } }) }
      }
    await EconomicClockSteps.runAwaitEnvelopeRoundTrip(
      ctx,
      { kind: "EconomicClockSteps.HoldInput", holdName: "held" },
      signal
    )
    Assert.equal(pages.length, 0)
  })

  describe("held across an observation", () => {
    const observation = { start: reading(21, 42), ticks: [reading(22, 44)] },
      ledger = { t5: t5(22, 1_500n, 20), blockLog: [blockRow(20, 22, 1_500n)] }

    test("one episode holding every epoch while consensus advanced passes", () => {
      EconomicClockSteps.assertEmissionsHeldAcross(hold, observation, ledger, [], ConsensusSec)
    })

    test("a closed episode fails", () => {
      Assert.throws(
        () => EconomicClockSteps.assertEmissionsHeldAcross(hold, observation, { ...ledger, blockLog: [] }, [], ConsensusSec),
        /episode closed/
      )
    })

    test("a new episode fails", () => {
      Assert.throws(
        () =>
          EconomicClockSteps.assertEmissionsHeldAcross(
            hold,
            observation,
            { ...ledger, blockLog: [blockRow(21, 22, 1_500n)] },
            [],
            ConsensusSec
          ),
        /another block episode replaced/
      )
    })

    test("an epoch inside the hold that was not held fails", () => {
      Assert.throws(
        () =>
          EconomicClockSteps.assertEmissionsHeldAcross(
            hold,
            observation,
            { ...ledger, blockLog: [{ ...blockRow(20, 22, 1_500n), blocked_epochs: 2 }] },
            [],
            ConsensusSec
          ),
        /was not held/
      )
    })

    test("a period that stopped accruing fails", () => {
      Assert.throws(
        () =>
          EconomicClockSteps.assertEmissionsHeldAcross(
            hold,
            observation,
            { t5: t5(22, 500n, 20), blockLog: [blockRow(20, 22, 500n)] },
            [],
            ConsensusSec
          ),
        /stopped accruing/
      )
    })

    test("a held epoch that paid fails", () => {
      Assert.throws(
        () => EconomicClockSteps.assertEmissionsHeldAcross(hold, observation, ledger, [payment(21, 6)], ConsensusSec),
        /a held economic epoch paid/
      )
    })

    test("consensus that stood still fails", () => {
      Assert.throws(
        () =>
          EconomicClockSteps.assertEmissionsHeldAcross(
            hold,
            { start: reading(21, 40), ticks: [reading(22, 40)] },
            ledger,
            [],
            ConsensusSec
          ),
        /consensus advanced 0 epoch/
      )
    })
  })
})

describe("emissions release", () => {
  const hold = {
      blockLog: blockRow(20, 20, 500n),
      t5: t5(20, 500n, 20),
      reading: reading(20, 40),
      envelopeLogTip: 100n
    },
    heldBefore = { t5: t5(22, 1_500n, 20, 500n), blockLog: [blockRow(20, 22, 1_500n)] },
    paidAt = { t5: t5(23, 0n, 24, 490n), blockLog: [] },
    payout = payment(23, 6, 1_990n)

  test("releaseOf waits until the ledger after the payout is read", () => {
    Assert.equal(EconomicClockSteps.releaseOf(payout, new Map([[22, heldBefore]])), null)
  })

  test("releaseOf returns the payout and the ledger around it", () => {
    Assert.deepEqual(
      EconomicClockSteps.releaseOf(payout, new Map([[22, heldBefore], [23, paidAt]])),
      { payout, heldBefore, paidAt }
    )
  })

  test("releaseOf refuses a payout whose surrounding ledger was missed", () => {
    Assert.throws(
      () => EconomicClockSteps.releaseOf(payout, new Map([[22, heldBefore], [24, paidAt]])),
      /was not read before the next tick/
    )
    Assert.throws(
      () => EconomicClockSteps.releaseOf(payout, new Map([[23, paidAt]])),
      /was not read before the next tick/
    )
  })

  test("a payout of the whole held period plus its own share passes", () => {
    EconomicClockSteps.assertEmissionsReleased(hold, { payout, heldBefore, paidAt })
  })

  test("a payout short of the held accrual fails", () => {
    Assert.throws(
      () => EconomicClockSteps.assertEmissionsReleased(hold, { payout: payment(23, 6, 1_500n), heldBefore, paidAt }),
      /held period's accrual plus the paying epoch's share/
    )
  })

  test("an episode still open after the payout fails", () => {
    Assert.throws(
      () =>
        EconomicClockSteps.assertEmissionsReleased(hold, {
          payout,
          heldBefore,
          paidAt: { ...paidAt, blockLog: [blockRow(20, 23, 1n)] }
        }),
      /still open after the payout/
    )
  })

  test("a payout that skipped the epoch after the last held one fails", () => {
    Assert.throws(
      () => EconomicClockSteps.assertEmissionsReleased(hold, { payout: payment(24, 6, 1_990n), heldBefore, paidAt }),
      /not the economic epoch after the last held one/
    )
  })

  test("a payout that left emission pending fails", () => {
    Assert.throws(
      () =>
        EconomicClockSteps.assertEmissionsReleased(hold, {
          payout,
          heldBefore,
          paidAt: { ...paidAt, t5: t5(23, 1n, 24, 490n) }
        }),
      /left emission pending/
    )
  })

  test("the release await records the ledger by tick and returns once the payout's ledger is in", async () => {
    const polls = [
        { t5: [heldBefore.t5, heldBefore.t5], blockLog: heldBefore.blockLog, epochLog: [payment(19, 5)] },
        { t5: [paidAt.t5, paidAt.t5], blockLog: [], epochLog: [payment(19, 5), payout] }
      ],
      t5Reads = polls.flatMap(poll => poll.t5),
      ctx = {
        config: { economicEpochDurationSec: 120 },
        outputs: new OutputStore().set(EconomicClockSteps.holdKey("held"), hold)
      }
    mock.method(Steps.contracts.sysio.system, "readT5State", async () => t5Reads.shift())
    mock.method(Steps.contracts.sysio.epoch, "readBlockLog", async () => polls[0].blockLog)
    mock.method(Steps.contracts.sysio.system, "readEpochLog", async () => polls.shift().epochLog)
    await EconomicClockSteps.runAwaitEmissionsReleased(
      ctx,
      { kind: "EconomicClockSteps.ReleaseInput", holdName: "held", releaseName: "refunded" },
      signal
    )
    const release = ctx.outputs.assert(EconomicClockSteps.releaseKey("refunded"))
    Assert.equal(release.payout, payout)
    Assert.equal(release.heldBefore.t5, heldBefore.t5)
    Assert.equal(release.paidAt.t5, paidAt.t5)
    EconomicClockSteps.assertEmissionsReleased(hold, release)
  })
})

test("the cord verify compares the pulled flag both ways", async () => {
  const { WireSyndicationTool } = require("@wireio/cluster-tool")
  mock.method(WireSyndicationTool, "readCord", async () => ({ pulled: true, reason: Constants.AndonReason }))
  await EconomicClockSteps.runVerifyCord({}, { kind: "EconomicClockSteps.CordInput", pulled: true }, signal)
  await Assert.rejects(
    EconomicClockSteps.runVerifyCord({}, { kind: "EconomicClockSteps.CordInput", pulled: false }, signal),
    /cord is pulled/
  )
})
